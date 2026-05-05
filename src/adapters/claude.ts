import {
  nowIso,
  randomId,
  type AgentSession,
  type ApprovalRequest,
  type ChoiceAnswer,
  type ChoiceRequest,
  type DiffPreview,
  type ProviderRuntimeMetadata,
  type SessionHistoryEntryDetails,
  type SessionMetricsSnapshot,
  type SessionUsageSnapshot
} from "../shared";
import { spawn } from "node:child_process";
import path from "node:path";
import type { HostClientConfig } from "../config";
import { ProviderConfigManager } from "../provider-config";
import {
  getClaudeNativeHistory,
  getClaudeNativeSession,
  isMeaningfulNativeSession,
  listClaudeNativeSessions,
  renameClaudeNativeSession,
  type NativeSessionSummary
} from "../provider-native-sessions";
import {
  buildProviderProcessEnv
} from "../provider-runtime";
import { AgentAdapter, type SessionRuntimeContext } from "./base";
import {
  beginTranscriptTurn,
  closeAssistantTranscriptElement,
  ensureAssistantTranscriptElement,
  ensureToolTranscriptElement,
  finishTranscriptTurn,
  type TranscriptElementState
} from "./transcript-elements";
import {
  asBoolean,
  asNumber,
  buildClaudeApprovalPrompt,
  buildClaudeChoiceContent,
  buildClaudeChoiceRequest,
  buildClaudeDraftSessionId,
  buildClaudeMessageSummary,
  buildClaudePlanUpdate,
  buildClaudeToolDetails,
  buildClaudeToolProgressSummary,
  buildClaudeToolResultSummary,
  buildClaudeToolStartSummary,
  extractClaudeAssistantText,
  extractClaudeStreamChunk,
  extractClaudeToolResults,
  extractClaudeToolUses,
  extractFilePaths,
  extractString,
  inferClaudeMessageDirection,
  inferClaudeMessageName,
  isIgnorableGitDiffError,
  mapClaudeSessionState,
  normalizeClaudeAccount,
  normalizeClaudeCommands,
  normalizeClaudeModels,
  normalizeClaudeQuota,
  readClaudeModelUsage,
  readClaudeUsageFromMessage,
  resolveClaudeBinary,
  runGitDiff,
  shouldSuppressDiscoveredSession
} from "./claude-helpers";
import { mergeDiscoveredSession } from "./discovered-session";

interface ClaudeSdkSession {
  readonly sessionId: string;
  send(message: string | Record<string, unknown>): Promise<void>;
  stream(): AsyncGenerator<Record<string, unknown>, void>;
  initializationResult?(): Promise<Record<string, unknown>>;
  supportedModels?(): Promise<Record<string, unknown>[]>;
  supportedCommands?(): Promise<Record<string, unknown>[]>;
  accountInfo?(): Promise<Record<string, unknown>>;
  getContextUsage?(): Promise<Record<string, unknown>>;
  close(): void;
}

interface ClaudeSdkModule {
  unstable_v2_createSession(options: Record<string, unknown>): ClaudeSdkSession;
  unstable_v2_resumeSession(
    sessionId: string,
    options: Record<string, unknown>
  ): ClaudeSdkSession;
}

type ClaudePermissionResult =
  | {
      behavior: "allow";
      updatedInput?: Record<string, unknown>;
      toolUseID?: string;
    }
  | {
      behavior: "deny";
      message: string;
      interrupt?: boolean;
      toolUseID?: string;
    };

interface ClaudePermissionOptions {
  signal?: AbortSignal;
  title?: string;
  description?: string;
  displayName?: string;
  decisionReason?: string;
  blockedPath?: string;
  toolUseID?: string;
}

interface PendingClaudeApproval {
  approval: ApprovalRequest;
  sessionId: string;
  toolInput: Record<string, unknown>;
  toolUseID?: string;
  resolve: (result: ClaudePermissionResult) => void;
}

interface ClaudeElicitationResult {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
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

interface PendingClaudeChoice {
  choice: ChoiceRequest;
  sessionId: string;
  responseMode: "ask_user_question" | "field_values";
  resolve: (result: ClaudeElicitationResult) => void;
}

interface ClaudeSessionRuntime extends TranscriptElementState {
  session: AgentSession;
  sdkSession?: ClaudeSdkSession;
  providerSessionId?: string;
  cwd?: string;
  streamTask?: Promise<void>;
  lastDiff?: DiffPreview;
  changedFiles: Set<string>;
  pendingApprovals: Map<string, PendingClaudeApproval>;
  pendingChoices: Map<string, PendingClaudeChoice>;
  observedToolUses: Map<string, ClaudeObservedToolUse>;
  emittedToolUseStarts: Set<string>;
  emittedToolUseResults: Set<string>;
  interrupted: boolean;
  sawPartialInCurrentTurn: boolean;
  recreateSdkOnNextTurn: boolean;
  metrics?: SessionMetricsSnapshot;
  lastContextUsageRefreshAt?: number;
  contextUsageRefreshTask?: Promise<void>;
  compactionActive?: boolean;
}

export class ClaudeAdapter implements AgentAdapter {
  public readonly name = "claude";

  private readonly sessions = new Map<string, ClaudeSessionRuntime>();
  private readonly discoveredSessions = new Map<string, NativeSessionSummary>();
  private runtimeContext?: SessionRuntimeContext;
  private sdkModulePromise?: Promise<ClaudeSdkModule>;
  private runtimeMetadataCache?: { fetchedAtMs: number; metadata: ProviderRuntimeMetadata };
  private latestRateLimitInfo?: Record<string, unknown>;

  public constructor(
    private readonly config: HostClientConfig,
    private readonly providerConfigs: ProviderConfigManager
  ) {}

