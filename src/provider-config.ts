import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import type { HostClientConfig } from "./config";

const TOML = require("@iarna/toml") as {
  parse: (input: string) => unknown;
  stringify: (input: unknown) => string;
};

export type ProviderName = "codex" | "claude";
export type ConfigScope = "global" | "session";
export type ConfigDocumentFormat = "toml" | "json";

export interface ConfigPatchOperation {
  set?: Record<string, unknown>;
  unset?: string[];
}

export interface GlobalConfigPatchInput {
  documents?: Partial<Record<"config" | "settings" | "global_state", ConfigPatchOperation>>;
  reloadRuntime?: boolean;
}

export interface SessionConfigPatchInput extends ConfigPatchOperation {
  applyImmediately?: boolean;
}

export interface ConfigDocumentSnapshot {
  kind: string;
  format: ConfigDocumentFormat;
  path: string;
  exists: boolean;
  managedByCodeFly?: boolean;
  explicitValues: Record<string, unknown>;
  explicitKeys: string[];
}

export interface ProviderConfigSnapshot {
  provider: ProviderName;
  scope: ConfigScope;
  sessionId?: string;
  documents: Record<string, ConfigDocumentSnapshot>;
  effectiveValues: Record<string, unknown>;
  defaults: Record<string, unknown>;
  runtimeApply: {
    applyMode: "reload_runtime" | "next_turn" | "persist_only";
    supportedKeys: string[];
    configuredKeys: string[];
    pendingKeys: string[];
  };
}

export interface CodexRuntimeConfig {
  providerName: string;
  model: string;
  reasoningEffort?: string;
  serviceTier?: string;
  approvalPolicy: string;
  approvalsReviewer: string;
  sandbox: string;
  personality: string;
}

export interface ClaudeRuntimeConfig {
  model: string;
  permissionMode: string;
  defaultMode?: string;
  env: Record<string, string>;
  allowedTools?: string[];
  disallowedTools?: string[];
  settings: Record<string, unknown>;
  globalState: Record<string, unknown>;
}

const CLAUDE_GLOBAL_STATE_KEYS = [
  "autoConnectIde",
  "autoInstallIdeExtension",
  "editorMode",
  "showTurnDuration",
  "terminalProgressBarEnabled",
  "teammateMode"
] as const;

const CODEX_SESSION_RUNTIME_KEYS = [
  "model",
  "model_provider",
  "model_reasoning_effort",
  "reasoning_effort",
  "model_reasoning_summary",
  "model_verbosity",
  "model_context_window",
  "model_auto_compact_token_limit",
  "service_tier",
  "web_search",
  "approval_policy",
  "approvals_reviewer",
  "sandbox_mode",
  "personality"
];

const CLAUDE_SESSION_RUNTIME_KEYS = [
  "model",
  "permissionMode",
  "defaultMode",
  "env",
  "allowedTools",
  "disallowedTools"
];

export class ProviderConfigManager {
  public constructor(private readonly config: HostClientConfig) {}

  public ensureBootstrapFiles(): void {
    mkdirSync(this.codexConfigDir(), { recursive: true });
    mkdirSync(this.claudeSettingsDir(), { recursive: true });
    mkdirSync(this.sessionConfigDir("codex"), { recursive: true });
    mkdirSync(this.sessionConfigDir("claude"), { recursive: true });

    if (!existsSync(this.codexConfigPath())) {
      this.writeTomlFile(this.codexConfigPath(), this.codexBootstrapConfig());
    }

    if (!existsSync(this.claudeSettingsPath())) {
      this.writeJsonFile(this.claudeSettingsPath(), this.claudeSettingsDefaults());
    }

    if (!existsSync(this.claudeGlobalStatePath())) {
      this.writeJsonFile(this.claudeGlobalStatePath(), {});
    }
  }

  public getGlobalSnapshot(provider: ProviderName): ProviderConfigSnapshot {
    return provider === "codex" ? this.getCodexGlobalSnapshot() : this.getClaudeGlobalSnapshot();
  }

