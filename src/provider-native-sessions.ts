import type {
  AgentSession,
  SessionHistoryEntry,
  SessionHistoryFileDetail,
  SessionHistorySnapshot
} from "./shared";
import Database from "better-sqlite3";
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export interface NativeSessionSummary {
  session: AgentSession;
  cwd?: string;
  sourcePath?: string;
}

export interface NativeSessionHistory {
  session: AgentSession;
  cwd?: string;
  entries: SessionHistoryEntry[];
}

interface MutableNativeSessionSummary {
  session: AgentSession;
  cwd?: string;
  sourcePath?: string;
}

interface ClaudeHistoryToolUse {
  id: string;
  toolName: string;
  input?: Record<string, unknown>;
  raw: Record<string, unknown>;
}

interface ClaudeHistoryToolResult {
  toolUseId: string;
  isError: boolean;
  content?: unknown;
  raw: Record<string, unknown>;
}

function isCompactCompletionText(input: string): boolean {
  const normalized = input
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.。]+$/g, "")
    .toLowerCase();
  return (
    normalized === "context compressed" ||
    normalized === "context compacted" ||
    normalized === "上下文已压缩" ||
    normalized === "已压缩上下文"
  );
}

export function isMeaningfulNativeSession(session: AgentSession): boolean {
  if (session.id.startsWith("claude-draft-session_")) {
    return false;
  }

  if (hasMeaningfulText(session.lastInput) || hasMeaningfulText(session.lastOutput)) {
    return true;
  }

  const title = session.title.trim();
  return Boolean(title && title !== session.id);
}

export function listCodexNativeSessions(codexConfigDir: string): NativeSessionSummary[] {
  const codexHome = path.resolve(codexConfigDir);
  const summaries = new Map<string, MutableNativeSessionSummary>();
  const threadEntries = readCodexThreads(codexHome);
  const indexEntries = readCodexSessionIndex(codexHome);

  for (const session of scanCodexRolloutSessions(codexHome)) {
    summaries.set(session.session.id, session);
  }

  for (const [sessionId, threadEntry] of threadEntries) {
    const current = summaries.get(sessionId);
    const indexEntry = indexEntries.get(sessionId);
    const createdAt =
      threadEntry.createdAt ??
      current?.session.createdAt ??
      indexEntry?.updatedAt ??
      fallbackTimestamp();
    const updatedAt = maxTimestamp(
      threadEntry.updatedAt,
      current?.session.updatedAt,
      indexEntry?.updatedAt,
      createdAt
    );
    const indexTitleIsNewer =
      Boolean(indexEntry?.threadName) &&
      (!threadEntry.updatedAt ||
        !indexEntry?.updatedAt ||
        indexEntry.updatedAt.localeCompare(threadEntry.updatedAt) >= 0);
    const session: AgentSession = {
      id: sessionId,
      adapter: "codex",
      title: indexTitleIsNewer
        ? indexEntry?.threadName ?? threadEntry.title ?? current?.session.title ?? sessionId
        : threadEntry.title ?? indexEntry?.threadName ?? current?.session.title ?? sessionId,
      state: current?.session.state ?? "idle",
      createdAt,
      updatedAt,
      lastInput: current?.session.lastInput ?? threadEntry.firstUserMessage ?? null,
      lastOutput: current?.session.lastOutput ?? null
    };

    summaries.set(sessionId, {
      session,
      cwd: threadEntry.cwd ?? current?.cwd,
      sourcePath: threadEntry.sourcePath ?? current?.sourcePath
    });
  }

  for (const [sessionId, indexEntry] of indexEntries) {
    const current = summaries.get(sessionId);
    const updatedAt = indexEntry.updatedAt ?? current?.session.updatedAt ?? fallbackTimestamp();
    const session: AgentSession = {
      id: sessionId,
      adapter: "codex",
      title: indexEntry.threadName ?? current?.session.title ?? sessionId,
      state: current?.session.state ?? "idle",
      createdAt: current?.session.createdAt ?? updatedAt,
      updatedAt,
      lastInput: current?.session.lastInput ?? null,
      lastOutput: current?.session.lastOutput ?? null
    };

    summaries.set(sessionId, {
      session,
      cwd: current?.cwd,
      sourcePath: current?.sourcePath
    });
  }

  return Array.from(summaries.values())
    .filter((summary) => isMeaningfulNativeSession(summary.session))
    .map(cloneNativeSession)
    .sort((left, right) => right.session.updatedAt.localeCompare(left.session.updatedAt));
}

export function getCodexNativeSession(
  codexConfigDir: string,
  sessionId: string
): NativeSessionSummary | undefined {
  return listCodexNativeSessions(codexConfigDir).find((session) => session.session.id === sessionId);
}

export function listClaudeNativeSessions(claudeConfigDir: string): NativeSessionSummary[] {
  const projectsDir = path.resolve(claudeConfigDir, "projects");
  const sessions: NativeSessionSummary[] = [];

  for (const filePath of walkFiles(projectsDir, (entryPath) => entryPath.endsWith(".jsonl"))) {
    const parsed = parseClaudeSessionFile(filePath);
    if (parsed) {
      sessions.push(parsed);
    }
  }

  return sessions
    .filter((summary) => isMeaningfulNativeSession(summary.session))
    .sort((left, right) => right.session.updatedAt.localeCompare(left.session.updatedAt));
}

export function getClaudeNativeSession(
  claudeConfigDir: string,
  sessionId: string
): NativeSessionSummary | undefined {
  return listClaudeNativeSessions(claudeConfigDir).find((session) => session.session.id === sessionId);
}

