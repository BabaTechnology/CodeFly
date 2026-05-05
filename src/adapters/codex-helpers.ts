import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  nowIso,
  type AgentSession,
  type ChoiceAnswer,
  type ChoiceOption,
  type ChoiceRequest,
  type ProviderCommandOption,
  type ProviderModelOption,
  type ProviderQuotaSnapshot,
  type ProviderReasoningEffortOption,
  type ProviderRuntimeMetadata,
  type SessionCompressionSnapshot,
  type SessionHistoryEntryDetails,
  type SessionHistoryFileDetail,
  type SessionMetricsSnapshot,
  type SessionUsageSnapshot
} from "../shared";
import { requireProviderRuntimeExecutable } from "../provider-runtime";
import { maxTimestamp } from "./discovered-session";

interface CodexThreadMetricsRow {
  model?: string | null;
  reasoningEffort?: string | null;
  tokensUsed?: number | null;
  rolloutPath?: string | null;
  updatedAt?: string | null;
}

interface CodexRolloutUsageInfo {
  timestamp: string;
  modelContextWindow?: number | null;
  totalTokenUsage?: {
    inputTokens?: number | null;
    cachedInputTokens?: number | null;
    outputTokens?: number | null;
    reasoningOutputTokens?: number | null;
    totalTokens?: number | null;
  } | null;
  lastTokenUsage?: {
    inputTokens?: number | null;
    cachedInputTokens?: number | null;
    outputTokens?: number | null;
    reasoningOutputTokens?: number | null;
    totalTokens?: number | null;
  } | null;
  raw?: unknown;
}

interface CodexContextUsageLogInfo {
  timestamp: string;
  estimatedTokenCount?: number | null;
  totalUsageTokens?: number | null;
  autoCompactLimit?: number | null;
  tokenLimitReached?: boolean | null;
  needsFollowUp?: boolean | null;
  turnId?: string | null;
  raw?: string;
}

export function readCodexSessionMetrics(
  codexConfigDir: string,
  sessionId: string,
  preferredRolloutPath?: string
): SessionMetricsSnapshot | undefined {
  const codexHome = path.resolve(codexConfigDir);
  const threadRow = readCodexThreadMetricsRow(codexHome, sessionId);
  const rolloutPath = preferredRolloutPath ?? threadRow?.rolloutPath ?? undefined;
  const rolloutUsage = rolloutPath ? readCodexRolloutUsageInfo(rolloutPath) : undefined;
  const contextUsage = readLatestCodexContextUsageLog(codexHome, sessionId);
  const compression = deriveCodexCompressionState(rolloutUsage, contextUsage, codexHome, sessionId);

  const contextWindowTokens =
    rolloutUsage?.modelContextWindow ??
    contextUsage?.autoCompactLimit ??
    undefined;
  const usedContextWindowTokens = contextUsage?.estimatedTokenCount ?? undefined;
  const contextUsagePercentage =
    contextWindowTokens && usedContextWindowTokens != null
      ? Math.max(0, Math.min(100, (usedContextWindowTokens / contextWindowTokens) * 100))
      : undefined;

  const totalUsage = rolloutUsage?.totalTokenUsage;
  const usageUpdatedAt = maxTimestamp(
    rolloutUsage?.timestamp ?? "",
    contextUsage?.timestamp ?? "",
    threadRow?.updatedAt ?? ""
  );

  const usage: SessionUsageSnapshot | null =
    totalUsage ||
    threadRow?.tokensUsed != null ||
    contextWindowTokens != null ||
    usedContextWindowTokens != null
      ? {
          provider: "codex",
          model: threadRow?.model ?? null,
          totalTokens: totalUsage?.totalTokens ?? threadRow?.tokensUsed ?? undefined,
          inputTokens: totalUsage?.inputTokens ?? undefined,
          outputTokens: totalUsage?.outputTokens ?? undefined,
          cacheCreationInputTokens: undefined,
          cacheReadInputTokens: totalUsage?.cachedInputTokens ?? undefined,
          cachedTokens: totalUsage?.cachedInputTokens ?? undefined,
          reasoningTokens: totalUsage?.reasoningOutputTokens ?? undefined,
          contextWindowTokens,
          usedContextWindowTokens,
          contextUsagePercentage,
          updatedAt: usageUpdatedAt,
          raw: {
            rolloutUsage,
            contextUsage,
            threadRow
          }
        }
      : null;

  if (!usage && !compression) {
    return undefined;
  }

  return {
    usage,
    compression
  };
}

function readCodexThreadMetricsRow(
  codexHome: string,
  sessionId: string
): CodexThreadMetricsRow | undefined {
  const dbPath = findLatestCodexDatabasePath(codexHome, "state");
  if (!dbPath || !existsSync(dbPath)) {
    return undefined;
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        `select
          model as model,
          reasoning_effort as reasoningEffort,
          tokens_used as tokensUsed,
          rollout_path as rolloutPath,
          updated_at as updatedAt
         from threads
         where id = ?`
      )
      .get(sessionId) as
      | {
          model?: string | null;
          reasoningEffort?: string | null;
          tokensUsed?: number | null;
          rolloutPath?: string | null;
          updatedAt?: number | null;
        }
      | undefined;
    if (!row) {
      return undefined;
    }
    return {
      model: row.model ?? null,
      reasoningEffort: row.reasoningEffort ?? null,
      tokensUsed: row.tokensUsed ?? null,
      rolloutPath: row.rolloutPath ?? null,
      updatedAt: unixSecondsToIso(row.updatedAt)
    };
  } finally {
    db.close();
  }
}

