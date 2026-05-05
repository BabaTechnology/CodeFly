import { execFile } from "node:child_process";
import {
  nowIso,
  randomId,
  type AgentSession,
  type ChoiceAnswer,
  type ChoiceField,
  type ChoiceOption,
  type ChoiceRequest,
  type ProviderCommandOption,
  type ProviderModelOption,
  type ProviderQuotaSnapshot,
  type ProviderReasoningEffortOption,
  type ProviderRuntimeMetadata,
  type SessionHistoryEntryDetails,
  type SessionHistoryFileDetail,
  type SessionModelUsageSnapshot,
  type SessionUsageSnapshot
} from "../shared";
import { requireProviderRuntimeExecutable } from "../provider-runtime";
import type { NativeSessionSummary } from "../provider-native-sessions";
import { isLiveSessionState } from "./discovered-session";

interface ClaudePermissionOptions {
  signal?: AbortSignal;
  title?: string;
  description?: string;
  displayName?: string;
  decisionReason?: string;
  blockedPath?: string;
  toolUseID?: string;
}

interface ClaudeSessionRuntimeLike {
  session: AgentSession;
  cwd?: string;
}

interface ClaudeObservedToolUse {
  id: string;
  toolName: string;
  input?: Record<string, unknown>;
  raw: Record<string, unknown>;
}

interface ClaudeToolResultBlock {
  toolUseId: string;
  isError: boolean;
  content?: unknown;
  raw: Record<string, unknown>;
}

export function shouldSuppressDiscoveredSession(
  discovered: NativeSessionSummary,
  runtimes: ClaudeSessionRuntimeLike[]
): boolean {
  return runtimes.some((runtime) => isMatchingLiveDraft(runtime, discovered));
}

function isMatchingLiveDraft(
  runtime: ClaudeSessionRuntimeLike,
  discovered: NativeSessionSummary
): boolean {
  if (!runtime.session.id.startsWith("claude-draft-session_")) {
    return false;
  }

  if (!isLiveSessionState(runtime.session.state)) {
    return false;
  }

  if (!runtime.session.lastInput || !discovered.session.lastInput) {
    return false;
  }

  if (runtime.session.lastInput.trim() !== discovered.session.lastInput.trim()) {
    return false;
  }

  const runtimeCreatedAt = Date.parse(runtime.session.createdAt);
  const discoveredCreatedAt = Date.parse(discovered.session.createdAt);
  if (Number.isNaN(runtimeCreatedAt) || Number.isNaN(discoveredCreatedAt)) {
    return false;
  }

  return Math.abs(discoveredCreatedAt - runtimeCreatedAt) <= 30_000;
}

export function buildClaudeDraftSessionId(): string {
  return `claude-draft-${randomId("session")}`;
}

export function resolveClaudeBinary(): string {
  return requireProviderRuntimeExecutable("claude");
}

export function normalizeClaudeModels(input: unknown): ProviderModelOption[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .map((entry): ProviderModelOption | null => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return null;
      }
      const record = entry as Record<string, unknown>;
      const id = extractString(record.value) ?? extractString(record.id);
      if (!id) {
        return null;
      }
      const reasoningEfforts = normalizeClaudeReasoningEfforts(record);
      const contextWindowTokens = inferClaudeModelContextWindow(record, id);
      return {
        id,
        label: extractString(record.displayName) ?? id,
        description: extractString(record.description) ?? null,
        contextWindowTokens,
        recommended: id === "sonnet" || id.includes("sonnet"),
        reasoningEfforts
      };
    })
    .filter((entry): entry is ProviderModelOption => Boolean(entry));
}

function inferClaudeModelContextWindow(record: Record<string, unknown>, id: string): number | null {
  const candidates = [
    record.contextWindowTokens,
    record.context_window_tokens,
    record.contextWindow,
    record.context_window,
    record.maxTokens,
    record.max_tokens
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
      return candidate;
    }
  }
  const normalizedId = id.toLowerCase();
  if (normalizedId.includes("[1m]") || normalizedId.includes("1m")) {
    return 1_000_000;
  }
  if (
    normalizedId.includes("claude") ||
    normalizedId.includes("sonnet") ||
    normalizedId.includes("opus") ||
    normalizedId.includes("haiku")
  ) {
    return 200_000;
  }
  return null;
}