export function renameCodexNativeSession(
  codexConfigDir: string,
  sessionId: string,
  title: string
): boolean {
  const normalizedTitle = title.trim();
  if (!sessionId || !normalizedTitle) {
    return false;
  }

  const codexHome = path.resolve(codexConfigDir);
  if (!existsSync(codexHome)) {
    return false;
  }

  const stateDbPath = findLatestCodexStateDbPath(codexHome);
  if (stateDbPath) {
    try {
      const database = new Database(stateDbPath);
      try {
        const result = database
          .prepare("update threads set title = ? where id = ?")
          .run(normalizedTitle, sessionId);
        if (result.changes > 0) {
          return true;
        }
      } finally {
        database.close();
      }
    } catch {
      // Fall through to the session index append below when the state database is unavailable.
    }
  }

  try {
    appendFileSync(
      path.resolve(codexHome, "session_index.jsonl"),
      `${JSON.stringify({
        id: sessionId,
        thread_name: normalizedTitle,
        updated_at: new Date().toISOString()
      })}\n`
    );
    return true;
  } catch {
    return false;
  }
}

export function renameClaudeNativeSession(
  claudeConfigDir: string,
  sessionId: string,
  title: string
): boolean {
  const normalizedTitle = title.trim();
  if (!sessionId || !normalizedTitle) {
    return false;
  }

  const summary = getClaudeNativeSession(claudeConfigDir, sessionId);
  const filePath =
    summary?.sourcePath ??
    walkFiles(
      path.resolve(claudeConfigDir, "projects"),
      (entryPath) => entryPath.endsWith(`${sessionId}.jsonl`)
    )[0];

  if (!filePath) {
    return false;
  }

  try {
    appendFileSync(
      filePath,
      `${JSON.stringify({
        type: "ai-title",
        aiTitle: normalizedTitle,
        sessionId,
        timestamp: new Date().toISOString()
      })}\n`
    );
    return true;
  } catch {
    return false;
  }
}

export function getCodexNativeHistory(
  codexConfigDir: string,
  sessionId: string,
  limit = 200
): SessionHistorySnapshot | undefined {
  const summary = getCodexNativeSession(codexConfigDir, sessionId);
  if (!summary) {
    return undefined;
  }

  const entries = listCodexSessionFiles(codexConfigDir, sessionId, summary.sourcePath)
    .flatMap((filePath) => parseCodexHistoryFile(filePath, sessionId))
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));

  return {
    session: summary.session,
    cwd: summary.cwd ?? null,
    entries: tail(entries, limit)
  };
}

export function getClaudeNativeHistory(
  claudeConfigDir: string,
  sessionId: string,
  limit = 200
): SessionHistorySnapshot | undefined {
  const summary = getClaudeNativeSession(claudeConfigDir, sessionId);
  if (!summary) {
    return undefined;
  }

  const filePath =
    summary.sourcePath ??
    walkFiles(
      path.resolve(claudeConfigDir, "projects"),
      (entryPath) => entryPath.endsWith(`${sessionId}.jsonl`)
    )[0];

  const entries = filePath
    ? parseClaudeHistoryFile(filePath, sessionId).sort((left, right) =>
        left.timestamp.localeCompare(right.timestamp)
      )
    : [];

  return {
    session: summary.session,
    cwd: summary.cwd ?? null,
    entries: tail(entries, limit)
  };
}

function scanCodexRolloutSessions(codexHome: string): MutableNativeSessionSummary[] {
  const sessionsDir = path.resolve(codexHome, "sessions");
  const summaries = new Map<string, MutableNativeSessionSummary>();

  for (const filePath of walkFiles(sessionsDir, (entryPath) => entryPath.endsWith(".jsonl"))) {
    const summary = parseCodexRolloutFile(filePath);
    if (!summary) {
      continue;
    }

    const current = summaries.get(summary.session.id);
    if (!current || current.session.updatedAt.localeCompare(summary.session.updatedAt) < 0) {
      summaries.set(summary.session.id, summary);
    }
  }

  return Array.from(summaries.values());
}

function parseCodexRolloutFile(filePath: string): MutableNativeSessionSummary | undefined {
  const lines = readJsonLines(filePath);
  let sessionId = "";
  let title = "";
  let createdAt = "";
  let updatedAt = "";
  let cwd: string | undefined;
  let firstUserInput: string | null = null;
  let firstAssistantOutput: string | null = null;
  let lastInput: string | null = null;
  let lastOutput: string | null = null;

  for (const entry of lines) {
    if (!isRecord(entry)) {
      continue;
    }

    const timestamp = normalizeTimestamp(extractString(entry.timestamp));
    if (timestamp) {
      if (!createdAt) {
        createdAt = timestamp;
      }
      updatedAt = timestamp;
    }

    const type = extractString(entry.type);
    if (type === "session_meta") {
      const payload = asRecord(entry.payload);
      const metaSessionId = extractString(payload?.id);
      if (metaSessionId) {
        sessionId = metaSessionId;
      }
      const payloadCreatedAt = normalizeTimestamp(extractString(payload?.timestamp));
      if (payloadCreatedAt) {
        createdAt = payloadCreatedAt;
      }
      cwd = extractString(payload?.cwd) ?? cwd;
      continue;
    }

    if (type === "event_msg") {
      const payload = asRecord(entry.payload);
      if (extractString(payload?.type) === "user_message") {
        const message = extractString(payload?.message);
        if (message) {
          const visibleMessage = extractDisplayedPrompt(message);
          if (visibleMessage) {
            firstUserInput = firstUserInput ?? visibleMessage;
            lastInput = visibleMessage;
          }
        }
      }
      continue;
    }

    if (type === "response_item") {
      const payload = asRecord(entry.payload);
      const role = extractString(payload?.role);
      const content = extractContentText(payload?.content);
      if (!content) {
        continue;
      }

      if (role === "user") {
        const visibleContent = extractDisplayedPrompt(content);
        if (visibleContent) {
          firstUserInput = firstUserInput ?? visibleContent;
          lastInput = visibleContent;
        }
      } else if (role === "assistant" && !isCompactCompletionText(content)) {
        firstAssistantOutput = firstAssistantOutput ?? content;
        lastOutput = content;
      }
    }
  }

  if (!sessionId) {
    return undefined;
  }

  const stats = safeStat(filePath);
  const normalizedCreatedAt = createdAt || normalizeTimestamp(stats?.birthtime.toISOString()) || fallbackTimestamp();
  const normalizedUpdatedAt =
    updatedAt ||
    normalizeTimestamp(stats?.mtime.toISOString()) ||
    normalizedCreatedAt;

  return {
    session: {
      id: sessionId,
      adapter: "codex",
      title:
        title ||
        summarizeText(firstUserInput, 80) ||
        summarizeText(firstAssistantOutput, 80) ||
        sessionId,
      state: "idle",
      createdAt: normalizedCreatedAt,
      updatedAt: normalizedUpdatedAt,
      lastInput,
      lastOutput
    },
    cwd,
    sourcePath: filePath
  };
}