function readCodexRolloutUsageInfo(rolloutPath: string): CodexRolloutUsageInfo | undefined {
  if (!rolloutPath || !existsSync(rolloutPath)) {
    return undefined;
  }

  let latestTokenCount: CodexRolloutUsageInfo | undefined;
  let latestTaskStartedWindow: number | undefined;
  let latestTaskStartedTimestamp = "";

  const lines = readFileSync(rolloutPath, "utf8").split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }
    const entry = parseJsonRecord(line);
    if (!entry || entry.type !== "event_msg") {
      continue;
    }
    const payload = toRecord(entry.payload);
    const payloadType = extractString(payload?.type);
    const timestamp = normalizeIsoTimestamp(extractString(entry.timestamp));
    if (payloadType === "token_count" && !latestTokenCount) {
      const info = toRecord(payload?.info);
      const total = toRecord(info?.total_token_usage);
      const last = toRecord(info?.last_token_usage);
      latestTokenCount = {
        timestamp: timestamp ?? nowIso(),
        modelContextWindow: extractInteger(info?.model_context_window),
        totalTokenUsage: {
          inputTokens: extractInteger(total?.input_tokens),
          cachedInputTokens: extractInteger(total?.cached_input_tokens),
          outputTokens: extractInteger(total?.output_tokens),
          reasoningOutputTokens: extractInteger(total?.reasoning_output_tokens),
          totalTokens: extractInteger(total?.total_tokens)
        },
        lastTokenUsage: {
          inputTokens: extractInteger(last?.input_tokens),
          cachedInputTokens: extractInteger(last?.cached_input_tokens),
          outputTokens: extractInteger(last?.output_tokens),
          reasoningOutputTokens: extractInteger(last?.reasoning_output_tokens),
          totalTokens: extractInteger(last?.total_tokens)
        },
        raw: payload
      };
      if (latestTaskStartedWindow != null) {
        break;
      }
      continue;
    }
    if (payloadType === "task_started" && latestTaskStartedWindow == null) {
      latestTaskStartedWindow = extractInteger(payload?.model_context_window) ?? undefined;
      latestTaskStartedTimestamp = timestamp ?? latestTaskStartedTimestamp;
      if (latestTokenCount) {
        break;
      }
    }
  }

  if (latestTokenCount) {
    if (latestTokenCount.modelContextWindow == null && latestTaskStartedWindow != null) {
      latestTokenCount.modelContextWindow = latestTaskStartedWindow;
    }
    return latestTokenCount;
  }

  if (latestTaskStartedWindow == null) {
    return undefined;
  }

  return {
    timestamp: latestTaskStartedTimestamp || nowIso(),
    modelContextWindow: latestTaskStartedWindow,
    totalTokenUsage: null,
    lastTokenUsage: null,
    raw: null
  };
}

function readLatestCodexContextUsageLog(
  codexHome: string,
  sessionId: string
): CodexContextUsageLogInfo | undefined {
  const dbPath = findLatestCodexDatabasePath(codexHome, "logs");
  if (!dbPath || !existsSync(dbPath)) {
    return undefined;
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        `select ts, feedback_log_body as body
         from logs
         where feedback_log_body like @postSampling
           and (
             target = 'codex_core::session::turn'
             or target = 'codex_core::codex'
           )
           and (
             thread_id = @threadId
             or feedback_log_body like @threadIdAttr
             or feedback_log_body like @threadIdTag
           )
         order by ts desc, ts_nanos desc, id desc
         limit 1`
      )
      .get({
        postSampling: "%post sampling token usage turn_id=%",
        threadId: sessionId,
        threadIdAttr: `%thread_id=${sessionId}%`,
        threadIdTag: `%thread.id=${sessionId}%`
      }) as { ts?: number; body?: string } | undefined;

    if (!row?.body) {
      return undefined;
    }

    const estimatedTokenMatch = row.body.match(/estimated_token_count=(?:Some\((\d+)\)|None)/);
    const totalUsageMatch = row.body.match(/total_usage_tokens=(\d+)/);
    const autoCompactLimitMatch = row.body.match(/auto_compact_limit=(\d+)/);
    const tokenLimitReachedMatch = row.body.match(/token_limit_reached=(true|false)/);
    const needsFollowUpMatch = row.body.match(/needs_follow_up=(true|false)/);
    const turnIdMatch = row.body.match(/turn_id=([0-9a-f-]+)/);

    return {
      timestamp: unixSecondsToIso(row.ts) ?? nowIso(),
      estimatedTokenCount: estimatedTokenMatch?.[1] ? Number(estimatedTokenMatch[1]) : null,
      totalUsageTokens: totalUsageMatch?.[1] ? Number(totalUsageMatch[1]) : null,
      autoCompactLimit: autoCompactLimitMatch?.[1] ? Number(autoCompactLimitMatch[1]) : null,
      tokenLimitReached:
        tokenLimitReachedMatch?.[1] != null ? tokenLimitReachedMatch[1] === "true" : null,
      needsFollowUp:
        needsFollowUpMatch?.[1] != null ? needsFollowUpMatch[1] === "true" : null,
      turnId: turnIdMatch?.[1] ?? null,
      raw: row.body
    };
  } finally {
    db.close();
  }
}

