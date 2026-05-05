import type {
  AgentSession,
  AppMessage,
  ApprovalRequest,
  ChoiceAnswer,
  ChoiceRequest,
  DiffPreview,
  ProviderRuntimeMetadata,
  SessionMetricsSnapshot,
  SessionHistorySnapshot
} from "../shared";

export interface SessionRuntimeContext {
  emit: (message: AppMessage) => Promise<void>;
  upsertSession: (session: AgentSession) => void;
  replaceSession?: (previousSessionId: string, session: AgentSession) => void;
}

export interface AgentAdapter {
  readonly name: string;
  listSessions(): Promise<AgentSession[]>;
  startSession(workspacePath: string, context: SessionRuntimeContext): Promise<AgentSession>;
  attachSession(sessionId: string, context: SessionRuntimeContext): Promise<AgentSession>;
  sendInput(
    sessionId: string,
    input: string,
    context: SessionRuntimeContext
  ): Promise<AgentSession>;
  respondToApproval(
    sessionId: string,
    approvalId: string,
    decision: "approve" | "deny",
    context: SessionRuntimeContext
  ): Promise<void>;
  respondToChoice(
    sessionId: string,
    choiceId: string,
    answers: ChoiceAnswer[],
    context: SessionRuntimeContext
  ): Promise<void>;
  resumeSession(sessionId: string, context: SessionRuntimeContext): Promise<void>;
  interruptSession(sessionId: string, context: SessionRuntimeContext): Promise<void>;
  renameSessionTitle?(
    sessionId: string,
    title: string,
    context: SessionRuntimeContext
  ): Promise<AgentSession>;
  getDiffPreview(sessionId: string): Promise<DiffPreview | undefined>;
  getPendingApproval(sessionId: string): Promise<ApprovalRequest | undefined>;
  getPendingChoice(sessionId: string): Promise<ChoiceRequest | undefined>;
  getSessionMetrics?(sessionId: string): Promise<SessionMetricsSnapshot | undefined>;
  getRuntimeMetadata?(options?: { force?: boolean }): Promise<ProviderRuntimeMetadata>;
  getSessionHistory(
    sessionId: string,
    limit: number
  ): Promise<SessionHistorySnapshot | undefined>;
  reloadConfiguration?(): Promise<void>;
  onSessionConfigurationUpdated?(sessionId: string): Promise<void>;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