function parseClaudeSessionFile(filePath: string): NativeSessionSummary | undefined {
  const lines = readJsonLines(filePath);
  const fileSessionId = path.basename(filePath, path.extname(filePath));
  let sessionId = fileSessionId;
  let title = "";
  let createdAt = "";
  let updatedAt = "";
  let cwd: string | undefined;
  let firstUserInput: string | null = null;
  let lastInput: string | null = null;
  let lastOutput: string | null = null;

  for (const entry of lines) {
    if (!isRecord(entry)) {
      continue;
    }

    const timestamp = normalizeTimestamp(extractString(entry.timestamp));
    if (timestamp) {
      if (!createdAt) {
        createdAt = timestamp;
      }
      updatedAt = timestamp;
    }

    sessionId = extractString(entry.sessionId) ?? sessionId;
    cwd = extractString(entry.cwd) ?? cwd;

    const type = extractString(entry.type);
    switch (type) {
      case "ai-title":
        title = extractString(entry.aiTitle) ?? title;
        break;
      case "last-prompt":
        lastInput = extractString(entry.lastPrompt) ?? lastInput;
        break;
      case "queue-operation":
        if (!lastInput) {
          lastInput = extractString(entry.content) ?? lastInput;
        }
        break;
      case "user": {
        const message = asRecord(entry.message);
        if (extractString(message?.role) === "user") {
          const content = extractClaudeMessageContent(message?.content);
          if (content) {
            firstUserInput = firstUserInput ?? content;
            lastInput = content;
          }
        }
        break;
      }
      case "assistant": {
        const message = asRecord(entry.message);
        if (extractString(message?.role) === "assistant") {
          lastOutput = extractClaudeMessageContent(message?.content) ?? lastOutput;
        }
        break;
      }
      default:
        break;
    }
  }

  if (!sessionId) {
    return undefined;
  }

  if (!title && !hasMeaningfulText(lastInput) && !hasMeaningfulText(lastOutput)) {
    return undefined;
  }

  const stats = safeStat(filePath);
  const normalizedCreatedAt = createdAt || normalizeTimestamp(stats?.birthtime.toISOString()) || fallbackTimestamp();
  const normalizedUpdatedAt =
    updatedAt ||
    normalizeTimestamp(stats?.mtime.toISOString()) ||
    normalizedCreatedAt;

  return {
    session: {
      id: sessionId,
      adapter: "claude",
      title: title || summarizeText(firstUserInput, 80) || sessionId,
      state: "idle",
      createdAt: normalizedCreatedAt,
      updatedAt: normalizedUpdatedAt,
      lastInput,
      lastOutput
    },
    cwd,
    sourcePath: filePath
  };
}

