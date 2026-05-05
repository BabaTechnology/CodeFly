import {
  nowIso,
  type AgentSession,
  type ApprovalRequest,
  type ChoiceAnswer,
  type ChoiceRequest,
  type DiffPreview,
  type ProviderRuntimeMetadata,
  type SessionHistoryEntryDetails,
  type SessionMetricsSnapshot
} from "../shared";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { HostClientConfig } from "../config";
import { ProviderConfigManager } from "../provider-config";
import {
  getCodexNativeHistory,
  getCodexNativeSession,
  isMeaningfulNativeSession,
  listCodexNativeSessions,
  renameCodexNativeSession,
  type NativeSessionSummary
} from "../provider-native-sessions";
import {
  buildProviderProcessEnv,
  shouldRunWithNode
} from "../provider-runtime";
import { AgentAdapter, sleep, type SessionRuntimeContext } from "./base";
import {
  beginTranscriptTurn,
  closeAssistantTranscriptElement,
  ensureAssistantTranscriptElement,
  ensureToolTranscriptElement,
  finishTranscriptTurn,
  type TranscriptElementState
} from "./transcript-elements";
import {
  buildApprovalPrompt,
  buildApprovalResult,
  buildChoiceResult,
  buildCodexChoiceRequest,
  buildCodexPlanUpdate,
  buildCodexToolDetails,
  describeCodexItemActivity,
  extractCodexItemId,
  extractCodexSessionId,
  getCodexDefaultReasoningEffort,
  inferCodexToolName,
  isCodexTraceableItemType,
  mapCodexThreadStatus,
  mapCodexTurnStatus,
  modelsResponseHasError,
  normalizeCodexAccount,
  normalizeCodexCommands,
  normalizeCodexModels,
  normalizeCodexQuota,
  readCodexSessionMetrics,
  resolveCodexBinary,
  sanitizeCodexItemForToolEvent,
  sanitizeCodexProviderEventParams,
  shouldEmitCodexProviderEvent,
  summarizeCodexProviderEvent
} from "./codex-helpers";
import { mergeDiscoveredSession } from "./discovered-session";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc?: "2.0";
  id: number;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