function deriveCodexCompressionState(
  rolloutUsage: CodexRolloutUsageInfo | undefined,
  contextUsage: CodexContextUsageLogInfo | undefined,
  codexHome: string,
  sessionId: string
): SessionCompressionSnapshot | null {
  const compactRequest = readLatestCodexCompactRequest(codexHome, sessionId);
  if (!compactRequest && !contextUsage?.tokenLimitReached) {
    return null;
  }

  const latestProgressTs = Math.max(
    isoToUnixSeconds(rolloutUsage?.timestamp),
    isoToUnixSeconds(contextUsage?.timestamp)
  );
  const compactRequestTs = isoToUnixSeconds(compactRequest?.timestamp);

  if (contextUsage?.tokenLimitReached === true) {
    return {
      provider: "codex",
      state: "compressing",
      summary: "Compressing context…",
      updatedAt: contextUsage.timestamp,
      raw: {
        compactRequest,
        contextUsage
      }
    };
  }

  if (compactRequest && compactRequestTs >= latestProgressTs) {
    return {
      provider: "codex",
      state: "compressing",
      summary: "Compressing context…",
      updatedAt: compactRequest.timestamp,
      raw: {
        compactRequest,
        contextUsage
      }
    };
  }

  if (compactRequest) {
    return {
      provider: "codex",
      state: "compressed",
      summary: "Context compressed.",
      updatedAt:
        contextUsage?.timestamp && isoToUnixSeconds(contextUsage.timestamp) > compactRequestTs
          ? contextUsage.timestamp
          : compactRequest.timestamp,
      raw: {
        compactRequest,
        contextUsage
      }
    };
  }

  return null;
}

function readLatestCodexCompactRequest(
  codexHome: string,
  sessionId: string
): { timestamp: string; raw: string } | undefined {
  const dbPath = findLatestCodexDatabasePath(codexHome, "logs");
  if (!dbPath || !existsSync(dbPath)) {
    return undefined;
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        `select ts, feedback_log_body as body
         from logs
         where target = 'codex_client::transport'
           and feedback_log_body like @compactPath
           and (
             feedback_log_body like @threadIdAttr
             or feedback_log_body like @threadIdTag
           )
         order by ts desc
         limit 1`
      )
      .get({
        compactPath: "%responses/compact%",
        threadIdAttr: `%thread_id=${sessionId}%`,
        threadIdTag: `%thread.id=${sessionId}%`
      }) as { ts?: number; body?: string } | undefined;

    if (!row?.body) {
      return undefined;
    }

    return {
      timestamp: unixSecondsToIso(row.ts) ?? nowIso(),
      raw: row.body
    };
  } finally {
    db.close();
  }
}

function findLatestCodexDatabasePath(
  codexHome: string,
  kind: "state" | "logs"
): string | undefined {
  if (!existsSync(codexHome)) {
    return undefined;
  }
  const prefix = kind === "state" ? "state_" : "logs_";
  const candidates = readdirSync(codexHome)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".sqlite"))
    .sort((left, right) => extractCodexDbSuffix(right) - extractCodexDbSuffix(left));
  const selected = candidates[0];
  return selected ? path.join(codexHome, selected) : undefined;
}

function extractCodexDbSuffix(name: string): number {
  const match = name.match(/_(\d+)\.sqlite$/);
  return match?.[1] ? Number(match[1]) : 0;
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return toRecord(parsed);
  } catch {
    return undefined;
  }
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function extractInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
  }
  return null;
}

function normalizeIsoTimestamp(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function unixSecondsToIso(value: number | null | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return new Date(value * 1000).toISOString();
}

function isoToUnixSeconds(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed / 1000) : 0;
}

export function buildCodexToolDetails(
  toolName: string,
  input?: unknown,
  result?: unknown
): SessionHistoryEntryDetails | undefined {
  const details = {} as SessionHistoryEntryDetails & {
    commands?: Array<{ command: string; cwd?: string | null }>;
    urls?: Array<{ url: string; title?: string | null }>;
    queries?: string[];
  };
  if (isCodexCommandTool(toolName)) {
    const commands = collectCommands(input, result);
    if (commands.length > 0) {
      details.commands = commands;
    }
  } else if (isCodexWebSearchTool(toolName)) {
    const urls = collectUrls(input, result).filter((item) => !isInternalCodexToolValue(item.url));
    const queries = collectQueries(input, result).filter((item) => !isInternalCodexToolValue(item));
    if (urls.length > 0) {
      details.urls = urls;
    }
    if (queries.length > 0) {
      details.queries = queries;
    }
  } else if (isCodexFileChangeTool(toolName)) {
    const files = collectFileDetails(input, result);
    if (files.length > 0) {
      details.files = files;
    }
  }

  return Object.keys(details).length > 0 ? details : undefined;
}

