import type { HostClientConfig } from "../config";
import { ProviderConfigManager } from "../provider-config";
import type { AgentAdapter } from "./base";
import { ClaudeAdapter } from "./claude";
import { CodexAdapter } from "./codex";

export function createAdapters(
  config: HostClientConfig,
  providerConfigs: ProviderConfigManager
): AgentAdapter[] {
  switch (config.adapter) {
    case "multi":
      return [
        new CodexAdapter(config, providerConfigs),
        new ClaudeAdapter(config, providerConfigs)
      ];
    case "codex":
      return [new CodexAdapter(config, providerConfigs)];
    case "claude":
      return [new ClaudeAdapter(config, providerConfigs)];
    default:
      return [
        new CodexAdapter(config, providerConfigs),
        new ClaudeAdapter(config, providerConfigs)
      ];
  }
}