interface JsonRpcNotification {
  jsonrpc?: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

interface CodexSessionRuntime extends TranscriptElementState {
  session: AgentSession;
  cwd?: string;
  sourcePath?: string;
  activeTurnId?: string;
  compactionActive?: boolean;
  compactionCompleted?: boolean;
  lastDiff?: DiffPreview;
  metrics?: SessionMetricsSnapshot;
}

function isCompactCommand(input: string): boolean {
  return input.trim().toLowerCase() === "/compact";
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

interface PendingApproval {
  approval: ApprovalRequest;
  requestId: number;
  method: string;
  params: Record<string, unknown>;
  sessionId: string;
}

interface PendingChoice {
  choice: ChoiceRequest;
  requestId: number;
  method: string;
  params: Record<string, unknown>;
  sessionId: string;
}

export class CodexAdapter implements AgentAdapter {
  public readonly name = "codex";

  private readonly sessions = new Map<string, CodexSessionRuntime>();
  private readonly discoveredSessions = new Map<string, NativeSessionSummary>();
  private readonly pendingRequests = new Map<
    number,
    {
      method: string;
      sessionId?: string;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly pendingChoices = new Map<string, PendingChoice>();
  private readonly pendingNativeRefreshes = new Map<string, Promise<void>>();

  private runtimeContext?: SessionRuntimeContext;
  private process?: ChildProcessWithoutNullStreams;
  private readyPromise?: Promise<void>;
  private runtimeMetadataCache?: { fetchedAtMs: number; metadata: ProviderRuntimeMetadata };
  private nextRequestId = 1;

  public constructor(
    private readonly config: HostClientConfig,
    private readonly providerConfigs: ProviderConfigManager
  ) {}

  public async listSessions(): Promise<AgentSession[]> {
    const discovered = this.refreshDiscoveredSessions();
    const merged = new Map<string, AgentSession>();

    for (const session of discovered) {
      if (isMeaningfulNativeSession(session.session)) {
        merged.set(session.session.id, { ...session.session });
      }
    }

    for (const runtime of this.sessions.values()) {
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
    await this.ensureReady();
    const runtimeConfig = this.providerConfigs.getCodexRuntimeConfig();
    const runtimeWorkspace = path.resolve(workspacePath);

    const result = (await this.request("thread/start", {
      cwd: runtimeWorkspace,
      model: runtimeConfig.model,
      ...(runtimeConfig.reasoningEffort
        ? { reasoningEffort: runtimeConfig.reasoningEffort }
        : {}),
      ...(runtimeConfig.serviceTier ? { serviceTier: runtimeConfig.serviceTier } : {}),
      modelProvider: runtimeConfig.providerName,
      approvalPolicy: runtimeConfig.approvalPolicy,
      approvalsReviewer: runtimeConfig.approvalsReviewer,
      sandbox: runtimeConfig.sandbox,
      personality: runtimeConfig.personality
    })) as { thread?: { id?: string } };

    const threadId = String(result.thread?.id ?? "");
    if (!threadId) {
      throw new Error("Codex thread/start did not return a thread id");
    }

    const session: AgentSession = {
      id: threadId,
      adapter: this.name,
      title: threadId,
      state: "idle",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastInput: null,
      lastOutput: null
    };

    this.sessions.set(threadId, { session, cwd: runtimeWorkspace });
    this.discoveredSessions.set(threadId, {
      session: { ...session },
      cwd: runtimeWorkspace
    });
    this.upsertSession(session);
    return session;
  }

  public async attachSession(
    sessionId: string,
    context: SessionRuntimeContext
  ): Promise<AgentSession> {
    this.runtimeContext = context;
    const runtime = await this.ensureSessionRuntime(sessionId);
    void this.refreshSessionMetrics(runtime, true);
    return runtime.session;
  }

  public async sendInput(
    sessionId: string,
    input: string,
    context: SessionRuntimeContext
  ): Promise<AgentSession> {
    this.runtimeContext = context;
    const session = await this.ensureSession(sessionId);
    const runtime = this.sessions.get(sessionId)!;
    const runtimeConfig = this.providerConfigs.getCodexRuntimeConfig(sessionId);

    session.lastInput = input;
    session.updatedAt = nowIso();
    session.state = "running";
    this.upsertSession(session);
    if (isCompactCommand(input)) {
      runtime.compactionActive = true;
      await this.updateCompressionMetrics(runtime, "compressing", "Compressing context…", {
        source: "command"
      });
    }
    void this.refreshSessionMetrics(runtime, true);

    const inputPayload = [{ type: "text", text: input }];
    const result = runtime.activeTurnId
      ? ((await this.request("turn/steer", {
          threadId: sessionId,
          expectedTurnId: runtime.activeTurnId,
          input: inputPayload
        })) as { turn?: { id?: string } })
      : ((await this.request("turn/start", {
          threadId: sessionId,
          input: inputPayload,
          model: runtimeConfig.model,
          ...(runtimeConfig.reasoningEffort
            ? { reasoningEffort: runtimeConfig.reasoningEffort }
            : {}),
          ...(runtimeConfig.serviceTier ? { serviceTier: runtimeConfig.serviceTier } : {}),
          modelProvider: runtimeConfig.providerName,
          approvalPolicy: runtimeConfig.approvalPolicy,
          approvalsReviewer: runtimeConfig.approvalsReviewer,
          sandbox: runtimeConfig.sandbox,
          personality: runtimeConfig.personality
        })) as { turn?: { id?: string } });

    if (result.turn?.id) {
      runtime.activeTurnId = result.turn.id;
      beginTranscriptTurn(runtime, result.turn.id);
    }

    return session;
  }

  public async respondToApproval(
    sessionId: string,
    approvalId: string,
    decision: "approve" | "deny",
    context: SessionRuntimeContext
  ): Promise<void> {
    this.runtimeContext = context;
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending || pending.sessionId !== sessionId) {
      throw new Error("Approval request not found");
    }

    this.pendingApprovals.delete(approvalId);
    const payload = buildApprovalResult(pending.method, pending.params, decision);
    this.send({
      jsonrpc: "2.0",
      id: pending.requestId,
      result: payload
    });

    const runtime = this.sessions.get(sessionId);
    if (runtime) {
      runtime.session.state = "running";
      runtime.session.updatedAt = nowIso();
      this.upsertSession(runtime.session);
    }
  }

  public async respondToChoice(
    sessionId: string,
    choiceId: string,
    answers: ChoiceAnswer[],
    context: SessionRuntimeContext
  ): Promise<void> {
    this.runtimeContext = context;
    const pending = this.pendingChoices.get(choiceId);
    if (!pending || pending.sessionId !== sessionId) {
      throw new Error("Choice request not found");
    }

    this.pendingChoices.delete(choiceId);
    this.send({
      jsonrpc: "2.0",
      id: pending.requestId,
      result: buildChoiceResult(pending.method, pending.params, answers)
    });

    const runtime = this.sessions.get(sessionId);
    if (runtime) {
      runtime.session.state = "running";
      runtime.session.updatedAt = nowIso();
      this.upsertSession(runtime.session);
    }
  }

  public async resumeSession(
    sessionId: string,
    context: SessionRuntimeContext
  ): Promise<void> {
    this.runtimeContext = context;
    const session = await this.ensureSession(sessionId);
    session.state = "idle";
    session.updatedAt = nowIso();
    this.upsertSession(session);
    await this.emitSessionState(sessionId, "idle", {
      reason: "session_resumed",
      summary: `Codex session ${sessionId} resumed.`,
      waitingFor: "none"
    });
  }

  public async interruptSession(
    sessionId: string,
    context: SessionRuntimeContext
  ): Promise<void> {
    this.runtimeContext = context;
    const runtime = this.sessions.get(sessionId) ?? (await this.ensureSessionRuntime(sessionId));
    if (runtime?.activeTurnId) {
      await this.request("turn/interrupt", {
        threadId: sessionId,
        turnId: runtime.activeTurnId
      });
      runtime.activeTurnId = undefined;
    }
    finishTranscriptTurn(runtime);

    const session = runtime.session;
    session.state = "interrupted";
    session.updatedAt = nowIso();
    this.upsertSession(session);
    await this.emitSessionState(sessionId, "interrupted", {
      reason: "session_interrupted",
      summary: `Codex session ${sessionId} interrupted.`,
      waitingFor: "none"
    });
    await this.emitAssistantDelta(sessionId, `Session ${sessionId} interrupted.`);
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

    const persisted = renameCodexNativeSession(
      this.config.codex.configDir,
      sessionId,
      normalizedTitle
    );
    const runtime = this.sessions.get(sessionId);
    const discovered =
      this.discoveredSessions.get(sessionId) ??
      getCodexNativeSession(this.config.codex.configDir, sessionId);

    if (!persisted && !runtime && !discovered) {
      throw new Error(`Codex session ${sessionId} was not found`);
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
      cwd: discovered?.cwd
        ? this.resolveRuntimeWorkspace(discovered.cwd)
        : runtime?.cwd
          ? this.resolveRuntimeWorkspace(runtime.cwd)
          : undefined,
      sourcePath: discovered?.sourcePath ?? runtime?.sourcePath
    });
    this.upsertSession(nextSession);
    return nextSession;
  }

  public async getDiffPreview(sessionId: string): Promise<DiffPreview | undefined> {
    return this.sessions.get(sessionId)?.lastDiff;
  }

  public async getPendingApproval(sessionId: string): Promise<ApprovalRequest | undefined> {
    return Array.from(this.pendingApprovals.values()).find(
      (approval) => approval.sessionId === sessionId
    )?.approval;
  }

  public async getPendingChoice(sessionId: string): Promise<ChoiceRequest | undefined> {
    return Array.from(this.pendingChoices.values()).find(
      (choice) => choice.sessionId === sessionId
    )?.choice;
  }

  public async getSessionMetrics(
    sessionId: string
  ): Promise<SessionMetricsSnapshot | undefined> {
    const runtime = this.sessions.get(sessionId);
    if (runtime) {
      return this.refreshSessionMetrics(runtime, false);
    }

    const discovered = this.discoveredSessions.get(sessionId) ?? getCodexNativeSession(
      this.config.codex.configDir,
      sessionId
    );
    return readCodexSessionMetrics(this.config.codex.configDir, sessionId, discovered?.sourcePath);
  }

  public async getSessionHistory(sessionId: string, limit: number) {
    return getCodexNativeHistory(this.config.codex.configDir, sessionId, limit);
  }

  public async reloadConfiguration(): Promise<void> {
    this.failPending("Codex configuration reloaded");

    for (const runtime of this.sessions.values()) {
      runtime.activeTurnId = undefined;
      finishTranscriptTurn(runtime);
      if (runtime.session.state === "running" || runtime.session.state === "awaiting_approval") {
        runtime.session.state = "interrupted";
        runtime.session.updatedAt = nowIso();
        this.upsertSession(runtime.session);
      }
    }

    this.sessions.clear();
    this.process?.kill();
    this.process = undefined;
    this.readyPromise = undefined;
  }

  public async onSessionConfigurationUpdated(_sessionId: string): Promise<void> {
    // Codex session overlays are read when the next turn starts or resumes.
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

    await this.ensureReady();
    const fetchedAt = nowIso();
    const runtimeConfig = this.providerConfigs.getCodexRuntimeConfig();
    const [modelsResponse, accountResponse, quotaResponse, skillsResponse] = await Promise.all([
      this.request("model/list", { includeHidden: false }).catch((error) => ({ error })),
      this.request("account/read", { refreshToken: false }).catch((error) => ({ error })),
      this.request("account/rateLimits/read").catch((error) => ({ error })),
      this.request("skills/list", {
        cwds: [this.config.defaultWorkspaceDir],
        forceReload: Boolean(options?.force)
      }).catch((error) => ({ error }))
    ]);

    const modelError = modelsResponseHasError(modelsResponse) ? modelsResponse.error : undefined;
    const models = modelError ? [] : normalizeCodexModels(modelsResponse);
    const defaultModel =
      models.find((model) => model.isDefault)?.id ||
      (models.some((model) => model.id === runtimeConfig.model) ? runtimeConfig.model : "") ||
      models[0]?.id ||
      runtimeConfig.model;
    const reasoningEffortOptionsByModel = Object.fromEntries(
      models.map((model) => [model.id, model.reasoningEfforts ?? []])
    );
    const reasoningEffortsByModel = Object.fromEntries(
      Object.entries(reasoningEffortOptionsByModel).map(([model, options]) => [
        model,
        options.map((option) => option.id)
      ])
    );

    const metadata: ProviderRuntimeMetadata = {
      provider: "codex",
      recommendedModels: models,
      defaultModel,
      defaultReasoningEffort:
        getCodexDefaultReasoningEffort(modelsResponse, defaultModel) ??
        runtimeConfig.reasoningEffort ??
        models.find((model) => model.id === defaultModel)?.reasoningEfforts?.[0]?.id ??
        "medium",
      reasoningEffortsByModel,
      reasoningEffortOptionsByModel,
      account: modelsResponseHasError(accountResponse)
        ? {
            kind: "unknown",
            requiresAuth: true,
            raw: { error: accountResponse.error.message }
          }
        : normalizeCodexAccount(accountResponse),
      quota: modelsResponseHasError(quotaResponse) ? null : normalizeCodexQuota(quotaResponse),
      refreshedAt: fetchedAt,
      source: "host",
      error: modelError instanceof Error ? modelError.message : null,
      approvalPolicies: ["untrusted", "on-request", "never", "granular"],
      defaultApprovalPolicy: runtimeConfig.approvalPolicy,
      sandboxModes: ["read-only", "workspace-write", "danger-full-access"],
      defaultSandboxMode: runtimeConfig.sandbox,
      approvalsReviewers: ["user", "auto_review"],
      defaultApprovalsReviewer:
        runtimeConfig.approvalsReviewer === "guardian_subagent"
          ? "auto_review"
          : runtimeConfig.approvalsReviewer,
      personalityOptions: ["pragmatic", "default"],
      defaultPersonality: runtimeConfig.personality,
      commands: modelsResponseHasError(skillsResponse) ? [] : normalizeCodexCommands(skillsResponse)
    };

    this.runtimeMetadataCache = { fetchedAtMs: Date.now(), metadata };
    return metadata;
  }

  private async ensureReady(): Promise<void> {
    if (this.readyPromise) {
      return this.readyPromise;
    }

    this.readyPromise = this.startProcess();
    return this.readyPromise;
  }

  private async startProcess(): Promise<void> {
    this.providerConfigs.ensureBootstrapFiles();
    this.writeCodexAuth();

    const binary = resolveCodexBinary();
    if (!existsSync(binary)) {
      throw new Error(`Codex CLI not found at ${binary}`);
    }

    const command = shouldRunWithNode(binary) ? process.execPath : binary;
    const args = shouldRunWithNode(binary) ? [binary, "app-server"] : ["app-server"];
    const child = spawn(command, args, {
      cwd: this.config.defaultWorkspaceDir,
      env: buildProviderProcessEnv(this.config.codex.homeDir, {
        CODEX_HOME: this.config.codex.configDir,
        OPENAI_API_KEY: this.config.codex.apiKey,
        PWD: this.config.defaultWorkspaceDir
      }),
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.process = child;

    const stdout = createInterface({ input: child.stdout });
    stdout.on("line", (line) => this.handleLine(line));

    child.stderr.on("data", (chunk) => {
      const message = chunk.toString().trim();
      if (!message) {
        return;
      }
      void this.emitError(message);
    });

    child.on("exit", (code, signal) => {
      const reason = `Codex app-server exited (${code ?? "null"}${signal ? `, ${signal}` : ""})`;
      this.failPending(reason);
      this.process = undefined;
      this.readyPromise = undefined;
    });

    await this.request("initialize", {
      clientInfo: {
        name: "codefly-host-client",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });
  }

  private writeCodexAuth(): void {
    const codexConfigDir = this.config.codex.configDir;
    mkdirSync(codexConfigDir, { recursive: true });
    if (this.config.codex.apiKey) {
      writeFileSync(
        path.resolve(codexConfigDir, "auth.json"),
        JSON.stringify(
          {
            OPENAI_API_KEY: this.config.codex.apiKey
          },
          null,
          2
        ),
        "utf8"
      );
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let message: JsonRpcResponse | JsonRpcRequest | JsonRpcNotification;
    try {
      message = JSON.parse(trimmed) as JsonRpcResponse | JsonRpcRequest | JsonRpcNotification;
    } catch {
      void this.emitError(`Unparseable Codex app-server output: ${trimmed}`);
      return;
    }

    if ("id" in message && ("result" in message || "error" in message) && !("method" in message)) {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) {
        return;
      }

      this.pendingRequests.delete(message.id);
      if (pending.sessionId) {
        void this.emitProviderEvent(
          pending.sessionId,
          "result",
          `${pending.method}:response`,
          message.error
            ? `Codex request ${pending.method} failed.`
            : `Codex request ${pending.method} completed.`,
          {
            error: message.error,
            result: message.result
          }
        );
      }
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "Codex request failed"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if ("method" in message && "id" in message) {
      void this.handleServerRequest(message as JsonRpcRequest);
      return;
    }

    if ("method" in message) {
      void this.handleNotification(message as JsonRpcNotification);
    }
  }

  private async handleServerRequest(message: JsonRpcRequest): Promise<void> {
    const params = (message.params ?? {}) as Record<string, unknown>;
    const sessionId = extractCodexSessionId(params) ?? "";
    if (!sessionId) {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32602,
          message: "Missing threadId on approval request"
        }
      } as unknown as JsonRpcRequest);
      return;
    }

    const session = await this.ensureSession(sessionId);
    await this.emitProviderEvent(
      sessionId,
      "request",
      message.method,
      `Codex requested client action via ${message.method}.`,
      params
    );

    const choice = buildCodexChoiceRequest(sessionId, message.method, params, message.id);
    if (choice) {
      this.pendingChoices.set(choice.id, {
        choice,
        requestId: message.id,
        method: message.method,
        params,
        sessionId
      });

      session.state = "awaiting_choice";
      session.updatedAt = nowIso();
      this.upsertSession(session);
      await this.emitSessionState(sessionId, "awaiting_choice", {
        reason: "provider_choice_request",
        summary: `Codex is waiting for input via ${message.method}.`,
        waitingFor: "choice",
        providerState: {
          method: message.method
        }
      });
      await this.emit({
        type: "choice_request",
        sessionId,
        timestamp: nowIso(),
        payload: choice
      });
      return;
    }

    const approvalId = `${message.method}:${message.id}`;
    const approval: ApprovalRequest = {
      id: approvalId,
      sessionId,
      prompt: buildApprovalPrompt(message.method, params),
      options: ["approve", "deny"],
      status: "pending",
      createdAt: nowIso(),
      handledAt: null
    };

    this.pendingApprovals.set(approvalId, {
      approval,
      requestId: message.id,
      method: message.method,
      params,
      sessionId
    });

    session.state = "awaiting_approval";
    session.updatedAt = nowIso();
    this.upsertSession(session);
    await this.emitSessionState(sessionId, "awaiting_approval", {
      reason: "provider_approval_request",
      summary: `Codex is waiting for approval via ${message.method}.`,
      waitingFor: "approval",
      providerState: {
        method: message.method
      }
    });
    await this.emitToolEvent(sessionId, inferCodexToolName(message.method, params), "requested", {
      summary: `Codex requested approval for ${message.method}.`,
      input: params
    });
    await this.emit({
      type: "approval_request",
      sessionId,
      timestamp: nowIso(),
      payload: approval
    });
  }

	  private async handleNotification(message: JsonRpcNotification): Promise<void> {
	    const params = (message.params ?? {}) as Record<string, unknown>;
	    const sessionId = extractCodexSessionId(params) ?? "";
	    if (sessionId) {
	      if (shouldEmitCodexProviderEvent(message.method)) {
	        await this.emitProviderEvent(
	          sessionId,
	          "notification",
	          message.method,
	          summarizeCodexProviderEvent(message.method, params),
	          sanitizeCodexProviderEventParams(message.method, params)
	        );
	      }
	      const planUpdate = buildCodexPlanUpdate(message.method, params);
	      if (planUpdate) {
        await this.emit({
          type: "plan_update",
          sessionId,
          timestamp: nowIso(),
          payload: planUpdate
        });
      }
    }

    switch (message.method) {
      case "error":
        await this.emitError(String(params.message ?? "Codex error"));
        return;
      case "thread/tokenUsage/updated": {
        const runtime = this.sessions.get(sessionId);
        if (runtime) {
          await this.refreshSessionMetrics(runtime, true);
        }
        return;
      }
      case "turn/started": {
        const turnId = String(params.turnId ?? "");
        const runtime = this.sessions.get(sessionId);
        if (runtime && turnId) {
          runtime.activeTurnId = turnId;
          beginTranscriptTurn(runtime, turnId);
          runtime.session.state = "running";
          runtime.session.updatedAt = nowIso();
          this.upsertSession(runtime.session);
          await this.emitSessionState(sessionId, "running", {
            reason: "turn_started",
            summary: `Codex turn ${turnId} started.`,
            waitingFor: "none",
            providerState: {
              turnId
            }
          });
          await this.refreshSessionMetrics(runtime, true);
        }
        return;
      }
      case "turn/completed": {
        const runtime = this.sessions.get(sessionId);
        if (!runtime) {
          return;
        }
        const wasCompacting = Boolean(runtime.compactionActive || runtime.compactionCompleted);
        runtime.compactionActive = false;
        runtime.compactionCompleted = false;
        runtime.activeTurnId = undefined;
        runtime.session.updatedAt = nowIso();
        runtime.session.state = mapCodexTurnStatus(params.turn);
        this.upsertSession(runtime.session);
        await this.emitSessionState(sessionId, runtime.session.state, {
          reason: "turn_completed",
          summary: `Codex turn completed with state ${runtime.session.state}.`,
          waitingFor: "none",
          providerState: params.turn
        });
        finishTranscriptTurn(runtime);
        if (runtime.session.state === "idle" && !runtime.session.lastOutput) {
          void this.scheduleNativeSessionRefresh(sessionId);
        }
        if (wasCompacting) {
          await this.updateCompressionMetrics(runtime, "compressed", "Context compressed.", params.turn);
          return;
        }
        await this.refreshSessionMetrics(runtime, true);
        return;
      }
      case "thread/status/changed": {
        const runtime = this.sessions.get(sessionId);
        if (!runtime) {
          return;
        }
        const statusSummary = summarizeCodexProviderEvent(message.method, params);
        runtime.session.state = mapCodexThreadStatus(params.status);
        runtime.session.updatedAt = nowIso();
        this.upsertSession(runtime.session);
        await this.emitSessionState(sessionId, runtime.session.state, {
          reason: "thread_status_changed",
          summary:
            statusSummary === `Codex emitted ${message.method}.`
              ? `Codex thread status changed to ${runtime.session.state}.`
              : statusSummary,
          waitingFor:
            runtime.session.state === "awaiting_approval"
              ? "approval"
              : runtime.session.state === "awaiting_choice"
                ? "choice"
              : "none",
          providerState: params.status
        });
        if (runtime.session.state === "idle" && !runtime.session.lastOutput) {
          void this.scheduleNativeSessionRefresh(sessionId);
        }
        await this.refreshSessionMetrics(runtime, true);
        return;
      }
      case "item/agentMessage/delta": {
        const delta = String(params.delta ?? "");
        const runtime = this.sessions.get(sessionId);
        if (runtime?.compactionActive) {
          return;
        }
        if (sessionId && delta) {
          await this.emitAssistantDelta(sessionId, delta);
        }
        return;
      }
      case "item/started": {
        const item = (params.item ?? {}) as Record<string, unknown>;
        if (!sessionId || !item.type) {
          return;
        }
        const activity = describeCodexItemActivity(item);
        if (isCodexTraceableItemType(String(item.type))) {
          const sanitizedItem = sanitizeCodexItemForToolEvent(item);
          await this.emitToolEvent(sessionId, String(item.type), "started", {
            summary: activity.summary,
            input: sanitizedItem,
            itemId: extractCodexItemId(item),
            details: buildCodexToolDetails(String(item.type), item, item)
          });
        }
        await this.emitSessionState(sessionId, "running", {
          reason: "item_started",
          summary: activity.activityLabel,
          waitingFor: "none",
          providerState: item
        });
        return;
      }
      case "turn/diff/updated": {
        const sessionId = String(params.threadId ?? "");
        const diff = String(params.diff ?? "");
        if (!sessionId || !diff) {
          return;
        }
        const runtime = this.sessions.get(sessionId);
        const preview: DiffPreview = {
          id: `diff:${sessionId}:${String(params.turnId ?? "unknown")}`,
          sessionId,
          summary: "Latest Codex turn diff",
          unifiedDiff: diff,
          createdAt: nowIso()
        };
        if (runtime) {
          runtime.lastDiff = preview;
          await this.emit({
            type: "diff_preview",
            sessionId,
            timestamp: nowIso(),
            payload: preview
          });
        }
        return;
      }
      case "item/completed": {
        const runtime = this.sessions.get(sessionId);
        const item = (params.item ?? {}) as Record<string, unknown>;
        if (runtime && item.type === "agentMessage" && typeof item.text === "string") {
          const finalText = item.text;
          if (runtime.compactionActive || isCompactCompletionText(finalText)) {
            runtime.compactionActive = false;
            runtime.compactionCompleted = true;
            runtime.session.updatedAt = nowIso();
            this.upsertSession(runtime.session);
            await this.updateCompressionMetrics(runtime, "compressed", "Context compressed.", item);
            return;
          }
          const previousText = runtime.session.lastOutput ?? "";
          if (finalText !== previousText) {
            const missingChunk = finalText.startsWith(previousText)
              ? finalText.slice(previousText.length)
              : finalText;
            if (missingChunk) {
              await this.emitAssistantDelta(sessionId, missingChunk);
            }
          }
          runtime.session.lastOutput = finalText;
          runtime.session.updatedAt = nowIso();
          this.upsertSession(runtime.session);
        }
        if (sessionId && item.type && isCodexTraceableItemType(String(item.type))) {
          const sanitizedItem = sanitizeCodexItemForToolEvent(item);
          await this.emitToolEvent(sessionId, String(item.type), "completed", {
            summary: `Codex completed item ${String(item.type)}.`,
            result: sanitizedItem,
            itemId: extractCodexItemId(item),
            details: buildCodexToolDetails(String(item.type), item, item)
          });
        }
        if (runtime && item.type === "fileChange" && Array.isArray(item.changes)) {
          const unifiedDiff = item.changes
            .map((change) => String((change as Record<string, unknown>).diff ?? ""))
            .filter(Boolean)
            .join("\n");
          if (unifiedDiff) {
            runtime.lastDiff = {
              id: `diff:${sessionId}:${String(item.id ?? "item")}`,
              sessionId,
              summary: "Latest Codex file changes",
              unifiedDiff,
              createdAt: nowIso()
            };
          }
        }
        return;
      }
      default:
        if (sessionId && message.method.toLowerCase().includes("compact")) {
          const runtime = this.sessions.get(sessionId);
          if (runtime) {
            await this.refreshSessionMetrics(runtime, true);
          }
        }
        return;
    }
  }

  private async ensureSession(sessionId: string): Promise<AgentSession> {
    return (await this.ensureSessionRuntime(sessionId)).session;
  }

  private async ensureSessionRuntime(sessionId: string): Promise<CodexSessionRuntime> {
    const runtime = this.sessions.get(sessionId);
    if (runtime) {
      const discovered = this.discoveredSessions.get(sessionId);
      if (discovered?.cwd && !runtime.cwd) {
        runtime.cwd = this.resolveRuntimeWorkspace(discovered.cwd);
      }
      if (discovered?.sourcePath && !runtime.sourcePath) {
        runtime.sourcePath = discovered.sourcePath;
      }
      runtime.session = mergeDiscoveredSession(runtime.session, discovered);
      return runtime;
    }

    await this.ensureReady();
    const discovered = this.ensureDiscoveredSession(sessionId);
    const runtimeConfig = this.providerConfigs.getCodexRuntimeConfig(sessionId);
    const session = { ...discovered.session };
    const runtimeWorkspace = this.resolveRuntimeWorkspace(discovered.cwd);

    await this.request("thread/resume", {
      threadId: sessionId,
      cwd: runtimeWorkspace,
      model: runtimeConfig.model,
      ...(runtimeConfig.serviceTier ? { serviceTier: runtimeConfig.serviceTier } : {}),
      modelProvider: runtimeConfig.providerName,
      approvalPolicy: runtimeConfig.approvalPolicy,
      approvalsReviewer: runtimeConfig.approvalsReviewer,
      sandbox: runtimeConfig.sandbox,
      personality: runtimeConfig.personality
    });

    const nextRuntime: CodexSessionRuntime = {
      session,
      cwd: runtimeWorkspace,
      sourcePath: discovered.sourcePath,
      activeTurnId: undefined,
      lastDiff: undefined,
      metrics: undefined
    };
    this.sessions.set(sessionId, nextRuntime);
    return nextRuntime;
  }

  private async scheduleNativeSessionRefresh(sessionId: string): Promise<void> {
    if (this.pendingNativeRefreshes.has(sessionId)) {
      return this.pendingNativeRefreshes.get(sessionId);
    }

    const task = (async () => {
      for (const delay of [250, 750, 1500]) {
        await sleep(delay);
        const runtime = this.sessions.get(sessionId);
        if (!runtime) {
          return;
        }

        const discovered = getCodexNativeSession(this.config.codex.configDir, sessionId);
        if (!discovered) {
          continue;
        }
        const discoveredCwd = discovered.cwd
          ? this.resolveRuntimeWorkspace(discovered.cwd)
          : undefined;

        runtime.cwd = runtime.cwd ?? discoveredCwd;
        runtime.sourcePath = runtime.sourcePath ?? discovered.sourcePath;
        runtime.session = mergeDiscoveredSession(runtime.session, discovered);
        this.discoveredSessions.set(sessionId, {
          session: { ...discovered.session },
          cwd: discoveredCwd,
          sourcePath: discovered.sourcePath
        });
        this.upsertSession(runtime.session);

        if (runtime.session.lastOutput) {
          return;
        }
      }
    })().finally(() => {
      this.pendingNativeRefreshes.delete(sessionId);
    });

    this.pendingNativeRefreshes.set(sessionId, task);
    return task;
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextRequestId++;
      const typedParams = (params ?? {}) as Record<string, unknown>;
      const sessionId = extractCodexSessionId(typedParams);
      this.pendingRequests.set(id, {
        method,
        sessionId,
        resolve,
        reject
      });
      this.send({
        jsonrpc: "2.0",
        id,
        method,
        params
      });
    });
  }

  private send(message: JsonRpcRequest | JsonRpcResponse): void {
    if (!this.process?.stdin.writable) {
      throw new Error("Codex app-server is not available");
    }
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private failPending(reason: string): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(new Error(reason));
    }
    this.pendingRequests.clear();

    for (const approval of this.pendingApprovals.values()) {
      approval.approval.status = "expired";
      approval.approval.handledAt = nowIso();
    }
    this.pendingApprovals.clear();

    for (const choice of this.pendingChoices.values()) {
      choice.choice.status = "expired";
      choice.choice.handledAt = nowIso();
    }
    this.pendingChoices.clear();
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
      | "session_metrics"
      | "session_state"
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
      runtime.session.updatedAt = nowIso();
      if (runtime.session.state !== "interrupted" && runtime.session.state !== "error") {
        runtime.session.state = "running";
      }
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
      itemId?: unknown;
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
        details.itemId == null ? null : String(details.itemId)
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
        raw: details.raw,
        itemId: details.itemId,
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

  private async refreshSessionMetrics(
    runtime: CodexSessionRuntime,
    emitUpdate: boolean
  ): Promise<SessionMetricsSnapshot | undefined> {
    const metrics = readCodexSessionMetrics(
      this.config.codex.configDir,
      runtime.session.id,
      runtime.sourcePath
    );
    if (!metrics) {
      return runtime.metrics;
    }
    runtime.metrics = runtime.compactionActive
      ? {
          ...metrics,
          compression: {
            provider: this.name,
            state: "compressing",
            summary: "Compressing context…",
            updatedAt: nowIso(),
            raw: metrics.compression?.raw
          }
        }
      : metrics;
    if (emitUpdate) {
      await this.emitSessionMetrics(runtime.session.id, runtime.metrics);
    }
    return runtime.metrics;
  }

  private async updateCompressionMetrics(
    runtime: CodexSessionRuntime,
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
    const sessions = listCodexNativeSessions(this.config.codex.configDir);
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

    const discovered = getCodexNativeSession(this.config.codex.configDir, sessionId);
    if (!discovered) {
      throw new Error(`Codex session ${sessionId} was not found in provider history`);
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