function isCodexCommandTool(toolName: string): boolean {
  const normalized = toolName.trim();
  return (
    normalized === "commandExecution" ||
    normalized === "Bash" ||
    /command/i.test(normalized) ||
    normalized === "local_command"
  );
}

function isCodexFileChangeTool(toolName: string): boolean {
  const normalized = toolName.trim();
  return (
    normalized === "fileChange" ||
    normalized === "filesystem" ||
    ["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(normalized)
  );
}

function isCodexWebSearchTool(toolName: string): boolean {
  const normalized = toolName.trim();
  const compact = normalized.replace(/[-_]/g, "").toLowerCase();
  return (
    normalized.includes("webSearch") ||
    /^ws_[a-z0-9]+$/i.test(normalized) ||
    compact.includes("websearch") ||
    compact === "search"
  );
}

function isInternalCodexToolValue(value: string): boolean {
  const normalized = value.trim();
  const compact = normalized.replace(/[-_]/g, "").toLowerCase();
  return (
    !normalized ||
    /^ws_[a-z0-9]+$/i.test(normalized) ||
    normalized === "webSearch" ||
    compact === "websearch" ||
    normalized === "search" ||
    normalized === "other"
  );
}

function collectCommands(...values: unknown[]): Array<{ command: string; cwd?: string | null }> {
  const commands = new Map<string, { command: string; cwd?: string | null }>();
  for (const value of values) {
    const cwd = collectCwd(value);
    for (const candidate of walkStrings(value, ["cmd", "command", "commandLine"])) {
      const normalized = candidate.trim();
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

function collectUrls(...values: unknown[]): Array<{ url: string; title?: string | null }> {
  const urls = new Map<string, { url: string; title?: string | null }>();
  for (const value of values) {
    for (const candidate of walkStrings(value, ["url", "uri", "href"])) {
      const normalized = candidate.trim();
      if (/^https?:\/\//i.test(normalized) && !urls.has(normalized)) {
        urls.set(normalized, { url: normalized });
      }
    }
    for (const candidate of walkStrings(value)) {
      const normalized = candidate.trim();
      if (/^https?:\/\//i.test(normalized) && !urls.has(normalized)) {
        urls.set(normalized, { url: normalized });
      }
    }
  }
  return [...urls.values()];
}

function collectQueries(...values: unknown[]): string[] {
  const queries = new Set<string>();
  for (const value of values) {
    for (const candidate of walkStrings(value, ["query"])) {
      const normalized = candidate.trim();
      if (normalized) {
        queries.add(normalized);
      }
    }
  }
  return [...queries];
}

function collectCwd(...values: unknown[]): string | null {
  for (const value of values) {
    for (const candidate of walkStrings(value, ["cwd", "workdir", "workingDirectory"])) {
      const normalized = candidate.trim();
      if (normalized) {
        return normalized;
      }
    }
  }
  return null;
}

function collectFileDetails(...values: unknown[]): SessionHistoryFileDetail[] {
  const files = new Map<string, SessionHistoryFileDetail>();
  for (const value of values) {
    if (Array.isArray((value as Record<string, unknown> | undefined)?.changes)) {
      const changes = (value as { changes: Array<Record<string, unknown>> }).changes;
      for (const change of changes) {
        const pathValue =
          extractString(change.path) ?? extractString(change.filePath) ?? extractString(change.filename);
        if (!pathValue) {
          continue;
        }
        const diff = extractString(change.diff) ?? "";
        const counts = countDiffLines(diff);
        files.set(pathValue, {
          path: pathValue,
          added: counts.added,
          removed: counts.removed,
          status: deriveFileStatus(change)
        });
      }
      continue;
    }

    for (const pathValue of walkStrings(value, ["path", "filePath", "filename"])) {
      const normalized = pathValue.trim();
      if (!normalized || normalized.length < 2 || (!normalized.includes("/") && !normalized.includes("\\"))) {
        continue;
      }
      if (!files.has(normalized)) {
        files.set(normalized, {
          path: normalized,
          status: "unknown"
        });
      }
    }
  }
  return [...files.values()];
}

function countDiffLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (/^\+\+\+/.test(line) || /^---/.test(line)) {
      continue;
    }
    if (line.startsWith("+")) {
      added += 1;
    } else if (line.startsWith("-")) {
      removed += 1;
    }
  }
  return { added, removed };
}

function deriveFileStatus(change: Record<string, unknown>): SessionHistoryFileDetail["status"] {
  const status = extractString(change.status)?.toLowerCase();
  if (status === "created" || status === "edited" || status === "deleted") {
    return status;
  }
  if (typeof change.created === "boolean" && change.created) {
    return "created";
  }
  if (typeof change.deleted === "boolean" && change.deleted) {
    return "deleted";
  }
  return "edited";
}

function walkStrings(value: unknown, preferredKeys?: string[], depth = 0): string[] {
  if (depth > 4 || value == null) {
    return [];
  }
  if (typeof value === "string") {
    return preferredKeys ? [] : [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => walkStrings(item, preferredKeys, depth + 1));
  }
  if (typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  const outputs: string[] = [];
  if (preferredKeys) {
    for (const key of preferredKeys) {
      const candidate = record[key];
      if (typeof candidate === "string") {
        outputs.push(candidate);
      }
    }
  }
  for (const candidate of Object.values(record)) {
    outputs.push(...walkStrings(candidate, preferredKeys, depth + 1));
  }
  return outputs;
}

function extractString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function extractModelContextWindow(record: Record<string, unknown>): number | null {
  const candidates = [
    record.contextWindowTokens,
    record.context_window_tokens,
    record.contextWindow,
    record.context_window,
    record.modelContextWindow,
    record.model_context_window,
    record.maxTokens,
    record.max_tokens
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
      return candidate;
    }
  }
  return null;
}

export function modelsResponseHasError(value: unknown): value is { error: Error } {
  return Boolean(
    value &&
      typeof value === "object" &&
      "error" in value &&
      (value as { error?: unknown }).error instanceof Error
  );
}

export function normalizeCodexModels(response: unknown): ProviderModelOption[] {
  const data = Array.isArray((response as { data?: unknown })?.data)
    ? ((response as { data: unknown[] }).data)
    : [];

  return data
    .map((entry): ProviderModelOption | null => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return null;
      }
      const record = entry as Record<string, unknown>;
      const id = extractString(record.id) ?? extractString(record.model);
      if (!id) {
        return null;
      }
      const reasoningEfforts = normalizeCodexReasoningEfforts(record.supportedReasoningEfforts);
      return {
        id,
        label: extractString(record.displayName) ?? id,
        description: extractString(record.description) ?? null,
        status: extractString(record.upgrade) ? `upgrade:${String(record.upgrade)}` : null,
        contextWindowTokens: extractModelContextWindow(record),
        recommended: Boolean(record.isDefault),
        deprecated: Boolean(record.upgrade),
        hidden: Boolean(record.hidden),
        isDefault: Boolean(record.isDefault),
        reasoningEfforts
      };
    })
    .filter((entry): entry is ProviderModelOption => Boolean(entry));
}