function normalizeClaudeReasoningEfforts(record: Record<string, unknown>): ProviderReasoningEffortOption[] {
  if (Array.isArray(record.supportedEffortLevels)) {
    return record.supportedEffortLevels
      .map((entry) => (typeof entry === "string" ? ({ id: entry } satisfies ProviderReasoningEffortOption) : null))
      .filter((entry): entry is ProviderReasoningEffortOption => Boolean(entry));
  }
  if (record.supportsEffort === false) {
    return [];
  }
  return ["low", "medium", "high", "xhigh", "max"].map((id) => ({ id }));
}

export function normalizeClaudeCommands(input: unknown): ProviderCommandOption[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const commands = new Map<string, ProviderCommandOption>();
  for (const entry of input) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const name = (extractString(record.name) ?? extractString(record.id))?.replace(/^\/+/, "");
    if (!name || commands.has(name)) {
      continue;
    }
    const argumentHint = extractString(record.argumentHint) ?? extractString(record.argument_hint);
    const aliases = Array.isArray(record.aliases)
      ? record.aliases.filter((alias): alias is string => typeof alias === "string" && alias.trim().length > 0)
      : [];
    commands.set(name, {
      id: name,
      label: `/${name}${argumentHint ? ` ${argumentHint}` : ""}`,
      description: extractString(record.description) ?? null,
      argumentHint: argumentHint ?? null,
      aliases,
      source: "claude_command"
    });
  }
  return Array.from(commands.values()).sort((left, right) => left.id.localeCompare(right.id));
}

export function normalizeClaudeAccount(input: unknown): ProviderRuntimeMetadata["account"] {
  const record = input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
  if (extractString(record.error)) {
    return { kind: "unknown", raw: input };
  }
  return {
    kind: extractString(record.email) || extractString(record.subscriptionType)
      ? "claude_account"
      : extractString(record.apiProvider) && record.apiProvider !== "firstParty"
        ? "external_provider"
        : "none",
    email: extractString(record.email) ?? null,
    organization: extractString(record.organization) ?? null,
    subscriptionType: extractString(record.subscriptionType) ?? null,
    tokenSource: extractString(record.tokenSource) ?? null,
    apiKeySource: extractString(record.apiKeySource) ?? null,
    apiProvider: extractString(record.apiProvider) ?? null,
    raw: input
  };
}

export function normalizeClaudeQuota(input: Record<string, unknown>): ProviderQuotaSnapshot {
  const resetsAt = typeof input.resetsAt === "number" ? input.resetsAt : null;
  const resetAtMs = resetsAt ? (resetsAt < 10_000_000_000 ? resetsAt * 1000 : resetsAt) : null;
  return {
    status: extractString(input.status) ?? null,
    utilizationPercent:
      typeof input.utilization === "number" ? Math.round(input.utilization * 100) : null,
    resetAt: resetAtMs ? new Date(resetAtMs).toISOString() : null,
    rateLimitType: extractString(input.rateLimitType) ?? null,
    raw: input
  };
}

export function mapClaudeSessionState(state: unknown): AgentSession["state"] {
  switch (String(state ?? "")) {
    case "running":
      return "running";
    case "requires_action":
      return "awaiting_approval";
    case "idle":
    default:
      return "idle";
  }
}

export function buildClaudeApprovalPrompt(
  toolName: string,
  input: Record<string, unknown>,
  options: ClaudePermissionOptions
): string {
  return [
    options.title ?? `Claude wants to use ${toolName}.`,
    options.description ?? null,
    options.decisionReason ? `Reason: ${options.decisionReason}` : null,
    options.blockedPath ? `Path: ${options.blockedPath}` : null,
    Object.keys(input).length > 0 ? `Input: ${JSON.stringify(input, null, 2)}` : null
  ]
    .filter(Boolean)
    .join("\n");
}

