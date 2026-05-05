import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  GitBranchItem,
  GitBranchListSnapshot,
  GitChangedFile,
  GitCommitDetail,
  GitCommitListItem,
  GitCommitListSnapshot,
  GitSummarySnapshot
} from "./shared";

const execFileAsync = promisify(execFile);
const DEFAULT_COMMIT_PAGE_SIZE = 50;

export async function getGitSummarySnapshot(workspacePath: string): Promise<GitSummarySnapshot> {
  const repo = await resolveGitRepository(workspacePath);
  if (!repo.gitInstalled || !repo.isGitRepository) {
    return buildEmptyGitSummary(workspacePath, repo.gitInstalled);
  }

  const [statusOutput, changedFiles] = await Promise.all([
    runGit(["status", "--porcelain=2", "--branch"], workspacePath),
    collectChangedFiles(workspacePath)
  ]);
  const parsed = parseBranchStatus(statusOutput);
  return {
    workspacePath,
    repoRoot: repo.repoRoot,
    gitInstalled: true,
    isGitRepository: true,
    head: parsed.head,
    currentBranch: parsed.currentBranch,
    detachedHead: parsed.detachedHead,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    statusCounts: parsed.statusCounts,
    changedFiles
  };
}

export async function getGitBranchListSnapshot(workspacePath: string): Promise<GitBranchListSnapshot> {
  const repo = await resolveGitRepository(workspacePath);
  if (!repo.gitInstalled || !repo.isGitRepository) {
    return {
      workspacePath,
      repoRoot: repo.repoRoot ?? null,
      gitInstalled: repo.gitInstalled,
      isGitRepository: false,
      branches: []
    };
  }

  const output = await runGit(
    [
      "for-each-ref",
      "--sort=-committerdate",
      "--format=%(refname:short)\t%(HEAD)\t%(upstream:short)\t%(objectname)\t%(committerdate:iso-strict)",
      "refs/heads"
    ],
    workspacePath
  );
  const branches = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map<GitBranchItem | null>((line) => {
      const [name, headMarker, upstream, head, lastCommitAt] = line.split("\t");
      if (!name) {
        return null;
      }
      return {
        name,
        current: headMarker === "*",
        upstream: upstream || null,
        head: head || null,
        lastCommitAt: lastCommitAt || null
      };
    })
    .filter((item): item is GitBranchItem => Boolean(item))
    .sort((left, right) => {
      if (left.current !== right.current) {
        return left.current ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });

  return {
    workspacePath,
    repoRoot: repo.repoRoot,
    gitInstalled: true,
    isGitRepository: true,
    branches
  };
}

export async function getGitCommitListSnapshot(
  workspacePath: string,
  limit = DEFAULT_COMMIT_PAGE_SIZE,
  before?: string
): Promise<GitCommitListSnapshot> {
  const repo = await resolveGitRepository(workspacePath);
  if (!repo.gitInstalled || !repo.isGitRepository) {
    return {
      workspacePath,
      repoRoot: repo.repoRoot ?? null,
      gitInstalled: repo.gitInstalled,
      isGitRepository: false,
      commits: [],
      nextCursor: null
    };
  }

  const pageSize = Math.min(Math.max(limit, 1), 100);
  const skip = normalizeCursor(before);
  const output = await runGit(
    [
      "log",
      `--max-count=${pageSize + 1}`,
      `--skip=${skip}`,
      "--date=iso-strict",
      "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%P%x1e"
    ],
    workspacePath
  );
  const commits = parseGitCommitList(output);
  const hasMore = commits.length > pageSize;

  return {
    workspacePath,
    repoRoot: repo.repoRoot,
    gitInstalled: true,
    isGitRepository: true,
    commits: hasMore ? commits.slice(0, pageSize) : commits,
    nextCursor: hasMore ? String(skip + pageSize) : null
  };
}

export async function getGitCommitDetailSnapshot(
  workspacePath: string,
  commitId: string
): Promise<GitCommitDetail> {
  const repo = await resolveGitRepository(workspacePath);
  if (!repo.gitInstalled || !repo.isGitRepository) {
    throw new GitWorkspaceError("not_git_repository");
  }

  const [headerOutput, numstatOutput, statusOutput] = await Promise.all([
    runGit(
      [
        "show",
        "-s",
        "--date=iso-strict",
        "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%b%x1f%P",
        commitId
      ],
      workspacePath
    ),
    runGit(["show", "--format=", "--numstat", "--find-renames", commitId], workspacePath),
    runGit(["diff-tree", "--no-commit-id", "--name-status", "-r", "--find-renames", commitId], workspacePath)
  ]);

  const commit = parseGitCommitList(`${headerOutput}\u001e`)[0];
  if (!commit) {
    throw new Error("Commit not found");
  }
  const [, , , , , , body = ""] = headerOutput.split("\u001f");
  const statusByPath = parseCommitFileStatuses(statusOutput);
  const files = parseCommitNumstat(numstatOutput, statusByPath);

  return {
    workspacePath,
    repoRoot: repo.repoRoot,
    commit,
    body: body.trim() || null,
    files
  };
}

export class GitWorkspaceError extends Error {
  public constructor(
    public readonly code: "git_not_installed" | "not_git_repository" | "git_command_failed"
  ) {
    super(code);
  }
}

async function resolveGitRepository(
  workspacePath: string
): Promise<{ gitInstalled: boolean; isGitRepository: boolean; repoRoot?: string | null }> {
  try {
    const repoRoot = (await runGit(["rev-parse", "--show-toplevel"], workspacePath)).trim();
    return {
      gitInstalled: true,
      isGitRepository: true,
      repoRoot: repoRoot || null
    };
  } catch (error) {
    if (error instanceof GitWorkspaceError) {
      if (error.code === "git_not_installed") {
        return { gitInstalled: false, isGitRepository: false, repoRoot: null };
      }
      if (error.code === "not_git_repository") {
        return { gitInstalled: true, isGitRepository: false, repoRoot: null };
      }
    }
    if (isGitNotInstalledError(error)) {
      return { gitInstalled: false, isGitRepository: false, repoRoot: null };
    }
    if (isNotGitRepositoryError(error)) {
      return { gitInstalled: true, isGitRepository: false, repoRoot: null };
    }
    throw error;
  }
}

async function collectChangedFiles(workspacePath: string): Promise<GitChangedFile[]> {
  const output = await runGit(["status", "--short"], workspacePath);
  const byPath = new Map<string, GitChangedFile>();

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) {
      continue;
    }
    if (line.startsWith("?? ")) {
      const filePath = line.slice(3).trim();
      byPath.set(filePath, {
        path: filePath,
        status: "untracked",
        staged: false,
        unstaged: false,
        untracked: true
      });
      continue;
    }

    const indexStatus = line[0];
    const worktreeStatus = line[1];
    const pathPart = line.slice(3).trim();
    const filePath = pathPart.includes(" -> ") ? pathPart.split(" -> ").pop() ?? pathPart : pathPart;
    const existing = byPath.get(filePath);
    byPath.set(filePath, {
      path: filePath,
      status: inferGitStatus(indexStatus, worktreeStatus),
      staged: (existing?.staged ?? false) || indexStatus !== " " && indexStatus !== "?",
      unstaged: (existing?.unstaged ?? false) || worktreeStatus !== " ",
      untracked: existing?.untracked ?? false
    });
  }

  return [...byPath.values()];
}