function normalizeCodexReasoningEfforts(input: unknown): ProviderReasoningEffortOption[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .map((entry): ProviderReasoningEffortOption | null => {
      if (typeof entry === "string") {
        return { id: entry };
      }
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return null;
      }
      const record = entry as Record<string, unknown>;
      const id = extractString(record.reasoningEffort) ?? extractString(record.id);
      if (!id) {
        return null;
      }
      return {
        id,
        description: extractString(record.description) ?? null
      };
    })
    .filter((entry): entry is ProviderReasoningEffortOption => Boolean(entry));
}

export function normalizeCodexCommands(response: unknown): ProviderCommandOption[] {
  const responseRecord =
    response && typeof response === "object" && !Array.isArray(response)
      ? (response as Record<string, unknown>)
      : {};
  const dataRecord =
    responseRecord.data && typeof responseRecord.data === "object" && !Array.isArray(responseRecord.data)
      ? (responseRecord.data as Record<string, unknown>)
      : null;
  const groups = Array.isArray(responseRecord.data)
    ? responseRecord.data
    : dataRecord && Array.isArray(dataRecord.skills)
      ? [dataRecord]
      : Array.isArray(responseRecord.skills)
        ? [responseRecord]
        : [];
  const commands = new Map<string, ProviderCommandOption>();

  for (const group of groups) {
    if (!group || typeof group !== "object" || Array.isArray(group)) {
      continue;
    }
    const skills = Array.isArray((group as { skills?: unknown }).skills)
      ? ((group as { skills: unknown[] }).skills)
      : [];
    for (const skill of skills) {
      if (!skill || typeof skill !== "object" || Array.isArray(skill)) {
        continue;
      }
      const record = skill as Record<string, unknown>;
      if (record.enabled === false) {
        continue;
      }
      const name = extractString(record.name)?.replace(/^\/+/, "");
      if (!name || commands.has(name)) {
        continue;
      }
      const skillInterface =
        record.interface && typeof record.interface === "object" && !Array.isArray(record.interface)
          ? (record.interface as Record<string, unknown>)
          : {};
      const displayName = extractString(skillInterface.displayName);
      const shortDescription =
        extractString(skillInterface.shortDescription) ??
        extractString(record.shortDescription) ??
        extractString(record.short_description);
      commands.set(name, {
        id: name,
        label: displayName ? `/${name} · ${displayName}` : `/${name}`,
        description: shortDescription ?? extractString(record.description) ?? null,
        argumentHint: null,
        aliases: [],
        source: "codex_skill"
      });
    }
  }

  return Array.from(commands.values()).sort((left, right) => left.id.localeCompare(right.id));
}

export function getCodexDefaultReasoningEffort(response: unknown, modelId: string): string | undefined {
  const data = Array.isArray((response as { data?: unknown })?.data)
    ? ((response as { data: unknown[] }).data)
    : [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const id = extractString(record.id) ?? extractString(record.model);
    if (id === modelId) {
      return extractString(record.defaultReasoningEffort);
    }
  }
  return undefined;
}

