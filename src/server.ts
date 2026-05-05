import {
  CODEFLY_MAX_TRANSPORT_PACKET_BYTES,
  EncryptedTransportReassembler,
  decryptAppFrame,
  encodeEncryptedTransportFrames,
  encryptAppMessage,
  isEncryptedTransportFrame,
  nowIso,
  type AgentSession,
  type AppMessage,
  type DiffPreview,
  type EncryptedAppFrame,
  type EncryptedTransportFrame
} from "./shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import Fastify from "fastify";
import { existsSync, constants as fsConstants } from "node:fs";
import {
  access,
  stat
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { TextDecoder } from "node:util";
import { createAdapters } from "./adapters";
import type { AgentAdapter } from "./adapters/base";
import {
  buildDirectPublicUrl,
  loadHostClientConfig,
  normalizeDirectPublicHost,
  parseBindHosts
} from "./config";
import { collectHostHardwareSnapshot } from "./hardware-status";
import { HostStore } from "./host-store";
import { ensureHostIdentity } from "./identity";
import { HostNotificationPublisher } from "./notifications";
import {
  ProviderConfigManager,
  type ProviderName
} from "./provider-config";
import { isProviderRuntimeInstalled as detectProviderRuntimeInstalled } from "./provider-runtime";
import { RelayUpstreamClient } from "./relay-client";
import { RuntimeConfigStore } from "./runtime-config-store";
import { registerRelayUpstreamRoutes } from "./server-relay-upstreams";
import { registerHostClientRoutes } from "./server-routes";
import { SessionManager } from "./session-manager";

interface ConnectionTarget {
  connectionKey: string;
  deviceId: string;
  label: string;
  publicKey: string;
  routeMode: "direct" | "relay";
  relayBindingId?: string | null;
  relaySeatId?: string | null;
  installationId?: string | null;
  installationTokenHash?: string | null;
  appVersion?: string | null;
  sendRaw: (frame: EncryptedTransportFrame) => void;
}

interface DirectRawConnectionState {
  socket: net.Socket;
  buffer: string;
  reassembler: EncryptedTransportReassembler;
  target?: ConnectionTarget;
}

interface SessionRoutingTarget {
  adapter: AgentAdapter;
  manager: SessionManager;
}

interface SessionListItem {
  id: string;
  adapter: string;
  title: string;
  state: AgentSession["state"];
  createdAt: string;
  updatedAt: string;
  lastReadAt?: string | null;
}

const MAX_SESSION_LIST_LIMIT = 500;
const MAX_SESSION_HISTORY_LIMIT = 5000;
const MAX_EDITABLE_TEXT_BYTES = 5 * 1024 * 1024;
const MAX_UPLOAD_FILE_BYTES = 10 * 1024 * 1024;
const MAX_UPLOAD_REQUEST_BODY_BYTES = 20 * 1024 * 1024;
const utf8TextDecoder = new TextDecoder("utf-8", {
  fatal: true
});

class WorkspacePathError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400
  ) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

function isWorkspacePathError(error: unknown): error is WorkspacePathError {
  return error instanceof WorkspacePathError;
}

function normalizeDevicePublicKey(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  let normalized = value.trim();
  if (!normalized) {
    return "";
  }

  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Ignore malformed escape sequences and continue with the raw string.
  }

  return normalized
    .replace(/ /g, "+")
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .replace(/\s+/g, "");
}

function isValidDevicePublicKey(value: string): boolean {
  if (!value || !/^[A-Za-z0-9+/=]+$/.test(value)) {
    return false;
  }

  try {
    return Buffer.from(value, "base64").length === 32;
  } catch {
    return false;
  }
}

