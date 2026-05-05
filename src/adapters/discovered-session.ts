import type { AgentSession } from "../shared";
import type { NativeSessionSummary } from "../provider-native-sessions";

export function mergeDiscoveredSession(
  runtime: AgentSession,
  discovered: NativeSessionSummary | undefined
): AgentSession {
  if (!discovered) {
    return { ...runtime };
  }

  const discoveredIsNewer =
    discovered.session.updatedAt.localeCompare(runtime.updatedAt) > 0;
  const runtimeStateAuthoritative = isLiveSessionState(runtime.state);

  return {
    ...discovered.session,
    ...runtime,
    title: runtime.title && runtime.title !== runtime.id ? runtime.title : discovered.session.title,
    createdAt:
      runtime.createdAt.localeCompare(discovered.session.createdAt) <= 0
        ? runtime.createdAt
        : discovered.session.createdAt,
    state: runtimeStateAuthoritative
      ? runtime.state
      : discoveredIsNewer
        ? discovered.session.state
        : runtime.state,
    updatedAt: runtimeStateAuthoritative
      ? maxTimestamp(runtime.updatedAt, discovered.session.updatedAt)
      : discoveredIsNewer
        ? discovered.session.updatedAt
        : runtime.updatedAt,
    lastInput: runtimeStateAuthoritative
      ? runtime.lastInput ?? discovered.session.lastInput ?? null
      : discoveredIsNewer
        ? discovered.session.lastInput ?? runtime.lastInput ?? null
        : runtime.lastInput ?? discovered.session.lastInput ?? null,
    lastOutput: runtimeStateAuthoritative
      ? runtime.lastOutput ?? discovered.session.lastOutput ?? null
      : discoveredIsNewer
        ? discovered.session.lastOutput ?? runtime.lastOutput ?? null
        : runtime.lastOutput ?? discovered.session.lastOutput ?? null
  };
}

export function isLiveSessionState(state: AgentSession["state"]): boolean {
  return state !== "idle" && state !== "completed";
}

export function maxTimestamp(...values: Array<string | undefined>): string {
  return values
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => right.localeCompare(left))[0] ?? new Date(0).toISOString();
}