export function extractClaudeStreamChunk(event: unknown): string {
  if (!event || typeof event !== "object") {
    return "";
  }

  const typedEvent = event as {
    delta?: { text?: unknown };
    text?: unknown;
    content_block?: { text?: unknown };
  };

  if (typeof typedEvent.delta?.text === "string") {
    return typedEvent.delta.text;
  }
  if (typeof typedEvent.text === "string") {
    return typedEvent.text;
  }
  if (typeof typedEvent.content_block?.text === "string") {
    return typedEvent.content_block.text;
  }
  return "";
}

export function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function asBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  return null;
}

export function readClaudeUsageFromMessage(
  message: Record<string, unknown>
): Partial<SessionUsageSnapshot> | null {
  const event = message.event as Record<string, unknown> | undefined;
  const messageRecord = message.message as Record<string, unknown> | undefined;
  const eventMessage = event?.message as Record<string, unknown> | undefined;
  const eventDelta = event?.delta as Record<string, unknown> | undefined;
  const usage = [
    message.usage,
    messageRecord?.usage,
    event?.usage,
    eventMessage?.usage,
    eventDelta?.usage,
    eventDelta?.usage_delta
  ].find((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate)) as
    | Record<string, unknown>
    | undefined;
  if (!usage || typeof usage !== "object") {
    return null;
  }

  const inputTokens = asNumber(usage.input_tokens) ?? asNumber(usage.inputTokens);
  const outputTokens = asNumber(usage.output_tokens) ?? asNumber(usage.outputTokens);
  const cacheCreationInputTokens =
    asNumber(usage.cache_creation_input_tokens) ?? asNumber(usage.cacheCreationInputTokens);
  const cacheReadInputTokens =
    asNumber(usage.cache_read_input_tokens) ?? asNumber(usage.cacheReadInputTokens);
  const reasoningTokens =
    asNumber(usage.reasoning_tokens) ?? asNumber(usage.reasoningTokens);
  const totalTokens = asNumber(usage.total_tokens) ?? asNumber(usage.totalTokens);
  const cachedTokens =
    (cacheCreationInputTokens ?? 0) + (cacheReadInputTokens ?? 0);

  return {
    totalTokens,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    cachedTokens,
    reasoningTokens
  };
}

export function readClaudeModelUsage(
  message: Record<string, unknown>
): Record<string, SessionModelUsageSnapshot> | undefined {
  const modelUsage = message.modelUsage as Record<string, Record<string, unknown>> | undefined;
  if (!modelUsage || typeof modelUsage !== "object") {
    return undefined;
  }

  const entries = Object.entries(modelUsage)
    .map(([model, usage]) => {
      const inputTokens = asNumber(usage.input_tokens);
      const outputTokens = asNumber(usage.output_tokens);
      const cacheCreationInputTokens = asNumber(usage.cache_creation_input_tokens);
      const cacheReadInputTokens = asNumber(usage.cache_read_input_tokens);
      const totalTokens =
        (inputTokens ?? 0) +
        (outputTokens ?? 0) +
        (cacheCreationInputTokens ?? 0) +
        (cacheReadInputTokens ?? 0);
      return [
        model,
        {
          inputTokens,
          outputTokens,
          cacheCreationInputTokens,
          cacheReadInputTokens,
          totalTokens
        } satisfies SessionModelUsageSnapshot
      ] as const;
    })
    .filter(([model]) => Boolean(model));

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function extractClaudeAssistantText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }

  const blocks = (message as { content?: unknown[] }).content;
  if (!Array.isArray(blocks)) {
    return "";
  }

  return blocks
    .map((block) => {
      const typedBlock = block as { type?: unknown; text?: unknown };
      return typedBlock.type === "text" && typeof typedBlock.text === "string"
        ? typedBlock.text
        : "";
    })
    .filter(Boolean)
    .join("");
}