function deriveTlsKeyPath(certificatePath: string): string {
  const parsed = path.parse(certificatePath);
  return path.join(parsed.dir, `${parsed.name}.key`);
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export async function startHostClient(): Promise<void> {
  const config = loadHostClientConfig();
  const runtimeConfigStore = new RuntimeConfigStore(config.runtimeConfigPath);
  runtimeConfigStore.applyToConfig(config);
  const hostStore = new HostStore(config.hostStatePath);
  const directServiceConfig = hostStore.ensureDirectServiceConfig({
    publicHost: config.directPublicHost,
    bindHosts: config.bindHosts,
    port: config.port,
    certificatePath: config.directCertificatePath
  });
  config.port = directServiceConfig.port;
  config.bindHosts = directServiceConfig.bindHosts;
  config.bindHost = config.bindHosts.join(", ");
  config.directPublicHost = directServiceConfig.publicHost;
  config.directCertificatePath = directServiceConfig.certificatePath ?? config.directCertificatePath;
  config.directKeyPath =
    process.env.HOST_CLIENT_TLS_KEY_PATH ?? deriveTlsKeyPath(config.directCertificatePath);
  config.directPublicUrl = buildDirectPublicUrl(config.directPublicHost, config.port);
  config.serviceBaseUrl = hostStore.getServiceBaseUrl() ?? config.serviceBaseUrl;
  if (config.relayUrl && config.relayCredential) {
    hostStore.upsertRelayBinding({
      relayUrl: config.relayUrl,
      serviceBaseUrl: config.serviceBaseUrl,
      hostCredential: config.relayCredential
    });
  }
  config.relayUrl = hostStore.getRelayUrl() ?? config.relayUrl;
  config.relayCredential = config.relayCredential ?? hostStore.getRelayCredential();
  const identity = await ensureHostIdentity(hostStore, config.dataDir, config.hostName, {
    tlsCertPath: config.directCertificatePath,
    tlsKeyPath: config.directKeyPath,
    certificateHosts: [config.directPublicHost]
  });
  const providerConfigs = new ProviderConfigManager(config);
  providerConfigs.ensureBootstrapFiles();

  const adapters = createAdapters(config, providerConfigs);
  const adapterByName = new Map<string, AgentAdapter>();
  const managerByName = new Map<string, SessionManager>();
  const providerManagers = new Map<ProviderName, SessionManager>();
  const sessionManagers: SessionManager[] = [];

  for (const adapter of adapters) {
    const manager = new SessionManager(adapter);
    adapterByName.set(adapter.name, adapter);
    managerByName.set(adapter.name, manager);
    sessionManagers.push(manager);
    if (adapter.name === "codex" || adapter.name === "claude") {
      providerManagers.set(adapter.name, manager);
    }
  }

  await Promise.all(sessionManagers.map((manager) => manager.hydrate()));

  const directTargets = new Map<string, ConnectionTarget>();
  const relayTargets = new Map<string, ConnectionTarget>();

  const relayClients = new Map<string, RelayUpstreamClient>();
  const notificationPublisher = new HostNotificationPublisher({
    hostName: config.hostName,
    hostFingerprint: identity.publicKeyFingerprint,
    getServiceBaseUrl: () => hostStore.getServiceBaseUrl() ?? config.serviceBaseUrl,
    getRelaySeatIds: () => activeRelaySeatIds(),
    sendRelayControl: (seatId, frame) => sendRelayControlToSeat(seatId, frame),
    onError: (error, context) => {
      app.log.error({ err: error, context }, "Failed to publish host notification");
    }
  });
  const sessionNotificationStates = new Map<
    string,
    {
      state?: string;
      terminalNotified: boolean;
      errorNotified: boolean;
    }
  >();

  const app = Fastify({
    logger: true,
    bodyLimit: MAX_UPLOAD_REQUEST_BODY_BYTES
  });

  function isLoopbackRequest(request: FastifyRequest): boolean {
    const ip = request.ip ?? "";
    return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  }

  function requireLoopbackRequest(request: FastifyRequest, reply: FastifyReply): boolean {
    if (isLoopbackRequest(request)) {
      return true;
    }
    void reply.code(403).send({ error: "This endpoint is only available from localhost" });
    return false;
  }

  function authenticateDirectHttpRequest(
    request: FastifyRequest,
    reply: FastifyReply
  ): { deviceId: string; label: string; publicKey: string; installationTokenHash?: string } | undefined {
    const deviceId = String(request.headers["x-codefly-device-id"] ?? "");
    const authToken = String(request.headers["x-codefly-auth-token"] ?? "");
    const paired = hostStore.validatePairedDevice(deviceId, authToken);
    if (!paired) {
      void reply.code(401).send({ error: "Unauthorized device" });
      return undefined;
    }
    hostStore.touchPairedDevice(deviceId, nowIso());
    const installationTokenHash = String(
      request.headers["x-codefly-installation-token-hash"] ?? ""
    ).trim();
    return {
      ...paired,
      ...(installationTokenHash ? { installationTokenHash } : {})
    };
  }

  function getDirectRequestTarget(
    request: FastifyRequest,
    sessionId?: string
  ): { connectionKey: string; sessionId?: string; installationTokenHash?: string } | null {
    if (isLoopbackRequest(request)) {
      return null;
    }
    const connectionKey = String(request.headers["x-codefly-device-id"] ?? "").trim();
    if (!connectionKey) {
      return null;
    }
    const installationTokenHash = String(
      request.headers["x-codefly-installation-token-hash"] ?? ""
    ).trim();
    return {
      connectionKey,
      ...(sessionId ? { sessionId } : {}),
      ...(installationTokenHash ? { installationTokenHash } : {})
    };
  }

  function requireProvider(value: string): ProviderName {
    if (value === "codex" || value === "claude") {
      return value;
    }
    throw new Error(`Unsupported provider: ${value}`);
  }

  function getProviderSettingsBlock(provider: ProviderName): { statusCode: number; error: string } | null {
    if (!isProviderEnabled(provider)) {
      return { statusCode: 403, error: "Provider is disabled by host configuration" };
    }
    if (!isProviderRuntimeInstalled(provider)) {
      return { statusCode: 404, error: "Provider runtime is not installed" };
    }
    return null;
  }

  function requireConfigurableProvider(value: string, reply: FastifyReply): ProviderName | null {
    const provider = requireProvider(value);
    const block = getProviderSettingsBlock(provider);
    if (block) {
      void reply.code(block.statusCode).send({ error: block.error });
      return null;
    }
    return provider;
  }

  function resolveWorkspacePath(input: unknown): string {
    const raw = typeof input === "string" ? input.trim() : "";
    if (!raw) {
      return path.resolve(config.defaultWorkspaceDir);
    }
    assertHostNativeWorkspacePath(raw);
    return path.isAbsolute(raw)
      ? path.resolve(raw)
      : path.resolve(config.defaultWorkspaceDir, raw);
  }

  function assertHostNativeWorkspacePath(raw: string): void {
    if (raw.includes("\0")) {
      throw new WorkspacePathError(
        "workspace_path_invalid",
        "Workspace path contains an invalid character"
      );
    }

    if (process.platform === "win32") {
      assertWindowsWorkspacePath(raw);
      return;
    }

    assertPosixWorkspacePath(raw);
  }

  function assertWindowsWorkspacePath(raw: string): void {
    if (raw.includes("/")) {
      throw new WorkspacePathError(
        "workspace_path_wrong_separator",
        "Use Windows path separators for this host"
      );
    }
    if (/[<>"|?*]/.test(raw)) {
      throw new WorkspacePathError(
        "workspace_path_invalid",
        "Workspace path contains characters that are not valid on Windows"
      );
    }
    if (raw.includes(":") && !/^[A-Za-z]:\\/.test(raw)) {
      throw new WorkspacePathError(
        "workspace_path_invalid",
        "Use a Windows absolute workspace path such as C:\\Users\\name\\project"
      );
    }
    const isDriveAbsolute = /^[A-Za-z]:\\/.test(raw);
    const isUncAbsolute = /^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(raw);
    if (!isDriveAbsolute && !isUncAbsolute) {
      throw new WorkspacePathError(
        "workspace_path_absolute_required",
        "Use a Windows absolute workspace path such as C:\\Users\\name\\project"
      );
    }
  }

  function assertPosixWorkspacePath(raw: string): void {
    if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("\\\\")) {
      throw new WorkspacePathError(
        "workspace_path_wrong_platform",
        "Use a Unix-style absolute workspace path for this host"
      );
    }
    if (raw.includes("\\")) {
      throw new WorkspacePathError(
        "workspace_path_wrong_separator",
        "Use Unix-style path separators for this host"
      );
    }
    if (!raw.startsWith("/")) {
      throw new WorkspacePathError(
        "workspace_path_absolute_required",
        "Use an absolute workspace path such as /home/name/project"
      );
    }
  }

  async function assertDirectoryAccessible(
    targetPath: string,
    options?: { writable?: boolean }
  ): Promise<void> {
    let targetStats;
    try {
      targetStats = await stat(targetPath);
    } catch (error) {
      const code = typeof error === "object" && error ? (error as { code?: unknown }).code : null;
      if (code === "EACCES" || code === "EPERM") {
        throw new WorkspacePathError(
          "workspace_path_permission_denied",
          "The current host user does not have permission to access this workspace",
          403
        );
      }
      throw new WorkspacePathError(
        "workspace_path_not_found",
        "Workspace directory does not exist",
        404
      );
    }

    if (!targetStats.isDirectory()) {
      throw new WorkspacePathError(
        "workspace_path_not_directory",
        "Workspace path is not a directory"
      );
    }

    const mode =
      fsConstants.R_OK |
      fsConstants.X_OK |
      (options?.writable === false ? 0 : fsConstants.W_OK);
    try {
      await access(targetPath, mode);
    } catch {
      throw new WorkspacePathError(
        "workspace_path_permission_denied",
        options?.writable === false
          ? "The current host user does not have permission to read this directory"
          : "The current host user does not have read, write, and enter permission for this workspace",
        403
      );
    }
  }

  async function resolveSessionWorkspacePath(input: unknown): Promise<string> {
    const workspacePath = resolveWorkspacePath(input);
    await assertDirectoryAccessible(workspacePath);
    return workspacePath;
  }

  function sendWorkspacePathError(reply: FastifyReply, error: unknown): FastifyReply {
    if (isWorkspacePathError(error)) {
      return reply.code(error.statusCode).send({
        error: error.message,
        code: error.code
      });
    }
    return reply.code(400).send({
      error: "Invalid workspace path",
      code: "workspace_path_invalid"
    });
  }

  function resolveOptionalWorkspaceRoot(input: unknown): string | undefined {
    const raw = typeof input === "string" ? input.trim() : "";
    return raw ? resolveWorkspacePath(raw) : undefined;
  }

  function isPathWithinRoot(rootPath: string, targetPath: string): boolean {
    const relativePath = path.relative(rootPath, targetPath);
    return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
  }

  function resolveScopedPath(targetInput: unknown, rootInput?: unknown): {
    targetPath: string;
    rootPath?: string;
  } {
    const rootPath = resolveOptionalWorkspaceRoot(rootInput);
    const targetPath = resolveWorkspacePath(targetInput ?? rootPath);
    if (rootPath && !isPathWithinRoot(rootPath, targetPath)) {
      const error = new Error("outside_root");
      (error as { code?: string }).code = "outside_root";
      throw error;
    }
    return {
      targetPath,
      ...(rootPath ? { rootPath } : {})
    };
  }

  function isLikelyUtf8Text(buffer: Buffer): boolean {
    try {
      utf8TextDecoder.decode(buffer);
    } catch {
      return false;
    }
    return !buffer.includes(0);
  }

  function buildWorkspaceFileAccess(editable: boolean, reason: "ok" | "outside_root" | "too_large" | "not_text" | "not_file" | "not_found") {
    return {
      editable,
      reason,
      maxEditableBytes: MAX_EDITABLE_TEXT_BYTES
    };
  }

  async function assertDirectoryExists(targetPath: string): Promise<void> {
    const targetStats = await stat(targetPath);
    if (!targetStats.isDirectory()) {
      throw new Error("Not a directory");
    }
  }

  async function assertFileExists(targetPath: string): Promise<void> {
    const targetStats = await stat(targetPath);
    if (!targetStats.isFile()) {
      throw new Error("Not a file");
    }
  }

  function isProviderEnabled(provider: ProviderName): boolean {
    if (config.adapter === "multi") {
      return true;
    }
    return config.adapter === provider;
  }

  function isProviderRuntimeInstalled(provider: ProviderName): boolean {
    return detectProviderRuntimeInstalled(provider);
  }

  function detectProviderAuthMode(provider: ProviderName): "api_key" | "account" | "missing" {
    const runtimeConfig = provider === "codex" ? config.codex : config.claude;
    if (runtimeConfig.apiKey?.trim()) {
      return "api_key";
    }

    if (provider === "codex") {
      return existsSync(path.resolve(config.codex.configDir, "auth.json"))
        ? "account"
        : "missing";
    }

    const claudeProjectsDir = path.resolve(config.claude.configDir, "projects");
    const claudeSessionsDir = path.resolve(config.claude.configDir, "sessions");
    return existsSync(claudeProjectsDir) || existsSync(claudeSessionsDir) ? "account" : "missing";
  }

  function listProviderCapabilities() {
    return (["codex", "claude"] as const).map((provider) => {
      const enabled = isProviderEnabled(provider);
      const installed = isProviderRuntimeInstalled(provider);
      const hasManager = providerManagers.has(provider);
      const runtimeConfig = provider === "codex" ? config.codex : config.claude;
      const authMode = detectProviderAuthMode(provider);
      const hasEndpoint = Boolean(runtimeConfig.baseUrl?.trim());
      const hasModel = Boolean(runtimeConfig.model?.trim());
      const configured = hasEndpoint && hasModel && authMode !== "missing";

      let reason: string | null = null;
      if (!enabled) {
        reason = "Disabled by host configuration";
      } else if (!installed) {
        reason = "Provider runtime is not installed";
      } else if (!configured) {
        reason = "Provider endpoint, model, or authentication is missing";
      } else if (!hasManager) {
        reason = "Provider manager is unavailable";
      }

      return {
        id: provider,
        label: provider === "codex" ? "Codex" : "Claude Code",
        enabled,
        installed,
        configured,
        authMode,
        baseUrl: runtimeConfig.baseUrl,
        available: enabled && installed && configured && hasManager,
        reason
      };
    });
  }

  function resolveDefaultProvider(): string | null {
    const availableProviders = listProviderCapabilities().filter((provider) => provider.available);
    if (availableProviders.length === 1) {
      return availableProviders[0].id;
    }
    return null;
  }

  function activeSessionCount(): number {
    return sessionManagers.reduce((sum, manager) => sum + manager.activeSessionCount(), 0);
  }

  async function sendToTarget(target: ConnectionTarget, message: AppMessage): Promise<void> {
    if (!isValidDevicePublicKey(target.publicKey)) {
      throw new Error(`Invalid target public key for device ${target.deviceId}`);
    }

    const frame = encryptAppMessage(
      target.routeMode,
      identity.hostId,
      target.deviceId,
      identity.keyPair.secretKey,
      identity.keyPair.publicKey,
      target.publicKey,
      message,
      target.relaySeatId ?? undefined
    );
    for (const transportFrame of encodeEncryptedTransportFrames(frame)) {
      target.sendRaw(transportFrame);
    }
  }

  async function broadcast(message: AppMessage): Promise<void> {
    const targets = [...directTargets.values(), ...relayTargets.values()];
    await Promise.all(targets.map((target) => sendToTarget(target, message)));
  }

  async function refreshSessions(
    adapterFilter?: string,
    limit = MAX_SESSION_LIST_LIMIT
  ): Promise<AgentSession[]> {
    const managers =
      adapterFilter && adapterFilter !== "all"
        ? [managerByName.get(adapterFilter)].filter(
            (manager): manager is SessionManager => Boolean(manager)
          )
        : sessionManagers;

    const sessions = (
      await Promise.all(managers.map((manager) => manager.refreshSessions()))
    ).flat();

    return sessions
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, Math.min(Math.max(limit, 1), MAX_SESSION_LIST_LIMIT));
  }

  function toSessionListItem(session: AgentSession): SessionListItem {
    return {
      id: session.id,
      adapter: session.adapter,
      title: session.title,
      state: session.state,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      lastReadAt: session.lastReadAt ?? null
    };
  }

  function trimHistoryByDialogueCount(
    history: Awaited<ReturnType<SessionManager["getSessionHistory"]>>,
    dialogueLimit?: number
  ) {
    if (!history || !Number.isFinite(dialogueLimit) || (dialogueLimit ?? 0) <= 0) {
      return history;
    }

    const entries = history.entries ?? [];
    if (entries.length === 0) {
      return history;
    }

    let remainingTurns = Math.floor(dialogueLimit ?? 0);
    let startIndex = 0;
    let foundBoundary = false;

    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (entries[index].role === "user") {
        remainingTurns -= 1;
        if (remainingTurns <= 0) {
          startIndex = index;
          foundBoundary = true;
          break;
        }
      }
    }

    if (!foundBoundary) {
      return history;
    }

    return {
      ...history,
      entries: entries.slice(startIndex)
    };
  }

  function sliceHistoryEntries(
    history: Awaited<ReturnType<SessionManager["getSessionHistory"]>>,
    options?: {
      beforeTimestamp?: string;
      afterTimestamp?: string;
      limit?: number;
      dialogueLimit?: number;
      loadAll?: boolean;
    }
  ) {
    if (!history) {
      return history;
    }

    const allEntries = history.entries ?? [];
    const beforeTimestamp = options?.beforeTimestamp?.trim() || "";
    const afterTimestamp = options?.afterTimestamp?.trim() || "";
    const loadAll = options?.loadAll === true;
    const safeLimit = Math.max(1, Math.min(options?.limit ?? 200, MAX_SESSION_HISTORY_LIMIT));
    const hasDialogueLimit =
      Number.isFinite(options?.dialogueLimit) && (options?.dialogueLimit ?? 0) > 0;

    let mode: "tail" | "before" | "after" | "between" | "full" = "tail";
    let selected = allEntries;

    if (afterTimestamp && beforeTimestamp) {
      mode = "between";
      selected = allEntries.filter(
        (entry) => entry.timestamp > afterTimestamp && entry.timestamp < beforeTimestamp
      );
    } else if (afterTimestamp) {
      mode = "after";
      selected = allEntries.filter((entry) => entry.timestamp > afterTimestamp);
    } else if (beforeTimestamp) {
      mode = "before";
      selected = allEntries.filter((entry) => entry.timestamp < beforeTimestamp);
    } else if (loadAll) {
      mode = "full";
      selected = allEntries;
    } else {
      mode = "tail";
      selected = hasDialogueLimit
        ? allEntries
        : allEntries.slice(Math.max(allEntries.length - safeLimit, 0));
    }

    if (
      (mode === "tail" || mode === "before") &&
      hasDialogueLimit
    ) {
      selected =
        trimHistoryByDialogueCount(
          {
            ...history,
            entries: selected
          },
          options?.dialogueLimit
        )?.entries ?? selected;
    }

    if ((mode === "before" || mode === "after" || mode === "between") && loadAll) {
      // keep the entire sliced range
    } else if (mode === "before" && !loadAll && !hasDialogueLimit) {
      selected = selected.slice(Math.max(selected.length - safeLimit, 0));
    } else if (mode === "after" && !loadAll) {
      selected = selected.slice(0, safeLimit);
    } else if (mode === "between" && !loadAll) {
      selected = selected.slice(0, safeLimit);
    } else if (mode !== "tail" && !loadAll && !beforeTimestamp && !afterTimestamp) {
      selected = selected.slice(Math.max(selected.length - safeLimit, 0));
    }

    const firstEntry = selected[0];
    const lastEntry = selected[selected.length - 1];
    const hasMoreBefore = firstEntry
      ? allEntries.some((entry) => entry.timestamp < firstEntry.timestamp)
      : beforeTimestamp
        ? allEntries.some((entry) => entry.timestamp < beforeTimestamp)
        : mode !== "full" && allEntries.length > 0;
    const hasMoreAfter = lastEntry
      ? allEntries.some((entry) => entry.timestamp > lastEntry.timestamp)
      : afterTimestamp
        ? allEntries.some((entry) => entry.timestamp > afterTimestamp)
        : false;

    return {
      ...history,
      entries: selected,
      range: {
        mode,
        anchorTimestamp: beforeTimestamp || afterTimestamp || null,
        firstEntryTimestamp: firstEntry?.timestamp ?? null,
        lastEntryTimestamp: lastEntry?.timestamp ?? null,
        totalEntryCount: allEntries.length,
        hasMoreBefore,
        hasMoreAfter,
        isComplete:
          (selected.length === allEntries.length && allEntries.length > 0) ||
          (allEntries.length === 0 && !hasMoreBefore && !hasMoreAfter) ||
          (!hasMoreBefore && !hasMoreAfter)
      }
    };
  }

  async function refreshSessionListItems(
    adapterFilter?: string,
    limit = MAX_SESSION_LIST_LIMIT
  ): Promise<SessionListItem[]> {
    return (await refreshSessions(adapterFilter, limit)).map(toSessionListItem);
  }

  async function broadcastSessionList(timestamp = nowIso()): Promise<void> {
    await broadcast({
      type: "session_list",
      timestamp,
      payload: {
        sessions: await refreshSessionListItems()
      }
    });
  }

  function buildHostStatus() {
    return {
      hostId: identity.hostId,
      hostName: config.hostName,
      adapter: config.adapter,
      providers: listProviderCapabilities(),
      online: true,
      directEnabled: true,
      relayEnabled: hostStore.listRelayBindings().length > 0,
      activeSeatId: activeRelaySeatIds()[0] ?? null,
      activeSeatIds: activeRelaySeatIds(),
      publicKeyFingerprint: identity.publicKeyFingerprint,
      connectedDevices: directTargets.size + relayTargets.size,
      activeSessions: activeSessionCount(),
      timestamp: nowIso()
    };
  }

  function activeRelaySeatIds(): string[] {
    return [...relayClients.values()]
      .map((client) => client.seatId())
      .filter((seatId): seatId is string => Boolean(seatId));
  }

  function relayConnectionKey(bindingId: string, deviceId: string): string {
    return `${bindingId}:${deviceId}`;
  }

  function listRelayBindingViews() {
    return hostStore.listRelayBindings().map((binding) => {
      const client = relayClients.get(binding.id);
      return {
        id: binding.id,
        relayUrl: binding.relayUrl,
        credentialStored: Boolean(binding.hostCredential),
        connected: client?.isConnected() ?? false,
        seatId: client?.seatId() ?? binding.seatId ?? null,
        label: binding.label ?? null,
        createdAt: binding.createdAt,
        updatedAt: binding.updatedAt
      };
    });
  }

  function relayBindingSummaryView() {
    const first = listRelayBindingViews()[0];
    return {
      relayUrl: first?.relayUrl ?? config.relayUrl ?? null,
      credentialStored: first?.credentialStored ?? Boolean(config.relayCredential),
      connected: first?.connected ?? false,
      seatId: first?.seatId ?? null
    };
  }

  function findRelayClientBySeatId(seatId: string): RelayUpstreamClient | undefined {
    return [...relayClients.values()].find((client) => client.seatId() === seatId);
  }

  function sendRelayControlToSeat(seatId: string, frame: Parameters<RelayUpstreamClient["sendControl"]>[0]): void {
    const client = findRelayClientBySeatId(seatId);
    if (!client) {
      throw new Error(`Relay upstream is not connected for seat ${seatId}`);
    }
    client.sendControl(frame);
  }

  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/")) {
      return;
    }

    if (
      request.headers["x-codefly-secure-channel"] === "1"
    ) {
      return;
    }

    if (isLoopbackRequest(request)) {
      return;
    }

    const publicApiPrefixes = ["/api/direct/pairings/issue"];
    if (publicApiPrefixes.some((prefix) => request.url.startsWith(prefix))) {
      return;
    }

    if (!authenticateDirectHttpRequest(request, reply)) {
      return reply;
    }
  });

  async function emitInitialState(target: ConnectionTarget): Promise<void> {
    await sendToTarget(target, {
      type: "host_status",
      timestamp: nowIso(),
      payload: buildHostStatus()
    });
    await sendToTarget(target, {
      type: "session_list",
      timestamp: nowIso(),
      payload: {
        sessions: await refreshSessionListItems()
      }
    });
  }

  async function resolveRoutingTargetForCreate(providerInput: unknown): Promise<SessionRoutingTarget> {
    if (typeof providerInput === "string" && providerInput.trim()) {
      const manager = managerByName.get(providerInput.trim());
      const adapter = adapterByName.get(providerInput.trim());
      if (!manager || !adapter) {
        throw new Error(`Provider is not available: ${providerInput}`);
      }
      return { manager, adapter };
    }

    if (sessionManagers.length === 1) {
      return {
        manager: sessionManagers[0],
        adapter: adapterByName.get(sessionManagers[0].providerName())!
      };
    }

    const defaultProvider = resolveDefaultProvider();
    if (defaultProvider) {
      return {
        manager: managerByName.get(defaultProvider)!,
        adapter: adapterByName.get(defaultProvider)!
      };
    }

    throw new Error("Provider is required when multiple providers are available");
  }

  async function resolveRoutingTargetForSession(
    sessionId: string,
    preferredProvider?: string
  ): Promise<SessionRoutingTarget> {
    if (preferredProvider) {
      const manager = managerByName.get(preferredProvider);
      const adapter = adapterByName.get(preferredProvider);
      if (!manager || !adapter) {
        throw new Error(`Provider is not available: ${preferredProvider}`);
      }
      if (manager.knowsSession(sessionId)) {
        return { manager, adapter };
      }
      const attached = await manager.tryAttachSession(sessionId);
      if (attached) {
        return { manager, adapter };
      }
      throw new Error("Session not found");
    }

    for (const manager of sessionManagers) {
      if (manager.knowsSession(sessionId)) {
        return {
          manager,
          adapter: adapterByName.get(manager.providerName())!
        };
      }
    }

    await Promise.all(sessionManagers.map((manager) => manager.refreshSessions()));
    for (const manager of sessionManagers) {
      if (manager.knowsSession(sessionId)) {
        return {
          manager,
          adapter: adapterByName.get(manager.providerName())!
        };
      }
    }

    for (const manager of sessionManagers) {
      const attached = await manager.tryAttachSession(sessionId);
      if (attached) {
        return {
          manager,
          adapter: adapterByName.get(manager.providerName())!
        };
      }
    }

    throw new Error("Session not found");
  }

  async function maybeReloadRuntime(
    provider: ProviderName,
    reloadRuntime: boolean | undefined
  ): Promise<boolean> {
    if (!reloadRuntime) {
      return false;
    }

    const adapter = adapterByName.get(provider);
    if (!adapter?.reloadConfiguration) {
      return false;
    }

    await adapter.reloadConfiguration();
    return true;
  }

  async function maybeApplySessionConfig(
    provider: ProviderName,
    sessionId: string,
    applyImmediately: boolean | undefined
  ): Promise<boolean> {
    if (!applyImmediately) {
      return false;
    }

    const adapter = adapterByName.get(provider);
    if (!adapter?.onSessionConfigurationUpdated) {
      return false;
    }

    const manager = providerManagers.get(provider);
    const resolvedSessionId = manager ? manager.resolveSessionId(sessionId) : sessionId;
    await adapter.onSessionConfigurationUpdated(resolvedSessionId);
    return true;
  }

  function resolveProviderSessionId(provider: ProviderName, sessionId: string): string {
    const manager = providerManagers.get(provider);
    return manager ? manager.resolveSessionId(sessionId) : sessionId;
  }

  async function sendDiff(
    target: ConnectionTarget,
    sessionId: string,
    diff: DiffPreview | undefined
  ): Promise<void> {
    await sendToTarget(target, {
      type: "diff_preview",
      sessionId,
      timestamp: nowIso(),
      payload:
        diff ?? {
          id: "none",
          sessionId,
          summary: "No diff available",
          unifiedDiff: "",
          createdAt: nowIso()
        }
    });
  }

  async function sendError(
    target: ConnectionTarget,
    error: unknown,
    requestId?: string
  ): Promise<void> {
    await sendToTarget(target, {
      type: "error",
      ...(requestId ? { requestId } : {}),
      timestamp: nowIso(),
      payload: {
        message: error instanceof Error ? error.message : "Unknown error"
      }
    });
  }

  async function maybePublishNotificationFromSessionMessage(
    manager: SessionManager,
    message: AppMessage
  ): Promise<void> {
    if (!message.sessionId) {
      return;
    }
    const sessionId = manager.resolveSessionId(message.sessionId);
    const session = manager.peekSession(sessionId);
    if (!session) {
      return;
    }

    if (message.type === "approval_request") {
      const payload = (message.payload as Record<string, unknown> | undefined) ?? {};
      const approvalId = String(payload.id ?? "");
      if (approvalId) {
        await notificationPublisher.publish({
          category: "session_action_required",
          occurredAt: message.timestamp,
          sessionId,
          sessionTitle: session.title,
          provider: session.adapter,
          actionKind: "approval",
          dedupeKey: `session_action_required:${sessionId}:approval:${approvalId}`
        });
      }
      return;
    }

    if (message.type === "choice_request") {
      const payload = (message.payload as Record<string, unknown> | undefined) ?? {};
      const choiceId = String(payload.id ?? "");
      if (choiceId) {
        await notificationPublisher.publish({
          category: "session_action_required",
          occurredAt: message.timestamp,
          sessionId,
          sessionTitle: session.title,
          provider: session.adapter,
          actionKind: "choice",
          dedupeKey: `session_action_required:${sessionId}:choice:${choiceId}`
        });
      }
      return;
    }

    if (message.type === "error") {
      const notificationState = sessionNotificationStates.get(sessionId) ?? {
        terminalNotified: false,
        errorNotified: false
      };
      if (!notificationState.errorNotified) {
        notificationState.errorNotified = true;
        notificationState.state = "error";
        sessionNotificationStates.set(sessionId, notificationState);
        await notificationPublisher.publish({
          category: "session_error",
          occurredAt: message.timestamp,
          sessionId,
          sessionTitle: session.title,
          provider: session.adapter,
          dedupeKey: `session_error:${identity.publicKeyFingerprint}:${sessionId}:${message.timestamp}`
        });
        return;
      }
      notificationState.errorNotified = true;
      notificationState.state = "error";
      sessionNotificationStates.set(sessionId, notificationState);
      return;
    }

    if (message.type === "session_state") {
      const payload = (message.payload as Record<string, unknown> | undefined) ?? {};
      const state = String(payload.state ?? "");
      const reason = String(payload.reason ?? "");
      const notificationState = sessionNotificationStates.get(sessionId) ?? {
        terminalNotified: false,
        errorNotified: false
      };
      const previousState = notificationState.state;
      const activeState =
        state === "running" || state === "awaiting_approval" || state === "awaiting_choice";
      if (activeState) {
        notificationState.terminalNotified = false;
        notificationState.errorNotified = false;
      }
      if (state === "error") {
        if (!notificationState.errorNotified && previousState !== "error") {
          notificationState.errorNotified = true;
          notificationState.state = state;
          sessionNotificationStates.set(sessionId, notificationState);
          await notificationPublisher.publish({
            category: "session_error",
            occurredAt: message.timestamp,
            sessionId,
            sessionTitle: session.title,
            provider: session.adapter,
            dedupeKey: `session_error:${identity.publicKeyFingerprint}:${sessionId}:${message.timestamp}`
          });
          return;
        }
        notificationState.errorNotified = true;
        notificationState.state = state;
        sessionNotificationStates.set(sessionId, notificationState);
        return;
      }
      if (state === "idle" || state === "completed") {
        const wasActive =
          previousState === "running" ||
          previousState === "awaiting_approval" ||
          previousState === "awaiting_choice";
        if (
          !notificationState.terminalNotified &&
          (wasActive || reason === "turn_completed")
        ) {
          notificationState.terminalNotified = true;
          notificationState.state = state;
          sessionNotificationStates.set(sessionId, notificationState);
          await notificationPublisher.publish({
            category: "session_completed",
            occurredAt: message.timestamp,
            sessionId,
            sessionTitle: session.title,
            provider: session.adapter,
            dedupeKey: `session_completed:${identity.publicKeyFingerprint}:${sessionId}:${message.timestamp}`
          });
          return;
        }
        notificationState.terminalNotified = true;
      }
      notificationState.state = state;
      sessionNotificationStates.set(sessionId, notificationState);
    }
  }

  function shouldMarkSessionReadForActiveViewer(message: AppMessage): boolean {
    return (
      message.type === "assistant_delta" ||
      message.type === "session_state" ||
      message.type === "approval_request" ||
      message.type === "choice_request" ||
      message.type === "provider_event" ||
      message.type === "tool_event" ||
      message.type === "plan_update" ||
      message.type === "diff_preview" ||
      message.type === "session_metrics" ||
      message.type === "error"
    );
  }

  sessionManagers.forEach((manager) => {
    manager.onMessage((message) => {
      if (message.type === "session_replace") {
        const payload = message.payload as {
          previousSessionId?: unknown;
          session?: AgentSession;
        } | undefined;
        const previousSessionId =
          typeof payload?.previousSessionId === "string" ? payload.previousSessionId : "";
        const nextSessionId = payload?.session?.id ?? message.sessionId ?? "";
        if (previousSessionId && nextSessionId) {
          notificationPublisher.replaceSessionId(previousSessionId, nextSessionId);
        }
      }
      if (
        message.sessionId &&
        shouldMarkSessionReadForActiveViewer(message) &&
        notificationPublisher.hasActiveSessionViewer(manager.resolveSessionId(message.sessionId))
      ) {
        manager.markSessionRead(message.sessionId, message.timestamp, { broadcast: false });
      }
      if (message.type === "session_list") {
        void broadcastSessionList(message.timestamp);
        return;
      }
      void maybePublishNotificationFromSessionMessage(manager, message);
      void broadcast(message);
    });
  });

  async function handleMessage(source: ConnectionTarget, message: AppMessage): Promise<void> {
    switch (message.type) {
      case "hello":
        await emitInitialState(source);
        break;
      case "pair_request": {
        const payload = (message.payload as Record<string, unknown> | undefined) ?? {};
        const code = String(payload.code ?? "").trim().toUpperCase();
        const deviceLabel = String(payload.deviceLabel ?? source.label ?? source.deviceId).trim();
        const pairing = code ? hostStore.claimPairingCode(code) : null;
        if (!pairing) {
          throw new Error("Invalid or expired pairing code");
        }
        const { authToken } = hostStore.pairDevice(
          source.deviceId,
          deviceLabel || source.deviceId,
          source.publicKey,
          nowIso()
        );
        source.label = deviceLabel || source.deviceId;
        await sendToTarget(source, {
          type: "pair_confirm",
          requestId: message.requestId,
          timestamp: nowIso(),
          payload: {
            deviceId: source.deviceId,
            authToken,
            hostName: config.hostName,
            directUrl: pairing.directUrl || config.directPublicUrl,
            serviceBaseUrl: hostStore.getServiceBaseUrl() ?? config.serviceBaseUrl ?? null,
            hostPublicKey: identity.keyPair.publicKey,
            hostPublicKeyFingerprint: identity.publicKeyFingerprint
          }
        });
        break;
      }
      case "host_request": {
        const payload = (message.payload as Record<string, unknown> | undefined) ?? {};
        const method = String(payload.method ?? "GET").toUpperCase();
        const requestPath = String(payload.path ?? "/").trim() || "/";
        const headers =
          payload.headers && typeof payload.headers === "object" && !Array.isArray(payload.headers)
            ? (payload.headers as Record<string, string>)
            : {};
        const response = await (app.inject as any)({
          method: method as any,
          url: requestPath,
          payload: payload.body as any,
          headers: {
            ...headers,
            "x-codefly-secure-channel": "1"
          }
        });
        let body: unknown = response.body;
        try {
          body = response.body ? JSON.parse(response.body) : null;
        } catch {
          body = response.body;
        }
        await sendToTarget(source, {
          type: "host_response",
          requestId: message.requestId,
          timestamp: nowIso(),
          payload: {
            status: response.statusCode,
            body,
            headers: Object.fromEntries(
              Object.entries(response.headers).filter(
                (entry): entry is [string, string] => typeof entry[1] === "string"
              )
            )
          }
        });
        break;
      }
      case "session_list": {
        const payload = (message.payload as Record<string, unknown> | undefined) ?? {};
        const limit = Number(payload.limit ?? 100);
        const adapterFilter =
          typeof payload.adapter === "string" ? payload.adapter : undefined;
        await sendToTarget(source, {
          type: "session_list",
          timestamp: nowIso(),
          payload: {
            sessions: await refreshSessionListItems(adapterFilter, limit)
          }
        });
        break;
      }
      case "session_start": {
        const payload = (message.payload as Record<string, unknown> | undefined) ?? {};
        const workspacePath = await resolveSessionWorkspacePath(payload.workspacePath);
        const target = await resolveRoutingTargetForCreate(payload.provider);
        const session = await target.manager.startSession(workspacePath);
        await sendToTarget(source, {
          type: "session_attach",
          sessionId: session.id,
          timestamp: nowIso(),
          payload: session
        });
        break;
      }
      case "session_attach": {
        if (!message.sessionId) {
          throw new Error("sessionId is required");
        }
        const payload = (message.payload as Record<string, unknown> | undefined) ?? {};
        source.installationId =
          typeof payload.installationId === "string" ? payload.installationId : source.installationId;
        source.installationTokenHash =
          typeof payload.installationTokenHash === "string"
            ? payload.installationTokenHash
            : source.installationTokenHash;
        notificationPublisher.markSessionAttached({
          connectionKey: source.connectionKey,
          deviceId: source.deviceId,
          routeMode: source.routeMode,
          relaySeatId: source.relaySeatId,
          sessionId: message.sessionId,
          installationId: source.installationId,
          installationTokenHash: source.installationTokenHash
        });
        const target = await resolveRoutingTargetForSession(
          message.sessionId,
          typeof payload.provider === "string" ? payload.provider : undefined
        );
        const attachedSession = await target.manager.attachSession(message.sessionId);
        const session = target.manager.markSessionRead(attachedSession.id) ?? attachedSession;
        if (session.id !== message.sessionId) {
          notificationPublisher.markSessionAttached({
            connectionKey: source.connectionKey,
            deviceId: source.deviceId,
            routeMode: source.routeMode,
            relaySeatId: source.relaySeatId,
            sessionId: session.id,
            installationId: source.installationId,
            installationTokenHash: source.installationTokenHash
          });
        }
        await sendToTarget(source, {
          type: "session_attach",
          sessionId: session.id,
          timestamp: nowIso(),
          payload: session
        });
        break;
      }
      case "session_detach": {
        if (!message.sessionId) {
          throw new Error("sessionId is required");
        }
        notificationPublisher.markSessionDetached(source.connectionKey, message.sessionId);
        break;
      }
      case "session_read": {
        if (!message.sessionId) {
          throw new Error("sessionId is required");
        }
        const target = await resolveRoutingTargetForSession(message.sessionId);
        target.manager.markSessionRead(message.sessionId);
        break;
      }
      case "session_snapshot": {
        if (!message.sessionId) {
          throw new Error("sessionId is required");
        }
        const target = await resolveRoutingTargetForSession(message.sessionId);
        const limit = Number(
          ((message.payload as Record<string, unknown> | undefined) ?? {}).limit ?? 100
        );
        const snapshot = await target.manager.getSessionSnapshot(message.sessionId, limit);
        if (!snapshot) {
          throw new Error("Session not found");
        }
        await sendToTarget(source, {
          type: "session_snapshot",
          sessionId: snapshot.session.id,
          timestamp: nowIso(),
          payload: snapshot
        });
        break;
      }
      case "session_events": {
        if (!message.sessionId) {
          throw new Error("sessionId is required");
        }
        const target = await resolveRoutingTargetForSession(message.sessionId);
        const limit = Number(
          ((message.payload as Record<string, unknown> | undefined) ?? {}).limit ?? 100
        );
        const resolvedSessionId = target.manager.resolveSessionId(message.sessionId);
        await sendToTarget(source, {
          type: "session_events",
          sessionId: resolvedSessionId,
          timestamp: nowIso(),
          payload: {
            events: target.manager.listSessionEvents(resolvedSessionId, limit)
          }
        });
        break;
      }
      case "session_history": {
        if (!message.sessionId) {
          throw new Error("sessionId is required");
        }
        const target = await resolveRoutingTargetForSession(message.sessionId);
        const limit = Number(
          ((message.payload as Record<string, unknown> | undefined) ?? {}).limit ?? 200
        );
        const history = await target.manager.getSessionHistory(message.sessionId, limit);
        if (!history) {
          throw new Error("Session history not found");
        }
        await sendToTarget(source, {
          type: "session_history",
          sessionId: history.session.id,
          timestamp: nowIso(),
          payload: history
        });
        break;
      }
      case "session_input": {
        if (!message.sessionId) {
          throw new Error("sessionId is required");
        }
        const payload = (message.payload as Record<string, unknown> | undefined) ?? {};
        const installationTokenHash =
          typeof payload.installationTokenHash === "string"
            ? payload.installationTokenHash
            : source.installationTokenHash;
        source.installationTokenHash = installationTokenHash;
        if (source.routeMode === "direct") {
          notificationPublisher.rememberDirectSessionTarget({
            connectionKey: source.connectionKey,
            sessionId: message.sessionId,
            installationTokenHash
          });
        }
        const input = String(
          payload.text ?? ""
        );
        const target = await resolveRoutingTargetForSession(message.sessionId);
        const session = await target.manager.sendInput(message.sessionId, input);
        target.manager.markSessionRead(session.id, nowIso(), { broadcast: false });
        break;
      }
      case "approval_response": {
        if (!message.sessionId) {
          throw new Error("sessionId is required");
        }
        const payload = (message.payload as Record<string, unknown> | undefined) ?? {};
        const installationTokenHash =
          typeof payload.installationTokenHash === "string"
            ? payload.installationTokenHash
            : source.installationTokenHash;
        source.installationTokenHash = installationTokenHash;
        if (source.routeMode === "direct") {
          notificationPublisher.rememberDirectSessionTarget({
            connectionKey: source.connectionKey,
            sessionId: message.sessionId,
            installationTokenHash
          });
        }
        const approvalId = String(payload.approvalId ?? "");
        const decision = String(payload.decision ?? "deny") === "approve" ? "approve" : "deny";
        const target = await resolveRoutingTargetForSession(message.sessionId);
        await target.manager.respondToApproval(message.sessionId, approvalId, decision);
        break;
      }
      case "choice_response": {
        if (!message.sessionId) {
          throw new Error("sessionId is required");
        }
        const payload = (message.payload as Record<string, unknown> | undefined) ?? {};
        const installationTokenHash =
          typeof payload.installationTokenHash === "string"
            ? payload.installationTokenHash
            : source.installationTokenHash;
        source.installationTokenHash = installationTokenHash;
        if (source.routeMode === "direct") {
          notificationPublisher.rememberDirectSessionTarget({
            connectionKey: source.connectionKey,
            sessionId: message.sessionId,
            installationTokenHash
          });
        }
        const choiceId = String(payload.choiceId ?? "");
        const rawAnswers = Array.isArray(payload.answers) ? payload.answers : [];
        const answers = rawAnswers
          .filter(
            (answer): answer is Record<string, unknown> =>
              Boolean(answer) && typeof answer === "object"
          )
          .map((answer) => ({
            fieldId: String(answer.fieldId ?? ""),
            value:
              answer.value === undefined ||
              typeof answer.value === "string" ||
              typeof answer.value === "number" ||
              typeof answer.value === "boolean" ||
              answer.value === null ||
              (Array.isArray(answer.value) &&
                answer.value.every((item) => typeof item === "string"))
                ? (answer.value as string | number | boolean | string[] | null)
                : null
          }));
        const target = await resolveRoutingTargetForSession(message.sessionId);
        await target.manager.respondToChoice(message.sessionId, choiceId, answers);
        break;
      }
      case "diff_preview": {
        if (!message.sessionId) {
          throw new Error("sessionId is required");
        }
        const target = await resolveRoutingTargetForSession(message.sessionId);
        const resolvedSessionId = target.manager.resolveSessionId(message.sessionId);
        const diff = await target.manager.getDiffPreview(resolvedSessionId);
        await sendDiff(source, resolvedSessionId, diff);
        break;
      }
      case "session_resume":
        if (!message.sessionId) {
          throw new Error("sessionId is required");
        }
        await (await resolveRoutingTargetForSession(message.sessionId)).manager.resumeSession(
          message.sessionId
        );
        break;
      case "session_interrupt":
        if (!message.sessionId) {
          throw new Error("sessionId is required");
        }
        await (await resolveRoutingTargetForSession(message.sessionId)).manager.interruptSession(
          message.sessionId
        );
        break;
      default:
        throw new Error(`Unsupported message type: ${message.type}`);
    }
  }

  function handleEncryptedInbound(source: ConnectionTarget, frame: EncryptedAppFrame): void {
    try {
      const message = decryptAppFrame(frame, identity.keyPair.secretKey);
      const payload = message.payload as Record<string, unknown> | undefined;
      if (payload && typeof payload.appVersion === "string") {
        source.appVersion = payload.appVersion;
      }
      void handleMessage(source, message).catch((error) => {
        void sendError(source, error, message.requestId);
      });
    } catch (error) {
      void sendError(source, error);
    }
  }

  function registerDirectRawSocket(socket: net.Socket): void {
    const state: DirectRawConnectionState = {
      socket,
      buffer: "",
      reassembler: new EncryptedTransportReassembler()
    };

    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      state.buffer += chunk;
      let newlineIndex = state.buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = state.buffer.slice(0, newlineIndex).trim();
        state.buffer = state.buffer.slice(newlineIndex + 1);
        if (line) {
          void handleDirectRawLine(state, line);
        }
        newlineIndex = state.buffer.indexOf("\n");
      }
      if (Buffer.byteLength(state.buffer, "utf8") > CODEFLY_MAX_TRANSPORT_PACKET_BYTES) {
        socket.destroy(new Error("Direct transport packet exceeded the maximum allowed size"));
      }
    });

    socket.on("close", () => {
      if (state.target) {
        notificationPublisher.markConnectionDetached(state.target.connectionKey);
        directTargets.delete(state.target.connectionKey);
      }
    });

    socket.on("error", (error) => {
      app.log.warn({ err: error }, "Direct raw socket error");
    });
  }

  function createDirectRawTarget(
    state: DirectRawConnectionState,
    frame: EncryptedAppFrame,
    label: string,
    publicKey: string
  ): ConnectionTarget {
    return {
      connectionKey: frame.senderId,
      deviceId: frame.senderId,
      label,
      publicKey,
      routeMode: "direct",
      sendRaw: (outboundFrame) => state.socket.write(`${JSON.stringify(outboundFrame)}\n`)
    };
  }

  async function closeDirectRawWithError(
    state: DirectRawConnectionState,
    frame: EncryptedAppFrame,
    message: AppMessage,
    publicKey: string,
    error: unknown
  ): Promise<void> {
    const target = createDirectRawTarget(state, frame, frame.senderId, publicKey);
    await sendError(target, error, message.requestId).catch((sendErrorFailure) => {
      app.log.warn({ err: sendErrorFailure }, "Failed to send direct raw error frame");
    });
    state.socket.end();
  }

  function shouldKeepDirectRawSocket(message: AppMessage): boolean {
    return message.type !== "pair_request" && message.type !== "host_request";
  }

  async function handleDirectRawLine(state: DirectRawConnectionState, line: string): Promise<void> {
    let frame: EncryptedAppFrame;
    try {
      if (Buffer.byteLength(line, "utf8") > CODEFLY_MAX_TRANSPORT_PACKET_BYTES) {
        throw new Error("Direct transport packet exceeded the maximum allowed size");
      }
      const parsed = JSON.parse(line) as unknown;
      if (!isEncryptedTransportFrame(parsed)) {
        throw new Error("Expected encrypted transport frame");
      }
      const completeFrame = state.reassembler.accept(parsed);
      if (!completeFrame) {
        return;
      }
      frame = completeFrame;
    } catch {
      state.socket.destroy();
      return;
    }

    const normalizedDevicePublicKey = normalizeDevicePublicKey(frame.senderPublicKey);
    if (!isValidDevicePublicKey(normalizedDevicePublicKey)) {
      state.socket.destroy();
      return;
    }

    let message: AppMessage;
    try {
      message = decryptAppFrame(frame, identity.keyPair.secretKey);
    } catch (error) {
      state.socket.destroy();
      return;
    }

    let target = state.target;
    if (!target) {
      if (message.type !== "pair_request") {
        const payload = (message.payload as Record<string, unknown> | undefined) ?? {};
        const authToken = String(payload.authToken ?? "").trim();
        const paired = hostStore.validatePairedDevice(frame.senderId, authToken);
        if (!paired) {
          await closeDirectRawWithError(
            state,
            frame,
            message,
            normalizedDevicePublicKey,
            new Error("Unauthorized device")
          );
          return;
        }
        if (paired.publicKey !== normalizedDevicePublicKey) {
          hostStore.updatePairedDevicePublicKey(frame.senderId, normalizedDevicePublicKey);
        }
        hostStore.touchPairedDevice(frame.senderId, nowIso());
        target = createDirectRawTarget(state, frame, paired.label, normalizedDevicePublicKey);
      } else {
        target = createDirectRawTarget(state, frame, frame.senderId, normalizedDevicePublicKey);
      }

      if (shouldKeepDirectRawSocket(message)) {
        state.target = target;
        directTargets.set(target.connectionKey, target);
      }
    }

    const closeAfterResponse = !shouldKeepDirectRawSocket(message);
    try {
      await handleMessage(target, message);
      if (closeAfterResponse) {
        state.socket.end();
      }
    } catch (error) {
      await sendError(target, error, message.requestId);
      if (closeAfterResponse) {
        state.socket.end();
      }
    }
  }

  registerHostClientRoutes({
    app,
    config,
    hostStore,
    identity,
    managerByName,
    providerManagers,
    providerConfigs,
    runtimeConfigStore,
    notificationPublisher,
    directTargets,
    relayTargets,
    requireLoopbackRequest,
    isLoopbackRequest,
    buildHostStatus,
    listProviderCapabilities,
    listRelayBindingViews,
    relayBindingSummaryView,
    activeRelaySeatIds,
    activeSessionCount,
    getDirectRequestTarget,
    resolveWorkspacePath,
    resolveSessionWorkspacePath,
    sendWorkspacePathError,
    isWorkspacePathError,
    assertDirectoryAccessible,
    assertDirectoryExists,
    resolveScopedPath,
    isPathWithinRoot,
    isLikelyUtf8Text,
    buildWorkspaceFileAccess,
    assertFileExists,
    refreshSessions,
    refreshSessionListItems,
    requireConfigurableProvider,
    detectProviderAuthMode,
    resolveProviderSessionId,
    maybeReloadRuntime,
    maybeApplySessionConfig,
    sendDiff,
    sendError,
    resolveRoutingTargetForCreate,
    resolveRoutingTargetForSession,
    handleMessage,
    resolveDefaultProvider,
    sliceHistoryEntries,
    collectHostHardwareSnapshot,
    MAX_SESSION_LIST_LIMIT,
    MAX_SESSION_HISTORY_LIMIT,
    MAX_EDITABLE_TEXT_BYTES,
    MAX_UPLOAD_FILE_BYTES,
    MAX_UPLOAD_REQUEST_BODY_BYTES,
    utf8TextDecoder
  });

  const relayUpstreams = registerRelayUpstreamRoutes({
    app,
    config,
    hostStore,
    identity,
    relayTargets,
    relayClients,
    notificationPublisher,
    relayConnectionKey,
    handleEncryptedInbound,
    emitInitialState,
    requireLoopbackRequest
  });

  app.get("/api/host/direct-service-config", async (request, reply) => {
    if (!requireLoopbackRequest(request, reply)) {
      return;
    }
    return {
      publicHost: config.directPublicHost,
      bindHost: config.bindHost,
      bindHosts: config.bindHosts,
      port: config.port,
      directPublicUrl: config.directPublicUrl,
      restartRequired: false
    };
  });

  app.put<{ Body: { publicHost?: string; bindHosts?: string[] | string; port?: number } }>(
    "/api/host/direct-service-config",
    async (request, reply) => {
      if (!requireLoopbackRequest(request, reply)) {
        return;
      }
      let publicHost: string;
      try {
        publicHost = normalizeDirectPublicHost(String(request.body?.publicHost ?? ""));
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : "Invalid public host"
        });
      }
      const port = Number(request.body?.port);
      if (!publicHost || !Number.isFinite(port) || port <= 0 || port > 65535) {
        return reply.code(400).send({ error: "publicHost and port are required" });
      }
      let bindHosts: string[];
      try {
        const rawBindHosts = Array.isArray(request.body?.bindHosts)
          ? request.body.bindHosts.join(",")
          : String(request.body?.bindHosts ?? config.bindHosts.join(","));
        bindHosts = parseBindHosts(rawBindHosts);
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : "Invalid bind hosts"
        });
      }

      const previousPort = config.port;
      const previousBindHosts = [...config.bindHosts];
      const next = hostStore.setDirectServiceConfig({
        publicHost,
        bindHosts,
        port,
        certificatePath: config.directCertificatePath
      });
      config.directPublicHost = next.publicHost;
      config.bindHosts = next.bindHosts;
      config.bindHost = config.bindHosts.join(", ");
      config.port = next.port;
      config.directPublicUrl = buildDirectPublicUrl(config.directPublicHost, config.port);

      return {
        publicHost: config.directPublicHost,
        bindHost: config.bindHost,
        bindHosts: config.bindHosts,
        port: config.port,
        directPublicUrl: config.directPublicUrl,
        restartRequired: previousPort !== config.port || !sameStringArray(previousBindHosts, config.bindHosts)
      };
    }
  );

  app.get("/api/host/security-config", async (request, reply) => {
    if (!requireLoopbackRequest(request, reply)) {
      return;
    }
    return {
      certificatePath: config.directCertificatePath,
      keyPath: config.directKeyPath,
      certificateFingerprint: identity.certificateFingerprint,
      hostPublicKey: identity.keyPair.publicKey,
      hostPublicKeyFingerprint: identity.publicKeyFingerprint,
      restartRequired: false
    };
  });

  app.put<{ Body: { certificatePath?: string } }>("/api/host/security-config", async (request, reply) => {
    if (!requireLoopbackRequest(request, reply)) {
      return;
    }
    const certificatePath = String(request.body?.certificatePath ?? "").trim();
    if (!certificatePath) {
      return reply.code(400).send({ error: "certificatePath is required" });
    }

    const previousCertificatePath = config.directCertificatePath;
    const next = hostStore.setDirectServiceConfig({
      publicHost: config.directPublicHost,
      bindHosts: config.bindHosts,
      port: config.port,
      certificatePath
    });
    config.directCertificatePath = next.certificatePath ?? config.directCertificatePath;
    config.directKeyPath =
      process.env.HOST_CLIENT_TLS_KEY_PATH ?? deriveTlsKeyPath(config.directCertificatePath);

    return {
      certificatePath: config.directCertificatePath,
      keyPath: config.directKeyPath,
      certificateFingerprint: identity.certificateFingerprint,
      hostPublicKey: identity.keyPair.publicKey,
      hostPublicKeyFingerprint: identity.publicKeyFingerprint,
      restartRequired: previousCertificatePath !== config.directCertificatePath
    };
  });

  app.get("/api/host/service-base-url", async (request, reply) => {
    if (!requireLoopbackRequest(request, reply)) {
      return;
    }
    return {
      serviceBaseUrl: hostStore.getServiceBaseUrl() ?? config.serviceBaseUrl ?? null
    };
  });

  app.put<{ Body: { serviceBaseUrl?: string } }>("/api/host/service-base-url", async (request, reply) => {
    if (!requireLoopbackRequest(request, reply)) {
      return;
    }
    const serviceBaseUrl = String(request.body?.serviceBaseUrl ?? "").trim();
    if (!serviceBaseUrl) {
      return reply.code(400).send({ error: "serviceBaseUrl is required" });
    }
    config.serviceBaseUrl = serviceBaseUrl;
    hostStore.setServiceBaseUrl(serviceBaseUrl);
    return { ok: true, serviceBaseUrl };
  });

  relayUpstreams.startAllRelayUpstreams();

  const directRawServers: net.Server[] = [];
  for (const bindHost of config.bindHosts) {
    const directRawServer = net.createServer((socket) => registerDirectRawSocket(socket));
    await new Promise<void>((resolve, reject) => {
      directRawServer.once("error", reject);
      directRawServer.listen(
        {
          port: config.port,
          host: bindHost,
          ipv6Only: bindHost === "::"
        },
        () => {
          directRawServer.off("error", reject);
          app.log.info({ bindHost, port: config.port }, "Direct raw TCP listener started");
          resolve();
        }
      );
    });
    directRawServers.push(directRawServer);
  }
  app.addHook("onClose", async () => {
    await Promise.all(
      directRawServers.map(
        (directRawServer) => new Promise<void>((resolve) => directRawServer.close(() => resolve()))
      )
    );
  });

  await app.listen({
    host: "127.0.0.1",
    port: config.managementPort
  });
}