export function normalizeCodexAccount(response: unknown): ProviderRuntimeMetadata["account"] {
  const record = response && typeof response === "object" ? (response as Record<string, unknown>) : {};
  const account = record.account && typeof record.account === "object"
    ? (record.account as Record<string, unknown>)
    : null;
  if (!account) {
    return {
      kind: "none",
      requiresAuth: Boolean(record.requiresOpenaiAuth),
      raw: response
    };
  }

  const type = extractString(account.type);
  if (type === "apiKey") {
    return { kind: "api_key", requiresAuth: Boolean(record.requiresOpenaiAuth), raw: response };
  }
  if (type === "chatgpt") {
    return {
      kind: "chatgpt",
      email: extractString(account.email) ?? null,
      planType: extractString(account.planType) ?? null,
      requiresAuth: Boolean(record.requiresOpenaiAuth),
      raw: response
    };
  }
  if (type === "amazonBedrock") {
    return { kind: "amazon_bedrock", requiresAuth: false, raw: response };
  }
  return { kind: "external_provider", requiresAuth: Boolean(record.requiresOpenaiAuth), raw: response };
}

export function normalizeCodexQuota(response: unknown): ProviderQuotaSnapshot | null {
  const record = response && typeof response === "object" ? (response as Record<string, unknown>) : {};
  const snapshot = record.rateLimits && typeof record.rateLimits === "object"
    ? (record.rateLimits as Record<string, unknown>)
    : null;
  if (!snapshot) {
    return null;
  }
  return {
    status: extractString(snapshot.rateLimitReachedType) ?? null,
    rateLimitType: extractString(snapshot.limitName) ?? extractString(snapshot.limitId) ?? null,
    primary: normalizeCodexQuotaWindow(snapshot.primary),
    secondary: normalizeCodexQuotaWindow(snapshot.secondary),
    credits: normalizeCodexCredits(snapshot.credits),
    limitsById:
      record.rateLimitsByLimitId && typeof record.rateLimitsByLimitId === "object"
        ? (record.rateLimitsByLimitId as Record<string, unknown>)
        : null,
    raw: response
  };
}

function normalizeCodexQuotaWindow(input: unknown): ProviderQuotaSnapshot["primary"] {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const record = input as Record<string, unknown>;
  const resetsAt = typeof record.resetsAt === "number" ? record.resetsAt : null;
  return {
    usedPercent: typeof record.usedPercent === "number" ? record.usedPercent : null,
    windowDurationMinutes:
      typeof record.windowDurationMins === "number" ? record.windowDurationMins : null,
    resetAt: resetsAt ? new Date(resetsAt * 1000).toISOString() : null
  };
}

function normalizeCodexCredits(input: unknown): ProviderQuotaSnapshot["credits"] {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const record = input as Record<string, unknown>;
  return {
    hasCredits: typeof record.hasCredits === "boolean" ? record.hasCredits : null,
    unlimited: typeof record.unlimited === "boolean" ? record.unlimited : null,
    balance: extractString(record.balance) ?? null
  };
}

export function resolveCodexBinary(): string {
  return requireProviderRuntimeExecutable("codex");
}

export function buildApprovalPrompt(method: string, params: Record<string, unknown>): string {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return [
        `Command approval requested.`,
        params.command ? `Command: ${String(params.command)}` : null,
        params.cwd ? `CWD: ${String(params.cwd)}` : null,
        params.reason ? `Reason: ${String(params.reason)}` : null
      ]
        .filter(Boolean)
        .join("\n");
    case "item/fileChange/requestApproval": {
      const changes = params.changes as Array<Record<string, unknown>> | undefined;
      const files = Array.isArray(changes)
        ? changes.map((change) => String(change.path ?? "")).filter(Boolean)
        : [];
      return [
        "File change approval requested.",
        files.length > 0 ? `Files: ${files.join(", ")}` : null,
        params.reason ? `Reason: ${String(params.reason)}` : null
      ]
        .filter(Boolean)
        .join("\n");
    }
    case "item/permissions/requestApproval":
      return [
        "Additional permissions requested.",
        params.reason ? `Reason: ${String(params.reason)}` : null,
        params.permissions ? `Permissions: ${JSON.stringify(params.permissions)}` : null
      ]
        .filter(Boolean)
        .join("\n");
    default:
      return `Approval requested for ${method}`;
  }
}

export function buildApprovalResult(
  method: string,
  params: Record<string, unknown>,
  decision: "approve" | "deny"
): unknown {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return {
        decision: decision === "approve" ? "accept" : "cancel"
      };
    case "item/fileChange/requestApproval":
      return {
        decision: decision === "approve" ? "accept" : "cancel"
      };
    case "item/permissions/requestApproval":
      return {
        permissions: decision === "approve" ? params.permissions ?? {} : {},
        scope: "turn"
      };
    default:
      return {
        decision: decision === "approve" ? "accept" : "cancel"
      };
  }
}

export function mapCodexTurnStatus(turn: unknown): AgentSession["state"] {
  const status = String((turn as { status?: string } | undefined)?.status ?? "");
  switch (status) {
    case "completed":
      return "idle";
    case "interrupted":
      return "interrupted";
    case "failed":
      return "error";
    case "inProgress":
      return "running";
    default:
      return "idle";
  }
}