export function extractClaudeToolUses(message: unknown): ClaudeObservedToolUse[] {
  if (!message || typeof message !== "object") {
    return [];
  }

  const blocks = (message as { content?: unknown[] }).content;
  if (!Array.isArray(blocks)) {
    return [];
  }

  return blocks
    .map((block): ClaudeObservedToolUse | null => {
      if (!block || typeof block !== "object" || Array.isArray(block)) {
        return null;
      }
      const raw = block as Record<string, unknown>;
      const type = extractString(raw.type);
      if (type !== "tool_use" && type !== "server_tool_use" && type !== "mcp_tool_use") {
        return null;
      }
      const id =
        extractString(raw.id) ??
        extractString(raw.tool_use_id) ??
        extractString(raw.toolUseId);
      const toolName =
        extractString(raw.name) ??
        extractString(raw.tool_name) ??
        extractString(raw.toolName) ??
        type;
      if (!id || !toolName) {
        return null;
      }
      const input =
        raw.input && typeof raw.input === "object" && !Array.isArray(raw.input)
          ? (raw.input as Record<string, unknown>)
          : undefined;
      return {
        id,
        toolName,
        ...(input ? { input } : {}),
        raw
      };
    })
    .filter((value): value is ClaudeObservedToolUse => Boolean(value));
}

export function extractClaudeToolResults(message: unknown): ClaudeToolResultBlock[] {
  if (!message || typeof message !== "object") {
    return [];
  }

  const blocks = (message as { content?: unknown[] }).content;
  if (!Array.isArray(blocks)) {
    return [];
  }

  return blocks
    .map((block): ClaudeToolResultBlock | null => {
      if (!block || typeof block !== "object" || Array.isArray(block)) {
        return null;
      }
      const raw = block as Record<string, unknown>;
      const type = extractString(raw.type);
      if (
        type !== "tool_result" &&
        type !== "mcp_tool_result" &&
        !type?.endsWith("_tool_result")
      ) {
        return null;
      }
      const toolUseId =
        extractString(raw.tool_use_id) ??
        extractString(raw.toolUseId) ??
        extractString(raw.id);
      if (!toolUseId) {
        return null;
      }
      return {
        toolUseId,
        isError: raw.is_error === true || raw.isError === true,
        ...(raw.content !== undefined ? { content: raw.content } : {}),
        raw
      };
    })
    .filter((value): value is ClaudeToolResultBlock => Boolean(value));
}

export function extractFilePaths(input: Record<string, unknown>): string[] {
  const candidates = [
    input.file_path,
    input.filePath,
    input.path,
    input.filename
  ];

  const files: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate) {
      files.push(candidate);
    }
  }

  if (Array.isArray(input.files)) {
    for (const item of input.files) {
      const candidate = extractString((item as Record<string, unknown>).filename);
      if (candidate) {
        files.push(candidate);
      }
    }
  }

  return Array.from(new Set(files));
}

export function buildClaudeToolDetails(
  toolName: string,
  input?: unknown,
  result?: unknown
): SessionHistoryEntryDetails | undefined {
  const details = {} as SessionHistoryEntryDetails & {
    commands?: Array<{ command: string; cwd?: string | null }>;
    urls?: Array<{ url: string; title?: string | null }>;
    queries?: string[];
  };
  if (isClaudeCommandTool(toolName)) {
    const commands = collectClaudeCommands(input);
    if (commands.length > 0) {
      details.commands = commands;
    }
  }
  if (isClaudeWebTool(toolName)) {
    const urls = collectClaudeUrls(input, result);
    const queries = collectClaudeQueries(input);
    if (urls.length > 0) {
      details.urls = urls;
    }
    if (queries.length > 0) {
      details.queries = queries;
    }
  }
  if (isClaudeFileEditTool(toolName)) {
    const files = collectClaudeFiles(input, result, toolName);
    if (files.length > 0) {
      details.files = files;
    }
  }

  return Object.keys(details).length > 0 ? details : undefined;
}

export function buildClaudeToolStartSummary(toolName: string, input?: unknown): string {
  const details = buildClaudeToolDetails(toolName, input);
  if (isClaudeCommandTool(toolName)) {
    const command = details?.commands?.[0]?.command;
    return command ? `Claude is running ${command}.` : "Claude is running a command.";
  }
  if (isClaudeWebTool(toolName)) {
    const query = details?.queries?.[0];
    return query ? `Claude is searching ${query}.` : "Claude is searching the web.";
  }
  if (isClaudeFileEditTool(toolName)) {
    return "Claude is editing files.";
  }
  return `Claude is using ${toolName}.`;
}