  public patchGlobal(provider: ProviderName, patch: GlobalConfigPatchInput): ProviderConfigSnapshot {
    this.ensureBootstrapFiles();

    if (provider === "codex") {
      const configPatch = patch.documents?.config ?? {};
      const next = applyPatch(this.readTomlFile(this.codexConfigPath()), configPatch);
      this.writeTomlFile(this.codexConfigPath(), next);
      return this.getCodexGlobalSnapshot();
    }

    if (patch.documents?.settings) {
      const next = applyPatch(
        this.readJsonFile(this.claudeSettingsPath()),
        patch.documents.settings
      );
      this.writeJsonFile(this.claudeSettingsPath(), next);
    }

    if (patch.documents?.global_state) {
      this.assertAllowedClaudeGlobalStatePaths(patch.documents.global_state);
      const raw = this.readJsonFile(this.claudeGlobalStatePath());
      const next = applyPatch(raw, patch.documents.global_state);
      this.writeJsonFile(this.claudeGlobalStatePath(), next);
    }

    return this.getClaudeGlobalSnapshot();
  }

  public getSessionSnapshot(
    provider: ProviderName,
    sessionId: string
  ): ProviderConfigSnapshot {
    return provider === "codex"
      ? this.getCodexSessionSnapshot(sessionId)
      : this.getClaudeSessionSnapshot(sessionId);
  }

  public patchSession(
    provider: ProviderName,
    sessionId: string,
    patch: SessionConfigPatchInput
  ): ProviderConfigSnapshot {
    this.ensureBootstrapFiles();
    const current = provider === "codex"
      ? this.readTomlFile(this.codexSessionOverlayPath(sessionId))
      : this.readJsonFile(this.claudeSessionOverlayPath(sessionId));
    const next = applyPatch(current, patch);
    if (provider === "codex") {
      this.writeTomlFile(this.codexSessionOverlayPath(sessionId), next);
    } else {
      this.writeJsonFile(this.claudeSessionOverlayPath(sessionId), next);
    }
    return this.getSessionSnapshot(provider, sessionId);
  }

  public clearSession(provider: ProviderName, sessionId: string): void {
    const filePath =
      provider === "codex"
        ? this.codexSessionOverlayPath(sessionId)
        : this.claudeSessionOverlayPath(sessionId);
    if (existsSync(filePath)) {
      rmSync(filePath, { force: true });
    }
  }

  public renameSession(
    provider: ProviderName,
    previousSessionId: string,
    nextSessionId: string
  ): void {
    if (!previousSessionId || !nextSessionId || previousSessionId === nextSessionId) {
      return;
    }

    const previousPath =
      provider === "codex"
        ? this.codexSessionOverlayPath(previousSessionId)
        : this.claudeSessionOverlayPath(previousSessionId);
    const nextPath =
      provider === "codex"
        ? this.codexSessionOverlayPath(nextSessionId)
        : this.claudeSessionOverlayPath(nextSessionId);

    if (!existsSync(previousPath)) {
      return;
    }

    if (!existsSync(nextPath)) {
      mkdirSync(path.dirname(nextPath), { recursive: true });
      renameSync(previousPath, nextPath);
      return;
    }

    if (provider === "codex") {
      const merged = deepMerge(
        this.readTomlFile(nextPath),
        this.readTomlFile(previousPath)
      );
      this.writeTomlFile(nextPath, merged);
    } else {
      const merged = deepMerge(
        this.readJsonFile(nextPath),
        this.readJsonFile(previousPath)
      );
      this.writeJsonFile(nextPath, merged);
    }

    rmSync(previousPath, { force: true });
  }

  public getCodexRuntimeConfig(sessionId?: string): CodexRuntimeConfig {
    const effective = sessionId
      ? this.getCodexSessionEffective(sessionId)
      : this.getCodexGlobalEffective();
    const providerName = asString(effective.model_provider) ?? this.config.codex.providerName;
    return {
      providerName,
      model: asString(effective.model) ?? this.config.codex.model,
      reasoningEffort:
        asString(effective.model_reasoning_effort) ??
        asString(effective.reasoning_effort) ??
        this.config.codex.reasoningEffort,
      serviceTier: asString(effective.service_tier),
      approvalPolicy:
        asString(effective.approval_policy) ?? this.config.codex.approvalPolicy,
      approvalsReviewer:
        asString(effective.approvals_reviewer) ?? this.config.codex.approvalsReviewer,
      sandbox: asString(effective.sandbox_mode) ?? this.config.codex.sandbox,
      personality: asString(effective.personality) ?? "pragmatic"
    };
  }