function parseCodexHistoryFile(filePath: string, sessionId: string): SessionHistoryEntry[] {
  if (getCodexFileSessionId(filePath) !== sessionId) {
    return [];
  }

  const entries: SessionHistoryEntry[] = [];
  let sequence = 0;
  const pendingToolCalls = new Map<
    string,
    {
      traceKey: "commandExecution" | "fileChange";
      text: string;
      details?: SessionHistoryEntry["details"];
    }
  >();

  const pushTrace = (
    timestamp: string,
    traceKey: NonNullable<SessionHistoryEntry["traceType"]>,
    text: string,
    details?: SessionHistoryEntry["details"]
  ) => {
    entries.push({
      id: `trace:${traceKey}:${buildHistoryEntryId(sessionId, filePath, sequence++)}`,
      sessionId,
      adapter: "codex",
      timestamp,
      role: "meta",
      kind: "trace",
      traceType: traceKey,
      phase: "completed",
      summary: text,
      details,
      text
    });
  };

  for (const entry of readJsonLines(filePath)) {
    if (!isRecord(entry)) {
      continue;
    }

    const timestamp = normalizeTimestamp(extractString(entry.timestamp)) ?? fallbackTimestamp();
    const type = extractString(entry.type) ?? "unknown";

    if (type === "event_msg") {
      const payload = asRecord(entry.payload);
      const eventType = extractString(payload?.type) ?? "";
      if (eventType === "task_complete") {
        const durationMs =
          typeof payload?.duration_ms === "number"
            ? payload.duration_ms
            : typeof payload?.durationMs === "number"
              ? payload.durationMs
              : null;
        if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0) {
          const durationSeconds = Math.max(1, Math.round(durationMs / 1000));
          const summary = `Processed in ${durationSeconds}s`;
          entries.push({
            id: buildHistoryEntryId(sessionId, filePath, sequence++),
            sessionId,
            adapter: "codex",
            timestamp,
            role: "meta",
            kind: "meta",
            traceType: "turnComplete",
            phase: "completed",
            durationSeconds,
            summary,
            text: summary
          });
        }
      }
      continue;
    }

    if (type !== "response_item") {
      continue;
    }

    const payload = asRecord(entry.payload);
    const payloadType = extractString(payload?.type);
    if (payloadType && payloadType !== "message") {
      if (payloadType === "web_search_call") {
        const webSearchDetails = payload ? extractWebSearchDetails(payload) : undefined;
        pushTrace(
          timestamp,
          "webSearch",
          summarizeWebSearchTrace(webSearchDetails),
          webSearchDetails
        );
      } else if (payloadType === "function_call") {
        const callId = extractString(payload?.call_id) ?? "";
        const name = extractString(payload?.name) ?? "";
        if (callId && name === "exec_command") {
          pendingToolCalls.set(callId, {
            traceKey: "commandExecution",
            text: "Ran 1 command",
            details: payload ? extractCommandDetails(payload) : undefined
          });
        }
      } else if (payloadType === "function_call_output") {
        const callId = extractString(payload?.call_id) ?? "";
        const pending = callId ? pendingToolCalls.get(callId) : undefined;
        if (pending) {
          pushTrace(timestamp, pending.traceKey, pending.text, pending.details);
          pendingToolCalls.delete(callId);
        }
      } else if (payloadType === "custom_tool_call") {
        const callId = extractString(payload?.call_id) ?? "";
        const name = extractString(payload?.name) ?? "";
        if (callId && name === "apply_patch") {
          pendingToolCalls.set(callId, {
            traceKey: "fileChange",
            text: "Edited 1 file",
            details: {
              files: parseApplyPatchFiles(extractString(payload?.input))
            }
          });
        }
      } else if (payloadType === "custom_tool_call_output") {
        const callId = extractString(payload?.call_id) ?? "";
        const pending = callId ? pendingToolCalls.get(callId) : undefined;
        if (pending) {
          const rawOutput = extractString(payload?.output);
          const summary =
            pending.traceKey === "fileChange"
              ? summarizeApplyPatchTrace(rawOutput, pending.text)
              : pending.text;
          pushTrace(timestamp, pending.traceKey, summary, pending.details);
          pendingToolCalls.delete(callId);
        }
      }
      continue;
    }

    const role = mapCodexHistoryRole(extractString(payload?.role));
    const content = extractContentText(payload?.content);
    if (!content) {
      continue;
    }

    if (role === "assistant" || role === "user") {
      const visibleContent = role === "user" ? extractDisplayedPrompt(content) : content;
      if (!visibleContent) {
        continue;
      }
      if (role === "assistant" && isCompactCompletionText(visibleContent)) {
        entries.push({
          id: `meta:compact:${buildHistoryEntryId(sessionId, filePath, sequence++)}`,
          sessionId,
          adapter: "codex",
          timestamp,
          role: "meta",
          kind: "meta",
          phase: "completed",
          summary: "Context compressed.",
          text: "Context compressed."
        });
        continue;
      }
      entries.push({
        id: buildHistoryEntryId(sessionId, filePath, sequence++),
        sessionId,
        adapter: "codex",
        timestamp,
        role,
        kind: "message",
        summary: summarizeText(visibleContent, 120),
        text: visibleContent
      });
    }
  }

  return entries;
}

function summarizeApplyPatchTrace(rawOutput: string | undefined, fallback: string): string {
  const outputBody = extractToolOutputBody(rawOutput);
  if (!outputBody) {
    return fallback;
  }

  const created = (outputBody.match(/^A\s+/gm) ?? []).length;
  const edited = (outputBody.match(/^M\s+/gm) ?? []).length;
  const deleted = (outputBody.match(/^D\s+/gm) ?? []).length;
  const parts: string[] = [];

  if (created > 0) {
    parts.push(`Created ${created} ${created === 1 ? "file" : "files"}`);
  }
  if (edited > 0) {
    parts.push(`Edited ${edited} ${edited === 1 ? "file" : "files"}`);
  }
  if (deleted > 0) {
    parts.push(`Deleted ${deleted} ${deleted === 1 ? "file" : "files"}`);
  }

  return parts.length > 0 ? parts.join(" | ") : fallback;
}

function extractToolOutputBody(rawOutput: string | undefined): string | undefined {
  if (!rawOutput) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(rawOutput) as { output?: unknown };
    if (typeof parsed.output === "string" && parsed.output.trim()) {
      return parsed.output;
    }
  } catch {
    // Ignore and fall back to the raw string body.
  }

  return rawOutput;
}

function extractCommandDetails(payload: Record<string, unknown>): SessionHistoryEntry["details"] {
  const details = {} as SessionHistoryEntry["details"] & {
    commands?: Array<{ command: string; cwd?: string | null }>;
  };
  const argumentsPayload = extractString(payload.arguments);
  if (argumentsPayload) {
    try {
      const parsed = JSON.parse(argumentsPayload) as Record<string, unknown>;
      if (typeof parsed.cmd === "string" && parsed.cmd.trim()) {
        details.commands = [
          {
            command: parsed.cmd.trim(),
            ...(typeof parsed.workdir === "string" && parsed.workdir.trim()
              ? { cwd: parsed.workdir.trim() }
              : {})
          }
        ];
      }
    } catch {
      // Ignore malformed arguments and fall back to raw payload.
    }
  }

  if (!details.commands) {
    const cmd =
      extractString(payload.cmd) ??
      extractString(payload.command) ??
      extractString(payload.commandLine);
    if (cmd?.trim()) {
      const cwd = extractString(payload.cwd) ?? extractString(payload.workdir);
      details.commands = [
        {
          command: cmd.trim(),
          ...(cwd?.trim() ? { cwd: cwd.trim() } : {})
        }
      ];
    }
  }

  return Object.keys(details).length > 0 ? details : undefined;
}

function extractWebSearchUrls(
  payload: Record<string, unknown>
): Array<{ url: string; title?: string | null }> | undefined {
  const urls = new Map<string, { url: string; title?: string | null }>();
  for (const candidate of walkRecordStrings(payload)) {
    const normalized = candidate.trim();
    if (/^https?:\/\//i.test(normalized)) {
      urls.set(normalized, { url: normalized });
    }
  }
  return urls.size > 0 ? [...urls.values()] : undefined;
}

