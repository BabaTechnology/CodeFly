import type { EncryptedAppFrame, RouteMode } from "./types";

export const CODEFLY_MAX_TRANSPORT_PACKET_BYTES = 256 * 1024;
export const CODEFLY_ENCRYPTED_CHUNK_DATA_BYTES = 180 * 1024;
export const CODEFLY_MAX_ENCRYPTED_FRAME_BYTES = 64 * 1024 * 1024;
export const CODEFLY_TRANSPORT_REASSEMBLY_TTL_MS = 60_000;

export interface EncryptedAppFrameChunk {
  kind: "encrypted_chunk";
  routeMode: RouteMode;
  seatId?: string;
  senderId: string;
  recipientId: string;
  senderPublicKey: string;
  timestamp: string;
  chunkId: string;
  index: number;
  total: number;
  originalBytes: number;
  chunkBytes: number;
  data: string;
}

export type EncryptedTransportFrame = EncryptedAppFrame | EncryptedAppFrameChunk;

interface ReassemblyState {
  createdAt: number;
  routeMode: RouteMode;
  seatId?: string;
  senderId: string;
  recipientId: string;
  senderPublicKey: string;
  timestamp: string;
  total: number;
  originalBytes: number;
  receivedBytes: number;
  receivedCount: number;
  chunks: Array<string | undefined>;
}

export function isEncryptedAppFrame(value: unknown): value is EncryptedAppFrame {
  return Boolean(value && typeof value === "object" && (value as { kind?: unknown }).kind === "encrypted");
}

export function isEncryptedAppFrameChunk(value: unknown): value is EncryptedAppFrameChunk {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { kind?: unknown }).kind === "encrypted_chunk"
  );
}

export function isEncryptedTransportFrame(value: unknown): value is EncryptedTransportFrame {
  return isEncryptedAppFrame(value) || isEncryptedAppFrameChunk(value);
}

export function encryptedTransportByteLength(frame: EncryptedTransportFrame): number {
  return Buffer.byteLength(JSON.stringify(frame), "utf8");
}

export function getEncryptedTransportRouting(frame: EncryptedTransportFrame): {
  routeMode: RouteMode;
  seatId?: string;
  senderId: string;
  recipientId: string;
  senderPublicKey: string;
} {
  return {
    routeMode: frame.routeMode,
    seatId: frame.seatId,
    senderId: frame.senderId,
    recipientId: frame.recipientId,
    senderPublicKey: frame.senderPublicKey
  };
}