function parseBranchStatus(output: string): {
  head?: string | null;
  currentBranch?: string | null;
  detachedHead?: boolean;
  upstream?: string | null;
  ahead: number;
  behind: number;
  statusCounts: { staged: number; unstaged: number; untracked: number };
} {
  let head: string | null = null;
  let currentBranch: string | null = null;
  let detachedHead = false;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;

  for (const line of output.split(/\r?\n/)) {
    if (!line) {
      continue;
    }
    if (line.startsWith("# branch.oid ")) {
      head = line.slice("# branch.oid ".length).trim();
      continue;
    }
    if (line.startsWith("# branch.head ")) {
      const value = line.slice("# branch.head ".length).trim();
      if (value === "(detached)") {
        detachedHead = true;
        currentBranch = null;
      } else {
        currentBranch = value;
      }
      continue;
    }
    if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length).trim() || null;
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      const match = line.match(/\+(\d+)\s+\-(\d+)/);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
      continue;
    }
    if (line.startsWith("? ")) {
      untracked += 1;
      continue;
    }
    if (line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("u ")) {
      const parts = line.split(" ");
      const xy = parts[1] ?? "";
      const x = xy[0] ?? " ";
      const y = xy[1] ?? " ";
      if (x !== ".") {
        staged += 1;
      }
      if (y !== ".") {
        unstaged += 1;
      }
    }
  }

  return {
    head,
    currentBranch,
    detachedHead,
    upstream,
    ahead,
    behind,
    statusCounts: {
      staged,
      unstaged,
      untracked
    }
  };
}

