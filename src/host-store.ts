import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sha256, type PairedDevice } from "./shared";

interface PairingCodeRecord {
  code: string;
  expiresAt: string;
  createdAt: string;
  directUrl?: string | null;
  claimedAt?: string | null;
}

interface PersistedPairedDevice extends PairedDevice {
  authTokenHash: string;
}

export interface DirectServiceConfig {
  publicHost: string;
  bindHosts: string[];
  port: number;
  certificatePath?: string | null;
}

export interface RelayBindingRecord {
  id: string;
  relayUrl: string;
  serviceBaseUrl?: string | null;
  hostCredential?: string | null;
  seatId?: string | null;
  label?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface HostStateDocument {
  version: 1;
  hostId?: string;
  hostPublicKey?: string;
  hostSecretKey?: string;
  relayUrl?: string;
  serviceBaseUrl?: string;
  relayHostCredential?: string;
  relayBindings?: RelayBindingRecord[];
  directServiceConfig?: DirectServiceConfig;
  pairingCodes: PairingCodeRecord[];
  pairedDevices: PersistedPairedDevice[];
}

const EMPTY_STATE: HostStateDocument = {
  version: 1,
  pairingCodes: [],
  pairedDevices: []
};

export class HostStore {
  private state: HostStateDocument;

  public constructor(private readonly filePath: string) {
    this.state = this.load();
    this.prunePairingCodes();
  }

  public getHostIdentity(): {
    hostId?: string;
    publicKey?: string;
    secretKey?: string;
  } {
    return {
      hostId: this.state.hostId,
      publicKey: this.state.hostPublicKey,
      secretKey: this.state.hostSecretKey
    };
  }

  public setHostIdentity(hostId: string, publicKey: string, secretKey: string): void {
    this.state.hostId = hostId;
    this.state.hostPublicKey = publicKey;
    this.state.hostSecretKey = secretKey;
    this.save();
  }

  public getRelayCredential(): string | undefined {
    return this.firstRelayBinding()?.hostCredential ?? this.state.relayHostCredential;
  }

  public getRelayUrl(): string | undefined {
    return this.firstRelayBinding()?.relayUrl ?? this.state.relayUrl;
  }

  public getServiceBaseUrl(): string | undefined {
    return this.state.serviceBaseUrl;
  }

  public getDirectServiceConfig(): DirectServiceConfig | undefined {
    return this.state.directServiceConfig
      ? { ...this.state.directServiceConfig }
      : undefined;
  }

  public ensureDirectServiceConfig(defaults: DirectServiceConfig): DirectServiceConfig {
    const current = this.state.directServiceConfig;
    const next: DirectServiceConfig = {
      publicHost: current?.publicHost?.trim() || defaults.publicHost,
      bindHosts: sanitizeBindHosts(current?.bindHosts, defaults.bindHosts),
      port: Number.isFinite(current?.port) && current!.port > 0 ? current!.port : defaults.port,
      certificatePath: current?.certificatePath?.trim() || defaults.certificatePath || null
    };
    this.state.directServiceConfig = next;
    this.save();
    return { ...next };
  }

  public setDirectServiceConfig(next: DirectServiceConfig): DirectServiceConfig {
    this.state.directServiceConfig = {
      publicHost: next.publicHost.trim(),
      bindHosts: sanitizeBindHosts(next.bindHosts, ["0.0.0.0"]),
      port: next.port,
      certificatePath: next.certificatePath?.trim() || null
    };
    this.save();
    return { ...this.state.directServiceConfig };
  }

  public setRelayCredential(credential: string): void {
    const binding = this.firstRelayBinding();
    if (binding) {
      this.upsertRelayBinding({
        ...binding,
        hostCredential: credential
      });
      return;
    }
    this.state.relayHostCredential = credential;
    this.save();
  }

  public setServiceBaseUrl(serviceBaseUrl: string): void {
    this.state.serviceBaseUrl = serviceBaseUrl.trim() || undefined;
    this.save();
  }

  public clearRelayBinding(): void {
    this.state.relayHostCredential = undefined;
    this.state.relayBindings = [];
    this.save();
  }