  public getClaudeRuntimeConfig(sessionId?: string): ClaudeRuntimeConfig {
    const globalSettings = this.getClaudeSettingsEffective();
    const globalState = this.getClaudeGlobalStateExposed();
    const overlay = sessionId ? this.readJsonFile(this.claudeSessionOverlayPath(sessionId)) : {};
    const merged = deepMerge(globalSettings, overlay);
    const permissionMode =
      asString(merged.permissionMode) ??
      asString(merged.defaultMode) ??
      this.config.claude.permissionMode;

    return {
      model: asString(merged.model) ?? this.config.claude.model,
      permissionMode,
      defaultMode: asString(merged.defaultMode) ?? undefined,
      env: {
        ...(this.config.claude.reasoningEffort
          ? { CLAUDE_CODE_EFFORT_LEVEL: this.config.claude.reasoningEffort }
          : {}),
        ...normalizeStringRecord(merged.env)
      },
      allowedTools: normalizeStringArray(merged.allowedTools),
      disallowedTools: normalizeStringArray(merged.disallowedTools),
      settings: merged,
      globalState
    };
  }

  private getCodexGlobalSnapshot(): ProviderConfigSnapshot {
    const explicit = this.readTomlFile(this.codexConfigPath());
    const effective = this.getCodexGlobalEffective();
    const configuredKeys = flattenKeys(explicit);
    return {
      provider: "codex",
      scope: "global",
      documents: {
        config: this.buildDocumentSnapshot(
          "config",
          "toml",
          this.codexConfigPath(),
          explicit
        )
      },
      effectiveValues: effective,
      defaults: this.codexDefaults(),
      runtimeApply: {
        applyMode: "reload_runtime",
        supportedKeys: flattenKeys(effective),
        configuredKeys,
        pendingKeys: []
      }
    };
  }

  private getClaudeGlobalSnapshot(): ProviderConfigSnapshot {
    const settings = this.readJsonFile(this.claudeSettingsPath());
    const globalState = this.getClaudeGlobalStateExposed();
    const configuredKeys = [...flattenKeys(settings), ...flattenKeys(globalState)];
    return {
      provider: "claude",
      scope: "global",
      documents: {
        settings: this.buildDocumentSnapshot(
          "settings",
          "json",
          this.claudeSettingsPath(),
          settings
        ),
        global_state: this.buildDocumentSnapshot(
          "global_state",
          "json",
          this.claudeGlobalStatePath(),
          globalState
        )
      },
      effectiveValues: {
        settings: this.getClaudeSettingsEffective(),
        global_state: globalState
      },
      defaults: {
        settings: this.claudeSettingsDefaults(),
        global_state: {}
      },
      runtimeApply: {
        applyMode: "reload_runtime",
        supportedKeys: flattenKeys({
          settings: this.getClaudeSettingsEffective(),
          global_state: globalState
        }),
        configuredKeys,
        pendingKeys: []
      }
    };
  }

  private getCodexSessionSnapshot(sessionId: string): ProviderConfigSnapshot {
    const overlay = this.readTomlFile(this.codexSessionOverlayPath(sessionId));
    const configuredKeys = flattenKeys(overlay);
    return {
      provider: "codex",
      scope: "session",
      sessionId,
      documents: {
        overlay: this.buildDocumentSnapshot(
          "overlay",
          "toml",
          this.codexSessionOverlayPath(sessionId),
          overlay,
          true
        )
      },
      effectiveValues: this.getCodexSessionEffective(sessionId),
      defaults: this.codexDefaults(),
      runtimeApply: {
        applyMode: "next_turn",
        supportedKeys: CODEX_SESSION_RUNTIME_KEYS,
        configuredKeys,
        pendingKeys: configuredKeys.filter((key) => !isSupportedKey(key, CODEX_SESSION_RUNTIME_KEYS))
      }
    };
  }