export function mapCodexThreadStatus(status: unknown): AgentSession["state"] {
  const type = String((status as { type?: string } | undefined)?.type ?? "");
  const activeFlags = Array.isArray((status as { activeFlags?: unknown[] } | undefined)?.activeFlags)
    ? ((status as { activeFlags?: unknown[] }).activeFlags ?? []).map(String)
    : [];

  if (type === "active") {
    if (activeFlags.includes("waitingOnApproval")) {
      return "awaiting_approval";
    }
    if (activeFlags.includes("waitingOnInput") || activeFlags.includes("waitingOnChoice")) {
      return "awaiting_choice";
    }
    return "running";
  }
  if (type === "systemError") {
    return "error";
  }
  if (type === "idle") {
    return "idle";
  }
  return "idle";
}

export function extractCodexSessionId(params: Record<string, unknown>): string | undefined {
  const value = params.threadId ?? params.conversationId ?? params.session_id;
  return typeof value === "string" && value ? value : undefined;
}

export function inferCodexToolName(method: string, params: Record<string, unknown>): string {
  if (method.includes("commandExecution")) {
    return "commandExecution";
  }
  if (method.includes("fileChange")) {
    return "fileChange";
  }
  if (method.includes("permissions")) {
    return "permissions";
  }
  if (typeof params.toolName === "string" && params.toolName) {
    return params.toolName;
  }
  return method;
}

export function extractCodexItemId(item: Record<string, unknown>): string | undefined {
  const id = item.id ?? item.itemId ?? item.callId ?? item.toolCallId;
  if (typeof id === "string" || typeof id === "number") {
    const normalized = String(id).trim();
    return normalized || undefined;
  }
  return undefined;
}

export function shouldEmitCodexProviderEvent(method: string): boolean {
  if (method.startsWith("item/")) {
    return false;
  }
  if (method === "thread/tokenUsage/updated" || method === "turn/diff/updated") {
    return false;
  }
  return true;
}

export function sanitizeCodexProviderEventParams(
  method: string,
  params: Record<string, unknown>
): Record<string, unknown> {
  if (method === "turn/started") {
    return {
      threadId: params.threadId,
      turnId: params.turnId,
      turn: sanitizeCodexTurn(params.turn)
    };
  }
  if (method === "turn/completed") {
    return {
      threadId: params.threadId,
      turnId: params.turnId,
      turn: sanitizeCodexTurn(params.turn)
    };
  }
  if (method === "thread/status/changed") {
    return {
      threadId: params.threadId,
      status: params.status
    };
  }
  return {
    threadId: params.threadId,
    sessionId: params.sessionId,
    status: params.status
  };
}

function sanitizeCodexTurn(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const turn = value as Record<string, unknown>;
  return {
    id: turn.id ?? turn.turnId,
    status: turn.status,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    durationMs: turn.durationMs
  };
}