  public listRelayBindings(): RelayBindingRecord[] {
    return [...(this.state.relayBindings ?? [])]
      .map((binding) => ({ ...binding }))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  public getRelayBinding(id: string): RelayBindingRecord | undefined {
    const binding = this.state.relayBindings?.find((entry) => entry.id === id);
    return binding ? { ...binding } : undefined;
  }

  public upsertRelayBinding(input: {
    id?: string | null;
    relayUrl: string;
    serviceBaseUrl?: string | null;
    hostCredential?: string | null;
    seatId?: string | null;
    label?: string | null;
  }): RelayBindingRecord {
    const relayUrl = input.relayUrl.trim();
    if (!relayUrl) {
      throw new Error("relayUrl is required");
    }

    const bindings = this.state.relayBindings ?? [];
    const existing =
      (input.id ? bindings.find((binding) => binding.id === input.id) : undefined) ??
      (input.seatId ? bindings.find((binding) => binding.seatId === input.seatId) : undefined) ??
      (input.hostCredential
        ? bindings.find((binding) => binding.hostCredential === input.hostCredential)
        : undefined);
    const timestamp = new Date().toISOString();
    const next: RelayBindingRecord = {
      id: existing?.id ?? (input.id?.trim() || generateLocalId("relay")),
      relayUrl,
      serviceBaseUrl: input.serviceBaseUrl?.trim() || existing?.serviceBaseUrl || null,
      hostCredential: input.hostCredential?.trim() || null,
      seatId: input.seatId?.trim() || existing?.seatId || null,
      label: input.label?.trim() || existing?.label || null,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp
    };

    this.state.relayBindings = existing
      ? bindings.map((binding) => (binding.id === existing.id ? next : binding))
      : [...bindings, next];
    this.state.relayUrl = this.state.relayUrl ?? relayUrl;
    this.state.relayHostCredential = undefined;
    this.save();
    return { ...next };
  }

  public updateRelayBindingCredential(
    id: string,
    credential: string,
    seatId?: string | null
  ): RelayBindingRecord | undefined {
    const binding = this.state.relayBindings?.find((entry) => entry.id === id);
    if (!binding) {
      return undefined;
    }
    return this.upsertRelayBinding({
      ...binding,
      hostCredential: credential,
      seatId: seatId ?? binding.seatId
    });
  }

  public updateRelayBindingSeat(id: string, seatId: string): RelayBindingRecord | undefined {
    const binding = this.state.relayBindings?.find((entry) => entry.id === id);
    if (!binding) {
      return undefined;
    }
    return this.upsertRelayBinding({
      ...binding,
      seatId
    });
  }

  public removeRelayBinding(id: string): RelayBindingRecord | undefined {
    const bindings = this.state.relayBindings ?? [];
    const binding = bindings.find((entry) => entry.id === id);
    if (!binding) {
      return undefined;
    }
    this.state.relayBindings = bindings.filter((entry) => entry.id !== id);
    this.state.relayUrl = this.firstRelayBinding()?.relayUrl;
    this.save();
    return { ...binding };
  }

  public issuePairingCode(
    ttlSeconds: number,
    createdAt: string,
    directUrl?: string | null
  ): { code: string; expiresAt: string } {
    this.prunePairingCodes();
    const code = generateBindingCode();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    this.state.pairingCodes.push({
      code,
      createdAt,
      expiresAt,
      directUrl: directUrl?.trim() || null,
      claimedAt: null
    });
    this.save();
    return { code, expiresAt };
  }

  public claimPairingCode(code: string): { directUrl?: string | null } | null {
    this.prunePairingCodes();
    const pairing = this.state.pairingCodes.find(
      (entry) => entry.code.toLowerCase() === code.toLowerCase()
    );
    if (!pairing || pairing.claimedAt) {
      return null;
    }

    pairing.claimedAt = new Date().toISOString();
    this.save();
    return {
      directUrl: pairing.directUrl ?? null
    };
  }

  public pairDevice(
    deviceId: string,
    label: string,
    publicKey: string,
    createdAt: string
  ): { authToken: string } {
    const authToken = randomBytes(24).toString("base64url");
    const authTokenHash = sha256(authToken);
    const existing = this.state.pairedDevices.find((device) => device.deviceId === deviceId);

    if (existing) {
      existing.label = label;
      existing.publicKey = publicKey;
      existing.authTokenHash = authTokenHash;
      existing.createdAt = createdAt;
    } else {
      this.state.pairedDevices.push({
        deviceId,
        label,
        publicKey,
        authTokenHash,
        createdAt,
        lastSeenAt: null
      });
    }

    this.save();
    return { authToken };
  }

  public validatePairedDevice(
    deviceId: string,
    authToken: string
  ): Pick<PairedDevice, "deviceId" | "label" | "publicKey"> | undefined {
    const authTokenHash = sha256(authToken);
    const device = this.state.pairedDevices.find(
      (entry) => entry.deviceId === deviceId && entry.authTokenHash === authTokenHash
    );

    if (!device) {
      return undefined;
    }

    return {
      deviceId: device.deviceId,
      label: device.label,
      publicKey: device.publicKey
    };
  }

  public touchPairedDevice(deviceId: string, timestamp: string): void {
    const device = this.state.pairedDevices.find((entry) => entry.deviceId === deviceId);
    if (!device) {
      return;
    }
    device.lastSeenAt = timestamp;
    this.save();
  }

  public updatePairedDevicePublicKey(deviceId: string, publicKey: string): void {
    const device = this.state.pairedDevices.find((entry) => entry.deviceId === deviceId);
    if (!device || !publicKey.trim() || device.publicKey === publicKey) {
      return;
    }
    device.publicKey = publicKey;
    this.save();
  }

  public listPairedDevices(): PairedDevice[] {
    return this.state.pairedDevices
      .map(({ authTokenHash: _authTokenHash, ...device }) => ({ ...device }))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  public removePairedDevice(deviceId: string): boolean {
    const before = this.state.pairedDevices.length;
    this.state.pairedDevices = this.state.pairedDevices.filter((entry) => entry.deviceId !== deviceId);
    if (this.state.pairedDevices.length !== before) {
      this.save();
      return true;
    }
    return false;
  }

  private load(): HostStateDocument {
    if (!existsSync(this.filePath)) {
      return structuredClone(EMPTY_STATE);
    }

    const raw = readFileSync(this.filePath, "utf8").trim();
    if (!raw) {
      return structuredClone(EMPTY_STATE);
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!isHostStateDocument(parsed)) {
      return structuredClone(EMPTY_STATE);
    }

    const relayBindings = Array.isArray(parsed.relayBindings)
      ? parsed.relayBindings.filter(isRelayBindingRecord)
      : [];

    return {
      version: 1,
      hostId: parsed.hostId,
      hostPublicKey: parsed.hostPublicKey,
      hostSecretKey: parsed.hostSecretKey,
      relayUrl: parsed.relayUrl,
      serviceBaseUrl: parsed.serviceBaseUrl,
      relayHostCredential: parsed.relayHostCredential,
      relayBindings,
      directServiceConfig: isDirectServiceConfig(parsed.directServiceConfig)
        ? parsed.directServiceConfig
        : undefined,
      pairingCodes: parsed.pairingCodes,
      pairedDevices: parsed.pairedDevices
    };
  }

  private prunePairingCodes(): void {
    const now = Date.now();
    const before = this.state.pairingCodes.length;
    this.state.pairingCodes = this.state.pairingCodes.filter(
      (entry) => new Date(entry.expiresAt).getTime() >= now
    );
    if (this.state.pairingCodes.length !== before) {
      this.save();
    }
  }

  private save(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
  }

  private firstRelayBinding(): RelayBindingRecord | undefined {
    return this.listRelayBindings()[0];
  }
}

function isHostStateDocument(value: unknown): value is HostStateDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const typedValue = value as Record<string, unknown>;
  return Array.isArray(typedValue.pairingCodes) && Array.isArray(typedValue.pairedDevices);
}

function isDirectServiceConfig(value: unknown): value is DirectServiceConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.publicHost === "string" &&
    typeof record.port === "number" &&
    (record.bindHosts === undefined ||
      (Array.isArray(record.bindHosts) && record.bindHosts.every((entry) => typeof entry === "string")))
  );
}

function sanitizeBindHosts(value: unknown, fallback: string[]): string[] {
  const input = Array.isArray(value) ? value : [];
  const hosts = input
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
  return hosts.length ? hosts : fallback;
}

function isRelayBindingRecord(value: unknown): value is RelayBindingRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.relayUrl === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string"
  );
}

function generateLocalId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

function generateBindingCode(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let code = "";
  for (let index = 0; index < 16; index += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}