function extractWebSearchDetails(payload: Record<string, unknown>): SessionHistoryEntry["details"] | undefined {
  const action = asRecord(payload.action);
  const urls = extractWebSearchUrls(payload);
  const queryValues = new Set<string>();
  const directQuery = extractString(action?.query);
  if (directQuery?.trim()) {
    queryValues.add(directQuery.trim());
  }
  const queries = action?.queries;
  if (Array.isArray(queries)) {
    for (const item of queries) {
      if (typeof item === "string" && item.trim()) {
        queryValues.add(item.trim());
      }
    }
  }

  const details = {} as SessionHistoryEntry["details"] & {
    queries?: string[];
  };
  if (urls && urls.length > 0) {
    details.urls = urls;
  }
  if (queryValues.size > 0) {
    details.queries = [...queryValues];
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

function summarizeWebSearchTrace(details?: SessionHistoryEntry["details"]): string {
  const typedDetails = details as (SessionHistoryEntry["details"] & { queries?: string[] }) | undefined;
  const urlCount = typedDetails?.urls?.length ?? 0;
  const queryCount = typedDetails?.queries?.length ?? 0;
  if (urlCount > 0 && queryCount > 0) {
    return `Searched the web ${queryCount} ${queryCount === 1 ? "time" : "times"} | Browsed ${urlCount} ${urlCount === 1 ? "page" : "pages"}`;
  }
  if (urlCount > 0) {
    return `Browsed ${urlCount} ${urlCount === 1 ? "page" : "pages"}`;
  }
  if (queryCount > 0) {
    return `Searched the web ${queryCount} ${queryCount === 1 ? "time" : "times"}`;
  }
  return "Searched the web once";
}

function parseApplyPatchFiles(input: string | undefined): SessionHistoryFileDetail[] {
  if (!input) {
    return [];
  }

  const files: SessionHistoryFileDetail[] = [];
  let current: SessionHistoryFileDetail | null = null;
  for (const line of input.split(/\r?\n/)) {
    const addMatch = line.match(/^\*\*\* Add File:\s+(.+)$/);
    if (addMatch) {
      current = { path: addMatch[1].trim(), added: 0, removed: 0, status: "created" };
      files.push(current);
      continue;
    }
    const updateMatch = line.match(/^\*\*\* Update File:\s+(.+)$/);
    if (updateMatch) {
      current = { path: updateMatch[1].trim(), added: 0, removed: 0, status: "edited" };
      files.push(current);
      continue;
    }
    const deleteMatch = line.match(/^\*\*\* Delete File:\s+(.+)$/);
    if (deleteMatch) {
      current = { path: deleteMatch[1].trim(), added: 0, removed: 0, status: "deleted" };
      files.push(current);
      continue;
    }
    if (!current) {
      continue;
    }
    if (/^\+\+\+|^---|^\*\*\*/.test(line)) {
      continue;
    }
    if (line.startsWith("+")) {
      current.added = (current.added ?? 0) + 1;
    } else if (line.startsWith("-")) {
      current.removed = (current.removed ?? 0) + 1;
    }
  }

  return files;
}

function walkRecordStrings(value: unknown, depth = 0): string[] {
  if (depth > 4 || value == null) {
    return [];
  }
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => walkRecordStrings(item, depth + 1));
  }
  if (typeof value !== "object") {
    return [];
  }
  return Object.values(value as Record<string, unknown>).flatMap((item) =>
    walkRecordStrings(item, depth + 1)
  );
}

function parseClaudeHistoryFile(filePath: string, sessionId: string): SessionHistoryEntry[] {
  const entries: SessionHistoryEntry[] = [];
  let sequence = 0;
  let lastKnownTimestamp = fallbackTimestamp();
  const pendingToolUses = new Map<string, ClaudeHistoryToolUse>();

  const pushToolTrace = (
    timestamp: string,
    toolUse: ClaudeHistoryToolUse,
    result?: ClaudeHistoryToolResult
  ) => {
    const traceType = normalizeClaudeHistoryTraceType(toolUse.toolName);
    if (!traceType) {
      return;
    }
    const details = buildClaudeHistoryToolDetails(toolUse.toolName, toolUse.input, result?.raw);
    const summary = summarizeClaudeHistoryToolTrace(traceType, details, result?.isError);
    entries.push({
      id: `trace:${traceType}:${toolUse.id}:${buildHistoryEntryId(sessionId, filePath, sequence++)}`,
      sessionId,
      adapter: "claude",
      timestamp,
      role: "meta",
      kind: "trace",
      traceType,
      phase: "completed",
      summary,
      details,
      text: summary
    });
  };

  for (const entry of readJsonLines(filePath)) {
    if (!isRecord(entry)) {
      continue;
    }

    const entrySessionId = extractString(entry.sessionId);
    if (entrySessionId && entrySessionId !== sessionId) {
      continue;
    }

    const timestamp = normalizeTimestamp(extractString(entry.timestamp)) ?? lastKnownTimestamp;
    lastKnownTimestamp = timestamp;
    const type = extractString(entry.type) ?? "unknown";

    switch (type) {
      case "user": {
        const message = asRecord(entry.message);
        for (const toolResult of extractClaudeHistoryToolResults(message?.content)) {
          const pending = pendingToolUses.get(toolResult.toolUseId);
          if (pending) {
            pushToolTrace(timestamp, pending, toolResult);
            pendingToolUses.delete(toolResult.toolUseId);
          }
        }
        const content = extractClaudeMessageContent(message?.content);
        if (content) {
          entries.push({
            id: buildHistoryEntryId(sessionId, filePath, sequence++),
            sessionId,
            adapter: "claude",
            timestamp,
            role: "user",
            kind: "message",
            summary: summarizeText(content, 120),
            text: content
          });
        }
        break;
      }
      case "assistant": {
        const message = asRecord(entry.message);
        for (const toolUse of extractClaudeHistoryToolUses(message?.content)) {
          pendingToolUses.set(toolUse.id, toolUse);
        }
        const content = extractClaudeMessageContent(message?.content);
        if (content) {
          entries.push({
            id: buildHistoryEntryId(sessionId, filePath, sequence++),
            sessionId,
            adapter: "claude",
            timestamp,
            role: "assistant",
            kind: "message",
            summary: summarizeText(content, 120),
            text: content
          });
        }
        break;
      }
      default:
        break;
    }
  }

  for (const pending of pendingToolUses.values()) {
    pushToolTrace(lastKnownTimestamp, pending);
  }

  return entries;
}