export function sanitizeCodexItemForToolEvent(item: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {
    id: extractCodexItemId(item),
    type: item.type,
    status: item.status
  };
  for (const key of ["command", "cmd", "cwd", "workdir", "workingDirectory", "query", "url", "uri"]) {
    const value = item[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      sanitized[key] = value;
    }
  }
  for (const key of ["exitCode", "exit_code", "durationMs", "duration_ms"]) {
    const value = item[key];
    if (typeof value === "number") {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

export function isCodexTraceableItemType(itemType: string): boolean {
  const normalized = itemType.trim();
  return (
    normalized === "commandExecution" ||
    normalized === "fileChange" ||
    normalized === "imageView" ||
    normalized === "mcpToolCall" ||
    normalized === "collabToolCall" ||
    isCodexWebSearchTool(normalized)
  );
}

export function describeCodexItemActivity(item: Record<string, unknown>): {
  summary: string;
  activityLabel: string;
} {
  const itemType = String(item.type ?? "");
  if (isCodexWebSearchTool(itemType)) {
    return {
      summary: "Codex started browsing the web.",
      activityLabel: "Browsing the web"
    };
  }
  switch (itemType) {
    case "reasoning":
      return {
        summary: "Codex started reasoning.",
        activityLabel: "Thinking"
      };
    case "commandExecution":
      return {
        summary: "Codex started running a command.",
        activityLabel: "Running command"
      };
    case "fileChange":
      return {
        summary: "Codex started editing files.",
        activityLabel: "Editing files"
      };
    case "imageView":
      return {
        summary: "Codex started viewing an image.",
        activityLabel: "Viewing image"
      };
    case "mcpToolCall":
    case "collabToolCall":
      return {
        summary: "Codex started using a tool.",
        activityLabel: "Using tool"
      };
    case "plan":
      return {
        summary: "Codex started updating the plan.",
        activityLabel: "Updating plan"
      };
    case "agentMessage":
      return {
        summary: "Codex started composing a reply.",
        activityLabel: "Composing reply"
      };
    default:
      return {
        summary: `Codex started item ${itemType}.`,
        activityLabel: "Working"
      };
  }
}

export function buildCodexChoiceRequest(
  sessionId: string,
  method: string,
  params: Record<string, unknown>,
  requestId: number
): ChoiceRequest | undefined {
  if (Array.isArray(params.questions) && params.questions.length > 0) {
    const fields = params.questions.flatMap((question, index) =>
      buildChoiceFieldsFromQuestion(question as Record<string, unknown>, index)
    );
    if (fields.length === 0) {
      return undefined;
    }
    return {
      id: `${method}:${requestId}`,
      sessionId,
      prompt: extractCodexChoicePrompt(method, params),
      fields,
      status: "pending",
      createdAt: nowIso(),
      handledAt: null
    };
  }

  const options = Array.isArray(params.options) ? params.options : undefined;
  const prompt = extractCodexChoicePrompt(method, params);
  if (!options || options.length === 0 || !prompt) {
    return undefined;
  }

  return {
    id: `${method}:${requestId}`,
    sessionId,
    prompt,
    fields: [
      {
        id: "selection",
        header: "Choice",
        prompt,
        kind: "single_select",
        required: true,
        options: options
          .map((option, index) => toChoiceOption(option as Record<string, unknown>, `option_${index}`))
          .filter((option): option is NonNullable<typeof option> => Boolean(option))
      }
    ],
    status: "pending",
    createdAt: nowIso(),
    handledAt: null
  };
}

function buildChoiceFieldsFromQuestion(
  question: Record<string, unknown>,
  index: number
): ChoiceRequest["fields"] {
  const prompt = typeof question.question === "string" ? question.question : "";
  if (!prompt) {
    return [];
  }

  const header =
    typeof question.header === "string" && question.header ? question.header : `Question ${index + 1}`;
  const options = Array.isArray(question.options)
    ? question.options
        .map((option, optionIndex) =>
          toChoiceOption(option as Record<string, unknown>, `${index}_option_${optionIndex}`)
        )
        .filter((option): option is NonNullable<typeof option> => Boolean(option))
    : [];

  if (options.length === 0) {
    return [];
  }

  return [
    {
      id: typeof question.id === "string" && question.id ? question.id : `question_${index}`,
      header,
      prompt,
      kind: question.multiSelect ? "multi_select" : "single_select",
      required: true,
      options
    }
  ];
}

function toChoiceOption(
  option: Record<string, unknown>,
  fallbackId: string
): ChoiceOption | undefined {
  const label = typeof option.label === "string" ? option.label : typeof option.value === "string" ? option.value : "";
  if (!label) {
    return undefined;
  }

  return {
    id:
      typeof option.id === "string" && option.id
        ? option.id
        : typeof option.value === "string" && option.value
          ? option.value
          : fallbackId,
    label,
    description: typeof option.description === "string" ? option.description : null,
    preview: typeof option.preview === "string" ? option.preview : null
  };
}

function extractCodexChoicePrompt(method: string, params: Record<string, unknown>): string {
  const promptCandidates = [params.prompt, params.question, params.message, params.title];
  for (const candidate of promptCandidates) {
    if (typeof candidate === "string" && candidate) {
      return candidate;
    }
  }
  return `Codex requested input for ${method}`;
}

export function buildChoiceResult(
  _method: string,
  params: Record<string, unknown>,
  answers: ChoiceAnswer[]
): unknown {
  const answerByFieldId = new Map(answers.map((answer) => [answer.fieldId, answer.value]));
  const questions = Array.isArray(params.questions) ? params.questions : [];

  if (questions.length > 0) {
    return {
      answers: questions.map((question, index) => {
        const typedQuestion = question as Record<string, unknown>;
        const fieldId =
          typeof typedQuestion.id === "string" && typedQuestion.id
            ? typedQuestion.id
            : `question_${index}`;
        return {
          questionId: fieldId,
          value: answerByFieldId.get(fieldId) ?? null
        };
      })
    };
  }

  if (answerByFieldId.has("selection")) {
    return {
      answer: answerByFieldId.get("selection") ?? null
    };
  }

  return {
    answers
  };
}

export function buildCodexPlanUpdate(method: string, params: Record<string, unknown>) {
  if (!method.toLowerCase().includes("plan")) {
    return undefined;
  }

  const itemsSource = Array.isArray(params.items)
    ? params.items
    : Array.isArray(params.steps)
      ? params.steps
      : [];

  const items = itemsSource.map((item, index) => {
    const typedItem = item as Record<string, unknown>;
    return {
      id:
        typeof typedItem.id === "string" && typedItem.id ? typedItem.id : `step_${index + 1}`,
      label:
        typeof typedItem.label === "string" && typedItem.label
          ? typedItem.label
          : typeof typedItem.title === "string" && typedItem.title
            ? typedItem.title
            : `Plan step ${index + 1}`,
      status: typeof typedItem.status === "string" ? typedItem.status : null,
      details:
        typeof typedItem.details === "string"
          ? typedItem.details
          : typeof typedItem.description === "string"
            ? typedItem.description
            : null
    };
  });

  return {
    provider: "codex",
    summary:
      typeof params.summary === "string" && params.summary
        ? params.summary
        : `Codex emitted ${method}.`,
    items,
    raw: params
  };
}