export function buildClaudeToolProgressSummary(
  toolName: string,
  message: Record<string, unknown>
): string {
  const elapsed = asNumber(message.elapsed_time_seconds);
  const elapsedSuffix = elapsed && elapsed > 0 ? ` for ${Math.round(elapsed)}s` : "";
  if (isClaudeCommandTool(toolName)) {
    return `Claude is running a command${elapsedSuffix}.`;
  }
  if (isClaudeWebTool(toolName)) {
    return `Claude is searching the web${elapsedSuffix}.`;
  }
  if (isClaudeFileEditTool(toolName)) {
    return `Claude is editing files${elapsedSuffix}.`;
  }
  return `Claude is using ${toolName}${elapsedSuffix}.`;
}

export function buildClaudeToolResultSummary(
  toolName: string,
  result: ClaudeToolResultBlock
): string {
  if (result.isError) {
    return `Claude tool ${toolName} failed.`;
  }
  if (isClaudeCommandTool(toolName)) {
    return "Claude ran a command.";
  }
  if (isClaudeWebTool(toolName)) {
    return "Claude searched the web.";
  }
  if (isClaudeFileEditTool(toolName)) {
    return "Claude edited files.";
  }
  return `Claude completed ${toolName}.`;
}

function isClaudeCommandTool(toolName: string): boolean {
  return /^(bash|local_command)$/i.test(toolName) || /command/i.test(toolName);
}

function isClaudeWebTool(toolName: string): boolean {
  return /web[-_]?search|web[-_]?fetch/i.test(toolName);
}

function isClaudeFileEditTool(toolName: string): boolean {
  return ["Edit", "MultiEdit", "Write", "NotebookEdit", "filesystem"].includes(toolName);
}

function collectClaudeCommands(...values: unknown[]): Array<{ command: string; cwd?: string | null }> {
  const commands = new Map<string, { command: string; cwd?: string | null }>();
  for (const value of values) {
    const cwd = collectClaudeCwd(value);
    for (const candidate of walkClaudeStrings(value, ["cmd", "command", "commandLine"])) {
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

function collectClaudeUrls(...values: unknown[]): Array<{ url: string; title?: string | null }> {
  const urls = new Map<string, { url: string; title?: string | null }>();
  for (const value of values) {
    for (const candidate of walkClaudeStrings(value, ["url", "uri", "href"])) {
      const normalized = candidate.trim();
      if (/^https?:\/\//i.test(normalized) && !urls.has(normalized)) {
        urls.set(normalized, { url: normalized });
      }
    }
    for (const candidate of walkClaudeStrings(value)) {
      const normalized = candidate.trim();
      if (/^https?:\/\//i.test(normalized) && !urls.has(normalized)) {
        urls.set(normalized, { url: normalized });
      }
    }
  }
  return [...urls.values()];
}

function collectClaudeQueries(...values: unknown[]): string[] {
  const queries = new Set<string>();
  for (const value of values) {
    for (const candidate of walkClaudeStrings(value, ["query"])) {
      const normalized = candidate.trim();
      if (normalized) {
        queries.add(normalized);
      }
    }
  }
  return [...queries];
}

function collectClaudeFiles(
  input: unknown,
  result: unknown,
  toolName: string
): SessionHistoryFileDetail[] {
  const files = new Map<string, SessionHistoryFileDetail>();
  const maybeInput = (input && typeof input === "object" ? (input as Record<string, unknown>) : {}) ?? {};
  for (const pathValue of extractFilePaths(maybeInput)) {
    files.set(pathValue, {
      path: pathValue,
      status: toolName === "filesystem" ? "edited" : "unknown"
    });
  }
  if (result && typeof result === "object" && Array.isArray((result as Record<string, unknown>).files)) {
    for (const file of (result as { files: unknown[] }).files) {
      if (typeof file === "string" && file.trim()) {
        files.set(file.trim(), { path: file.trim(), status: "edited" });
      }
    }
  }
  return [...files.values()];
}

function collectClaudeCwd(value: unknown): string | null {
  for (const candidate of walkClaudeStrings(value, ["cwd", "workdir", "workingDirectory"])) {
    const normalized = candidate.trim();
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function walkClaudeStrings(value: unknown, preferredKeys?: string[], depth = 0): string[] {
  if (depth > 4 || value == null) {
    return [];
  }
  if (typeof value === "string") {
    return preferredKeys ? [] : [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => walkClaudeStrings(item, preferredKeys, depth + 1));
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
    outputs.push(...walkClaudeStrings(candidate, preferredKeys, depth + 1));
  }
  return outputs;
}

export function extractString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function runGitDiff(workspaceDir: string, files: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["-C", workspaceDir, "diff", "--no-ext-diff", "--"];
    if (files.length > 0) {
      args.push(...files);
    }

    execFile("git", args, { maxBuffer: 5 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(
          new Error(stderr.trim() || error.message || "Unable to collect git diff preview")
        );
        return;
      }
      resolve(stdout);
    });
  });
}

export function isIgnorableGitDiffError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("not a git repository") ||
    normalized.includes("outside a working tree") ||
    normalized.includes("unknown revision")
  );
}

