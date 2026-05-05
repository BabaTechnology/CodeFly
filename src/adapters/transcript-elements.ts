export interface TranscriptElementIdentity {
  elementId: string;
  startedAt: string;
  sequence: number;
}

export interface TranscriptElementState {
  activeAssistantElement?: TranscriptElementIdentity;
  activeTurnKey?: string;
  transcriptSequence?: number;
  toolElements?: Map<string, TranscriptElementIdentity>;
}

function sanitizeElementIdPart(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 96) || "unknown";
}

function nextSequence(state: TranscriptElementState): number {
  state.transcriptSequence = (state.transcriptSequence ?? 0) + 1;
  return state.transcriptSequence;
}

function createElement(
  state: TranscriptElementState,
  provider: string,
  sessionId: string,
  kind: string,
  stableKey?: string | null
): TranscriptElementIdentity {
  const sequence = nextSequence(state);
  const startedAt = new Date().toISOString();
  const turnPart = state.activeTurnKey ? `${sanitizeElementIdPart(state.activeTurnKey)}:` : "";
  const stablePart = stableKey ? `${sanitizeElementIdPart(stableKey)}:` : "";
  return {
    elementId: `live:${sanitizeElementIdPart(provider)}:${sanitizeElementIdPart(sessionId)}:${turnPart}${sanitizeElementIdPart(kind)}:${stablePart}${sequence}`,
    startedAt,
    sequence
  };
}

export function beginTranscriptTurn(
  state: TranscriptElementState,
  turnKey?: string | null
): void {
  state.activeTurnKey = turnKey?.trim() || undefined;
  state.activeAssistantElement = undefined;
  state.toolElements = new Map<string, TranscriptElementIdentity>();
}

export function finishTranscriptTurn(state: TranscriptElementState): void {
  state.activeAssistantElement = undefined;
  state.toolElements?.clear();
  state.activeTurnKey = undefined;
}

export function closeAssistantTranscriptElement(state: TranscriptElementState): void {
  state.activeAssistantElement = undefined;
}

export function ensureAssistantTranscriptElement(
  state: TranscriptElementState,
  provider: string,
  sessionId: string
): TranscriptElementIdentity {
  if (!state.activeAssistantElement) {
    state.activeAssistantElement = createElement(state, provider, sessionId, "assistant");
  }
  return state.activeAssistantElement;
}

export function ensureToolTranscriptElement(
  state: TranscriptElementState,
  provider: string,
  sessionId: string,
  toolName: string,
  stableKey?: string | null
): TranscriptElementIdentity {
  if (!state.toolElements) {
    state.toolElements = new Map<string, TranscriptElementIdentity>();
  }
  const normalizedStableKey = stableKey?.trim() || null;
  const mapKey = normalizedStableKey ? `${toolName}:${normalizedStableKey}` : null;
  if (mapKey) {
    const existing = state.toolElements.get(mapKey);
    if (existing) {
      return existing;
    }
  }
  const element = createElement(state, provider, sessionId, `tool:${toolName}`, normalizedStableKey);
  if (mapKey) {
    state.toolElements.set(mapKey, element);
  }
  return element;
}
