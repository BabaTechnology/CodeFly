import { createHash, randomBytes, randomUUID } from "node:crypto";
import nacl from "tweetnacl";
import type { AppMessage, EncryptedAppFrame, RouteMode } from "./types";

export interface KeyPair {
  publicKey: string;
  secretKey: string;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function randomId(prefix = "id"): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

export function randomToken(prefix = "tok", bytes = 32): string {
  return `${prefix}_${randomBytes(bytes).toString("base64url")}`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function deriveAppleAppAccountToken(userId: string): string {
  const hash = sha256(`apple-app-account:${userId}`);
  const part4FirstNibble = ((parseInt(hash.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `${part4FirstNibble}${hash.slice(17, 20)}`,
    hash.slice(20, 32)
  ].join("-");
}

export function publicKeyFingerprint(publicKey: string): string {
  return sha256(publicKey);
}

export function generateKeyPair(): KeyPair {
  const pair = nacl.box.keyPair();
  return {
    publicKey: Buffer.from(pair.publicKey).toString("base64"),
    secretKey: Buffer.from(pair.secretKey).toString("base64")
  };
}

function decodeBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

export function encryptAppMessage<TPayload>(
  routeMode: RouteMode,
  senderId: string,
  recipientId: string,
  senderSecretKey: string,
  senderPublicKey: string,
  recipientPublicKey: string,
  payload: AppMessage<TPayload>,
  seatId?: string
): EncryptedAppFrame {
  const nonce = randomBytes(nacl.box.nonceLength);
  const message = Buffer.from(JSON.stringify(payload), "utf8");
  const ciphertext = nacl.box(
    message,
    nonce,
    decodeBase64(recipientPublicKey),
    decodeBase64(senderSecretKey)
  );

  return {
    kind: "encrypted",
    routeMode,
    seatId,
    senderId,
    recipientId,
    senderPublicKey,
    nonce: Buffer.from(nonce).toString("base64"),
    ciphertext: Buffer.from(ciphertext).toString("base64"),
    timestamp: nowIso()
  };
}

export function decryptAppFrame<TPayload = Record<string, unknown>>(
  frame: EncryptedAppFrame,
  recipientSecretKey: string
): AppMessage<TPayload> {
  const opened = nacl.box.open(
    decodeBase64(frame.ciphertext),
    decodeBase64(frame.nonce),
    decodeBase64(frame.senderPublicKey),
    decodeBase64(recipientSecretKey)
  );

  if (!opened) {
    throw new Error("Unable to decrypt frame");
  }

  return JSON.parse(Buffer.from(opened).toString("utf8")) as AppMessage<TPayload>;
}
