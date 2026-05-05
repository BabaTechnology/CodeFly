import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  ClaudeAdapterConfig,
  CodexAdapterConfig,
  HostClientConfig
} from "./config";
import { normalizeHostClientConfig } from "./config";
import {
  resolveClaudeConfigDir,
  resolveClaudeGlobalStatePath,
  resolveCodexConfigDir,
  resolveUserHomePath
} from "./provider-runtime";

interface PersistedRuntimeConfigDocument {
  version: 1;
  codex?: Partial<CodexRuntimeEditableConfig>;
  claude?: Partial<ClaudeRuntimeEditableConfig>;
}

export interface CodexRuntimeEditableConfig {
  providerName: string;
  baseUrl: string;
  apiKey?: string;
  homeDir: string;
  model: string;
  reasoningEffort?: string;
  approvalPolicy: CodexAdapterConfig["approvalPolicy"];
  approvalsReviewer: CodexAdapterConfig["approvalsReviewer"];
  sandbox: CodexAdapterConfig["sandbox"];
}

export interface ClaudeRuntimeEditableConfig {
  baseUrl: string;
  apiKey?: string;
  homeDir: string;
  model: string;
  reasoningEffort?: string;
  permissionMode: ClaudeAdapterConfig["permissionMode"];
  disableNonessentialTraffic: boolean;
  disableExperimentalBetas: boolean;
}

const EMPTY_DOCUMENT: PersistedRuntimeConfigDocument = {
  version: 1
};

export class RuntimeConfigStore {
  private document: PersistedRuntimeConfigDocument;

  public constructor(private readonly filePath: string) {
    this.document = this.load();
  }

  public applyToConfig(config: HostClientConfig): void {
    if (this.document.codex) {
      Object.assign(config.codex, this.document.codex);
      if (this.document.codex.homeDir) {
        config.codex.configDir = resolveCodexConfigDir(config.codex.homeDir);
      }
    }

    if (this.document.claude) {
      Object.assign(config.claude, this.document.claude);
      if (this.document.claude.homeDir) {
        config.claude.configDir = resolveClaudeConfigDir(config.claude.homeDir);
        config.claude.globalStatePath = resolveClaudeGlobalStatePath(config.claude.homeDir);
      }
    }
    normalizeHostClientConfig(config);
  }

  public getProviderSnapshot(
    provider: "codex" | "claude",
    config: HostClientConfig,
    authMode: "api_key" | "account" | "missing"
  ): {
    provider: "codex" | "claude";
    authMode: "api_key" | "account" | "missing";
    values: Record<string, unknown>;
  } {
    return {
      provider,
      authMode,
      values:
        provider === "codex"
	          ? {
	              providerName: config.codex.providerName,
	              baseUrl: config.codex.baseUrl,
	              apiKey: config.codex.apiKey ?? "",
	              homeDir: config.codex.homeDir,
	              configDir: config.codex.configDir,
	              model: config.codex.model,
	              reasoningEffort: config.codex.reasoningEffort ?? "",
              approvalPolicy: config.codex.approvalPolicy,
              approvalsReviewer: config.codex.approvalsReviewer,
              sandbox: config.codex.sandbox
            }
	          : {
	              baseUrl: config.claude.baseUrl,
	              apiKey: config.claude.apiKey ?? "",
	              homeDir: config.claude.homeDir,
	              configDir: config.claude.configDir,
	              globalStatePath: config.claude.globalStatePath,
	              model: config.claude.model,
	              reasoningEffort: config.claude.reasoningEffort ?? "",
              permissionMode: config.claude.permissionMode,
              disableNonessentialTraffic: config.claude.disableNonessentialTraffic,
              disableExperimentalBetas: config.claude.disableExperimentalBetas
            }
    };
  }

  public patchProvider(
    provider: "codex" | "claude",
    values: Record<string, unknown>,
    config: HostClientConfig
  ): void {
    if (provider === "codex") {
      const next = sanitizeCodexPatch(values);
      this.document.codex = {
        ...(this.document.codex ?? {}),
        ...next
      };
      Object.assign(config.codex, next);
      if (next.homeDir) {
        config.codex.configDir = resolveCodexConfigDir(next.homeDir);
      }
      normalizeHostClientConfig(config);
      if (next.homeDir) {
        this.document.codex.homeDir = config.codex.homeDir;
      }
    } else {
      const next = sanitizeClaudePatch(values);
      this.document.claude = {
        ...(this.document.claude ?? {}),
        ...next
      };
      Object.assign(config.claude, next);
      if (next.homeDir) {
        config.claude.configDir = resolveClaudeConfigDir(next.homeDir);
        config.claude.globalStatePath = resolveClaudeGlobalStatePath(next.homeDir);
      }
      normalizeHostClientConfig(config);
      if (next.homeDir) {
        this.document.claude.homeDir = config.claude.homeDir;
      }
    }

    this.save();
  }

