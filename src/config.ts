import { mkdirSync } from "node:fs";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  resolveClaudeConfigDir,
  resolveClaudeGlobalStatePath,
  resolveCodexConfigDir,
  resolveProviderPath,
  resolveUserHomePath
} from "./provider-runtime";

export type HostAdapterName = "codex" | "claude" | "multi";

export interface CodexAdapterConfig {
  providerName: string;
  baseUrl: string;
  model: string;
  reasoningEffort?: string;
  apiKey?: string;
  homeDir: string;
  configDir: string;
  approvalPolicy: "untrusted" | "on-failure" | "on-request" | "never" | "granular";
  approvalsReviewer: "user" | "auto_review" | "guardian_subagent";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
}

export interface ClaudeAdapterConfig {
  model: string;
  reasoningEffort?: string;
  baseUrl: string;
  apiKey?: string;
  homeDir: string;
  configDir: string;
  globalStatePath: string;
  permissionMode:
    | "default"
    | "acceptEdits"
    | "plan"
    | "auto"
    | "bypassPermissions"
    | "dontAsk";
  disableNonessentialTraffic: boolean;
  disableExperimentalBetas: boolean;
}

export interface HostClientConfig {
  bindHost: string;
  port: number;
  managementPort: number;
  useTls: boolean;
  dataDir: string;
  hostStatePath: string;
  runtimeConfigPath: string;
  hostName: string;
  directPublicUrl: string;
  directPublicHost: string;
  directCertificatePath: string;
  directKeyPath: string;
  workspaceDir: string;
  defaultWorkspaceDir: string;
  adapter: HostAdapterName;
  codex: CodexAdapterConfig;
  claude: ClaudeAdapterConfig;
  relayUrl?: string;
  relayCredential?: string;
  serviceBaseUrl?: string;
}

export function loadHostClientConfig(): HostClientConfig {
  const cwd = process.cwd();
  const dataDir = path.resolve(cwd, process.env.HOST_CLIENT_DATA_DIR ?? "./data");
  mkdirSync(dataDir, { recursive: true });
  const userHome = resolveUserHomePath(os.homedir());

  const bindHost = process.env.HOST_CLIENT_BIND ?? "0.0.0.0";
  const useTls = false;
  const port = Number(process.env.HOST_CLIENT_PORT ?? "7788");
  const managementPort = Number(process.env.HOST_CLIENT_MANAGEMENT_PORT ?? String(port + 1));
  const directPublicHost = normalizeDirectPublicHost(
    process.env.HOST_CLIENT_DIRECT_PUBLIC_HOST ?? getPrimaryNetworkAddress()
  );
  const directPublicUrl = buildDirectPublicUrl(directPublicHost, port);
  const workspaceDir = resolveProviderPath(process.env.HOST_CLIENT_WORKSPACE_DIR ?? userHome, cwd);
  const defaultWorkspaceDir = resolveProviderPath(
    process.env.HOST_CLIENT_DEFAULT_WORKSPACE_DIR ?? workspaceDir,
    cwd
  );
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(defaultWorkspaceDir, { recursive: true });
  const adapter = parseHostAdapterName(process.env.HOST_CLIENT_ADAPTER);
  const runtimeConfigPath = path.resolve(dataDir, "runtime-config.json");
  const codexHomeDir = resolveUserHomePath(process.env.CODEX_HOME_DIR ?? userHome);
  const claudeHomeDir = resolveUserHomePath(process.env.CLAUDE_HOME_DIR ?? userHome);
  const sharedApiKey =
    process.env.PROVIDER_API_KEY ??
    process.env.RIGHT_CODES_API_KEY ??
    process.env.CODEX_API_KEY ??
    process.env.CLAUDE_API_KEY;

  const config: HostClientConfig = {
    bindHost,
    port,
    managementPort,
    useTls,
    dataDir,
    hostStatePath: path.resolve(dataDir, "host-state.json"),
    runtimeConfigPath,
    hostName: process.env.HOST_CLIENT_NAME ?? "CodeFly Test Host",
    directPublicUrl,
    directPublicHost,
    directCertificatePath: path.resolve(
      process.env.HOST_CLIENT_TLS_CERT_PATH ?? path.join(dataDir, "tls.crt")
    ),
    directKeyPath: path.resolve(
      process.env.HOST_CLIENT_TLS_KEY_PATH ?? path.join(dataDir, "tls.key")
    ),
    workspaceDir,
    defaultWorkspaceDir,
    adapter,
    codex: {
      providerName: process.env.CODEX_PROVIDER_NAME ?? "rightcode",
      baseUrl: normalizeCodexBaseUrl(process.env.CODEX_BASE_URL ?? "https://right.codes/codex"),
      model: process.env.CODEX_MODEL ?? "gpt-5.4-mini",
      reasoningEffort: emptyToUndefined(process.env.CODEX_REASONING_EFFORT),
      apiKey: process.env.CODEX_API_KEY ?? sharedApiKey,
      homeDir: codexHomeDir,
      configDir: resolveCodexConfigDir(
        codexHomeDir,
        process.env.CODEX_CONFIG_DIR ?? process.env.CODEX_HOME
      ),
      approvalPolicy: (
        process.env.CODEX_APPROVAL_POLICY ?? "on-request"
      ) as CodexAdapterConfig["approvalPolicy"],
      approvalsReviewer: (
        process.env.CODEX_APPROVALS_REVIEWER ?? "user"
      ) as CodexAdapterConfig["approvalsReviewer"],
      sandbox: (process.env.CODEX_SANDBOX ?? "danger-full-access") as CodexAdapterConfig["sandbox"]
    },
    claude: {
      model: process.env.CLAUDE_MODEL ?? "claude-haiku-4-5",
      reasoningEffort: emptyToUndefined(process.env.CLAUDE_REASONING_EFFORT),
      baseUrl: process.env.CLAUDE_BASE_URL ?? "https://right.codes/claude",
      apiKey: process.env.CLAUDE_API_KEY ?? sharedApiKey,
      homeDir: claudeHomeDir,
      configDir: resolveClaudeConfigDir(claudeHomeDir),
      globalStatePath: resolveClaudeGlobalStatePath(claudeHomeDir),
      permissionMode: (
        process.env.CLAUDE_PERMISSION_MODE ?? "default"
      ) as ClaudeAdapterConfig["permissionMode"],
      disableNonessentialTraffic:
        parseBoolean(process.env.CLAUDE_DISABLE_NONESSENTIAL_TRAFFIC, true),
      disableExperimentalBetas:
        parseBoolean(process.env.CLAUDE_DISABLE_EXPERIMENTAL_BETAS, false)
    },
    relayUrl: process.env.RELAY_URL,
    relayCredential: process.env.RELAY_HOST_CREDENTIAL,
    serviceBaseUrl: process.env.CODEFLY_SERVICE_BASE_URL ?? process.env.RELAY_URL
  };
  normalizeHostClientConfig(config);
  return config;
}