function parseGitCommitList(output: string): GitCommitListItem[] {
  return output
    .split("\u001e")
    .map((line) => line.trim())
    .filter(Boolean)
    .map<GitCommitListItem | null>((line) => {
      const [id, shortId, authorName, authorEmail, authoredAt, subject, parentsRaw] =
        line.split("\u001f");
      if (!id || !shortId || !authorName || !authoredAt) {
        return null;
      }
      return {
        id,
        shortId,
        authorName,
        authorEmail: authorEmail || null,
        authoredAt,
        subject: subject ?? "",
        parents: (parentsRaw ?? "").split(" ").filter(Boolean)
      };
    })
    .filter((item): item is GitCommitListItem => Boolean(item));
}

function parseCommitFileStatuses(output: string): Map<string, GitChangedFile["status"]> {
  const byPath = new Map<string, GitChangedFile["status"]>();
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const [statusRaw, ...pathParts] = line.split("\t");
    const pathValue = pathParts[pathParts.length - 1] ?? "";
    if (!pathValue) {
      continue;
    }
    byPath.set(pathValue, mapNameStatusToGitStatus(statusRaw));
  }
  return byPath;
}

function parseCommitNumstat(
  output: string,
  statusByPath: Map<string, GitChangedFile["status"]>
): GitChangedFile[] {
  const files: GitChangedFile[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const [addedRaw, removedRaw, ...pathParts] = line.split("\t");
    const filePath = pathParts.join("\t").trim();
    if (!filePath) {
      continue;
    }
    files.push({
      path: filePath,
      status: statusByPath.get(filePath) ?? "unknown",
      added: addedRaw === "-" ? null : Number(addedRaw),
      removed: removedRaw === "-" ? null : Number(removedRaw)
    });
  }
  return files;
}

function inferGitStatus(indexStatus: string, worktreeStatus: string): GitChangedFile["status"] {
  const dominant = indexStatus !== " " && indexStatus !== "?" ? indexStatus : worktreeStatus;
  switch (dominant) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "M":
      return "modified";
    default:
      return "unknown";
  }
}

function mapNameStatusToGitStatus(value: string): GitChangedFile["status"] {
  const code = value[0];
  switch (code) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "M":
      return "modified";
    default:
      return "unknown";
  }
}

function normalizeCursor(before: string | undefined): number {
  const value = Number(before ?? "0");
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

async function runGit(args: string[], cwd: string): Promise<string> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    });
    return result.stdout;
  } catch (error) {
    if (isGitNotInstalledError(error)) {
      throw new GitWorkspaceError("git_not_installed");
    }
    if (isNotGitRepositoryError(error)) {
      throw new GitWorkspaceError("not_git_repository");
    }
    throw new GitWorkspaceError("git_command_failed");
  }
}

function isGitNotInstalledError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function isNotGitRepositoryError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const stderr = String((error as { stderr?: unknown }).stderr ?? "");
  return /not a git repository/i.test(stderr);
}

function buildEmptyGitSummary(workspacePath: string, gitInstalled: boolean): GitSummarySnapshot {
  return {
    workspacePath,
    repoRoot: null,
    gitInstalled,
    isGitRepository: false,
    head: null,
    currentBranch: null,
    detachedHead: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    statusCounts: {
      staged: 0,
      unstaged: 0,
      untracked: 0
    },
    changedFiles: []
  };
}