export function inferClaudeMessageDirection(
  message: Record<string, unknown>
): "request" | "notification" | "stream" | "control" | "result" {
  const type = String(message.type ?? "");
  if (type === "result") {
    return "result";
  }
  if (type === "system") {
    return "notification";
  }
  if (type === "stream_event") {
    return "stream";
  }
  return "notification";
}

export function inferClaudeMessageName(message: Record<string, unknown>): string {
  const type = String(message.type ?? "unknown");
  const subtype = extractString(message.subtype);
  if (subtype) {
    return `${type}/${subtype}`;
  }
  const event = message.event;
  if (event && typeof event === "object") {
    const eventType = extractString((event as Record<string, unknown>).type);
    if (eventType) {
      return `${type}/${eventType}`;
    }
  }
  return type;
}

export function buildClaudeMessageSummary(message: Record<string, unknown>): string {
  const type = String(message.type ?? "message");
  const subtype = extractString(message.subtype);
  if (type === "result") {
    return Boolean(message.is_error)
      ? "Claude produced an error result."
      : "Claude produced a result.";
  }
  if (type === "system" && subtype === "api_retry") {
    return buildClaudeApiRetrySummary(message);
  }
  if (subtype) {
    return `Claude emitted ${type}/${subtype}.`;
  }
  return `Claude emitted ${type}.`;
}

function buildClaudeApiRetrySummary(message: Record<string, unknown>): string {
  const attempt = asNumber(message.attempt);
  const maxRetries = asNumber(message.max_retries);
  const retryDelayMs = asNumber(message.retry_delay_ms);
  const delaySeconds =
    retryDelayMs != null && retryDelayMs > 0 ? Math.max(1, Math.round(retryDelayMs / 1000)) : null;
  const attemptLabel =
    attempt != null && maxRetries != null ? `${attempt}/${maxRetries}` : attempt != null ? `${attempt}` : "";
  const delayLabel = delaySeconds != null ? ` in ${delaySeconds}s` : "";
  const errorStatus = asNumber(message.error_status);
  const error = extractString(message.error);
  const reason =
    errorStatus != null
      ? ` after HTTP ${errorStatus}`
      : error && error !== "unknown"
        ? ` after ${error}`
        : "";
  return attemptLabel
    ? `API retry ${attemptLabel}${delayLabel}${reason}.`
    : `API retry${delayLabel}${reason}.`;
}

export function buildClaudePlanUpdate(message: Record<string, unknown>) {
  const itemsSource = Array.isArray(message.items)
    ? message.items
    : Array.isArray(message.steps)
      ? message.steps
      : [];

  return {
    provider: "claude",
    summary:
      extractString(message.summary) ??
      extractString(message.text) ??
      "Claude updated the execution plan.",
    items: itemsSource.map((item, index) => {
      const typedItem = item as Record<string, unknown>;
      return {
        id:
          extractString(typedItem.id) ??
          extractString(typedItem.slug) ??
          `step_${index + 1}`,
        label:
          extractString(typedItem.label) ??
          extractString(typedItem.title) ??
          `Step ${index + 1}`,
        status: extractString(typedItem.status) ?? null,
        details:
          extractString(typedItem.details) ??
          extractString(typedItem.description) ??
          null
      };
    }),
    raw: message
  };
}