  private load(): PersistedRuntimeConfigDocument {
    if (!existsSync(this.filePath)) {
      return structuredClone(EMPTY_DOCUMENT);
    }

    try {
      const raw = readFileSync(this.filePath, "utf8").trim();
      if (!raw) {
        return structuredClone(EMPTY_DOCUMENT);
      }
      const parsed = JSON.parse(raw) as PersistedRuntimeConfigDocument;
      return {
        version: 1,
        codex: parsed.codex ? sanitizeCodexPatch(parsed.codex) : undefined,
        claude: parsed.claude ? sanitizeClaudePatch(parsed.claude) : undefined
      };
    } catch {
      return structuredClone(EMPTY_DOCUMENT);
    }
  }

  private save(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(this.document, null, 2)}\n`, "utf8");
  }
}

function sanitizeCodexPatch(values: Record<string, unknown>): Partial<CodexRuntimeEditableConfig> {
  const next: Partial<CodexRuntimeEditableConfig> = {};

  if (typeof values.providerName === "string" && values.providerName.trim()) {
    next.providerName = values.providerName.trim();
  }
  if (typeof values.baseUrl === "string" && values.baseUrl.trim()) {
    next.baseUrl = values.baseUrl.trim();
  }
  if (typeof values.apiKey === "string") {
    next.apiKey = values.apiKey.trim() || undefined;
  }
  if (typeof values.homeDir === "string" && values.homeDir.trim()) {
    next.homeDir = resolveUserHomePath(values.homeDir);
  }
  if (typeof values.model === "string" && values.model.trim()) {
    next.model = values.model.trim();
  }
  if (typeof values.reasoningEffort === "string") {
    next.reasoningEffort = values.reasoningEffort.trim() || undefined;
  }
  if (
    values.approvalPolicy === "untrusted" ||
    values.approvalPolicy === "on-failure" ||
    values.approvalPolicy === "on-request" ||
    values.approvalPolicy === "never" ||
    values.approvalPolicy === "granular"
  ) {
    next.approvalPolicy = values.approvalPolicy;
  }
  if (
    values.approvalsReviewer === "user" ||
    values.approvalsReviewer === "auto_review" ||
    values.approvalsReviewer === "guardian_subagent"
  ) {
    next.approvalsReviewer = values.approvalsReviewer;
  }
  if (
    values.sandbox === "read-only" ||
    values.sandbox === "workspace-write" ||
    values.sandbox === "danger-full-access"
  ) {
    next.sandbox = values.sandbox;
  }

  return next;
}

function sanitizeClaudePatch(values: Record<string, unknown>): Partial<ClaudeRuntimeEditableConfig> {
  const next: Partial<ClaudeRuntimeEditableConfig> = {};

  if (typeof values.baseUrl === "string" && values.baseUrl.trim()) {
    next.baseUrl = values.baseUrl.trim();
  }
  if (typeof values.apiKey === "string") {
    next.apiKey = values.apiKey.trim() || undefined;
  }
  if (typeof values.homeDir === "string" && values.homeDir.trim()) {
    next.homeDir = resolveUserHomePath(values.homeDir);
  }
  if (typeof values.model === "string" && values.model.trim()) {
    next.model = values.model.trim();
  }
  if (typeof values.reasoningEffort === "string") {
    next.reasoningEffort = values.reasoningEffort.trim() || undefined;
  }
  if (
    values.permissionMode === "default" ||
    values.permissionMode === "acceptEdits" ||
    values.permissionMode === "plan" ||
    values.permissionMode === "auto" ||
    values.permissionMode === "bypassPermissions" ||
    values.permissionMode === "dontAsk"
  ) {
    next.permissionMode = values.permissionMode;
  }
  if (typeof values.disableNonessentialTraffic === "boolean") {
    next.disableNonessentialTraffic = values.disableNonessentialTraffic;
  }
  if (typeof values.disableExperimentalBetas === "boolean") {
    next.disableExperimentalBetas = values.disableExperimentalBetas;
  }

  return next;
}