function walkFiles(rootDir: string, include: (filePath: string) => boolean): string[] {
  if (!existsSync(rootDir)) {
    return [];
  }

  const files: string[] = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.resolve(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (entry.isFile() && include(entryPath)) {
        files.push(entryPath);
      }
    }
  }

  return files;
}

function listCodexSessionFiles(
  codexConfigDir: string,
  sessionId: string,
  preferredPath?: string
): string[] {
  const files = new Set<string>();
  if (preferredPath && getCodexFileSessionId(preferredPath) === sessionId) {
    files.add(preferredPath);
  }

  const sessionsDir = path.resolve(codexConfigDir, "sessions");
  for (const filePath of walkFiles(sessionsDir, (entryPath) => entryPath.endsWith(".jsonl"))) {
    if (getCodexFileSessionId(filePath) === sessionId) {
      files.add(filePath);
    }
  }

  return Array.from(files).sort();
}

function readCodexThreads(
  codexHome: string
): Map<
  string,
  {
    title?: string;
    createdAt?: string;
    updatedAt?: string;
    cwd?: string;
    sourcePath?: string;
    firstUserMessage?: string;
  }
> {
  const stateDbPath = findLatestCodexStateDbPath(codexHome);
  if (!stateDbPath) {
    return new Map();
  }

  try {
    const database = new Database(stateDbPath, { readonly: true, fileMustExist: true });
    const rows = database
      .prepare(
        `
          select
            id,
            rollout_path,
            created_at,
            updated_at,
            cwd,
            title,
            first_user_message
          from threads
          where archived = 0
        `
      )
      .all() as Array<{
      id: string;
      rollout_path?: string | null;
      created_at?: number | null;
      updated_at?: number | null;
      cwd?: string | null;
      title?: string | null;
      first_user_message?: string | null;
    }>;
    database.close();

    const threads = new Map<
      string,
      {
        title?: string;
        createdAt?: string;
        updatedAt?: string;
        cwd?: string;
        sourcePath?: string;
        firstUserMessage?: string;
      }
    >();

    for (const row of rows) {
      if (!row.id) {
        continue;
      }

      threads.set(row.id, {
        title: row.title ?? undefined,
        createdAt: normalizeUnixTimestamp(row.created_at),
        updatedAt: normalizeUnixTimestamp(row.updated_at),
        cwd: normalizeProviderPath(row.cwd ?? undefined),
        sourcePath: normalizeProviderPath(row.rollout_path ?? undefined),
        firstUserMessage: row.first_user_message
          ? extractDisplayedPrompt(row.first_user_message)
          : undefined
      });
    }

    return threads;
  } catch {
    return new Map();
  }
}

function findLatestCodexStateDbPath(codexHome: string): string | undefined {
  if (!existsSync(codexHome)) {
    return undefined;
  }

  const candidates = readdirSync(codexHome)
    .filter((entry) => /^state_\d+\.sqlite$/i.test(entry))
    .map((entry) => path.resolve(codexHome, entry))
    .map((filePath) => ({ filePath, stats: safeStat(filePath) }))
    .filter((entry): entry is { filePath: string; stats: NonNullable<ReturnType<typeof safeStat>> } =>
      Boolean(entry.stats)
    )
    .sort((left, right) => right.stats.mtimeMs - left.stats.mtimeMs);

  return candidates[0]?.filePath;
}

function readCodexSessionIndex(
  codexHome: string
): Map<string, { threadName?: string; updatedAt?: string }> {
  const sessions = new Map<string, { threadName?: string; updatedAt?: string }>();
  const indexPath = path.resolve(codexHome, "session_index.jsonl");

  for (const entry of readJsonLines(indexPath)) {
    if (!isRecord(entry)) {
      continue;
    }

    const sessionId = extractString(entry.id);
    if (!sessionId) {
      continue;
    }

    const current = sessions.get(sessionId);
    const nextThreadName = extractString(entry.thread_name) ?? current?.threadName;
    const nextUpdatedAt = normalizeTimestamp(extractString(entry.updated_at)) ?? current?.updatedAt;
    const currentUpdatedAt = current?.updatedAt ?? fallbackTimestamp();

    if (!current || (nextUpdatedAt ?? fallbackTimestamp()).localeCompare(currentUpdatedAt) >= 0) {
      sessions.set(sessionId, {
        threadName: nextThreadName,
        updatedAt: nextUpdatedAt
      });
    }
  }

  return sessions;
}

function getCodexFileSessionId(filePath: string): string | undefined {
  for (const entry of readJsonLines(filePath)) {
    if (!isRecord(entry) || extractString(entry.type) !== "session_meta") {
      continue;
    }

    const payload = asRecord(entry.payload);
    const sessionId = extractString(payload?.id);
    if (sessionId) {
      return sessionId;
    }
  }

  return undefined;
}

function readJsonLines(filePath: string): unknown[] {
  if (!existsSync(filePath)) {
    return [];
  }

  const raw = readFileSync(filePath, "utf8");
  const values: unknown[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      values.push(JSON.parse(trimmed) as unknown);
    } catch {
      // Provider-owned files may contain partial or future lines. Ignore what we cannot parse.
    }
  }

  return values;
}