export function buildClaudeChoiceRequest(
  sessionId: string,
  request: Record<string, unknown>
): ChoiceRequest | undefined {
  const requestedSchema =
    request.requestedSchema && typeof request.requestedSchema === "object"
      ? (request.requestedSchema as Record<string, unknown>)
      : undefined;
  const prompt =
    extractString(request.title) ??
    extractString(request.message) ??
    extractString(request.description) ??
    "Claude is requesting structured input.";

  const fields = requestedSchema
    ? buildChoiceFieldsFromJsonSchema(requestedSchema)
    : [];

  if (fields.length === 0 && Array.isArray(request.questions) && request.questions.length > 0) {
    fields.push(
      ...request.questions.flatMap((question, index) =>
        buildClaudeChoiceFieldsFromQuestion(question as Record<string, unknown>, index)
      )
    );
  }

  if (fields.length === 0 && extractString(request.url)) {
    fields.push({
      id: "url",
      header: "URL",
      prompt: extractString(request.message) ?? "Open the required URL and confirm.",
      kind: "url",
      required: false,
      defaultValue: extractString(request.url) ?? null
    });
  }

  const directQuestion = extractString(request.question);
  if (fields.length === 0 && directQuestion) {
    fields.push({
      id: "answer",
      header: "Answer",
      prompt: directQuestion,
      kind: "text",
      required: true,
      defaultValue: null
    });
  }

  if (fields.length === 0) {
    return undefined;
  }

  return {
    id: randomId("choice"),
    sessionId,
    prompt,
    fields,
    status: "pending",
    createdAt: nowIso(),
    handledAt: null
  };
}

function buildClaudeChoiceFieldsFromQuestion(
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
          buildClaudeChoiceOption(option as Record<string, unknown>, `${index}_option_${optionIndex}`)
        )
        .filter((option): option is NonNullable<typeof option> => Boolean(option))
    : [];

  if (options.length > 0) {
    return [
      {
        id: typeof question.id === "string" && question.id ? question.id : `question_${index}`,
        header: header.slice(0, 12),
        prompt,
        kind: question.multiSelect ? "multi_select" : "single_select",
        required: true,
        options
      }
    ];
  }

  return [
    {
      id: typeof question.id === "string" && question.id ? question.id : `question_${index}`,
      header: header.slice(0, 12),
      prompt,
      kind: "text",
      required: true,
      defaultValue: null
    }
  ];
}

