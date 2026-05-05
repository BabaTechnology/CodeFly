import {
  nowIso,
  type AgentSession,
  type AppMessage,
  type ChoiceAnswer,
  type ProviderRuntimeMetadata,
  type SessionEventRecord,
  type SessionHistorySnapshot,
  type SessionSnapshot,
  type SessionStateUpdate
} from "./shared";
import { EventEmitter } from "node:events";
import type { AgentAdapter } from "./adapters/base";

export class SessionManager {
  private readonly events = new EventEmitter();
  private readonly sessions = new Map<string, AgentSession>();
  private readonly sessionQueues = new Map<string, Promise<unknown>>();
  private readonly sessionEvents = new Map<string, SessionEventRecord[]>();
  private readonly sessionAliases = new Map<string, string>();
  private readonly sessionReadAt = new Map<string, string>();

  public constructor(private readonly adapter: AgentAdapter) {}

  public providerName(): string {
    return this.adapter.name;
  }

  public onMessage(listener: (message: AppMessage) => void): void {
    this.events.on("message", listener);
  }

  public listSessions(): AgentSession[] {
    return Array.from(this.sessions.values()).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    );
  }

  public resolveSessionId(sessionId: string): string {
    let resolved = sessionId;
    const seen = new Set<string>();
    while (resolved && this.sessionAliases.has(resolved) && !seen.has(resolved)) {
      seen.add(resolved);
      resolved = this.sessionAliases.get(resolved) ?? resolved;
    }
    return resolved;
  }

  public knowsSession(sessionId: string): boolean {
    const resolvedSessionId = this.resolveSessionId(sessionId);
    return this.sessions.has(resolvedSessionId) || this.sessionAliases.has(sessionId);
  }

  public peekSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(this.resolveSessionId(sessionId));
  }

  public markSessionRead(
    sessionId: string,
    readAt = nowIso(),
    options?: { broadcast?: boolean }
  ): AgentSession | undefined {
    const resolvedSessionId = this.resolveSessionId(sessionId);
    const session = this.sessions.get(resolvedSessionId);
    if (!session) {
      return undefined;
    }

    const nextReadAt = latestIsoTimestamp(
      this.sessionReadAt.get(resolvedSessionId),
      session.lastReadAt ?? null,
      readAt
    );
    if (!nextReadAt || nextReadAt === session.lastReadAt) {
      return session;
    }

    const nextSession = {
      ...session,
      lastReadAt: nextReadAt
    };
    this.sessions.set(resolvedSessionId, nextSession);
    this.sessionReadAt.set(resolvedSessionId, nextReadAt);

    if (options?.broadcast !== false) {
      this.events.emit("message", {
        type: "session_list",
        timestamp: nowIso(),
        payload: {
          sessions: this.listSessions()
        }
      } as AppMessage);
    }

    return nextSession;
  }

  public activeSessionCount(): number {
    return this.listSessions().filter((session) =>
      ["running", "awaiting_approval", "awaiting_choice"].includes(session.state)
    ).length;
  }

  public async hydrate(): Promise<void> {
    await this.refreshSessions();
  }

  public async refreshSessions(): Promise<AgentSession[]> {
    const fromAdapter = await this.adapter.listSessions();
    fromAdapter.forEach((session) => this.upsertSession(session));
    return this.listSessions();
  }

  public async startSession(workspacePath: string): Promise<AgentSession> {
    const session = await this.adapter.startSession(workspacePath, this.context());
    this.upsertSession(session);
    return this.peekSession(session.id) ?? session;
  }

  public async attachSession(sessionId: string): Promise<AgentSession> {
    const session = await this.adapter.attachSession(
      this.resolveSessionId(sessionId),
      this.context()
    );
    this.upsertSession(session);
    return this.peekSession(session.id) ?? session;
  }

  public async tryAttachSession(sessionId: string): Promise<AgentSession | undefined> {
    try {
      return await this.attachSession(sessionId);
    } catch {
      return undefined;
    }
  }

  public async sendInput(sessionId: string, input: string): Promise<AgentSession> {
    return this.enqueueForSession(this.resolveSessionId(sessionId), () =>
      this.adapter.sendInput(this.resolveSessionId(sessionId), input, this.context())
    );
  }

  public async respondToApproval(
    sessionId: string,
    approvalId: string,
    decision: "approve" | "deny"
  ): Promise<void> {
    const resolvedSessionId = this.resolveSessionId(sessionId);
    await this.enqueueForSession(resolvedSessionId, () =>
      this.adapter.respondToApproval(
        this.resolveSessionId(sessionId),
        approvalId,
        decision,
        this.context()
      )
    );
    this.recordAndBroadcast({
      type: "approval_response",
      sessionId: resolvedSessionId,
      timestamp: nowIso(),
      payload: {
        approvalId,
        decision
      }
    });
    this.recordStateUpdate(
      resolvedSessionId,
      "running",
      "approval_response",
      "Approval response submitted."
    );
  }

  public async respondToChoice(
    sessionId: string,
    choiceId: string,
    answers: ChoiceAnswer[]
  ): Promise<void> {
    const resolvedSessionId = this.resolveSessionId(sessionId);
    await this.enqueueForSession(resolvedSessionId, () =>
      this.adapter.respondToChoice(
        this.resolveSessionId(sessionId),
        choiceId,
        answers,
        this.context()
      )
    );
    this.recordAndBroadcast({
      type: "choice_response",
      sessionId: resolvedSessionId,
      timestamp: nowIso(),
      payload: {
        choiceId,
        answers
      }
    });
    this.recordStateUpdate(
      resolvedSessionId,
      "running",
      "choice_response",
      "Choice response submitted."
    );
  }

  public async resumeSession(sessionId: string): Promise<void> {
    await this.enqueueForSession(this.resolveSessionId(sessionId), () =>
      this.adapter.resumeSession(this.resolveSessionId(sessionId), this.context())
    );
  }

  public async interruptSession(sessionId: string): Promise<void> {
    await this.enqueueForSession(this.resolveSessionId(sessionId), () =>
      this.adapter.interruptSession(this.resolveSessionId(sessionId), this.context())
    );
  }

  public async renameSessionTitle(sessionId: string, title: string): Promise<AgentSession> {
    const resolvedSessionId = this.resolveSessionId(sessionId);
    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      throw new Error("Session title is required");
    }

    const session = await this.enqueueForSession(resolvedSessionId, async () => {
      if (this.adapter.renameSessionTitle) {
        return this.adapter.renameSessionTitle(resolvedSessionId, normalizedTitle, this.context());
      }

      const existing = await this.ensureKnownSession(resolvedSessionId);
      if (!existing) {
        throw new Error("Session not found");
      }
      return {
        ...existing,
        title: normalizedTitle
      };
    });

    const nextSession = session as AgentSession;
    this.upsertSession(nextSession);
    this.events.emit("message", {
      type: "session_list",
      timestamp: nowIso(),
      payload: {
        sessions: this.listSessions()
      }
    } as AppMessage);
    return nextSession;
  }

  public async getDiffPreview(sessionId: string) {
    return this.adapter.getDiffPreview(this.resolveSessionId(sessionId));
  }

  public async getPendingApproval(sessionId: string) {
    return this.adapter.getPendingApproval(this.resolveSessionId(sessionId));
  }

  public async getPendingChoice(sessionId: string) {
    return this.adapter.getPendingChoice(this.resolveSessionId(sessionId));
  }

  public async getRuntimeMetadata(options?: { force?: boolean }): Promise<ProviderRuntimeMetadata | undefined> {
    return this.adapter.getRuntimeMetadata?.(options);
  }

  public listSessionEvents(sessionId: string, limit = 100) {
    const safeLimit = Math.min(Math.max(limit, 1), 500);
    return [...(this.sessionEvents.get(this.resolveSessionId(sessionId)) ?? [])].slice(0, safeLimit);
  }

  public async getSessionSnapshot(
    sessionId: string,
    limit = 100
  ): Promise<SessionSnapshot | undefined> {
    let session = await this.ensureKnownSession(sessionId);
    if (!session) {
      return undefined;
    }

    session = await this.backfillIdleSessionOutput(sessionId, session);

    const recentEvents = this.listSessionEvents(sessionId, limit);
    const latestStateEvent = recentEvents.find((event) => event.type === "session_state");

    return {
      session,
      pendingApproval: (await this.getPendingApproval(sessionId)) ?? null,
      pendingChoice: (await this.getPendingChoice(sessionId)) ?? null,
      lastDiff: (await this.getDiffPreview(sessionId)) ?? null,
      latestState: (latestStateEvent?.payload as SessionStateUpdate | undefined) ?? null,
      metrics: (await this.adapter.getSessionMetrics?.(this.resolveSessionId(sessionId))) ?? null,
      recentEvents
    };
  }

  public async getSessionHistory(
    sessionId: string,
    limit = 200
  ): Promise<SessionHistorySnapshot | undefined> {
    return this.adapter.getSessionHistory(this.resolveSessionId(sessionId), limit);
  }

  private async ensureKnownSession(sessionId: string): Promise<AgentSession | undefined> {
    const resolvedSessionId = this.resolveSessionId(sessionId);
    const existing = this.sessions.get(resolvedSessionId);
    if (
      existing &&
      !["running", "awaiting_approval", "awaiting_choice"].includes(existing.state)
    ) {
      return existing;
    }

    const refreshed = await this.refreshSessions();
    const discovered = refreshed.find((session) => session.id === sessionId);
    if (discovered) {
      return discovered;
    }

    try {
      const attached = await this.adapter.attachSession(resolvedSessionId, this.context());
      this.upsertSession(attached);
      return attached;
    } catch {
      return undefined;
    }
  }

  private async backfillIdleSessionOutput(
    sessionId: string,
    session: AgentSession
  ): Promise<AgentSession> {
    if (session.state !== "idle" || session.lastOutput || !session.lastInput) {
      return session;
    }

    const resolvedSessionId = this.resolveSessionId(sessionId);
    for (const delayMs of [0, 250, 750, 1500]) {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }

      const refreshed = await this.refreshSessions();
      const discovered = refreshed.find((candidate) => candidate.id === resolvedSessionId);
      if (!discovered) {
        return session;
      }

      session = discovered;
      if (session.lastOutput || session.state !== "idle") {
        return session;
      }
    }

    return session;
  }

  private context() {
    return {
      emit: async (message: AppMessage) => {
        this.recordAndBroadcast(message);
      },
      upsertSession: (session: AgentSession) => {
        this.upsertSession(session);
        this.events.emit("message", {
          type: "session_list",
          timestamp: nowIso(),
          payload: {
            sessions: this.listSessions()
          }
        } as AppMessage);
      },
      replaceSession: (previousSessionId: string, session: AgentSession) => {
        this.replaceSession(previousSessionId, session);
        this.events.emit("message", {
          type: "session_replace",
          sessionId: session.id,
          timestamp: nowIso(),
          payload: {
            previousSessionId,
            session
          }
        } as AppMessage);
        this.events.emit("message", {
          type: "session_list",
          timestamp: nowIso(),
          payload: {
            sessions: this.listSessions()
          }
        } as AppMessage);
      }
    };
  }

  private recordAndBroadcast(message: AppMessage): void {
    const normalizedMessage =
      message.sessionId && this.resolveSessionId(message.sessionId) !== message.sessionId
        ? {
            ...message,
            sessionId: this.resolveSessionId(message.sessionId)
          }
        : message;

    if (normalizedMessage.sessionId) {
      const record: SessionEventRecord = {
        id: `${normalizedMessage.sessionId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        type: normalizedMessage.type,
        requestId: normalizedMessage.requestId,
        sessionId: normalizedMessage.sessionId,
        timestamp: normalizedMessage.timestamp,
        payload: normalizedMessage.payload
      };
      const currentEvents = this.sessionEvents.get(normalizedMessage.sessionId) ?? [];
      currentEvents.unshift(record);
      if (currentEvents.length > 500) {
        currentEvents.length = 500;
      }
      this.sessionEvents.set(normalizedMessage.sessionId, currentEvents);
    }
    this.events.emit("message", normalizedMessage);
  }

  private recordStateUpdate(
    sessionId: string,
    state: AgentSession["state"],
    reason: string,
    summary: string
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    this.recordAndBroadcast({
      type: "session_state",
      sessionId,
      timestamp: nowIso(),
      payload: {
        provider: session.adapter,
        state,
        reason,
        summary,
        waitingFor: "none"
      }
    });
  }

  private upsertSession(session: AgentSession): void {
    const existing = this.sessions.get(session.id);
    const lastReadAt = latestIsoTimestamp(
      session.lastReadAt ?? null,
      existing?.lastReadAt ?? null,
      this.sessionReadAt.get(session.id) ?? null,
      existing ? null : session.updatedAt
    );
    this.sessions.set(session.id, {
      ...session,
      updatedAt: session.updatedAt ?? nowIso(),
      ...(lastReadAt ? { lastReadAt } : {})
    });
    if (lastReadAt) {
      this.sessionReadAt.set(session.id, lastReadAt);
    }
  }

  private replaceSession(previousSessionId: string, session: AgentSession): void {
    const resolvedPreviousSessionId = this.resolveSessionId(previousSessionId);
    const nextSessionId = session.id;

    if (!resolvedPreviousSessionId || resolvedPreviousSessionId === nextSessionId) {
      this.upsertSession(session);
      return;
    }

    const previousReadAt = latestIsoTimestamp(
      this.sessionReadAt.get(resolvedPreviousSessionId) ?? null,
      this.sessions.get(resolvedPreviousSessionId)?.lastReadAt ?? null,
      this.sessionReadAt.get(nextSessionId) ?? null,
      this.sessions.get(nextSessionId)?.lastReadAt ?? null,
      session.lastReadAt ?? null,
      session.updatedAt
    );

    this.sessions.delete(resolvedPreviousSessionId);
    this.sessions.set(nextSessionId, {
      ...session,
      updatedAt: session.updatedAt ?? nowIso(),
      ...(previousReadAt ? { lastReadAt: previousReadAt } : {})
    });
    this.sessionReadAt.delete(resolvedPreviousSessionId);
    if (previousReadAt) {
      this.sessionReadAt.set(nextSessionId, previousReadAt);
    }

    const previousEvents = this.sessionEvents.get(resolvedPreviousSessionId) ?? [];
    const nextEvents = this.sessionEvents.get(nextSessionId) ?? [];
    if (previousEvents.length > 0 || nextEvents.length > 0) {
      const mergedEvents = [...previousEvents, ...nextEvents]
        .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
        .slice(0, 500);
      this.sessionEvents.set(nextSessionId, mergedEvents);
      this.sessionEvents.delete(resolvedPreviousSessionId);
    }

    const queued = this.sessionQueues.get(resolvedPreviousSessionId);
    if (queued) {
      this.sessionQueues.set(nextSessionId, queued);
      this.sessionQueues.delete(resolvedPreviousSessionId);
    }

    this.sessionAliases.set(previousSessionId, nextSessionId);
    this.sessionAliases.set(resolvedPreviousSessionId, nextSessionId);
    for (const [alias, target] of this.sessionAliases.entries()) {
      if (target === resolvedPreviousSessionId) {
        this.sessionAliases.set(alias, nextSessionId);
      }
    }
  }

  private async enqueueForSession<T>(
    sessionId: string,
    task: () => Promise<T>
  ): Promise<T> {
    const previous = this.sessionQueues.get(sessionId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });

    const queued = previous
      .catch(() => undefined)
      .then(() => current);

    this.sessionQueues.set(
      sessionId,
      queued
    );

    try {
      await previous.catch(() => undefined);
      return await task();
    } finally {
      release?.();
      if (this.sessionQueues.get(sessionId) === queued) {
        this.sessionQueues.delete(sessionId);
      }
    }
  }
}

function latestIsoTimestamp(...values: Array<string | null | undefined>): string | undefined {
  const validValues = values
    .map((value) => value?.trim() ?? "")
    .filter((value) => value.length > 0);
  if (validValues.length === 0) {
    return undefined;
  }
  const sorted = validValues.sort();
  return sorted[sorted.length - 1];
}
