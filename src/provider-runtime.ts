import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

export type ProviderRuntimeName = "codex" | "claude";

const requireFromHere = createRequire(__filename);

const PROVIDER_RUNTIME_ENTRYPOINTS: Record<
  ProviderRuntimeName,
  { command: string; packageName: string; segments: string[] }
> = {
  codex: {
    command: "codex",
    packageName: "@openai/codex",
    segments: ["@openai", "codex", "bin", "codex.js"]
  },
  claude: {
    command: "claude",
    packageName: "@anthropic-ai/claude-code",
    segments: ["@anthropic-ai", "claude-code", "bin", "claude.exe"]
  }
};

function resolveProviderRuntimeExecutable(provider: ProviderRuntimeName): string | null {
  const entrypoint = PROVIDER_RUNTIME_ENTRYPOINTS[provider];
  return (
    findPackageBinEntrypoint(entrypoint.packageName, entrypoint.command) ??
    findNodePackageEntrypoint(...entrypoint.segments) ??
    findCommandOnPath(entrypoint.command)
  );
}

export function requireProviderRuntimeExecutable(provider: ProviderRuntimeName): string {
  const resolved = resolveProviderRuntimeExecutable(provider);
  if (resolved) {
    return resolved;
  }
  return legacyNodePackageEntrypoint(...PROVIDER_RUNTIME_ENTRYPOINTS[provider].segments);
}

export function isProviderRuntimeInstalled(provider: ProviderRuntimeName): boolean {
  return Boolean(resolveProviderRuntimeExecutable(provider));
}

export function shouldRunWithNode(executablePath: string): boolean {
  return /\.(?:cjs|js|mjs)$/i.test(executablePath);
}

export function resolveUserHomePath(value?: string): string {
  return resolveProviderPath(value ?? os.homedir(), os.homedir());
}

export function resolveProviderPath(value: string, homeDir: string): string {
  const trimmed = value.trim();
  const fallback = homeDir || os.homedir();
  if (!trimmed || trimmed === "~") {
    return path.resolve(fallback);
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.resolve(fallback, trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

export function resolveCodexConfigDir(homeDir: string, explicitConfigDir?: string): string {
  return resolveProviderPath(explicitConfigDir?.trim() || path.join(homeDir, ".codex"), homeDir);
}

export function resolveClaudeConfigDir(homeDir: string): string {
  return resolveProviderPath(path.join(homeDir, ".claude"), homeDir);
}

export function resolveClaudeGlobalStatePath(homeDir: string): string {
  return resolveProviderPath(path.join(homeDir, ".claude.json"), homeDir);
}

function findNodePackageEntrypoint(...segments: string[]): string | null {
  const specifier = packageSegmentsToSpecifier(segments);
  const candidates = new Set<string>();

  if (specifier) {
    try {
      candidates.add(requireFromHere.resolve(specifier));
    } catch {
      // Some package managers may not expose package subpaths through require.resolve.
    }
  }

  [
    path.resolve(process.cwd(), "..", "node_modules", ...segments),
    path.resolve(process.cwd(), "node_modules", ...segments),
    path.resolve(__dirname, "..", "node_modules", ...segments),
    path.resolve(__dirname, "..", "..", "node_modules", ...segments),
    path.resolve(__dirname, "..", "..", "..", "node_modules", ...segments)
  ].forEach((candidate) => candidates.add(candidate));

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function findPackageBinEntrypoint(packageName: string, command: string): string | null {
  const packageJsonPath = findPackageJson(packageName);
  if (!packageJsonPath) {
    return null;
  }

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      bin?: string | Record<string, string>;
    };
    const binPath =
      typeof packageJson.bin === "string"
        ? packageJson.bin
        : packageJson.bin && typeof packageJson.bin === "object"
          ? packageJson.bin[command]
          : undefined;
    if (!binPath) {
      return null;
    }
    const resolved = path.resolve(path.dirname(packageJsonPath), binPath);
    return existsSync(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

function findPackageJson(packageName: string): string | null {
  const specifier = `${packageName}/package.json`;
  const segments = packageName.split("/");
  const candidates = new Set<string>();

  try {
    candidates.add(requireFromHere.resolve(specifier));
  } catch {
    // Some package managers may block direct package.json resolution.
  }

  [
    path.resolve(process.cwd(), "..", "node_modules", ...segments, "package.json"),
    path.resolve(process.cwd(), "node_modules", ...segments, "package.json"),
    path.resolve(__dirname, "..", "node_modules", ...segments, "package.json"),
    path.resolve(__dirname, "..", "..", "node_modules", ...segments, "package.json"),
    path.resolve(__dirname, "..", "..", "..", "node_modules", ...segments, "package.json")
  ].forEach((candidate) => candidates.add(candidate));

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function legacyNodePackageEntrypoint(...segments: string[]): string {
  return path.resolve(process.cwd(), "..", "node_modules", ...segments);
}

function packageSegmentsToSpecifier(segments: string[]): string | null {
  if (segments.length < 2) {
    return null;
  }
  if (segments[0].startsWith("@")) {
    if (segments.length < 3) {
      return null;
    }
    return `${segments[0]}/${segments[1]}/${segments.slice(2).join("/")}`;
  }
  return segments.join("/");
}

function findCommandOnPath(command: string): string | null {
  const lookupCommand = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(lookupCommand, [command], {
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0 || !result.stdout) {
    return null;
  }
  const firstMatch = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return firstMatch && existsSync(firstMatch) ? firstMatch : null;
}

export function buildProviderProcessEnv(
  homeDir: string,
  overrides: Record<string, string | undefined> = {}
): NodeJS.ProcessEnv {
  const normalizedHomeDir = path.resolve(homeDir);

  return mergeEnv(process.env, {
    HOME: normalizedHomeDir,
    USERPROFILE: normalizedHomeDir,
    APPDATA: path.resolve(normalizedHomeDir, "AppData", "Roaming"),
    LOCALAPPDATA: path.resolve(normalizedHomeDir, "AppData", "Local"),
    XDG_CONFIG_HOME: path.resolve(normalizedHomeDir, ".config"),
    XDG_STATE_HOME: path.resolve(normalizedHomeDir, ".local", "state"),
    XDG_CACHE_HOME: path.resolve(normalizedHomeDir, ".cache"),
    ...overrides
  });
}

function mergeEnv(
  base: NodeJS.ProcessEnv,
  overrides: Record<string, string | undefined>
): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete nextEnv[key];
      continue;
    }
    nextEnv[key] = value;
  }
  return nextEnv;
}