function buildClaudeChoiceOption(
  option: Record<string, unknown>,
  fallbackId: string
): ChoiceOption | undefined {
  const label =
    typeof option.label === "string"
      ? option.label
      : typeof option.value === "string"
        ? option.value
        : "";
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

function buildChoiceFieldsFromJsonSchema(schema: Record<string, unknown>): ChoiceField[] {
  const properties =
    schema.properties && typeof schema.properties === "object"
      ? (schema.properties as Record<string, unknown>)
      : {};
  const required = Array.isArray(schema.required)
    ? new Set(schema.required.filter((value): value is string => typeof value === "string"))
    : new Set<string>();

  const fields: ChoiceField[] = [];

  for (const [fieldId, rawField] of Object.entries(properties)) {
    if (!rawField || typeof rawField !== "object") {
      continue;
    }

    const field = rawField as Record<string, unknown>;
    const title = extractString(field.title) ?? fieldId;
    const prompt = extractString(field.description) ?? title;
    const enumValues = Array.isArray(field.enum) ? field.enum : undefined;

    if (enumValues && enumValues.length > 0) {
      fields.push({
        id: fieldId,
        header: title.slice(0, 12),
        prompt,
        kind: "single_select",
        required: required.has(fieldId),
        options: enumValues.map((value) => ({
          id: String(value),
          label: String(value),
          description: null,
          preview: null
        })),
        defaultValue:
          field.default === undefined ? null : normalizeChoiceValue(field.default, "single_select")
      });
      continue;
    }

    const type = extractString(field.type);
    if (type === "boolean") {
      fields.push({
        id: fieldId,
        header: title.slice(0, 12),
        prompt,
        kind: "boolean",
        required: required.has(fieldId),
        options: [
          {
            id: "true",
            label: "Yes",
            description: null,
            preview: null
          },
          {
            id: "false",
            label: "No",
            description: null,
            preview: null
          }
        ],
        defaultValue:
          field.default === undefined ? null : normalizeChoiceValue(field.default, "boolean")
      });
      continue;
    }

    if (type === "number" || type === "integer") {
      fields.push({
        id: fieldId,
        header: title.slice(0, 12),
        prompt,
        kind: "number",
        required: required.has(fieldId),
        defaultValue:
          field.default === undefined ? null : normalizeChoiceValue(field.default, "number")
      });
      continue;
    }

    if (type === "string" && extractString(field.format) === "uri") {
      fields.push({
        id: fieldId,
        header: title.slice(0, 12),
        prompt,
        kind: "url",
        required: required.has(fieldId),
        defaultValue:
          field.default === undefined ? null : normalizeChoiceValue(field.default, "url")
      });
      continue;
    }

    fields.push({
      id: fieldId,
      header: title.slice(0, 12),
      prompt,
      kind: "text",
      required: required.has(fieldId),
      defaultValue:
        field.default === undefined ? null : normalizeChoiceValue(field.default, "text")
    });
  }

  return fields;
}

function normalizeChoiceValue(
  value: unknown,
  kind: ChoiceField["kind"]
): ChoiceField["defaultValue"] {
  switch (kind) {
    case "boolean":
      return typeof value === "boolean" ? value : null;
    case "number":
      return typeof value === "number" ? value : null;
    case "multi_select":
      return Array.isArray(value) ? value.map(String) : null;
    default:
      return typeof value === "string" ? value : null;
  }
}

export function buildClaudeChoiceContent(
  answers: ChoiceAnswer[],
  fields: ChoiceField[],
  responseMode: "ask_user_question" | "field_values"
): Record<string, unknown> {
  const answerByFieldId = new Map(answers.map((answer) => [answer.fieldId, answer.value]));

  if (responseMode === "ask_user_question") {
    const questionAnswers: Record<string, string> = {};
    for (const field of fields) {
      const value = answerByFieldId.get(field.id);
      const formatted = formatClaudeQuestionAnswer(field, value);
      if (formatted !== null) {
        questionAnswers[field.prompt || field.header || field.id] = formatted;
      }
    }
    return { answers: questionAnswers };
  }

  const content: Record<string, string | number | boolean | string[]> = {};
  for (const field of fields) {
    const value = answerByFieldId.get(field.id);
    if (value === undefined || value === null) {
      continue;
    }

    switch (field.kind) {
      case "boolean":
        if (typeof value === "boolean") {
          content[field.id] = value;
        }
        break;
      case "number":
        if (typeof value === "number") {
          content[field.id] = value;
        } else if (typeof value === "string" && value.trim()) {
          const parsed = Number(value);
          if (!Number.isNaN(parsed)) {
            content[field.id] = parsed;
          }
        }
        break;
      case "multi_select":
        if (Array.isArray(value)) {
          content[field.id] = value.map(String);
        } else if (typeof value === "string") {
          content[field.id] = [value];
        }
        break;
      default:
        if (Array.isArray(value)) {
          content[field.id] = value.map(String);
        } else {
          content[field.id] = String(value);
        }
        break;
    }
  }
  return content;
}

function formatClaudeQuestionAnswer(field: ChoiceField, value: ChoiceAnswer["value"] | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (field.kind === "multi_select") {
    const selectedValues = Array.isArray(value) ? value : [String(value)];
    const selectedLabels = selectedValues
      .map((item) => field.options?.find((option) => option.id === item)?.label ?? item)
      .filter(Boolean);
    return selectedLabels.length > 0 ? selectedLabels.join(", ") : null;
  }

  if (field.kind === "single_select") {
    const selected = String(value);
    return field.options?.find((option) => option.id === selected)?.label ?? selected;
  }

  return Array.isArray(value) ? value.map(String).join(", ") : String(value);
}
