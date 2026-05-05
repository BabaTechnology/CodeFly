export type RouteMode = "direct" | "relay";

export type SessionState =
  | "idle"
  | "running"
  | "awaiting_approval"
  | "awaiting_choice"
  | "interrupted"
  | "completed"
  | "error";

export type EventType =
  | "hello"
  | "host_request"
  | "host_response"
  | "pair_request"
  | "pair_confirm"
  | "host_status"
  | "session_list"
  | "session_start"
  | "session_attach"
  | "session_detach"
  | "session_read"
  | "session_replace"
  | "session_snapshot"
  | "session_events"
  | "session_history"
  | "session_input"
  | "assistant_delta"
  | "session_state"
  | "provider_event"
  | "tool_event"
  | "session_metrics"
  | "plan_update"
  | "approval_request"
  | "approval_response"
  | "choice_request"
  | "choice_response"
  | "diff_preview"
  | "session_resume"
  | "session_interrupt"
  | "seat_release"
  | "heartbeat"
  | "error";

export interface User {
  id: string;
  createdAt: string;
  deletedAt?: string | null;
  relayBandwidthPolicyCode?: number | null;
  hostOfflineNotificationDelayMinutes?: number | null;
}

export interface ExternalIdentity {
  id: string;
  userId: string;
  provider: "apple" | "google" | string;
  subject: string;
  email?: string | null;
  displayName?: string | null;
  createdAt: string;
}

export interface Seat {
  id: string;
  userId: string;
  label: string;
  createdAt: string;
  releasedAt?: string | null;
  relayUsable?: boolean;
  blockedReason?: "subscription_required" | "plan_limit_reached" | null;
}