function parseHostAdapterName(value: string | undefined): HostAdapterName {
  return value === "codex" || value === "claude" || value === "multi" ? value : "multi";
}

export function normalizeHostClientConfig(config: HostClientConfig): void {
  config.codex.homeDir = resolveUserHomePath(config.codex.homeDir);
  config.codex.configDir = resolveCodexConfigDir(config.codex.homeDir, config.codex.configDir);
  config.claude.homeDir = resolveUserHomePath(config.claude.homeDir);
  config.claude.configDir = resolveClaudeConfigDir(config.claude.homeDir);
  config.claude.globalStatePath = resolveClaudeGlobalStatePath(config.claude.homeDir);
  config.workspaceDir = resolveProviderPath(config.workspaceDir, process.cwd());
  config.defaultWorkspaceDir = resolveProviderPath(config.defaultWorkspaceDir, process.cwd());
}

function getPrimaryNetworkAddress(): string {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        return entry.address;
      }
    }
  }
  return "127.0.0.1";
}

export function normalizeDirectPublicHost(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("HOST_CLIENT_DIRECT_PUBLIC_HOST is required");
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || trimmed.includes("/")) {
    throw new Error("HOST_CLIENT_DIRECT_PUBLIC_HOST must be a host name or IP address without protocol or path");
  }

  const unbracketed = trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;
  if (unbracketed.includes(":") && isIP(unbracketed) !== 6) {
    throw new Error("HOST_CLIENT_DIRECT_PUBLIC_HOST must not include a port");
  }
  return unbracketed;
}

export function buildDirectPublicUrl(host: string, port: number): string {
  const normalizedHost = normalizeDirectPublicHost(host);
  const hostForUrl = isIP(normalizedHost) === 6 ? `[${normalizedHost}]` : normalizedHost;
  return `codefly-tcp://${hostForUrl}:${port}`;
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }

  return value === "1" || value.toLowerCase() === "true";
}

function emptyToUndefined(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeCodexBaseUrl(value: string): string {
  const parsed = new URL(value);
  if (!parsed.pathname.endsWith("/v1")) {
    parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}/v1`;
  }
  return parsed.toString().replace(/\/$/, "");
}