function extractContentText(content: unknown): string | null {
  if (!Array.isArray(content)) {
    return null;
  }

  const parts = content
    .map((item) => {
      if (!isRecord(item)) {
        return "";
      }
      if (typeof item.text === "string" && item.text) {
        return item.text;
      }
      if (typeof item.input_text === "string" && item.input_text) {
        return item.input_text;
      }
      return "";
    })
    .filter(Boolean);

  return parts.length > 0 ? parts.join("\n").trim() : null;
}

function extractClaudeMessageContent(content: unknown): string | null {
  if (typeof content === "string" && content.trim()) {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const parts = content
    .map((item) => {
      if (!isRecord(item)) {
        return "";
      }
      if (extractString(item.type) === "text" && typeof item.text === "string") {
        return item.text;
      }
      return "";
    })
    .filter(Boolean);

  return parts.length > 0 ? parts.join("\n").trim() : null;
}

function extractClaudeHistoryToolUses(content: unknown): ClaudeHistoryToolUse[] {
  if (!Array.isArray(content)) {
    return [];
  }

  return content
    .map((item): ClaudeHistoryToolUse | null => {
      if (!isRecord(item)) {
        return null;
      }
      const type = extractString(item.type);
      if (type !== "tool_use" && type !== "server_tool_use" && type !== "mcp_tool_use") {
        return null;
      }
      const id =
        extractString(item.id) ??
        extractString(item.tool_use_id) ??
        extractString(item.toolUseId);
      const toolName =
        extractString(item.name) ??
        extractString(item.tool_name) ??
        extractString(item.toolName) ??
        type;
      if (!id || !toolName) {
        return null;
      }
      const input =
        item.input && typeof item.input === "object" && !Array.isArray(item.input)
          ? (item.input as Record<string, unknown>)
          : undefined;
      return {
        id,
        toolName,
        ...(input ? { input } : {}),
        raw: item
      };
    })
    .filter((value): value is ClaudeHistoryToolUse => Boolean(value));
}

function extractClaudeHistoryToolResults(content: unknown): ClaudeHistoryToolResult[] {
  if (!Array.isArray(content)) {
    return [];
  }

  return content
    .map((item): ClaudeHistoryToolResult | null => {
      if (!isRecord(item)) {
        return null;
      }
      const type = extractString(item.type);
      if (
        type !== "tool_result" &&
        type !== "mcp_tool_result" &&
        !type?.endsWith("_tool_result")
      ) {
        return null;
      }
      const toolUseId =
        extractString(item.tool_use_id) ??
        extractString(item.toolUseId) ??
        extractString(item.id);
      if (!toolUseId) {
        return null;
      }
      return {
        toolUseId,
        isError: item.is_error === true || item.isError === true,
        ...(item.content !== undefined ? { content: item.content } : {}),
        raw: item
      };
    })
    .filter((value): value is ClaudeHistoryToolResult => Boolean(value));
}

function normalizeClaudeHistoryTraceType(
  toolName: string
): NonNullable<SessionHistoryEntry["traceType"]> | null {
  if (/^(bash|local_command)$/i.test(toolName) || /command/i.test(toolName)) {
    return "commandExecution";
  }
  if (/web[-_]?search|web[-_]?fetch/i.test(toolName)) {
    return "webSearch";
  }
  if (["Edit", "MultiEdit", "Write", "NotebookEdit", "filesystem"].includes(toolName)) {
    return "fileChange";
  }
  return "toolCall";
}

function buildClaudeHistoryToolDetails(
  toolName: string,
  input?: unknown,
  result?: unknown
): SessionHistoryEntry["details"] | undefined {
  const details = {} as SessionHistoryEntry["details"] & {
    commands?: Array<{ command: string; cwd?: string | null }>;
    queries?: string[];
  };
  const traceType = normalizeClaudeHistoryTraceType(toolName);

  if (traceType === "commandExecution") {
    const commands = collectClaudeHistoryCommands(input);
    if (commands.length > 0) {
      details.commands = commands;
    }
  }
  if (traceType === "webSearch") {
    const urls = extractWebSearchUrls({ input, result });
    const queries = collectClaudeHistoryQueries(input);
    if (urls && urls.length > 0) {
      details.urls = urls;
    }
    if (queries.length > 0) {
      details.queries = queries;
    }
  }
  if (traceType === "fileChange") {
    const files = collectClaudeHistoryFiles(toolName, input, result);
    if (files.length > 0) {
      details.files = files;
    }
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

function collectClaudeHistoryCommands(
  ...values: unknown[]
): Array<{ command: string; cwd?: string | null }> {
  const commands = new Map<string, { command: string; cwd?: string | null }>();
  for (const value of values) {
    const cwd = collectClaudeHistoryCwd(value);
    for (const command of walkPreferredRecordStrings(value, ["cmd", "command", "commandLine"])) {
      const normalized = command.trim();
      if (normalized && !commands.has(normalized)) {
        commands.set(normalized, {
          command: normalized,
          ...(cwd ? { cwd } : {})
        });
      }
    }
  }
  return [...commands.values()];
}

function collectClaudeHistoryQueries(...values: unknown[]): string[] {
  const queries = new Set<string>();
  for (const value of values) {
    for (const query of walkPreferredRecordStrings(value, ["query"])) {
      const normalized = query.trim();
      if (normalized) {
        queries.add(normalized);
      }
    }
  }
  return [...queries];
}

function collectClaudeHistoryFiles(
  toolName: string,
  input?: unknown,
  result?: unknown
): SessionHistoryFileDetail[] {
  if (!["Edit", "MultiEdit", "Write", "NotebookEdit", "filesystem"].includes(toolName)) {
    return [];
  }
  const files = new Map<string, SessionHistoryFileDetail>();
  for (const value of [input, result]) {
    const record = asRecord(value);
    if (!record) {
      continue;
    }
    for (const pathValue of extractClaudeHistoryFilePaths(record)) {
      files.set(pathValue, {
        path: pathValue,
        status: "edited"
      });
    }
  }
  return [...files.values()];
}

function extractClaudeHistoryFilePaths(input: Record<string, unknown>): string[] {
  const candidates = [
    input.file_path,
    input.filePath,
    input.path,
    input.filename
  ];
  const files: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      files.push(candidate.trim());
    }
  }
  if (Array.isArray(input.files)) {
    for (const item of input.files) {
      if (typeof item === "string" && item.trim()) {
        files.push(item.trim());
        continue;
      }
      const nested = asRecord(item);
      const candidate = extractString(nested?.filename) ?? extractString(nested?.path);
      if (candidate?.trim()) {
        files.push(candidate.trim());
      }
    }
  }
  return Array.from(new Set(files));
}

function collectClaudeHistoryCwd(value: unknown): string | null {
  for (const cwd of walkPreferredRecordStrings(value, ["cwd", "workdir", "workingDirectory"])) {
    const normalized = cwd.trim();
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function walkPreferredRecordStrings(
  value: unknown,
  preferredKeys: string[],
  depth = 0
): string[] {
  if (depth > 4 || value == null) {
    return [];
  }
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => walkPreferredRecordStrings(item, preferredKeys, depth + 1));
  }
  if (!isRecord(value)) {
    return [];
  }
  const outputs: string[] = [];
  for (const key of preferredKeys) {
    const candidate = value[key];
    if (typeof candidate === "string") {
      outputs.push(candidate);
    }
  }
  for (const nested of Object.values(value)) {
    outputs.push(...walkPreferredRecordStrings(nested, preferredKeys, depth + 1));
  }
  return outputs;
}

function summarizeClaudeHistoryToolTrace(
  traceType: NonNullable<SessionHistoryEntry["traceType"]>,
  details?: SessionHistoryEntry["details"],
  isError?: boolean
): string {
  if (isError) {
    return "Tool call failed";
  }
  switch (traceType) {
    case "commandExecution": {
      const count = details?.commands?.length || 1;
      return `Ran ${count} ${count === 1 ? "command" : "commands"}`;
    }
    case "webSearch":
      return summarizeWebSearchTrace(details);
    case "fileChange":
      return summarizeClaudeFileTrace(details);
    case "imageView":
      return "Viewed image";
    case "toolCall":
    default:
      return "Completed tool calls";
  }
}

function summarizeClaudeFileTrace(details?: SessionHistoryEntry["details"]): string {
  const files = details?.files ?? [];
  if (files.length === 0) {
    return "Edited 1 file";
  }
  const created = files.filter((file) => file.status === "created").length;
  const deleted = files.filter((file) => file.status === "deleted").length;
  const edited = files.length - created - deleted;
  const parts: string[] = [];
  if (created > 0) {
    parts.push(`Created ${created} ${created === 1 ? "file" : "files"}`);
  }
  if (edited > 0) {
    parts.push(`Edited ${edited} ${edited === 1 ? "file" : "files"}`);
  }
  if (deleted > 0) {
    parts.push(`Deleted ${deleted} ${deleted === 1 ? "file" : "files"}`);
  }
  return parts.join(" | ") || "Edited 1 file";
}

function cloneNativeSession(summary: MutableNativeSessionSummary): NativeSessionSummary {
  return {
    session: { ...summary.session },
    cwd: summary.cwd,
    sourcePath: summary.sourcePath
  };
}

function tail<T>(values: T[], limit: number): T[] {
  const safeLimit = Math.max(1, Math.min(limit, 500));
  return values.slice(Math.max(values.length - safeLimit, 0));
}

function buildHistoryEntryId(sessionId: string, filePath: string, sequence: number): string {
  const fileName = path.basename(filePath, path.extname(filePath));
  return `${sessionId}:${fileName}:${sequence}`;
}

function summarizeText(value: string | null | undefined, maxLength: number): string {
  if (!value) {
    return "";
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }

  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

function hasMeaningfulText(value: string | null | undefined): boolean {
  return Boolean(value && value.trim());
}

function normalizeProviderPath(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return value.replace(/^\\\\\?\\/, "");
}

function maxTimestamp(...values: Array<string | undefined>): string {
  return values
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => right.localeCompare(left))[0] ?? fallbackTimestamp();
}

function extractDisplayedPrompt(value: string): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return normalized;
  }

  const stripped = normalized
    .replace(/^# AGENTS\.md instructions[\s\S]*?<\/INSTRUCTIONS>\s*/i, "")
    .replace(/^<environment_context>[\s\S]*?<\/environment_context>\s*/i, "")
    .trim();

  let visible = stripped;

  for (const marker of [
    "## My request for Codex:",
    "## My request for Claude:",
    "## My request:"
  ]) {
    const markerIndex = visible.indexOf(marker);
    if (markerIndex >= 0) {
      visible = visible.slice(markerIndex + marker.length).trim();
      break;
    }
  }

  if (!visible) {
    if (
      /^# AGENTS\.md instructions[\s\S]*<\/INSTRUCTIONS>\s*$/i.test(normalized) ||
      /^<environment_context>[\s\S]*<\/environment_context>\s*$/i.test(normalized)
    ) {
      return "";
    }
    return normalized;
  }

  return visible;
}

function normalizeTimestamp(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function normalizeUnixTimestamp(value: number | null | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return new Date(value * 1000).toISOString();
}

function fallbackTimestamp(): string {
  return new Date(0).toISOString();
}

function safeStat(filePath: string) {
  try {
    return statSync(filePath);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function mapCodexHistoryRole(role: string | undefined): SessionHistoryEntry["role"] {
  switch (role) {
    case "assistant":
      return "assistant";
    case "user":
      return "user";
    case "developer":
    case "system":
      return "system";
    default:
      return "unknown";
  }
}

function extractString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