export interface HostBinding {
  id: string;
  seatId: string;
  hostFingerprint: string;
  hostPublicKey: string;
  status: "active" | "user_removed" | "system_removed";
  statusReason?: string | null;
  unbindRequestedAt?: string | null;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type NotificationCategory =
  | "session_completed"
  | "session_action_required"
  | "session_error"
  | "host_offline"
  | "host_online";

export interface InstallationNotificationPreferences {
  sessionCompleted: boolean;
  sessionActionRequired: boolean;
  sessionError: boolean;
  hostOffline: boolean;
  hostOnline: boolean;
}

export interface UserNotificationSettings {
  hostOfflineNotificationDelayMinutes: number;
}

export interface Installation {
  id: string;
  clientInstallationId: string;
  platform: "ios" | "android" | "unknown";
  expoPushToken?: string | null;
  expoPushTokenStatus?: "active" | "invalid" | "unavailable";
  appVersion?: string | null;
  locale?: string | null;
  lastSeenAt: string;
  userId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationEventPayload {
  category: NotificationCategory;
  occurredAt: string;
  hostName: string;
  hostFingerprint: string;
  sessionId?: string | null;
  sessionTitle?: string | null;
  provider?: string | null;
  actionKind?: "approval" | "choice" | null;
  dedupeKey: string;
}

export interface NotificationOutboxItem {
  id: string;
  category: NotificationCategory;
  routeMode: RouteMode;
  installationId: string;
  userId?: string | null;
  seatId?: string | null;
  hostFingerprint?: string | null;
  sessionId?: string | null;
  provider?: string | null;
  title: string;
  body: string;
  data?: Record<string, unknown> | null;
  dedupeKey: string;
  status:
    | "pending"
    | "sending"
    | "sent"
    | "receipt_ok"
    | "receipt_error"
    | "invalid_token"
    | "suppressed";
  expoTicketId?: string | null;
  expoReceiptId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HostCredential {
  seatId: string;
  createdAt: string;
  lastUsedAt?: string | null;
}

export interface PairedDevice {
  deviceId: string;
  label: string;
  publicKey: string;
  createdAt: string;
  lastSeenAt?: string | null;
}

export interface HostStatus {
  hostId: string;
  hostName: string;
  adapter: string;
  providers?: HostProviderCapability[];
  online: boolean;
  directEnabled: boolean;
  relayEnabled: boolean;
  activeSeatId?: string | null;
  publicKeyFingerprint: string;
  connectedDevices: number;
  activeSessions: number;
  timestamp: string;
}

export interface HostProviderCapability {
  id: string;
  label: string;
  enabled: boolean;
  installed?: boolean;
  configured?: boolean;
  authMode?: "api_key" | "account" | "missing";
  baseUrl?: string;
  available: boolean;
  reason?: string | null;
}

export interface AgentSession {
  id: string;
  adapter: string;
  title: string;
  state: SessionState;
  createdAt: string;
  updatedAt: string;
  lastReadAt?: string | null;
  lastInput?: string | null;
  lastOutput?: string | null;
}

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  prompt: string;
  options: string[];
  status: "pending" | "approved" | "denied" | "expired";
  createdAt: string;
  handledAt?: string | null;
}

export interface ChoiceOption {
  id: string;
  label: string;
  description?: string | null;
  preview?: string | null;
}

export type ChoiceFieldKind =
  | "single_select"
  | "multi_select"
  | "text"
  | "number"
  | "boolean"
  | "url";

export interface ChoiceField {
  id: string;
  header: string;
  prompt: string;
  kind: ChoiceFieldKind;
  required?: boolean;
  options?: ChoiceOption[];
  defaultValue?: string | number | boolean | string[] | null;
  placeholder?: string | null;
}

export interface ChoiceRequest {
  id: string;
  sessionId: string;
  prompt: string;
  fields: ChoiceField[];
  status: "pending" | "answered" | "expired";
  createdAt: string;
  handledAt?: string | null;
}

export interface ChoiceAnswer {
  fieldId: string;
  value: string | number | boolean | string[] | null;
}

export interface DiffPreview {
  id: string;
  sessionId: string;
  summary: string;
  unifiedDiff: string;
  createdAt: string;
}

export interface SessionModelUsageSnapshot {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  totalTokens?: number | null;
}

export interface SessionContextUsageCategory {
  name: string;
  tokens: number;
  color?: string | null;
  isDeferred?: boolean;
}

export interface SessionUsageSnapshot {
  provider: string;
  model?: string | null;
  totalTokens?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  cachedTokens?: number | null;
  reasoningTokens?: number | null;
  contextWindowTokens?: number | null;
  usedContextWindowTokens?: number | null;
  contextUsagePercentage?: number | null;
  totalCostUsd?: number | null;
  categories?: SessionContextUsageCategory[];
  modelUsage?: Record<string, SessionModelUsageSnapshot>;
  updatedAt: string;
  raw?: unknown;
}

export interface SessionCompressionSnapshot {
  provider: string;
  state: "idle" | "compressing" | "compressed";
  summary: string;
  updatedAt: string;
  raw?: unknown;
}

export interface SessionMetricsSnapshot {
  usage?: SessionUsageSnapshot | null;
  compression?: SessionCompressionSnapshot | null;
}

export interface SessionStateUpdate {
  provider: string;
  state: SessionState;
  summary: string;
  reason?: string;
  waitingFor?: "approval" | "choice" | "provider" | "tool" | "none";
  providerState?: unknown;
}

export interface ProviderEvent {
  provider: string;
  direction: "request" | "notification" | "stream" | "control" | "result";
  name: string;
  summary: string;
  raw?: unknown;
}

export interface ToolEvent {
  provider: string;
  toolName: string;
  phase: "requested" | "started" | "progress" | "completed" | "failed" | "output";
  summary: string;
  details?: SessionHistoryEntryDetails;
  input?: unknown;
  result?: unknown;
  raw?: unknown;
}

export interface PlanUpdateItem {
  id: string;
  label: string;
  status?: string | null;
  details?: string | null;
}

export interface PlanUpdate {
  provider: string;
  summary: string;
  items: PlanUpdateItem[];
  raw?: unknown;
}

export interface PairingBundle {
  hostId: string;
  hostName: string;
  directUrl: string;
  hostPublicKey: string;
  hostPublicKeyFingerprint: string;
  pairingCode: string;
  expiresAt: string;
}

export interface AppMessage<TPayload = unknown> {
  type: EventType;
  requestId?: string;
  sessionId?: string;
  timestamp: string;
  payload?: TPayload;
}

export interface SessionEventRecord<TPayload = unknown> {
  id: string;
  type: EventType;
  requestId?: string;
  sessionId: string;
  timestamp: string;
  payload?: TPayload;
}

export interface SessionSnapshot {
  session: AgentSession;
  pendingApproval?: ApprovalRequest | null;
  pendingChoice?: ChoiceRequest | null;
  lastDiff?: DiffPreview | null;
  latestState?: SessionStateUpdate | null;
  metrics?: SessionMetricsSnapshot | null;
  recentEvents: SessionEventRecord[];
}

export type SessionHistoryEntryRole =
  | "user"
  | "assistant"
  | "system"
  | "tool"
  | "meta"
  | "unknown";

export interface SessionHistoryFileDetail {
  path: string;
  added?: number | null;
  removed?: number | null;
  status?: "created" | "edited" | "deleted" | "unknown";
}

export interface SessionHistoryUrlDetail {
  url: string;
  title?: string | null;
}

export interface SessionHistoryCommandDetail {
  command: string;
  cwd?: string | null;
}

export interface SessionHistoryEntryDetails {
  urls?: SessionHistoryUrlDetail[];
  queries?: string[];
  commands?: SessionHistoryCommandDetail[];
  files?: SessionHistoryFileDetail[];
}

export interface SessionHistoryEntry {
  id: string;
  sessionId: string;
  adapter: string;
  timestamp: string;
  role: SessionHistoryEntryRole;
  summary: string;
  kind?: "message" | "trace" | "meta";
  turnId?: string;
  batchId?: string;
  traceType?:
    | "webSearch"
    | "commandExecution"
    | "fileChange"
    | "imageView"
    | "toolCall"
    | "turnComplete";
  phase?: "running" | "completed";
  durationSeconds?: number | null;
  details?: SessionHistoryEntryDetails;
  text?: string | null;
}

export interface SessionHistorySnapshot {
  session: AgentSession;
  cwd?: string | null;
  entries: SessionHistoryEntry[];
  range?: SessionHistoryRange | null;
}

export interface SessionHistoryRange {
  mode: "tail" | "before" | "after" | "between" | "full";
  anchorTimestamp?: string | null;
  firstEntryTimestamp?: string | null;
  lastEntryTimestamp?: string | null;
  totalEntryCount: number;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  isComplete: boolean;
}

export interface ProviderModelOption {
  id: string;
  label: string;
  description?: string | null;
  status?: string | null;
  contextWindowTokens?: number | null;
  recommended?: boolean;
  deprecated?: boolean;
  hidden?: boolean;
  isDefault?: boolean;
  reasoningEfforts?: ProviderReasoningEffortOption[];
}

export interface ProviderReasoningEffortOption {
  id: string;
  label?: string | null;
  description?: string | null;
}

export interface ProviderCommandOption {
  id: string;
  label: string;
  description?: string | null;
  argumentHint?: string | null;
  aliases?: string[];
  source?: "codex_skill" | "claude_command" | "built_in";
}

export interface ProviderAccountSnapshot {
  kind:
    | "api_key"
    | "chatgpt"
    | "claude_account"
    | "amazon_bedrock"
    | "external_provider"
    | "none"
    | "unknown";
  email?: string | null;
  planType?: string | null;
  organization?: string | null;
  subscriptionType?: string | null;
  tokenSource?: string | null;
  apiKeySource?: string | null;
  apiProvider?: string | null;
  requiresAuth?: boolean;
  raw?: unknown;
}

export interface ProviderQuotaSnapshot {
  status?: string | null;
  utilizationPercent?: number | null;
  resetAt?: string | null;
  rateLimitType?: string | null;
  primary?: ProviderQuotaWindowSnapshot | null;
  secondary?: ProviderQuotaWindowSnapshot | null;
  credits?: {
    hasCredits?: boolean | null;
    unlimited?: boolean | null;
    balance?: string | null;
  } | null;
  limitsById?: Record<string, unknown> | null;
  raw?: unknown;
}

export interface ProviderQuotaWindowSnapshot {
  usedPercent?: number | null;
  windowDurationMinutes?: number | null;
  resetAt?: string | null;
}

export interface ProviderRuntimeMetadata {
  provider: "codex" | "claude";
  recommendedModels: ProviderModelOption[];
  defaultModel: string;
  defaultReasoningEffort?: string;
  reasoningEffortsByModel: Record<string, string[]>;
  reasoningEffortOptionsByModel?: Record<string, ProviderReasoningEffortOption[]>;
  account?: ProviderAccountSnapshot | null;
  quota?: ProviderQuotaSnapshot | null;
  authMode?: "api_key" | "account" | "missing";
  refreshedAt?: string;
  source?: "host" | "built_in";
  error?: string | null;
  permissionModes?: string[];
  defaultPermissionMode?: string;
  approvalPolicies?: string[];
  defaultApprovalPolicy?: string;
  sandboxModes?: string[];
  defaultSandboxMode?: string;
  approvalsReviewers?: string[];
  defaultApprovalsReviewer?: string;
  personalityOptions?: string[];
  defaultPersonality?: string;
  commands?: ProviderCommandOption[];
}

export interface RuntimeMetadataEnvelope {
  metadataVersion: string;
  generatedAt: string;
  expiresAt: string;
  minAppVersion?: string | null;
  codex: ProviderRuntimeMetadata;
  claude: ProviderRuntimeMetadata;
}

export interface WorkspaceFileAccessResult {
  editable: boolean;
  reason?:
    | "ok"
    | "outside_root"
    | "too_large"
    | "not_text"
    | "not_file"
    | "not_found";
  maxEditableBytes: number;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface DirectoryBrowseSnapshot {
  currentPath: string;
  rootPath?: string | null;
  homePath: string;
  parentPath?: string | null;
  pathSeparator: string;
  entries: DirectoryEntry[];
}

export interface FileSnapshot {
  path: string;
  name: string;
  rootPath?: string | null;
  content?: string;
  sizeBytes: number;
  updatedAt: string;
  access: WorkspaceFileAccessResult;
}

export interface FileMutationResult {
  ok: boolean;
  path: string;
  sizeBytes: number;
  updatedAt: string;
}

export interface UploadedFileSnapshot {
  ok: boolean;
  path: string;
  name: string;
  sizeBytes: number;
  updatedAt: string;
}

export interface GitChangedFile {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "copied" | "untracked" | "unknown";
  staged?: boolean;
  unstaged?: boolean;
  untracked?: boolean;
  added?: number | null;
  removed?: number | null;
}

export interface GitSummarySnapshot {
  workspacePath: string;
  repoRoot?: string | null;
  gitInstalled: boolean;
  isGitRepository: boolean;
  head?: string | null;
  currentBranch?: string | null;
  detachedHead?: boolean;
  upstream?: string | null;
  ahead: number;
  behind: number;
  statusCounts: {
    staged: number;
    unstaged: number;
    untracked: number;
  };
  changedFiles: GitChangedFile[];
}

export interface GitBranchItem {
  name: string;
  current: boolean;
  upstream?: string | null;
  lastCommitAt?: string | null;
  head?: string | null;
}

export interface GitBranchListSnapshot {
  workspacePath: string;
  repoRoot?: string | null;
  gitInstalled: boolean;
  isGitRepository: boolean;
  branches: GitBranchItem[];
}

export interface GitCommitListItem {
  id: string;
  shortId: string;
  authorName: string;
  authorEmail?: string | null;
  authoredAt: string;
  subject: string;
  parents: string[];
}

export interface GitCommitListSnapshot {
  workspacePath: string;
  repoRoot?: string | null;
  gitInstalled: boolean;
  isGitRepository: boolean;
  commits: GitCommitListItem[];
  nextCursor?: string | null;
}

export interface GitCommitDetail {
  workspacePath: string;
  repoRoot?: string | null;
  commit: GitCommitListItem;
  body?: string | null;
  files: GitChangedFile[];
}

export interface EncryptedAppFrame {
  kind: "encrypted";
  routeMode: RouteMode;
  seatId?: string;
  senderId: string;
  recipientId: string;
  senderPublicKey: string;
  nonce: string;
  ciphertext: string;
  timestamp: string;
}

export type RelayControlFrame =
  | {
      kind: "host_auth";
      credential: string;
      hostName: string;
      hostFingerprint: string;
      hostPublicKey: string;
    }
  | {
      kind: "host_authenticated";
      seatId: string;
      hostCredential?: string;
      hostFingerprint: string;
      hostPublicKey: string;
    }
  | {
      kind: "host_unbind";
      seatId: string;
      reason: "user_removed" | "system_removed";
      message?: string;
    }
  | {
      kind: "relay_backoff";
      seatId: string;
      reason: "subscription_required";
      retryAfterSeconds: number;
      message?: string;
    }
  | {
      kind: "device_auth";
      userToken: string;
      seatId: string;
      deviceId: string;
      deviceLabel: string;
      devicePublicKey: string;
      appVersion?: string;
    }
  | {
      kind: "device_authenticated";
      seatId: string;
      deviceId: string;
      hostOnline: boolean;
      hostPublicKey?: string;
      hostFingerprint?: string;
    }
  | {
      kind: "device_attached";
      seatId: string;
      deviceId: string;
      deviceLabel: string;
      devicePublicKey: string;
      appVersion?: string;
    }
  | {
      kind: "device_detached";
      seatId: string;
      deviceId: string;
    }
  | {
      kind: "host_presence";
      seatId: string;
      hostOnline: boolean;
      hostPublicKey?: string;
      hostFingerprint?: string;
    }
  | {
      kind: "push_publish";
      category: NotificationCategory;
      occurredAt: string;
      hostName: string;
      hostFingerprint: string;
      seatId: string;
      sessionId?: string | null;
      sessionTitle?: string | null;
      provider?: string | null;
      actionKind?: "approval" | "choice" | null;
      dedupeKey: string;
      excludeInstallationIds?: string[];
    }
  | {
      kind: "heartbeat";
      timestamp: string;
    }
  | {
      kind: "error";
      code: string;
      message: string;
    };