  private getClaudeSessionSnapshot(sessionId: string): ProviderConfigSnapshot {
    const overlay = this.readJsonFile(this.claudeSessionOverlayPath(sessionId));
    const configuredKeys = flattenKeys(overlay);
    return {
      provider: "claude",
      scope: "session",
      sessionId,
      documents: {
        overlay: this.buildDocumentSnapshot(
          "overlay",
          "json",
          this.claudeSessionOverlayPath(sessionId),
          overlay,
          true
        )
      },
      effectiveValues: {
        settings: this.getClaudeRuntimeConfig(sessionId).settings,
        global_state: this.getClaudeRuntimeConfig(sessionId).globalState
      },
      defaults: {
        settings: this.claudeSettingsDefaults(),
        global_state: {}
      },
      runtimeApply: {
        applyMode: "next_turn",
        supportedKeys: CLAUDE_SESSION_RUNTIME_KEYS,
        configuredKeys,
        pendingKeys: configuredKeys.filter((key) => !isSupportedKey(key, CLAUDE_SESSION_RUNTIME_KEYS))
      }
    };
  }

  private buildDocumentSnapshot(
    kind: string,
    format: ConfigDocumentFormat,
    filePath: string,
    explicitValues: Record<string, unknown>,
    managedByCodeFly = false
  ): ConfigDocumentSnapshot {
    return {
      kind,
      format,
      path: filePath,
      exists: existsSync(filePath),
      managedByCodeFly,
      explicitValues,
      explicitKeys: flattenKeys(explicitValues)
    };
  }

  private getCodexGlobalEffective(): Record<string, unknown> {
    return deepMerge(this.codexDefaults(), this.readTomlFile(this.codexConfigPath()));
  }

  private getCodexSessionEffective(sessionId: string): Record<string, unknown> {
    return deepMerge(this.getCodexGlobalEffective(), this.readTomlFile(this.codexSessionOverlayPath(sessionId)));
  }

  private getClaudeSettingsEffective(): Record<string, unknown> {
    return deepMerge(this.claudeSettingsDefaults(), this.readJsonFile(this.claudeSettingsPath()));
  }

  private getClaudeGlobalStateExposed(): Record<string, unknown> {
    const raw = this.readJsonFile(this.claudeGlobalStatePath());
    return pick(raw, CLAUDE_GLOBAL_STATE_KEYS);
  }

  private codexDefaults(): Record<string, unknown> {
    return {
      model_provider: this.config.codex.providerName,
      model: this.config.codex.model,
      ...(this.config.codex.reasoningEffort
        ? { model_reasoning_effort: this.config.codex.reasoningEffort }
        : {}),
      approval_policy: this.config.codex.approvalPolicy,
      approvals_reviewer: this.config.codex.approvalsReviewer,
      sandbox_mode: this.config.codex.sandbox,
      personality: "pragmatic",
      model_providers: {
        [this.config.codex.providerName]: {
          name: this.config.codex.providerName,
          base_url: this.config.codex.baseUrl,
          wire_api: "responses",
          requires_openai_auth: true,
          env_key: "OPENAI_API_KEY"
        }
      }
    };
  }

  private codexBootstrapConfig(): Record<string, unknown> {
    return {
      model_provider: this.config.codex.providerName,
      model: this.config.codex.model,
      ...(this.config.codex.reasoningEffort
        ? { model_reasoning_effort: this.config.codex.reasoningEffort }
        : {}),
      model_providers: {
        [this.config.codex.providerName]: {
          name: this.config.codex.providerName,
          base_url: this.config.codex.baseUrl,
          wire_api: "responses",
          requires_openai_auth: true,
          env_key: "OPENAI_API_KEY"
        }
      }
    };
  }

  private claudeSettingsDefaults(): Record<string, unknown> {
    return {
      $schema: "https://json.schemastore.org/claude-code-settings.json",
      model: this.config.claude.model,
      defaultMode: this.config.claude.permissionMode,
      ...(this.config.claude.reasoningEffort
        ? { env: { CLAUDE_CODE_EFFORT_LEVEL: this.config.claude.reasoningEffort } }
        : {})
    };
  }

  private assertAllowedClaudeGlobalStatePaths(patch: ConfigPatchOperation): void {
    for (const key of Object.keys(patch.set ?? {})) {
      if (!CLAUDE_GLOBAL_STATE_KEYS.includes(key as (typeof CLAUDE_GLOBAL_STATE_KEYS)[number])) {
        throw new Error(`Unsupported Claude global_state key: ${key}`);
      }
    }

    for (const key of patch.unset ?? []) {
      if (!CLAUDE_GLOBAL_STATE_KEYS.includes(key as (typeof CLAUDE_GLOBAL_STATE_KEYS)[number])) {
        throw new Error(`Unsupported Claude global_state key: ${key}`);
      }
    }
  }