  public async listSessions(): Promise<AgentSession[]> {
    const discovered = this.refreshDiscoveredSessions();
    const merged = new Map<string, AgentSession>();
    const runtimes = Array.from(this.sessions.values());

    for (const session of discovered) {
      if (shouldSuppressDiscoveredSession(session, runtimes)) {
        continue;
      }
      if (isMeaningfulNativeSession(session.session)) {
        merged.set(session.session.id, { ...session.session });
      }
    }

    for (const runtime of runtimes) {
      const known = this.discoveredSessions.get(runtime.session.id);
      if (known?.cwd && !runtime.cwd) {
        runtime.cwd = this.resolveRuntimeWorkspace(known.cwd);
      }
      runtime.session = mergeDiscoveredSession(runtime.session, known);
      if (isMeaningfulNativeSession(runtime.session)) {
        merged.set(runtime.session.id, { ...runtime.session });
      }
    }

    return Array.from(merged.values()).sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt)
    );
  }

  public async startSession(
    workspacePath: string,
    context: SessionRuntimeContext
  ): Promise<AgentSession> {
    this.runtimeContext = context;
    const runtime = this.createRuntime(workspacePath);
    this.sessions.set(runtime.session.id, runtime);
    this.upsertSession(runtime.session);
    return runtime.session;
  }

  public async attachSession(
    sessionId: string,
    context: SessionRuntimeContext
  ): Promise<AgentSession> {
    this.runtimeContext = context;
    const runtime = await this.ensureSdkSession(sessionId);
    void this.maybeRefreshContextUsage(runtime, true);
    return runtime.session;
  }

  public async sendInput(
    sessionId: string,
    input: string,
    context: SessionRuntimeContext
  ): Promise<AgentSession> {
    this.runtimeContext = context;
    const runtime = await this.ensureSdkSession(sessionId);

    runtime.interrupted = false;
    runtime.sawPartialInCurrentTurn = false;
    beginTranscriptTurn(runtime, `${runtime.session.id}:${Date.now()}`);
    runtime.session.lastInput = input;
    runtime.session.state = "running";
    runtime.session.updatedAt = nowIso();
    this.upsertSession(runtime.session);
    void this.maybeRefreshContextUsage(runtime, true);
    await this.emitSessionState(runtime.session.id, "running", {
      reason: "user_input",
      summary: "",
      waitingFor: "none"
    });

    if (!runtime.streamTask) {
      const streamTask = this.pumpStream(runtime);
      runtime.streamTask = streamTask;
      void streamTask.finally(() => {
        if (runtime.streamTask === streamTask) {
          runtime.streamTask = undefined;
        }
      });
    }

    await runtime.sdkSession!.send(input);

    return runtime.session;
  }

  public async respondToApproval(
    sessionId: string,
    approvalId: string,
    decision: "approve" | "deny",
    context: SessionRuntimeContext
  ): Promise<void> {
    this.runtimeContext = context;
    const runtime = await this.ensureRuntime(sessionId);
    const pending = runtime.pendingApprovals.get(approvalId);
    if (!pending) {
      throw new Error("Approval request not found");
    }

    runtime.pendingApprovals.delete(approvalId);
    pending.approval.status = decision === "approve" ? "approved" : "denied";
    pending.approval.handledAt = nowIso();
    runtime.session.state = "running";
    runtime.session.updatedAt = nowIso();
    this.upsertSession(runtime.session);

    pending.resolve(
      decision === "approve"
        ? {
            behavior: "allow",
            updatedInput: pending.toolInput,
            toolUseID: pending.toolUseID
          }
        : {
            behavior: "deny",
            message: "Denied by CodeFly user",
            toolUseID: pending.toolUseID
          }
    );
  }

  public async respondToChoice(
    sessionId: string,
    choiceId: string,
    answers: ChoiceAnswer[],
    context: SessionRuntimeContext
  ): Promise<void> {
    this.runtimeContext = context;
    const runtime = await this.ensureRuntime(sessionId);
    const pending = runtime.pendingChoices.get(choiceId);
    if (!pending) {
      throw new Error("Choice request not found");
    }

    runtime.pendingChoices.delete(choiceId);
    pending.choice.status = "answered";
    pending.choice.handledAt = nowIso();
    runtime.session.state = "running";
    runtime.session.updatedAt = nowIso();
    this.upsertSession(runtime.session);

    pending.resolve({
      action: "accept",
      content: buildClaudeChoiceContent(answers, pending.choice.fields, pending.responseMode)
    });
  }

  public async resumeSession(
    sessionId: string,
    context: SessionRuntimeContext
  ): Promise<void> {
    this.runtimeContext = context;
    const runtime = await this.ensureSdkSession(sessionId);
    if (runtime.streamTask) {
      throw new Error("Claude session is still running");
    }

    runtime.interrupted = false;
    runtime.session.state = "idle";
    runtime.session.updatedAt = nowIso();
    this.upsertSession(runtime.session);
    await this.emitSessionState(runtime.session.id, "idle", {
      reason: "session_resumed",
      summary: `Claude session ${runtime.session.id} resumed.`,
      waitingFor: "none"
    });
  }

  public async interruptSession(
    sessionId: string,
    context: SessionRuntimeContext
  ): Promise<void> {
    this.runtimeContext = context;
    const runtime = await this.ensureRuntime(sessionId);
    runtime.interrupted = true;
    finishTranscriptTurn(runtime);

    this.expireApprovals(runtime, "Session interrupted");
    this.expireChoices(runtime, "Session interrupted");

    if (runtime.sdkSession) {
      runtime.sdkSession.close();
      runtime.sdkSession = undefined;
    }

    runtime.session.state = "interrupted";
    runtime.session.updatedAt = nowIso();
    this.upsertSession(runtime.session);
    await this.emitSessionState(runtime.session.id, "interrupted", {
      reason: "session_interrupted",
      summary: `Claude session ${runtime.session.id} interrupted.`,
      waitingFor: "none"
    });
    await this.emitAssistantDelta(
      runtime.session.id,
      `Session ${runtime.session.id} interrupted.`
    );
  }

  public async renameSessionTitle(
    sessionId: string,
    title: string,
    context: SessionRuntimeContext
  ): Promise<AgentSession> {
    this.runtimeContext = context;
    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      throw new Error("Session title is required");
    }

    const runtime = this.sessions.get(sessionId);
    const discovered =
      this.discoveredSessions.get(sessionId) ??
      getClaudeNativeSession(this.config.claude.configDir, sessionId);
    const persisted = renameClaudeNativeSession(
      this.config.claude.configDir,
      sessionId,
      normalizedTitle
    );

    if (!persisted && !runtime && !discovered) {
      throw new Error(`Claude session ${sessionId} was not found`);
    }

    const now = nowIso();
    const currentSession = runtime?.session ?? discovered?.session;
    const nextSession: AgentSession = {
      ...(currentSession ?? {
        id: sessionId,
        adapter: this.name,
        state: "idle",
        createdAt: now,
        updatedAt: now,
        lastInput: null,
        lastOutput: null
      }),
      id: sessionId,
      adapter: this.name,
      title: normalizedTitle,
      updatedAt: currentSession?.updatedAt ?? now
    };

    if (runtime) {
      runtime.session = nextSession;
    }
    this.discoveredSessions.set(sessionId, {
      session: { ...nextSession },
      cwd: discovered?.cwd ?? runtime?.cwd,
      sourcePath: discovered?.sourcePath
    });
    this.upsertSession(nextSession);
    return nextSession;
  }

  public async getDiffPreview(sessionId: string): Promise<DiffPreview | undefined> {
    return this.sessions.get(sessionId)?.lastDiff;
  }

  public async getPendingApproval(sessionId: string): Promise<ApprovalRequest | undefined> {
    const runtime = this.sessions.get(sessionId);
    return runtime?.pendingApprovals.values().next().value?.approval;
  }

  public async getPendingChoice(sessionId: string): Promise<ChoiceRequest | undefined> {
    const runtime = this.sessions.get(sessionId);
    return runtime?.pendingChoices.values().next().value?.choice;
  }

  public async getSessionMetrics(sessionId: string): Promise<SessionMetricsSnapshot | undefined> {
    const existing = this.sessions.get(sessionId);
    try {
      const runtime = existing?.sdkSession ? existing : await this.ensureSdkSession(sessionId);
      await this.maybeRefreshContextUsage(runtime, true);
      return runtime.metrics;
    } catch {
      return existing?.metrics;
    }
  }

  public async getSessionHistory(sessionId: string, limit: number) {
    const runtime = this.sessions.get(sessionId);
    const providerSessionId = runtime?.providerSessionId ?? sessionId;
    return getClaudeNativeHistory(this.config.claude.configDir, providerSessionId, limit);
  }

  public async reloadConfiguration(): Promise<void> {
    for (const runtime of this.sessions.values()) {
      this.expireApprovals(runtime, "Claude configuration reloaded");
      this.expireChoices(runtime, "Claude configuration reloaded");
      runtime.recreateSdkOnNextTurn = false;

      if (runtime.streamTask) {
        runtime.interrupted = true;
        runtime.session.state = "interrupted";
        runtime.session.updatedAt = nowIso();
        this.upsertSession(runtime.session);
      }

      runtime.sdkSession?.close();
      runtime.sdkSession = undefined;
    }
  }

  public async onSessionConfigurationUpdated(sessionId: string): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) {
      return;
    }

    if (runtime.streamTask) {
      runtime.recreateSdkOnNextTurn = true;
      return;
    }

    runtime.sdkSession?.close();
    runtime.sdkSession = undefined;
    runtime.recreateSdkOnNextTurn = false;
    this.runtimeMetadataCache = undefined;
  }

  public async getRuntimeMetadata(options?: { force?: boolean }): Promise<ProviderRuntimeMetadata> {
    const cacheTtlMs = 10 * 60 * 1000;
    if (
      !options?.force &&
      this.runtimeMetadataCache &&
      Date.now() - this.runtimeMetadataCache.fetchedAtMs < cacheTtlMs
    ) {
      return this.runtimeMetadataCache.metadata;
    }

    const metadata = await this.readRuntimeMetadataFromSdk();
    this.runtimeMetadataCache = { fetchedAtMs: Date.now(), metadata };
    return metadata;
  }

  private async ensureRuntime(sessionId: string): Promise<ClaudeSessionRuntime> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      const discovered = this.discoveredSessions.get(sessionId);
      if (discovered?.cwd && !existing.cwd) {
        existing.cwd = this.resolveRuntimeWorkspace(discovered.cwd);
      }
      existing.session = mergeDiscoveredSession(existing.session, discovered);
      return existing;
    }
    const discovered = this.ensureDiscoveredSession(sessionId);
    const runtime: ClaudeSessionRuntime = {
      session: { ...discovered.session },
      providerSessionId: sessionId,
      cwd: discovered.cwd ? this.resolveRuntimeWorkspace(discovered.cwd) : undefined,
      changedFiles: new Set<string>(),
      pendingApprovals: new Map<string, PendingClaudeApproval>(),
      pendingChoices: new Map<string, PendingClaudeChoice>(),
      observedToolUses: new Map<string, ClaudeObservedToolUse>(),
      emittedToolUseStarts: new Set<string>(),
      emittedToolUseResults: new Set<string>(),
      interrupted: false,
      sawPartialInCurrentTurn: false,
      recreateSdkOnNextTurn: false
    };
    this.sessions.set(sessionId, runtime);
    return runtime;
  }

  private async ensureSdkSession(sessionId: string): Promise<ClaudeSessionRuntime> {
    const runtime = await this.ensureRuntime(sessionId);
    if (runtime.sdkSession && !runtime.recreateSdkOnNextTurn) {
      return runtime;
    }

    if (runtime.sdkSession) {
      runtime.sdkSession.close();
      runtime.sdkSession = undefined;
    }

    const sdk = await this.loadSdk();
    const options = this.buildSdkOptions(runtime);
    runtime.sdkSession = runtime.providerSessionId
      ? sdk.unstable_v2_resumeSession(runtime.providerSessionId, options)
      : sdk.unstable_v2_createSession(options);

    runtime.recreateSdkOnNextTurn = false;
    this.captureProviderSessionId(runtime);
    return runtime;
  }

  private createRuntime(workspacePath: string): ClaudeSessionRuntime {
    return {
      session: {
        id: buildClaudeDraftSessionId(),
        adapter: this.name,
        title: "",
        state: "idle",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        lastInput: null,
        lastOutput: null
      },
      cwd: workspacePath,
      changedFiles: new Set<string>(),
      pendingApprovals: new Map<string, PendingClaudeApproval>(),
      pendingChoices: new Map<string, PendingClaudeChoice>(),
      observedToolUses: new Map<string, ClaudeObservedToolUse>(),
      emittedToolUseStarts: new Set<string>(),
      emittedToolUseResults: new Set<string>(),
      interrupted: false,
      sawPartialInCurrentTurn: false,
      recreateSdkOnNextTurn: false
    };
  }

  private async loadSdk(): Promise<ClaudeSdkModule> {
    if (!this.sdkModulePromise) {
      this.sdkModulePromise = new Function(
        "specifier",
        "return import(specifier)"
      )("@anthropic-ai/claude-agent-sdk") as Promise<ClaudeSdkModule>;
    }

    return this.sdkModulePromise;
  }

  private buildSdkOptions(runtime: ClaudeSessionRuntime): Record<string, unknown> {
    const getSessionId = () => runtime.session.id;
    const runtimeConfig = this.providerConfigs.getClaudeRuntimeConfig(runtime.session.id);
    const cwd = path.resolve(runtime.cwd ?? this.config.defaultWorkspaceDir);
    const env = buildProviderProcessEnv(this.config.claude.homeDir, {
      ANTHROPIC_BASE_URL: this.config.claude.baseUrl,
      ANTHROPIC_AUTH_TOKEN: this.config.claude.apiKey,
      ANTHROPIC_API_KEY: this.config.claude.apiKey,
      CLAUDE_AGENT_SDK_CLIENT_APP: "codefly-host-client/0.1.0",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: this.config.claude
        .disableNonessentialTraffic
        ? "1"
        : "0",
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: this.config.claude
        .disableExperimentalBetas
        ? "1"
        : "0",
      PWD: cwd,
      ...runtimeConfig.env
    });
    return {
      model: runtimeConfig.model,
      cwd,
      permissionMode: runtimeConfig.permissionMode,
      includePartialMessages: true,
      pathToClaudeCodeExecutable: resolveClaudeBinary(),
      env,
      spawnClaudeCodeProcess: (options: {
        command: string;
        args: string[];
        cwd?: string;
        env: NodeJS.ProcessEnv;
        signal: AbortSignal;
      }) => {
        const childCwd = path.resolve(options.cwd ?? cwd);
        const childEnv = {
          ...options.env,
          PWD: childCwd
        };
        return spawn(options.command, options.args, {
          cwd: childCwd,
          env: childEnv,
          signal: options.signal,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true
        });
      },
      stderr: (data: string) => {
        const message = data.trim();
        if (message) {
          void this.emitError(`[claude] ${message}`);
        }
      },
      onElicitation: (request: Record<string, unknown>, options: { signal: AbortSignal }) =>
        this.handleElicitation(getSessionId(), request, options.signal),
      canUseTool: (
        toolName: string,
        input: Record<string, unknown>,
        options: ClaudePermissionOptions
      ) => this.handleToolPermission(getSessionId(), toolName, input, options)
    };
  }

  private async readRuntimeMetadataFromSdk(): Promise<ProviderRuntimeMetadata> {
    const runtimeConfig = this.providerConfigs.getClaudeRuntimeConfig();
    const runtime = this.createRuntime(this.config.defaultWorkspaceDir);
    const sdk = await this.loadSdk();
    const sdkSession = sdk.unstable_v2_createSession(this.buildSdkOptions(runtime));
    runtime.sdkSession = sdkSession;

    try {
      const [models, account, commands] = await Promise.all([
        sdkSession.supportedModels
          ? sdkSession.supportedModels()
          : sdkSession.initializationResult
            ? sdkSession.initializationResult().then((result) =>
                Array.isArray(result.models) ? (result.models as Record<string, unknown>[]) : []
              )
            : Promise.resolve([]),
        sdkSession.accountInfo
          ? sdkSession.accountInfo().catch((error) => ({
              error: error instanceof Error ? error.message : String(error)
            }))
          : sdkSession.initializationResult
            ? sdkSession.initializationResult().then((result) =>
                result.account && typeof result.account === "object"
                  ? (result.account as Record<string, unknown>)
                  : {}
              )
            : Promise.resolve({}),
        sdkSession.supportedCommands
          ? sdkSession.supportedCommands().catch(() => [])
          : sdkSession.initializationResult
            ? sdkSession.initializationResult().then((result) =>
                Array.isArray(result.commands)
                  ? (result.commands as Record<string, unknown>[])
                  : Array.isArray(result.supportedCommands)
                    ? (result.supportedCommands as Record<string, unknown>[])
                    : []
              )
            : Promise.resolve([])
      ]);

      const normalizedModels = normalizeClaudeModels(models);
      const availableModels = normalizedModels.length
        ? normalizedModels
        : normalizeClaudeModels([{ id: runtimeConfig.model, displayName: runtimeConfig.model }]);
      const defaultModel = availableModels.some((model) => model.id === runtimeConfig.model)
        ? runtimeConfig.model
        : availableModels[0]?.id ?? runtimeConfig.model;
      const reasoningEffortOptionsByModel = Object.fromEntries(
        availableModels.map((model) => [model.id, model.reasoningEfforts ?? []])
      );

      return {
        provider: "claude",
        recommendedModels: availableModels,
        defaultModel,
        defaultReasoningEffort:
          runtimeConfig.env.CLAUDE_CODE_EFFORT_LEVEL ??
          availableModels.find((model) => model.id === defaultModel)?.reasoningEfforts?.[0]?.id ??
          "medium",
        reasoningEffortsByModel: Object.fromEntries(
          Object.entries(reasoningEffortOptionsByModel).map(([model, efforts]) => [
            model,
            efforts.map((effort) => effort.id)
          ])
        ),
        reasoningEffortOptionsByModel,
        account: normalizeClaudeAccount(account),
        quota: this.latestRateLimitInfo ? normalizeClaudeQuota(this.latestRateLimitInfo) : null,
        refreshedAt: nowIso(),
        source: "host",
        error: null,
        permissionModes: ["default", "acceptEdits", "plan", "auto", "bypassPermissions", "dontAsk"],
        defaultPermissionMode: runtimeConfig.permissionMode,
        commands: normalizeClaudeCommands(commands)
      };
    } finally {
      sdkSession.close();
    }
  }

  private async handleToolPermission(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    options: ClaudePermissionOptions
  ): Promise<ClaudePermissionResult> {
    const runtime = await this.ensureRuntime(sessionId);
    const activeSessionId = runtime.session.id;
    this.trackPotentialFileChanges(runtime, toolName, input);
    const runtimeConfig = this.providerConfigs.getClaudeRuntimeConfig(activeSessionId);

    if (!this.runtimeContext) {
      return {
        behavior: "deny",
        message: "No active client is attached to handle approvals.",
        interrupt: true,
        toolUseID: options.toolUseID
      };
    }

    if (runtimeConfig.allowedTools && !runtimeConfig.allowedTools.includes(toolName)) {
      return {
        behavior: "deny",
        message: `Tool ${toolName} is not allowed by the current session configuration.`,
        interrupt: true,
        toolUseID: options.toolUseID
      };
    }

    if (runtimeConfig.disallowedTools?.includes(toolName)) {
      return {
        behavior: "deny",
        message: `Tool ${toolName} is disallowed by the current session configuration.`,
        interrupt: true,
        toolUseID: options.toolUseID
      };
    }

    if (toolName === "AskUserQuestion") {
      await this.emitToolEvent(activeSessionId, toolName, "requested", {
        summary: "Claude wants to ask the user a structured question.",
        input,
        details: buildClaudeToolDetails(toolName, input)
      });
      const elicitation = await this.requestChoiceFromClaude(activeSessionId, runtime, input, options.signal);
      if (!elicitation) {
        return {
          behavior: "allow",
          updatedInput: input,
          toolUseID: options.toolUseID
        };
      }
      if (elicitation.action !== "accept") {
        return {
          behavior: "deny",
          message:
            elicitation.action === "cancel"
              ? "Structured question cancelled by CodeFly user"
              : "Structured question was declined by CodeFly user",
          interrupt: true,
          toolUseID: options.toolUseID
        };
      }
      return {
        behavior: "allow",
        updatedInput: {
          ...input,
          ...(elicitation.content ?? {})
        },
        toolUseID: options.toolUseID
      };
    }

    const approvalId = randomId("appr");
    const approval: ApprovalRequest = {
      id: approvalId,
      sessionId: activeSessionId,
      prompt: buildClaudeApprovalPrompt(toolName, input, options),
      options: ["approve", "deny"],
      status: "pending",
      createdAt: nowIso(),
      handledAt: null
    };

    runtime.session.state = "awaiting_approval";
    runtime.session.updatedAt = nowIso();
    this.upsertSession(runtime.session);
    await this.emitSessionState(activeSessionId, "awaiting_approval", {
      reason: "tool_permission_requested",
      summary: `Claude is waiting for approval for ${toolName}.`,
      waitingFor: "approval",
      providerState: {
        toolName,
        title: options.title
      }
    });
    await this.emitToolEvent(activeSessionId, toolName, "requested", {
      summary: `Claude requested permission for tool ${toolName}.`,
      input,
      details: buildClaudeToolDetails(toolName, input)
    });

    return new Promise<ClaudePermissionResult>((resolve) => {
      const pending: PendingClaudeApproval = {
        approval,
        sessionId: activeSessionId,
        toolInput: input,
        toolUseID: options.toolUseID,
        resolve: (result) => {
          options.signal?.removeEventListener("abort", onAbort);
          resolve(result);
        }
      };

      const onAbort = () => {
        if (!runtime.pendingApprovals.has(approvalId)) {
          return;
        }

        runtime.pendingApprovals.delete(approvalId);
        approval.status = "expired";
        approval.handledAt = nowIso();
        runtime.session.state = "running";
        runtime.session.updatedAt = nowIso();
        this.upsertSession(runtime.session);
        resolve({
          behavior: "deny",
          message: "Approval request aborted",
          interrupt: true,
          toolUseID: options.toolUseID
        });
      };

      options.signal?.addEventListener("abort", onAbort, { once: true });
      runtime.pendingApprovals.set(approvalId, pending);
      void this.emit({
        type: "approval_request",
        sessionId: activeSessionId,
        timestamp: nowIso(),
        payload: approval
      });
    });
  }

  private async handleElicitation(
    sessionId: string,
    request: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<ClaudeElicitationResult> {
    const runtime = await this.ensureRuntime(sessionId);
    const activeSessionId = runtime.session.id;
    const result = await this.requestChoiceFromClaude(activeSessionId, runtime, request, signal);
    return result ?? { action: "decline" };
  }

  private async requestChoiceFromClaude(
    activeSessionId: string,
    runtime: ClaudeSessionRuntime,
    request: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<ClaudeElicitationResult | undefined> {
    const choice = buildClaudeChoiceRequest(activeSessionId, request);
    if (!choice || !this.runtimeContext) {
      return undefined;
    }

    runtime.session.state = "awaiting_choice";
    runtime.session.updatedAt = nowIso();
    this.upsertSession(runtime.session);
    await this.emitSessionState(activeSessionId, "awaiting_choice", {
      reason: "elicitation_requested",
      summary: "Claude is waiting for structured user input.",
      waitingFor: "choice",
      providerState: request
    });

    return new Promise<ClaudeElicitationResult>((resolve) => {
      const pending: PendingClaudeChoice = {
        choice,
        sessionId: activeSessionId,
        responseMode:
          Array.isArray(request.questions) && request.questions.length > 0
            ? "ask_user_question"
            : "field_values",
        resolve: (result) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(result);
        }
      };

      const onAbort = () => {
        if (!runtime.pendingChoices.has(choice.id)) {
          return;
        }

        runtime.pendingChoices.delete(choice.id);
        choice.status = "expired";
        choice.handledAt = nowIso();
        runtime.session.state = "running";
        runtime.session.updatedAt = nowIso();
        this.upsertSession(runtime.session);
        resolve({
          action: "cancel"
        });
      };

      signal?.addEventListener("abort", onAbort, { once: true });
      runtime.pendingChoices.set(choice.id, pending);
      void this.emit({
        type: "choice_request",
        sessionId: activeSessionId,
        timestamp: nowIso(),
        payload: choice
      });
    });
  }

  private async pumpStream(runtime: ClaudeSessionRuntime): Promise<void> {
    if (!runtime.sdkSession) {
      return;
    }

    try {
      for await (const message of runtime.sdkSession.stream()) {
        this.captureProviderSessionId(runtime, message);
        const activeSessionId = runtime.session.id;
        await this.emitProviderEvent(
          activeSessionId,
          inferClaudeMessageDirection(message),
          inferClaudeMessageName(message),
          buildClaudeMessageSummary(message),
          message
        );
        await this.handleStreamMessage(runtime, message);
      }
    } catch (error) {
      if (!runtime.interrupted) {
        runtime.session.state = "error";
        runtime.session.updatedAt = nowIso();
        this.upsertSession(runtime.session);
        await this.emitSessionState(runtime.session.id, "error", {
          reason: "stream_error",
          summary: error instanceof Error ? error.message : "Claude session stream failed",
          waitingFor: "none"
        });
        await this.emitError(
          error instanceof Error ? error.message : "Claude session stream failed"
        );
      }
      return;
    } finally {
      if (runtime.pendingApprovals.size > 0) {
        this.expireApprovals(runtime, runtime.interrupted ? "Session interrupted" : "Turn ended");
      }
      if (runtime.pendingChoices.size > 0) {
        this.expireChoices(runtime, runtime.interrupted ? "Session interrupted" : "Turn ended");
      }
    }

    if (runtime.interrupted) {
      runtime.session.state = "interrupted";
      runtime.session.updatedAt = nowIso();
      this.upsertSession(runtime.session);
      await this.emitSessionState(runtime.session.id, "interrupted", {
        reason: "session_interrupted",
        summary: `Claude session ${runtime.session.id} was interrupted.`,
        waitingFor: "none"
      });
      finishTranscriptTurn(runtime);
      return;
    }

    if (runtime.session.state === "running") {
      runtime.session.state = "idle";
      runtime.session.updatedAt = nowIso();
      this.upsertSession(runtime.session);
      await this.emitSessionState(runtime.session.id, "idle", {
        reason: "turn_completed",
        summary: `Claude session ${runtime.session.id} completed.`,
        waitingFor: "none"
      });
    }
  }

  private async handleStreamMessage(
    runtime: ClaudeSessionRuntime,
    message: Record<string, unknown>
  ): Promise<void> {
    const activeSessionId = runtime.session.id;
    const type = String(message.type ?? "");
    switch (type) {
      case "stream_event": {
        await this.updateUsageMetricsFromMessage(runtime, message);
        const streamEvent = (message.event ?? {}) as Record<string, unknown>;
        const streamEventType = extractString(streamEvent.type);
        const deltaType = extractString((streamEvent.delta as Record<string, unknown> | undefined)?.type);
        if (deltaType === "compaction_delta") {
          runtime.compactionActive = true;
          await this.updateCompressionMetrics(
            runtime,
            "compressing",
            "Compressing context…",
            streamEvent
          );
        } else if (streamEventType === "content_block_stop" && runtime.compactionActive) {
          runtime.compactionActive = false;
          await this.updateCompressionMetrics(runtime, "compressed", "Context compressed.", streamEvent);
          void this.maybeRefreshContextUsage(runtime, true);
        }
        const chunk = extractClaudeStreamChunk(message.event);
        if (chunk) {
          runtime.sawPartialInCurrentTurn = true;
          await this.emitAssistantDelta(activeSessionId, chunk);
        }
        return;
      }
      case "assistant": {
        await this.updateUsageMetricsFromMessage(runtime, message);
        for (const toolUse of extractClaudeToolUses(message.message)) {
          this.rememberClaudeToolUse(runtime, toolUse);
          await this.emitClaudeToolUseStart(activeSessionId, runtime, toolUse);
        }
        const content = extractClaudeAssistantText(message.message);
        if (content) {
          const previousText = runtime.session.lastOutput ?? "";
          const missingChunk = content.startsWith(previousText)
            ? content.slice(previousText.length)
            : runtime.sawPartialInCurrentTurn
              ? ""
              : content;
          if (missingChunk) {
            await this.emitAssistantDelta(activeSessionId, missingChunk);
          }
        }
        if (typeof message.error === "string" && message.error) {
          runtime.session.state = "error";
          runtime.session.updatedAt = nowIso();
          this.upsertSession(runtime.session);
          await this.emitError(`Claude assistant error: ${message.error}`);
        }
        return;
      }
      case "user": {
        for (const toolResult of extractClaudeToolResults(message.message)) {
          await this.emitClaudeToolUseResult(activeSessionId, runtime, toolResult);
        }
        return;
      }
      case "tool_progress": {
        const toolUseId = extractString(message.tool_use_id) ?? extractString(message.toolUseId);
        const toolName = extractString(message.tool_name) ?? extractString(message.toolName);
        const observed = toolUseId ? runtime.observedToolUses.get(toolUseId) : undefined;
        const resolvedToolName = observed?.toolName ?? toolName ?? "ClaudeTool";
        const input = observed?.input ?? {};
        await this.emitToolEvent(activeSessionId, resolvedToolName, "progress", {
          summary: buildClaudeToolProgressSummary(resolvedToolName, message),
          details: buildClaudeToolDetails(resolvedToolName, input, message),
          input,
          result: message,
          raw: message,
          ...(toolUseId ? { itemId: toolUseId } : {})
        });
        return;
      }
      case "result": {
        await this.updateUsageMetricsFromMessage(runtime, message);
        if (runtime.compactionActive) {
          runtime.compactionActive = false;
          await this.updateCompressionMetrics(runtime, "compressed", "Context compressed.", message);
        }
        const isError = Boolean(message.is_error);
        runtime.session.state = isError ? "error" : "idle";
        runtime.session.updatedAt = nowIso();
        this.upsertSession(runtime.session);
        await this.emitSessionState(activeSessionId, runtime.session.state, {
          reason: "result",
          summary: isError
            ? "Claude finished the turn with an error."
            : "Claude finished the turn successfully.",
          waitingFor: "none",
          providerState: {
            subtype: message.subtype,
            isError
          }
        });
        finishTranscriptTurn(runtime);

        if (runtime.changedFiles.size > 0) {
          await this.refreshDiffPreview(runtime, true);
        }
        void this.maybeRefreshContextUsage(runtime, true);

        if (isError) {
          const errorMessage =
            typeof message.result === "string" && message.result
              ? message.result
              : `Claude result ${String(message.subtype ?? "error")}`;
          await this.emitError(errorMessage);
        }
        return;
      }
      case "rate_limit_event": {
        const rateLimitInfo = message.rate_limit_info;
        if (rateLimitInfo && typeof rateLimitInfo === "object" && !Array.isArray(rateLimitInfo)) {
          this.latestRateLimitInfo = rateLimitInfo as Record<string, unknown>;
          this.runtimeMetadataCache = undefined;
        }
        return;
      }
      case "system": {
        await this.handleSystemMessage(runtime, message);
        return;
      }
      default:
        return;
    }
  }

  private async handleSystemMessage(
    runtime: ClaudeSessionRuntime,
    message: Record<string, unknown>
  ): Promise<void> {
    const activeSessionId = runtime.session.id;
    const subtype = String(message.subtype ?? "");
    switch (subtype) {
      case "init":
        this.captureProviderSessionId(runtime, message);
        return;
      case "session_state_changed":
        runtime.session.state = mapClaudeSessionState(message.state);
        runtime.session.updatedAt = nowIso();
        this.upsertSession(runtime.session);
        await this.emitSessionState(activeSessionId, runtime.session.state, {
          reason: "session_state_changed",
          summary: `Claude session state changed to ${runtime.session.state}.`,
          waitingFor:
            runtime.session.state === "awaiting_approval"
              ? "approval"
              : runtime.session.state === "awaiting_choice"
                ? "choice"
                : "none",
          providerState: message.state
        });
        return;
      case "files_persisted": {
        const files = Array.isArray(message.files)
          ? message.files
              .map((file) => extractString((file as Record<string, unknown>).filename))
              .filter((value): value is string => Boolean(value))
          : [];
        files.forEach((file) => runtime.changedFiles.add(file));
        await this.emitToolEvent(activeSessionId, "filesystem", "completed", {
          summary: `Claude persisted ${files.length} file change${files.length === 1 ? "" : "s"}.`,
          details: {
            files: files.map((file) => ({
              path: file,
              status: "edited"
            }))
          },
          result: {
            files
          }
        });
        await this.refreshDiffPreview(runtime, true);
        return;
      }
      case "local_command_output": {
        const content = extractString(message.content);
        if (content) {
          await this.emitToolEvent(activeSessionId, "local_command", "output", {
            summary: "Claude emitted local command output.",
            details: buildClaudeToolDetails("local_command", message, {
              content
            }),
            result: {
              content
            }
          });
        }
        return;
      }
      case "post_turn_summary": {
        const plan = buildClaudePlanUpdate(message);
        if (plan) {
          await this.emit({
            type: "plan_update",
            sessionId: activeSessionId,
            timestamp: nowIso(),
            payload: plan
          });
        }
        return;
      }
      case "notification": {
        const text = extractString(message.text);
        if (text) {
          await this.emit({
            type: "error",
            timestamp: nowIso(),
            payload: {
              message: `[claude-notification] ${text}`
            }
          });
        }
        return;
      }
      default:
        return;
    }
  }

  private rememberClaudeToolUse(
    runtime: ClaudeSessionRuntime,
    toolUse: ClaudeObservedToolUse
  ): void {
    runtime.observedToolUses.set(toolUse.id, toolUse);
  }

  private async emitClaudeToolUseStart(
    sessionId: string,
    runtime: ClaudeSessionRuntime,
    toolUse: ClaudeObservedToolUse
  ): Promise<void> {
    if (runtime.emittedToolUseStarts.has(toolUse.id)) {
      return;
    }

    runtime.emittedToolUseStarts.add(toolUse.id);
    await this.emitToolEvent(sessionId, toolUse.toolName, "started", {
      summary: buildClaudeToolStartSummary(toolUse.toolName, toolUse.input),
      details: buildClaudeToolDetails(toolUse.toolName, toolUse.input),
      input: toolUse.input,
      raw: toolUse.raw,
      itemId: toolUse.id
    });
  }

  private async emitClaudeToolUseResult(
    sessionId: string,
    runtime: ClaudeSessionRuntime,
    toolResult: ClaudeToolResultBlock
  ): Promise<void> {
    if (runtime.emittedToolUseResults.has(toolResult.toolUseId)) {
      return;
    }

    runtime.emittedToolUseResults.add(toolResult.toolUseId);
    const observed = runtime.observedToolUses.get(toolResult.toolUseId);
    const toolName = observed?.toolName ?? "ClaudeTool";
    const input = observed?.input ?? {};
    await this.emitToolEvent(sessionId, toolName, "completed", {
      summary: buildClaudeToolResultSummary(toolName, toolResult),
      details: buildClaudeToolDetails(toolName, input, toolResult.raw),
      input,
      result: toolResult.raw,
      raw: toolResult.raw,
      itemId: toolResult.toolUseId
    });
  }

  private captureProviderSessionId(
    runtime: ClaudeSessionRuntime,
    message?: Record<string, unknown>
  ): void {
    const cwd = message ? extractString(message.cwd) : undefined;
    if (cwd) {
      runtime.cwd = path.resolve(cwd);
    }

    const fromMessage = message ? extractString(message.session_id) : undefined;
    if (fromMessage) {
      this.adoptProviderSessionId(runtime, fromMessage);
      return;
    }

    if (!runtime.providerSessionId && runtime.sdkSession) {
      try {
        this.adoptProviderSessionId(runtime, runtime.sdkSession.sessionId);
      } catch {
        // The SDK only exposes the session id after initialization.
      }
    }
  }

  private adoptProviderSessionId(
    runtime: ClaudeSessionRuntime,
    providerSessionId: string
  ): void {
    if (!providerSessionId) {
      return;
    }

    runtime.providerSessionId = providerSessionId;
    if (runtime.session.id === providerSessionId) {
      this.discoveredSessions.set(providerSessionId, {
        session: { ...runtime.session },
        cwd: runtime.cwd
      });
      return;
    }

    const previousSessionId = runtime.session.id;
    this.sessions.delete(previousSessionId);

    runtime.session = {
      ...runtime.session,
      id: providerSessionId,
      title:
        !runtime.session.title || runtime.session.title === previousSessionId
          ? ""
          : runtime.session.title
    };

    if (runtime.lastDiff) {
      runtime.lastDiff = {
        ...runtime.lastDiff,
        id: `diff:${providerSessionId}:${Date.now()}`,
        sessionId: providerSessionId
      };
    }

    for (const pending of runtime.pendingApprovals.values()) {
      pending.sessionId = providerSessionId;
      pending.approval.sessionId = providerSessionId;
    }

    for (const pending of runtime.pendingChoices.values()) {
      pending.sessionId = providerSessionId;
      pending.choice.sessionId = providerSessionId;
    }

    this.sessions.set(providerSessionId, runtime);

    const discovered = this.discoveredSessions.get(previousSessionId);
    if (discovered) {
      this.discoveredSessions.delete(previousSessionId);
    }
    this.discoveredSessions.set(providerSessionId, {
      session: { ...runtime.session },
      cwd: runtime.cwd,
      sourcePath: discovered?.sourcePath
    });

    this.providerConfigs.renameSession("claude", previousSessionId, providerSessionId);
    if (this.runtimeContext?.replaceSession) {
      this.runtimeContext.replaceSession(previousSessionId, runtime.session);
      return;
    }

    this.upsertSession(runtime.session);
  }

  private async refreshDiffPreview(
    runtime: ClaudeSessionRuntime,
    shouldEmit: boolean
  ): Promise<DiffPreview | undefined> {
    const activeSessionId = runtime.session.id;
    const files = Array.from(runtime.changedFiles.values()).sort();
    const diffWorkspace = runtime.cwd ?? this.config.defaultWorkspaceDir;
    let unifiedDiff = "";
    try {
      unifiedDiff = await runGitDiff(diffWorkspace, files);
    } catch (error) {
      if (isIgnorableGitDiffError(error)) {
        runtime.lastDiff = undefined;
        return undefined;
      }
      throw error;
    }
    if (!unifiedDiff.trim()) {
      runtime.lastDiff = undefined;
      return undefined;
    }

    runtime.lastDiff = {
      id: `diff:${activeSessionId}:${Date.now()}`,
      sessionId: activeSessionId,
      summary:
        files.length > 0
          ? `Workspace changes in ${files.length} file${files.length === 1 ? "" : "s"}`
          : "Workspace changes",
      unifiedDiff,
      createdAt: nowIso()
    };

    if (shouldEmit) {
      await this.emit({
        type: "diff_preview",
        sessionId: activeSessionId,
        timestamp: nowIso(),
        payload: runtime.lastDiff
      });
    }

    return runtime.lastDiff;
  }

  private async maybeRefreshContextUsage(
    runtime: ClaudeSessionRuntime,
    force = false
  ): Promise<void> {
    if (!runtime.sdkSession?.getContextUsage) {
      return;
    }
    if (runtime.contextUsageRefreshTask) {
      return runtime.contextUsageRefreshTask;
    }
    const nowMs = Date.now();
    if (!force && runtime.lastContextUsageRefreshAt && nowMs - runtime.lastContextUsageRefreshAt < 1500) {
      return;
    }

    const activeSessionId = runtime.session.id;
    const task = (async () => {
      try {
        const usage = await runtime.sdkSession!.getContextUsage!();
        const typed = usage as {
          totalTokens?: unknown;
          maxTokens?: unknown;
          rawMaxTokens?: unknown;
          percentage?: unknown;
          model?: unknown;
          categories?: Array<{
            name?: unknown;
            tokens?: unknown;
            color?: unknown;
            isDeferred?: unknown;
          }>;
        };
        const usageSnapshot: SessionUsageSnapshot = {
          provider: this.name,
          ...(runtime.metrics?.usage ?? {}),
          model: extractString(typed.model) ?? runtime.metrics?.usage?.model ?? null,
          contextWindowTokens: asNumber(typed.maxTokens),
          usedContextWindowTokens: asNumber(typed.totalTokens),
          contextUsagePercentage: asNumber(typed.percentage),
          categories: Array.isArray(typed.categories)
            ? typed.categories
                .map((category) => ({
                  name: extractString(category.name) ?? "",
                  tokens: asNumber(category.tokens) ?? 0,
                  color: extractString(category.color) ?? null,
                  isDeferred: asBoolean(category.isDeferred) ?? undefined
                }))
                .filter((category) => category.name)
            : runtime.metrics?.usage?.categories,
          updatedAt: nowIso(),
          raw: usage
        };
        usageSnapshot.contextWindowTokens =
          asNumber(typed.maxTokens) ??
          asNumber(typed.rawMaxTokens) ??
          runtime.metrics?.usage?.contextWindowTokens ??
          null;
        usageSnapshot.usedContextWindowTokens = asNumber(typed.totalTokens);
        usageSnapshot.contextUsagePercentage =
          asNumber(typed.percentage) ??
          (usageSnapshot.contextWindowTokens && usageSnapshot.usedContextWindowTokens != null
            ? Math.max(
                0,
                Math.min(
                  100,
                  (usageSnapshot.usedContextWindowTokens / usageSnapshot.contextWindowTokens) * 100
                )
              )
            : null);

        runtime.metrics = {
          ...runtime.metrics,
          usage: usageSnapshot
        };
        runtime.lastContextUsageRefreshAt = Date.now();
        await this.emitSessionMetrics(activeSessionId, runtime.metrics);
      } catch {
        return;
      }
    })().finally(() => {
      runtime.contextUsageRefreshTask = undefined;
    });

    runtime.contextUsageRefreshTask = task;
    return task;
  }

  private async updateUsageMetricsFromMessage(
    runtime: ClaudeSessionRuntime,
    message: Record<string, unknown>
  ): Promise<void> {
    const activeSessionId = runtime.session.id;
    const usage = readClaudeUsageFromMessage(message);
    const modelUsage = readClaudeModelUsage(message);
    const totalCostUsd = asNumber(message.total_cost_usd);
    if (!usage && !modelUsage && totalCostUsd == null) {
      await this.maybeRefreshContextUsage(runtime, false);
      return;
    }

    const nextUsage: SessionUsageSnapshot = {
      provider: this.name,
      ...(runtime.metrics?.usage ?? {}),
      ...(usage ?? {}),
      ...(modelUsage ? { modelUsage } : {}),
      ...(totalCostUsd != null ? { totalCostUsd } : {}),
      updatedAt: nowIso(),
      raw: message
    };
    nextUsage.cachedTokens =
      (nextUsage.cacheCreationInputTokens ?? 0) + (nextUsage.cacheReadInputTokens ?? 0);
    if (
      nextUsage.inputTokens != null ||
      nextUsage.outputTokens != null ||
      nextUsage.cacheCreationInputTokens != null ||
      nextUsage.cacheReadInputTokens != null
    ) {
      nextUsage.totalTokens =
        (nextUsage.inputTokens ?? 0) +
        (nextUsage.outputTokens ?? 0) +
        (nextUsage.cachedTokens ?? 0);
    }

    runtime.metrics = {
      ...runtime.metrics,
      usage: nextUsage
    };
    await this.maybeRefreshContextUsage(runtime, false);
    await this.emitSessionMetrics(activeSessionId, runtime.metrics);
  }

  private async updateCompressionMetrics(
    runtime: ClaudeSessionRuntime,
    state: "compressing" | "compressed" | "idle",
    summary: string,
    raw?: unknown
  ): Promise<void> {
    runtime.metrics = {
      ...runtime.metrics,
      compression:
        state === "idle"
          ? null
          : {
              provider: this.name,
              state,
              summary,
              updatedAt: nowIso(),
              raw
            }
    };
    await this.emitSessionMetrics(runtime.session.id, runtime.metrics);
  }

  private trackPotentialFileChanges(
    runtime: ClaudeSessionRuntime,
    toolName: string,
    input: Record<string, unknown>
  ): void {
    if (!["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(toolName)) {
      return;
    }

    for (const file of extractFilePaths(input)) {
      runtime.changedFiles.add(file);
    }
  }

  private expireApprovals(runtime: ClaudeSessionRuntime, reason: string): void {
    for (const pending of runtime.pendingApprovals.values()) {
      pending.approval.status = "expired";
      pending.approval.handledAt = nowIso();
      pending.resolve({
        behavior: "deny",
        message: reason,
        interrupt: true,
        toolUseID: pending.toolUseID
      });
    }
    runtime.pendingApprovals.clear();
  }

  private expireChoices(runtime: ClaudeSessionRuntime, reason: string): void {
    for (const pending of runtime.pendingChoices.values()) {
      pending.choice.status = "expired";
      pending.choice.handledAt = nowIso();
      pending.resolve({
        action: reason === "Session interrupted" ? "cancel" : "decline"
      });
    }
    runtime.pendingChoices.clear();
  }

  private async emit(message: {
    type:
      | "assistant_delta"
      | "approval_request"
      | "choice_request"
      | "diff_preview"
      | "error"
      | "plan_update"
      | "provider_event"
      | "session_state"
      | "session_metrics"
      | "tool_event";
    timestamp: string;
    sessionId?: string;
    payload: unknown;
  }): Promise<void> {
    if (!this.runtimeContext) {
      return;
    }
    await this.runtimeContext.emit(message);
  }

  private upsertSession(session: AgentSession): void {
    this.runtimeContext?.upsertSession(session);
  }

  private async emitAssistantDelta(sessionId: string, chunk: string): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    const element = runtime
      ? ensureAssistantTranscriptElement(runtime, this.name, sessionId)
      : undefined;
    if (runtime) {
      runtime.session.lastOutput = [runtime.session.lastOutput ?? "", chunk].join("");
      if (runtime.session.state !== "interrupted" && runtime.session.state !== "error") {
        runtime.session.state = "running";
      }
      runtime.session.updatedAt = nowIso();
      this.upsertSession(runtime.session);
    }
    await this.emit({
      type: "assistant_delta",
      sessionId,
      timestamp: nowIso(),
      payload: {
        chunk,
        ...(element
          ? {
              elementId: element.elementId,
              startedAt: element.startedAt,
              sequence: element.sequence
            }
          : {})
      }
    });
  }

  private async emitError(message: string): Promise<void> {
    await this.emit({
      type: "error",
      timestamp: nowIso(),
      payload: { message }
    });
  }

  private async emitProviderEvent(
    sessionId: string,
    direction: "request" | "notification" | "stream" | "control" | "result",
    name: string,
    summary: string,
    raw?: unknown
  ): Promise<void> {
    await this.emit({
      type: "provider_event",
      sessionId,
      timestamp: nowIso(),
      payload: {
        provider: this.name,
        direction,
        name,
        summary,
        raw
      }
    });
  }

  private async emitToolEvent(
    sessionId: string,
    toolName: string,
    phase: "requested" | "started" | "progress" | "completed" | "failed" | "output",
    details: {
      summary: string;
      details?: SessionHistoryEntryDetails;
      input?: unknown;
      result?: unknown;
      raw?: unknown;
      itemId?: string;
    }
  ): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    let element: ReturnType<typeof ensureToolTranscriptElement> | undefined;
    if (runtime) {
      closeAssistantTranscriptElement(runtime);
      element = ensureToolTranscriptElement(
        runtime,
        this.name,
        sessionId,
        toolName,
        details.itemId ?? null
      );
    }
    await this.emit({
      type: "tool_event",
      sessionId,
      timestamp: nowIso(),
      payload: {
        provider: this.name,
        toolName,
        phase,
        summary: details.summary,
        details: details.details,
        input: details.input,
        result: details.result,
        itemId: details.itemId,
        raw: details.raw,
        ...(element
          ? {
              elementId: element.elementId,
              startedAt: element.startedAt,
              sequence: element.sequence
            }
          : {})
      }
    });
  }

  private async emitSessionState(
    sessionId: string,
    state: AgentSession["state"],
    details: {
      summary: string;
      reason?: string;
      waitingFor?: "approval" | "choice" | "provider" | "tool" | "none";
      providerState?: unknown;
    }
  ): Promise<void> {
    await this.emit({
      type: "session_state",
      sessionId,
      timestamp: nowIso(),
      payload: {
        provider: this.name,
        state,
        summary: details.summary,
        reason: details.reason,
        waitingFor: details.waitingFor,
        providerState: details.providerState
      }
    });
  }

  private async emitSessionMetrics(
    sessionId: string,
    metrics: SessionMetricsSnapshot | undefined
  ): Promise<void> {
    if (!metrics) {
      return;
    }
    await this.emit({
      type: "session_metrics",
      sessionId,
      timestamp: nowIso(),
      payload: metrics
    });
  }

  private refreshDiscoveredSessions(): NativeSessionSummary[] {
    const sessions = listClaudeNativeSessions(this.config.claude.configDir);
    this.discoveredSessions.clear();
    for (const session of sessions) {
      this.discoveredSessions.set(session.session.id, {
        session: { ...session.session },
        cwd: session.cwd ? this.resolveRuntimeWorkspace(session.cwd) : undefined,
        sourcePath: session.sourcePath
      });
    }
    return sessions;
  }

  private ensureDiscoveredSession(sessionId: string): NativeSessionSummary {
    const existing = this.discoveredSessions.get(sessionId);
    if (existing) {
      return {
        session: { ...existing.session },
        cwd: existing.cwd ? this.resolveRuntimeWorkspace(existing.cwd) : undefined,
        sourcePath: existing.sourcePath
      };
    }

    const discovered = getClaudeNativeSession(this.config.claude.configDir, sessionId);
    if (!discovered) {
      throw new Error(`Claude session ${sessionId} was not found in provider history`);
    }

    this.discoveredSessions.set(sessionId, {
      session: { ...discovered.session },
      cwd: discovered.cwd ? this.resolveRuntimeWorkspace(discovered.cwd) : undefined,
      sourcePath: discovered.sourcePath
    });
    return {
      ...discovered,
      cwd: discovered.cwd ? this.resolveRuntimeWorkspace(discovered.cwd) : undefined
    };
  }

  private resolveRuntimeWorkspace(cwd: string | undefined): string {
    if (!cwd) {
      return path.resolve(this.config.defaultWorkspaceDir);
    }
    return path.resolve(cwd);
  }
}