export function encodeEncryptedTransportFrames(frame: EncryptedAppFrame): EncryptedTransportFrame[] {
  const serialized = JSON.stringify(frame);
  const originalBytes = Buffer.byteLength(serialized, "utf8");
  if (originalBytes > CODEFLY_MAX_ENCRYPTED_FRAME_BYTES) {
    throw new Error("Encrypted frame exceeds the maximum allowed size");
  }
  if (originalBytes <= CODEFLY_MAX_TRANSPORT_PACKET_BYTES) {
    return [frame];
  }

  const buffer = Buffer.from(serialized, "utf8");
  const total = Math.ceil(buffer.byteLength / CODEFLY_ENCRYPTED_CHUNK_DATA_BYTES);
  const chunkId = `chunk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  const chunks: EncryptedTransportFrame[] = [];
  for (let index = 0; index < total; index += 1) {
    const start = index * CODEFLY_ENCRYPTED_CHUNK_DATA_BYTES;
    const part = buffer.subarray(start, Math.min(start + CODEFLY_ENCRYPTED_CHUNK_DATA_BYTES, buffer.byteLength));
    const chunk: EncryptedAppFrameChunk = {
      kind: "encrypted_chunk",
      routeMode: frame.routeMode,
      ...(frame.seatId ? { seatId: frame.seatId } : {}),
      senderId: frame.senderId,
      recipientId: frame.recipientId,
      senderPublicKey: frame.senderPublicKey,
      timestamp: frame.timestamp,
      chunkId,
      index,
      total,
      originalBytes,
      chunkBytes: part.byteLength,
      data: part.toString("base64")
    };
    const encodedBytes = encryptedTransportByteLength(chunk);
    if (encodedBytes > CODEFLY_MAX_TRANSPORT_PACKET_BYTES) {
      throw new Error("Encrypted transport chunk exceeds the maximum allowed packet size");
    }
    chunks.push(chunk);
  }
  return chunks;
}

export class EncryptedTransportReassembler {
  private readonly states = new Map<string, ReassemblyState>();

  public constructor(
    private readonly maxFrameBytes = CODEFLY_MAX_ENCRYPTED_FRAME_BYTES,
    private readonly ttlMs = CODEFLY_TRANSPORT_REASSEMBLY_TTL_MS
  ) {}

  public accept(frame: EncryptedTransportFrame): EncryptedAppFrame | undefined {
    this.cleanupExpired();
    if (isEncryptedAppFrame(frame)) {
      const frameBytes = encryptedTransportByteLength(frame);
      if (frameBytes > this.maxFrameBytes) {
        throw new Error("Encrypted frame exceeds the maximum allowed size");
      }
      return frame;
    }

    this.validateChunk(frame);
    const existing = this.states.get(frame.chunkId);
    const state =
      existing ??
      {
        createdAt: Date.now(),
        routeMode: frame.routeMode,
        seatId: frame.seatId,
        senderId: frame.senderId,
        recipientId: frame.recipientId,
        senderPublicKey: frame.senderPublicKey,
        timestamp: frame.timestamp,
        total: frame.total,
        originalBytes: frame.originalBytes,
        receivedBytes: 0,
        receivedCount: 0,
        chunks: new Array<string | undefined>(frame.total)
      };

    this.validateChunkMatchesState(state, frame);
    if (!state.chunks[frame.index]) {
      state.chunks[frame.index] = frame.data;
      state.receivedBytes += frame.chunkBytes;
      state.receivedCount += 1;
    }
    this.states.set(frame.chunkId, state);

    if (state.receivedCount !== state.total || state.receivedBytes !== state.originalBytes) {
      return undefined;
    }

    const joined = Buffer.concat(
      state.chunks.map((chunk) => Buffer.from(chunk as string, "base64"))
    );
    this.states.delete(frame.chunkId);
    if (joined.byteLength !== state.originalBytes) {
      throw new Error("Encrypted transport chunk size mismatch");
    }
    const parsed = JSON.parse(joined.toString("utf8")) as unknown;
    if (!isEncryptedAppFrame(parsed)) {
      throw new Error("Encrypted transport chunks did not reassemble to an encrypted frame");
    }
    return parsed;
  }

  public reset(): void {
    this.states.clear();
  }

  private validateChunk(chunk: EncryptedAppFrameChunk): void {
    if (
      !Number.isInteger(chunk.index) ||
      !Number.isInteger(chunk.total) ||
      !Number.isInteger(chunk.originalBytes) ||
      !Number.isInteger(chunk.chunkBytes) ||
      chunk.index < 0 ||
      chunk.total < 2 ||
      chunk.index >= chunk.total ||
      chunk.originalBytes <= CODEFLY_MAX_TRANSPORT_PACKET_BYTES ||
      chunk.originalBytes > this.maxFrameBytes ||
      chunk.chunkBytes <= 0 ||
      chunk.chunkBytes > CODEFLY_ENCRYPTED_CHUNK_DATA_BYTES
    ) {
      throw new Error("Invalid encrypted transport chunk metadata");
    }
    if (Buffer.from(chunk.data, "base64").byteLength !== chunk.chunkBytes) {
      throw new Error("Invalid encrypted transport chunk data");
    }
  }

  private validateChunkMatchesState(state: ReassemblyState, chunk: EncryptedAppFrameChunk): void {
    if (
      state.routeMode !== chunk.routeMode ||
      state.seatId !== chunk.seatId ||
      state.senderId !== chunk.senderId ||
      state.recipientId !== chunk.recipientId ||
      state.senderPublicKey !== chunk.senderPublicKey ||
      state.timestamp !== chunk.timestamp ||
      state.total !== chunk.total ||
      state.originalBytes !== chunk.originalBytes
    ) {
      throw new Error("Encrypted transport chunk metadata mismatch");
    }
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [chunkId, state] of this.states.entries()) {
      if (now - state.createdAt > this.ttlMs) {
        this.states.delete(chunkId);
      }
    }
  }
}