  private codexConfigDir(): string {
    return this.config.codex.configDir;
  }

  private codexConfigPath(): string {
    return path.resolve(this.codexConfigDir(), "config.toml");
  }

  private claudeSettingsDir(): string {
    return this.config.claude.configDir;
  }

  private claudeSettingsPath(): string {
    return path.resolve(this.claudeSettingsDir(), "settings.json");
  }

  private claudeGlobalStatePath(): string {
    return this.config.claude.globalStatePath;
  }

  private sessionConfigDir(provider: ProviderName): string {
    return path.resolve(this.config.dataDir, "session-configs", provider);
  }

  private codexSessionOverlayPath(sessionId: string): string {
    return path.resolve(this.sessionConfigDir("codex"), `${sessionId}.toml`);
  }

  private claudeSessionOverlayPath(sessionId: string): string {
    return path.resolve(this.sessionConfigDir("claude"), `${sessionId}.json`);
  }

  private readJsonFile(filePath: string): Record<string, unknown> {
    if (!existsSync(filePath)) {
      return {};
    }

    const raw = readFileSync(filePath, "utf8").trim();
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  }

  private writeJsonFile(filePath: string, value: Record<string, unknown>): void {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  private readTomlFile(filePath: string): Record<string, unknown> {
    if (!existsSync(filePath)) {
      return {};
    }

    const raw = readFileSync(filePath, "utf8").trim();
    if (!raw) {
      return {};
    }

    const parsed = TOML.parse(raw);
    return isRecord(parsed) ? parsed : {};
  }

  private writeTomlFile(filePath: string, value: Record<string, unknown>): void {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${TOML.stringify(value)}`, "utf8");
  }
}

function applyPatch(
  current: Record<string, unknown>,
  patch: ConfigPatchOperation
): Record<string, unknown> {
  let next = structuredClone(current);
  next = deepMerge(next, patch.set ?? {});
  for (const entry of patch.unset ?? []) {
    next = unsetPath(next, entry);
  }
  return next;
}

function deepMerge(
  base: Record<string, unknown>,
  incoming: Record<string, unknown>
): Record<string, unknown> {
  const output = structuredClone(base);
  for (const [key, value] of Object.entries(incoming)) {
    if (isRecord(value) && isRecord(output[key])) {
      output[key] = deepMerge(output[key] as Record<string, unknown>, value);
      continue;
    }
    output[key] = structuredClone(value);
  }
  return output;
}

function unsetPath(target: Record<string, unknown>, dottedPath: string): Record<string, unknown> {
  const parts = dottedPath.split(".").filter(Boolean);
  if (parts.length === 0) {
    return target;
  }

  const clone = structuredClone(target);
  let current: Record<string, unknown> = clone;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const segment = parts[index];
    const next = current[segment];
    if (!isRecord(next)) {
      return clone;
    }
    current[segment] = structuredClone(next);
    current = current[segment] as Record<string, unknown>;
  }

  delete current[parts[parts.length - 1]];
  return clone;
}

function flattenKeys(value: unknown, prefix = ""): string[] {
  if (!isRecord(value)) {
    return prefix ? [prefix] : [];
  }

  const keys: string[] = [];
  for (const [key, nested] of Object.entries(value)) {
    const nextPrefix = prefix ? `${prefix}.${key}` : key;
    if (isRecord(nested) && Object.keys(nested).length > 0) {
      keys.push(...flattenKeys(nested, nextPrefix));
      continue;
    }
    keys.push(nextPrefix);
  }
  return Array.from(new Set(keys)).sort();
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entryValue]) => typeof entryValue === "string")
      .map(([key, entryValue]) => [key, String(entryValue)])
  );
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const values = value.filter((entry): entry is string => typeof entry === "string");
  return values.length > 0 ? Array.from(new Set(values)) : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function pick<T extends string>(
  value: Record<string, unknown>,
  keys: readonly T[]
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in value) {
      output[key] = value[key];
    }
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSupportedKey(key: string, supported: readonly string[]): boolean {
  return supported.some((candidate) => key === candidate || key.startsWith(`${candidate}.`));
}
