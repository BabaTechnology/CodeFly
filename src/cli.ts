#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import WebSocket from "ws";
import cliI18n from "./cli-i18n.json";
import { buildDirectPublicUrl, loadHostClientConfig, normalizeDirectPublicHost } from "./config";
import type { HostHardwareSnapshot } from "./hardware-status";
const qrcode = require("qrcode-terminal") as {
  error?: unknown;
  generate(value: string, options?: { small?: boolean }): void;
};
const TerminalQRCode = require("qrcode-terminal/vendor/QRCode") as TerminalQRCodeConstructor;

interface TerminalQRCodeInstance {
  addData(value: string): void;
  make(): void;
  getModuleCount(): number;
  isDark(row: number, col: number): boolean;
}

interface TerminalQRCodeConstructor {
  new (typeNumber: number, errorCorrectionLevel: unknown): TerminalQRCodeInstance;
}

interface ConnectionListResponse {
  directDevices: Array<{
    deviceId: string;
    label: string;
    publicKey: string;
    createdAt: string;
    lastSeenAt?: string | null;
  }>;
  relay: {
    relayUrl?: string | null;
    credentialStored: boolean;
    connected: boolean;
    seatId?: string | null;
  };
  relayBindings?: Array<{
    id: string;
    relayUrl?: string | null;
    credentialStored: boolean;
    connected: boolean;
    seatId?: string | null;
    label?: string | null;
    createdAt?: string | null;
    updatedAt?: string | null;
  }>;
}

interface HostInfoResponse {
  hostName: string;
  directPublicUrl: string;
  hostPublicKey: string;
  hostPublicKeyFingerprint: string;
  serviceBaseUrl?: string | null;
}

interface DirectServiceConfigResponse {
  publicHost: string;
  bindHost?: string;
  bindHosts?: string[];
  port: number;
  managementPort?: number;
  directPublicUrl: string;
  restartRequired: boolean;
}

interface SecurityConfigResponse {
  certificatePath: string;
  keyPath: string;
  certificateFingerprint?: string | null;
  hostPublicKey?: string | null;
  hostPublicKeyFingerprint?: string | null;
  restartRequired: boolean;
}

type CliLanguageCode =
  | "en"
  | "zh-CN"
  | "zh-TW"
  | "ja"
  | "ko"
  | "fr"
  | "de"
  | "ru"
  | "es";

type CliStringKey = keyof (typeof cliI18n.strings)["en"];

interface RenderedConnections {
  items: Array<{ kind: "direct" | "relay"; id: string }>;
  lines: string[];
}

const ASCII_WORDMARK = String.raw`
   ______          __      ________
  / ____/___  ____/ /__   / ____/ /_  __
 / /   / __ \/ __  / _ \ / /_  / / / / /
/ /___/ /_/ / /_/ /  __// __/ / / /_/ /
\____/\____/\__,_/\___//_/   /_/\__, /
                               /____/
`;

const languageOptions = cliI18n.languageOptions as Array<{
  code: CliLanguageCode;
  label: string;
}>;
const translations = cliI18n.strings as Record<CliLanguageCode, Record<CliStringKey, string>>;
const HOST_PACKAGE_NAME = "codefly-host";
const HOST_PACKAGE_VERSION_FALLBACK = "0.1.1";

function buildDirectPairingQrPayload(issued: {
  pairingCode: string;
  directUrl?: string | null;
  hostPublicKey?: string | null;
}): string {
  const compactUrl = parseCompactDirectUrl(issued.directUrl);
  const hostPublicKey = compactPublicKey(issued.hostPublicKey);
  if (!compactUrl || !hostPublicKey) {
    throw new Error("Direct pairing QR is missing host address or host public key");
  }
  const ipv4 = compactIpv4(compactUrl.host);
  const port = compactPort(compactUrl.port);
  if (/^[a-z0-9]{16}$/.test(issued.pairingCode) && ipv4 && port.length === 3) {
    return `CF3D${issued.pairingCode}${ipv4}${port}${hostPublicKey}`;
  }
  return ["CF3H", encodeQrField(issued.pairingCode), encodeQrField(compactUrl.host), port, hostPublicKey].join("|");
}

function buildRelayPairingQrPayload(input: {
  token: string;
  nodeId: string;
}): string {
  return ["CF2N", encodeQrField(input.nodeId), encodeQrField(input.token)].join("|");
}

function parseCompactDirectUrl(value?: string | null): { host: string; port: string } | null {
  if (!value?.trim()) {
    return null;
  }
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "codefly-tcp:" || !parsed.hostname) {
      return null;
    }
    return {
      host: parsed.hostname,
      port: parsed.port
    };
  } catch {
    return null;
  }
}

function encodeQrField(value: string): string {
  return encodeURIComponent(value.trim());
}

function compactIpv4(value: string): string | null {
  const parts = value.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const bytes = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const value = Number(part);
    return Number.isInteger(value) && value >= 0 && value <= 255 ? value : null;
  });
  if (bytes.some((part) => part === null)) {
    return null;
  }
  return toBase64Url(Buffer.from(bytes as number[]));
}

function compactPort(value: string): string {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error("Direct pairing QR is missing a valid port");
  }
  return parsed.toString(36).padStart(3, "0");
}

function normalizeUrl(value?: string | null): string | null {
  if (!value?.trim()) {
    return null;
  }
  try {
    return new URL(value).toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function compactPublicKey(value?: string | null): string | null {
  const text = value?.trim();
  if (!text) {
    return null;
  }
  try {
    const bytes = Buffer.from(text, "base64");
    if (bytes.length !== 32) {
      return null;
    }
    return bytes.toString("base64url");
  } catch {
    return null;
  }
}

function toBase64Url(value: Buffer): string {
  return value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function printQrCode(value: string): void {
  try {
    console.log(renderSquareQr(value));
  } catch {
    qrcode.generate(value, { small: true });
  }
}

function renderSquareQr(value: string): string {
  const qr = new TerminalQRCode(-1, qrcode.error);
  qr.addData(value);
  qr.make();

  const quietZone = 4;
  const moduleCount = qr.getModuleCount();
  const totalSize = moduleCount + quietZone * 2;
  const lines: string[] = [];

  for (let row = 0; row < totalSize; row += 1) {
    let line = "";
    for (let col = 0; col < totalSize; col += 1) {
      const qrRow = row - quietZone;
      const qrCol = col - quietZone;
      const inQr = qrRow >= 0 && qrRow < moduleCount && qrCol >= 0 && qrCol < moduleCount;
      line += inQr && qr.isDark(qrRow, qrCol) ? "\x1b[40m  " : "\x1b[107m  ";
    }
    lines.push(`${line}\x1b[0m`);
  }
  return lines.join("\n");
}

function translate(
  language: CliLanguageCode,
  key: CliStringKey,
  values?: Record<string, string | number>
): string {
  const template = translations[language]?.[key] ?? translations.en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name] ?? ""));
}

function normalizeHostCandidate(value: string | undefined | null): string | null {
  if (!value?.trim()) {
    return null;
  }
  try {
    return normalizeDirectPublicHost(value);
  } catch {
    return null;
  }
}

function isSpecialDirectQrHost(host: string): boolean {
  const normalized = host.trim().replace(/^\[|\]$/g, "").toLowerCase();
  if (
    !normalized ||
    normalized === "localhost" ||
    normalized === "0.0.0.0" ||
    normalized === "::" ||
    normalized === "::1"
  ) {
    return true;
  }
  if (/^127\./.test(normalized) || /^169\.254\./.test(normalized)) {
    return true;
  }
  return normalized.startsWith("fe80:");
}

function addDirectAddressCandidate(
  candidates: Array<{ host: string; label: string }>,
  skipped: Set<string>,
  value: string | undefined | null,
  label: string
): void {
  const host = normalizeHostCandidate(value);
  if (!host) {
    return;
  }
  if (isSpecialDirectQrHost(host)) {
    skipped.add(host);
    return;
  }
  const key = host.toLowerCase();
  if (!candidates.some((candidate) => candidate.host.toLowerCase() === key)) {
    candidates.push({ host, label });
  }
}

function getNetworkAddressCandidates(): Array<{ host: string; label: string }> {
  const candidates: Array<{ host: string; label: string }> = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) {
        continue;
      }
      const host = normalizeHostCandidate(entry.address);
      if (!host || isSpecialDirectQrHost(host)) {
        continue;
      }
      addDirectAddressCandidate(candidates, new Set(), host, `${name} ${entry.family}`);
    }
  }
  return candidates;
}

function collectDirectQrAddressCandidates(current: DirectServiceConfigResponse): {
  candidates: Array<{ host: string; label: string }>;
  skipped: string[];
} {
  const candidates: Array<{ host: string; label: string }> = [];
  const skipped = new Set<string>();
  addDirectAddressCandidate(candidates, skipped, current.publicHost, "configured-public");
  for (const bindHost of current.bindHosts ?? splitCommaList(current.bindHost)) {
    addDirectAddressCandidate(candidates, skipped, bindHost, "configured-listen");
  }
  for (const candidate of getNetworkAddressCandidates()) {
    addDirectAddressCandidate(candidates, skipped, candidate.host, candidate.label);
  }
  return {
    candidates,
    skipped: Array.from(skipped)
  };
}

function splitCommaList(value: string | undefined | null): string[] {
  return value?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? [];
}

async function selectDirectQrAddress(
  current: DirectServiceConfigResponse,
  readline: ReturnType<typeof createInterface>,
  language: CliLanguageCode
): Promise<string> {
  const { candidates, skipped } = collectDirectQrAddressCandidates(current);
  console.log("");
  console.log(translate(language, "directAddressSelectTitle"));
  if (skipped.length) {
    console.log(translate(language, "directAddressSkipped", { hosts: skipped.join(", ") }));
  }
  if (!candidates.length) {
    throw new Error(translate(language, "directAddressMissing"));
  }
  for (const [index, candidate] of candidates.entries()) {
    const label =
      candidate.label === "configured-public"
        ? translate(language, "directAddressConfiguredPublic")
        : candidate.label === "configured-listen"
          ? translate(language, "directAddressConfiguredListen")
          : candidate.label;
    console.log(`${index + 1}. ${candidate.host} (${label})`);
  }
  while (true) {
    const answer =
      (await readline.question(`${translate(language, "directAddressPrompt")} [1]: `)).trim() || "1";
    const index = Number(answer);
    const candidate = candidates[index - 1];
    if (Number.isInteger(index) && candidate) {
      return candidate.host;
    }
    console.log(translate(language, "invalidInput"));
  }
}

function printLogo(): void {
  console.log(ASCII_WORDMARK);
}

async function selectLanguage(readline: ReturnType<typeof createInterface>): Promise<CliLanguageCode> {
  while (true) {
    console.log("Select a language");
    console.log("Enter the number for your language.");
    for (const [index, option] of languageOptions.entries()) {
      console.log(`${index + 1}. ${option.label}`);
    }
    const answer = (await readline.question("> ")).trim();
    const index = Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= languageOptions.length) {
      return languageOptions[index - 1]!.code;
    }
    console.log("Invalid selection. Try again.");
    console.log("");
  }
}

async function main(): Promise<void> {
  printLogo();

  const readline = createInterface({ input: stdin, output: stdout });
  let language: CliLanguageCode = "en";
  try {
    language = await selectLanguage(readline);
    const config = loadHostClientConfig();
    const baseUrl = await resolveLocalBaseUrl(config.managementPort);

    if (!baseUrl) {
      console.error(translate(language, "notRunning", { port: config.port }));
      process.exitCode = 1;
      return;
    }

    let done = false;
    while (!done) {
      printMainMenu(language);
      const answer = (await readline.question("> ")).trim();
      if (answer === "1") {
        await directMenu(baseUrl, readline, language);
      } else if (answer === "2") {
        await relayMenu(baseUrl, readline, language);
      } else if (answer === "3") {
        await manageSecurityConfig(baseUrl, readline, language);
      } else if (answer === "4") {
        await printEnvironmentReport(baseUrl, language);
      } else if (answer === "5") {
        await printVersionReport(readline, language);
      } else if (answer.toLowerCase() === "q") {
        done = true;
      } else {
        console.log(translate(language, "invalidInput"));
      }
    }
  } finally {
    readline.close();
  }
}

function printMainMenu(language: CliLanguageCode): void {
  console.log("");
  console.log(translate(language, "mainMenuTitle"));
  console.log(translate(language, "mainMenuDirect"));
  console.log(translate(language, "mainMenuRelay"));
  console.log(translate(language, "mainMenuSecurity"));
  console.log(translate(language, "mainMenuEnvironment"));
  console.log(translate(language, "mainMenuVersion"));
  console.log(translate(language, "menuQuit"));
}

async function directMenu(
  baseUrl: string,
  readline: ReturnType<typeof createInterface>,
  language: CliLanguageCode
): Promise<void> {
  let done = false;
  while (!done) {
    const connections = await requestJson<ConnectionListResponse>(baseUrl, "/api/host/connections", {
      method: "GET"
    });
    console.log("");
    console.log(translate(language, "directMenuTitle"));
    console.log(translate(language, "directMenuManage", { count: connections.directDevices.length }));
    console.log(translate(language, "directMenuAdd"));
    console.log(translate(language, "directMenuConfig"));
    console.log(translate(language, "menuBack"));
    const answer = (await readline.question("> ")).trim();
    if (answer === "1") {
      await manageDirectDevices(baseUrl, connections, readline, language);
    } else if (answer === "2") {
      await handleDirectBinding(baseUrl, connections, readline, language);
    } else if (answer === "3") {
      await manageDirectServiceConfig(baseUrl, readline, language);
    } else if (answer.toLowerCase() === "b" || answer.toLowerCase() === "q") {
      done = true;
    } else {
      console.log(translate(language, "invalidInput"));
    }
  }
}

async function relayMenu(
  baseUrl: string,
  readline: ReturnType<typeof createInterface>,
  language: CliLanguageCode
): Promise<void> {
  let done = false;
  while (!done) {
    const connections = await requestJson<ConnectionListResponse>(baseUrl, "/api/host/connections", {
      method: "GET"
    });
    const relayBindings = resolveRelayBindings(connections);
    const boundCount = relayBindings.length;
    console.log("");
    console.log(translate(language, "relayMenuTitle"));
    console.log(translate(language, "relayMenuManage", { count: boundCount }));
    console.log(translate(language, "relayMenuAdd"));
    console.log(translate(language, "menuBack"));
    const answer = (await readline.question("> ")).trim();
    if (answer === "1") {
      await manageRelayBinding(baseUrl, connections, readline, language);
    } else if (answer === "2") {
      await handleRelayQrBinding(baseUrl, connections, language);
    } else if (answer.toLowerCase() === "b" || answer.toLowerCase() === "q") {
      done = true;
    } else {
      console.log(translate(language, "invalidInput"));
    }
  }
}

async function resolveLocalBaseUrl(port: number): Promise<string | null> {
  const candidate = `http://127.0.0.1:${port}`;
  try {
    await requestJson(candidate, "/health", { method: "GET" });
    return candidate;
  } catch {
    return null;
  }
}

function renderConnections(
  connections: ConnectionListResponse,
  language: CliLanguageCode
): RenderedConnections {
  const items: Array<{ kind: "direct" | "relay"; id: string }> = [];
  const lines: string[] = [];

  for (const device of connections.directDevices) {
    items.push({ kind: "direct", id: device.deviceId });
    lines.push(`${items.length}. [${translate(language, "directTag")}] ${device.label} (${device.deviceId})`);
  }

  for (const binding of resolveRelayBindings(connections)) {
    items.push({ kind: "relay", id: binding.id });
    const status = binding.connected
      ? translate(language, "relayStatusConnected")
      : binding.credentialStored
        ? translate(language, "relayStatusBound")
        : translate(language, "relayStatusPending");
    const seatSuffix = binding.seatId
      ? translate(language, "relaySeatSuffix", { seatId: binding.seatId })
      : "";
    lines.push(
      `${items.length}. [${translate(language, "relayTag")}] ${
        binding.label || binding.relayUrl || translate(language, "relayUrlMissing")
      } • ${status}${seatSuffix}`
    );
  }

  if (lines.length === 0) {
    lines.push(translate(language, "noConnections"));
  }

  return { items, lines };
}

function resolveRelayBindings(connections: ConnectionListResponse): NonNullable<ConnectionListResponse["relayBindings"]> {
  const relayBindings = connections.relayBindings ?? [];
  if (relayBindings.length > 0) {
    return relayBindings;
  }
  if (connections.relay.credentialStored || connections.relay.relayUrl) {
    return [
      {
        id: "relay",
        relayUrl: connections.relay.relayUrl,
        credentialStored: connections.relay.credentialStored,
        connected: connections.relay.connected,
        seatId: connections.relay.seatId
      }
    ];
  }
  return [];
}

async function manageDirectDevices(
  baseUrl: string,
  connections: ConnectionListResponse,
  readline: ReturnType<typeof createInterface>,
  language: CliLanguageCode
): Promise<void> {
  const indexed = renderConnections(
    { ...connections, relay: { connected: false, credentialStored: false }, relayBindings: [] },
    language
  );
  console.log("");
  console.log(translate(language, "currentConnections"));
  for (const line of indexed.lines) {
    console.log(line);
  }
  if (connections.directDevices.length === 0) {
    return;
  }
  const answer = (await readline.question(translate(language, "deletePrompt"))).trim();
  if (!answer) {
    return;
  }
  const index = Number(answer);
  const target = connections.directDevices[index - 1];
  if (!Number.isInteger(index) || !target) {
    console.log(translate(language, "missingIndex"));
    return;
  }
  await deleteConnection(baseUrl, "direct", target.deviceId, language);
}

async function manageRelayBinding(
  baseUrl: string,
  connections: ConnectionListResponse,
  readline: ReturnType<typeof createInterface>,
  language: CliLanguageCode
): Promise<void> {
  const relayBindings = resolveRelayBindings(connections);
  if (relayBindings.length === 0) {
    console.log(translate(language, "noConnections"));
    return;
  }
  relayBindings.forEach((binding, index) => {
    const status = binding.connected
      ? translate(language, "relayStatusConnected")
      : binding.credentialStored
        ? translate(language, "relayStatusBound")
        : translate(language, "relayStatusPending");
    const seatSuffix = binding.seatId
      ? translate(language, "relaySeatSuffix", { seatId: binding.seatId })
      : "";
    console.log(
      `${index + 1}. ${binding.label || binding.relayUrl || translate(language, "relayUrlMissing")} • ${status}${seatSuffix}`
    );
  });
  const answer = (await readline.question(translate(language, "deletePrompt"))).trim();
  const index = Number(answer);
  const target = relayBindings[index - 1];
  if (!Number.isInteger(index) || !target) {
    return;
  }
  await deleteConnection(baseUrl, "relay", target.id, language);
}

async function manageDirectServiceConfig(
  baseUrl: string,
  readline: ReturnType<typeof createInterface>,
  language: CliLanguageCode
): Promise<void> {
  const current = await requestJson<DirectServiceConfigResponse>(
    baseUrl,
    "/api/host/direct-service-config",
    { method: "GET" }
  );
  console.log("");
  console.log(translate(language, "directConfigCurrent"));
  console.log(`  ${translate(language, "directConfigHost")}: ${current.publicHost}`);
  console.log(
    `  ${translate(language, "directConfigBindHosts")}: ${(current.bindHosts ?? splitCommaList(current.bindHost)).join(", ")}`
  );
  console.log(`  ${translate(language, "directConfigPort")}: ${current.port}`);
  const publicHost =
    (await readline.question(`${translate(language, "directConfigHost")} [${current.publicHost}]: `)).trim() ||
    current.publicHost;
  const bindHostsDefault = (current.bindHosts ?? splitCommaList(current.bindHost)).join(", ");
  const bindHosts =
    (await readline.question(`${translate(language, "directConfigBindHosts")} [${bindHostsDefault}]: `)).trim() ||
    bindHostsDefault;
  const portInput =
    (await readline.question(`${translate(language, "directConfigPort")} [${current.port}]: `)).trim() ||
    String(current.port);
  const updated = await requestJson<DirectServiceConfigResponse>(
    baseUrl,
    "/api/host/direct-service-config",
    {
      method: "PUT",
      body: {
        publicHost,
        bindHosts,
        port: Number(portInput)
      }
    }
  );
  console.log(translate(language, "directConfigSaved"));
  if (updated.restartRequired) {
    console.log(translate(language, "directConfigRestartRequired"));
  }
}

async function manageSecurityConfig(
  baseUrl: string,
  readline: ReturnType<typeof createInterface>,
  language: CliLanguageCode
): Promise<void> {
  const current = await requestJson<SecurityConfigResponse>(baseUrl, "/api/host/security-config", {
    method: "GET"
  });
  console.log("");
  console.log(translate(language, "securityConfigCurrent"));
  console.log(`  ${translate(language, "securityConfigCert")}: ${current.certificatePath}`);
  console.log(`  ${translate(language, "securityConfigKey")}: ${current.keyPath}`);
  if (current.hostPublicKeyFingerprint) {
    console.log(`  ${translate(language, "securityConfigHostKey")}: ${current.hostPublicKeyFingerprint}`);
  }
  if (current.certificateFingerprint) {
    console.log(`  ${translate(language, "securityConfigTls")}: ${current.certificateFingerprint}`);
  }
  const certificatePath =
    (await readline.question(
      `${translate(language, "securityConfigCert")} [${current.certificatePath}]: `
    )).trim() || current.certificatePath;
  const updated = await requestJson<SecurityConfigResponse>(baseUrl, "/api/host/security-config", {
    method: "PUT",
    body: {
      certificatePath
    }
  });
  console.log(translate(language, "securityConfigSaved"));
  if (updated.restartRequired) {
    console.log(translate(language, "securityConfigRestartRequired"));
  }
}

async function handleDirectBinding(
  baseUrl: string,
  before: ConnectionListResponse,
  readline: ReturnType<typeof createInterface>,
  language: CliLanguageCode
): Promise<void> {
  const current = await requestJson<DirectServiceConfigResponse>(
    baseUrl,
    "/api/host/direct-service-config",
    { method: "GET" }
  );
  const publicHost = await selectDirectQrAddress(current, readline, language);
  const issued = await requestJson<{
    pairingCode: string;
    expiresAt: string;
    directUrl?: string;
    hostPublicKey?: string;
    hostPublicKeyFingerprint?: string;
    hostName?: string;
  }>(baseUrl, "/api/direct/pairings/issue", {
    method: "POST",
    body: {
      publicHost
    }
  });

  console.log("");
  console.log(translate(language, "directAddressSelected", { address: buildDirectPublicUrl(publicHost, current.port) }));
  console.log(translate(language, "expiresAt", { expiresAt: issued.expiresAt }));
  console.log(translate(language, "directInstructions"));
  console.log("");
  printQrCode(buildDirectPairingQrPayload(issued));
  console.log("");

  const knownDeviceIds = new Set(before.directDevices.map((device) => device.deviceId));
  const success = await waitFor(async () => {
    const current = await requestJson<ConnectionListResponse>(baseUrl, "/api/host/connections", {
      method: "GET"
    });
    return current.directDevices.some((device) => !knownDeviceIds.has(device.deviceId));
  }, 120_000, 3_000);

  console.log(success ? translate(language, "directSuccess") : translate(language, "directTimeout"));
}

async function handleRelayQrBinding(
  baseUrl: string,
  connections: ConnectionListResponse,
  language: CliLanguageCode
): Promise<void> {
  const hostInfo = await requestJson<HostInfoResponse>(baseUrl, "/api/host/info", {
    method: "GET"
  });
  const relayUrl =
    resolveRelayBindings(connections)[0]?.relayUrl ??
    hostInfo.serviceBaseUrl ??
    process.env.RELAY_URL ??
    "https://relay.codefly.run";
  const issued = await requestJson<{
    token: string;
    expiresAt: string;
    pairingUrl?: string | null;
    hostRelayUrl?: string | null;
    nodeId?: string | null;
  }>(
    relayUrl,
    "/api/relay/host-pairings",
    {
      method: "POST",
      body: {
        hostName: hostInfo.hostName,
        hostFingerprint: hostInfo.hostPublicKeyFingerprint,
        hostPublicKey: hostInfo.hostPublicKey,
        ttlSeconds: 300
      }
    }
  );
  const pairingUrl = normalizeUrl(issued.pairingUrl) ?? relayUrl;
  const hostRelayUrl = normalizeUrl(issued.hostRelayUrl) ?? relayUrl;
  const nodeId = issued.nodeId?.trim();
  if (!nodeId) {
    throw new Error("Relay pairing response is missing node id");
  }

  console.log("");
  console.log(translate(language, "expiresAt", { expiresAt: issued.expiresAt }));
  console.log(translate(language, "relayQrInstructions"));
  console.log("");
  printQrCode(
    buildRelayPairingQrPayload({
      token: issued.token,
      nodeId
    })
  );
  console.log("");

  try {
    const status = await waitForRelayPairingStatus(pairingUrl, issued.token);
    await requestJson(baseUrl, "/api/relay/binding", {
      method: "POST",
      body: {
        relayUrl: hostRelayUrl,
        credential: status.hostCredential,
        seatId: status.seatId ?? null,
        label: hostInfo.hostName
      }
    });
    console.log(translate(language, "relaySuccess"));
  } catch (error) {
    console.log(formatRelayPairingFailure(error, language));
  }
}

function formatRelayPairingFailure(error: unknown, language: CliLanguageCode): string {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  const message = error instanceof Error ? error.message : "";
  if (code === "subscription_required" || /subscription required/i.test(message)) {
    return translate(language, "relaySubscriptionRequired");
  }
  if (code === "plan_limit_reached" || /host limit|plan limit|limit reached/i.test(message)) {
    return translate(language, "relayHostLimitReached");
  }
  if (/timed out/i.test(message)) {
    return translate(language, "relayTimeout");
  }
  return translate(language, "relayFailed");
}

async function waitForRelayPairingStatus(
  relayUrl: string,
  token: string
): Promise<{
  status: "claimed";
  seatId?: string | null;
  hostCredential: string;
}> {
  const url = new URL("/ws/relay/host-pairings/status", relayUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", token);

  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      socket.close();
      reject(new Error("Relay binding timed out"));
    }, 300_000);
    const socket = new WebSocket(url.toString());
    const finish = (
      callback: () => void
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    socket.on("message", (data) => {
      try {
        const status = JSON.parse(data.toString()) as {
          status?: "pending" | "claimed" | "failed" | "expired";
          seatId?: string | null;
          hostCredential?: string | null;
          errorCode?: string | null;
          errorMessage?: string | null;
          error?: string;
        };
        if (status.error) {
          finish(() => reject(new Error(status.error)));
          socket.close();
          return;
        }
        const hostCredential = status.hostCredential?.trim();
        if (status.status === "claimed" && hostCredential) {
          finish(() =>
            resolve({
              status: "claimed",
              seatId: status.seatId ?? null,
              hostCredential
            })
          );
          socket.close();
          return;
        }
        if (status.status === "failed" || status.status === "expired") {
          const error = new Error(status.errorMessage ?? status.status) as Error & {
            code?: string | null;
          };
          error.code = status.errorCode ?? status.status;
          finish(() => reject(error));
          socket.close();
        }
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
        socket.close();
      }
    });
    socket.on("error", (error) => finish(() => reject(error)));
    socket.on("close", () => {
      if (!settled) {
        finish(() => reject(new Error("Relay status socket closed before pairing completed")));
      }
    });
  });
}

async function printEnvironmentReport(baseUrl: string, language: CliLanguageCode): Promise<void> {
  console.log("");
  console.log(translate(language, "environmentTitle"));
  printSection("Runtime");
  printKeyValueRows([
    ["OS", `${os.type()} ${os.release()} (${os.arch()})`],
    ["CPU", `${os.cpus()[0]?.model ?? "unknown"} x ${os.cpus().length}`],
    ["Memory", formatBytes(os.totalmem())],
    ["Network", formatLocalNetworkInterfaces()]
  ]);
  try {
    const hardware = await requestJson<HostHardwareSnapshot>(baseUrl, "/api/host/hardware", {
      method: "GET"
    });
    printHardwareSnapshot(hardware);
  } catch {
    printSection("Hardware");
    console.log("  unavailable");
  }
  printSection("Tools");
  printKeyValueRows([
    ["Codex", commandVersion("codex", ["--version"])],
    ["Claude Code", commandVersion("claude", ["--version"])]
  ]);
}

function printHardwareSnapshot(hardware: HostHardwareSnapshot): void {
  printSection("Software");
  printKeyValueRows([
    ["Captured", formatTimestamp(hardware.timestamp)],
    ["System", hardware.software.systemVersion || "unknown"],
    ["Uptime", formatDuration(hardware.software.uptimeSeconds)],
    ["Node.js", hardware.software.nodeVersion || "unknown"],
    ["Python", hardware.software.pythonVersion || "not found"],
    ["CUDA", hardware.software.cudaVersion || "not found"],
    ["GPU driver", hardware.software.gpuDriverVersion || "not found"]
  ]);

  printSection("CPU");
  printKeyValueRows([
    ["Model", hardware.cpu.model || "unknown"],
    ["Usage", formatPercent(hardware.cpu.overallUsagePercent)],
    ["Cores", String(hardware.cpu.cores.length)],
    ["Core load", formatCoreLoads(hardware.cpu.cores)]
  ]);

  printSection("Memory");
  printKeyValueRows([
    ["Total", formatBytes(hardware.memory.totalBytes)],
    ["Used", formatBytes(hardware.memory.usedBytes)],
    ["Available", formatBytes(hardware.memory.availableBytes)],
    ["Usage", formatPercent(hardware.memory.usagePercent)]
  ]);

  printSection("Disks");
  if (hardware.disks.length === 0) {
    console.log("  none");
  } else {
    printTable(
      ["Mount", "FS", "Type", "Used", "Available", "Total", "Use"],
      hardware.disks.map((disk) => [
        disk.mount,
        disk.fs,
        disk.type,
        formatBytes(disk.usedBytes),
        formatBytes(disk.availableBytes),
        formatBytes(disk.totalBytes),
        formatPercent(disk.usagePercent)
      ])
    );
  }

  printSection("GPUs");
  if (hardware.gpus.length === 0) {
    console.log("  none detected");
  } else {
    printTable(
      ["ID", "Vendor", "Model", "Usage", "Memory", "Power", "Driver"],
      hardware.gpus.map((gpu) => [
        gpu.id,
        gpu.vendor,
        gpu.model,
        formatPercent(gpu.usagePercent),
        formatGpuMemory(gpu.memoryUsedMiB, gpu.memoryTotalMiB),
        formatGpuPower(gpu.powerDrawWatts, gpu.powerLimitWatts),
        gpu.driverVersion || "unknown"
      ])
    );
  }

  printSection("Network");
  if (hardware.network.length === 0) {
    console.log("  none");
  } else {
    printTable(
      ["Interface", "Status", "Speed", "RX/s", "TX/s", "RX total", "TX total"],
      hardware.network.map((entry) => [
        entry.displayName || entry.id,
        entry.operational ? "up" : "down",
        entry.linkSpeedMbit && entry.linkSpeedMbit > 0 ? `${entry.linkSpeedMbit} Mbit/s` : "unknown",
        formatBytesPerSecond(entry.rxBytesPerSecond),
        formatBytesPerSecond(entry.txBytesPerSecond),
        formatBytes(entry.rxBytes),
        formatBytes(entry.txBytes)
      ])
    );
  }
}

function printSection(title: string): void {
  console.log("");
  console.log(title);
  console.log("-".repeat(title.length));
}

function printKeyValueRows(rows: Array<[string, string]>): void {
  const labelWidth = rows.reduce((width, [label]) => Math.max(width, label.length), 0);
  for (const [label, value] of rows) {
    console.log(`  ${label.padEnd(labelWidth)}  ${value}`);
  }
}

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => row[column]?.length ?? 0))
  );
  const formatRow = (row: string[]) =>
    row.map((cell, index) => (cell ?? "").padEnd(widths[index] ?? 0)).join("  ");
  console.log(`  ${formatRow(headers)}`);
  console.log(`  ${widths.map((width) => "-".repeat(width)).join("  ")}`);
  for (const row of rows) {
    console.log(`  ${formatRow(row)}`);
  }
}

function formatLocalNetworkInterfaces(): string {
  const entries = Object.entries(os.networkInterfaces())
    .flatMap(([name, addresses]) =>
      (addresses ?? [])
        .filter((entry) => !entry.internal)
        .map((entry) => `${name} ${entry.family} ${entry.address}`)
    );
  return entries.length > 0 ? entries.join("; ") : "none";
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "unknown";
  }
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const parts = [
    days > 0 ? `${days}d` : "",
    hours > 0 || days > 0 ? `${hours}h` : "",
    `${minutes}m`
  ].filter(Boolean);
  return parts.join(" ");
}

function formatBytes(value?: number | null): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "unknown";
  }
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let current = value;
  let unitIndex = 0;
  while (current >= 1024 && unitIndex < units.length - 1) {
    current /= 1024;
    unitIndex += 1;
  }
  const precision = current >= 100 || unitIndex === 0 ? 0 : current >= 10 ? 1 : 2;
  return `${current.toFixed(precision)} ${units[unitIndex]}`;
}

function formatBytesPerSecond(value?: number | null): string {
  const formatted = formatBytes(value);
  return formatted === "unknown" ? formatted : `${formatted}/s`;
}

function formatPercent(value?: number | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "unknown";
  }
  return `${value.toFixed(value % 1 === 0 ? 0 : 1)}%`;
}

function formatCoreLoads(cores: HostHardwareSnapshot["cpu"]["cores"]): string {
  if (cores.length === 0) {
    return "unknown";
  }
  const sample = cores
    .slice(0, 12)
    .map((core) => `${core.id.replace(/^core\s+/i, "#")}:${formatPercent(core.usagePercent)}`);
  if (cores.length > sample.length) {
    sample.push(`+${cores.length - sample.length} more`);
  }
  return sample.join(", ");
}

function formatGpuMemory(used?: number | null, total?: number | null): string {
  if (typeof used === "number" && typeof total === "number" && Number.isFinite(used) && Number.isFinite(total)) {
    return `${used} / ${total} MiB`;
  }
  if (typeof total === "number" && Number.isFinite(total)) {
    return `${total} MiB`;
  }
  return "unknown";
}

function formatGpuPower(draw?: number | null, limit?: number | null): string {
  if (typeof draw === "number" && typeof limit === "number" && Number.isFinite(draw) && Number.isFinite(limit)) {
    return `${draw} / ${limit} W`;
  }
  if (typeof draw === "number" && Number.isFinite(draw)) {
    return `${draw} W`;
  }
  return "unknown";
}

async function printVersionReport(
  readline: ReturnType<typeof createInterface>,
  language: CliLanguageCode
): Promise<void> {
  const installedVersion = getInstalledPackageVersion();
  const latestVersion = await fetchLatestNpmVersion(HOST_PACKAGE_NAME);
  console.log("");
  console.log(translate(language, "versionTitle"));
  console.log(translate(language, "versionInstalled", { version: installedVersion }));
  if (latestVersion) {
    console.log(translate(language, "versionLatest", { version: latestVersion }));
  } else {
    console.log(translate(language, "versionCheckFailed"));
  }
  console.log("Compatible Codex CLI: configured by @openai/codex dependency in package.json");
  console.log("Compatible Claude Code: configured by @anthropic-ai/claude-code dependency in package.json");
  if (!latestVersion) {
    return;
  }
  const comparison = compareSemver(latestVersion, installedVersion);
  if (comparison <= 0) {
    console.log(
      comparison === 0
        ? translate(language, "versionUpToDate")
        : translate(language, "versionNewerThanLatest")
    );
    return;
  }
  console.log(translate(language, "versionUpdateAvailable", { current: installedVersion, latest: latestVersion }));
  const answer = (await readline.question(translate(language, "versionUpgradePrompt"))).trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") {
    console.log(translate(language, "versionUpgradeSkipped"));
    return;
  }
  await runAutoUpgrade(latestVersion, language);
}

function getInstalledPackageVersion(): string {
  const candidatePaths = [
    path.resolve(__dirname, "..", "package.json"),
    path.resolve(process.cwd(), "package.json")
  ];
  for (const packageJsonPath of candidatePaths) {
    try {
      const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
        name?: string;
        version?: string;
      };
      if (
        parsed.name === HOST_PACKAGE_NAME &&
        typeof parsed.version === "string" &&
        parsed.version.trim()
      ) {
        return parsed.version.trim();
      }
    } catch {
      // Try the next possible package root.
    }
  }
  return HOST_PACKAGE_VERSION_FALLBACK;
}

async function fetchLatestNpmVersion(packageName: string): Promise<string | null> {
  const registryUrl = new URL(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`);
  return new Promise((resolve) => {
    const request = https.request(
      registryUrl,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": `${HOST_PACKAGE_NAME}/${getInstalledPackageVersion()}`
        },
        timeout: 8_000
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            resolve(null);
            return;
          }
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { version?: unknown };
            resolve(typeof parsed.version === "string" && parsed.version.trim() ? parsed.version.trim() : null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    request.on("timeout", () => request.destroy(new Error("npm registry request timed out")));
    request.on("error", () => resolve(null));
    request.end();
  });
}

function compareSemver(left: string, right: string): number {
  const parse = (value: string) => {
    const normalized = value.trim().replace(/^v/i, "");
    const [core = "", prerelease = ""] = normalized.split(/[+-]/, 2);
    const parts = core.split(".").map((part) => Number.parseInt(part, 10));
    return {
      numbers: [parts[0] || 0, parts[1] || 0, parts[2] || 0],
      prerelease
    };
  };
  const leftParsed = parse(left);
  const rightParsed = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParsed.numbers[index]! - rightParsed.numbers[index]!;
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  if (leftParsed.prerelease === rightParsed.prerelease) {
    return 0;
  }
  if (!leftParsed.prerelease) {
    return 1;
  }
  if (!rightParsed.prerelease) {
    return -1;
  }
  return Math.sign(leftParsed.prerelease.localeCompare(rightParsed.prerelease));
}

async function runAutoUpgrade(latestVersion: string, language: CliLanguageCode): Promise<void> {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const args = ["install", "-g", `${HOST_PACKAGE_NAME}@latest`];
  console.log(translate(language, "versionUpgradeCommand", { command: `npm ${args.join(" ")}` }));
  const exitCode = await new Promise<number | null>((resolve) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", (error) => {
      console.log(translate(language, "versionUpgradeError", { message: error.message }));
      resolve(null);
    });
    child.on("close", (code) => resolve(code));
  });
  if (exitCode === 0) {
    console.log(translate(language, "versionUpgradeSuccess", { version: latestVersion }));
  } else if (exitCode !== null) {
    console.log(translate(language, "versionUpgradeFailed", { code: exitCode }));
  }
}

function commandVersion(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return "not found";
  }
}

async function deleteConnection(
  baseUrl: string,
  kind: "direct" | "relay",
  id: string,
  language: CliLanguageCode
): Promise<void> {
  if (kind === "direct") {
    await requestJson(baseUrl, `/api/direct/paired-devices/${encodeURIComponent(id)}`, {
      method: "DELETE"
    });
    console.log(translate(language, "deleteDirectSuccess"));
    return;
  }

  await requestJson(baseUrl, `/api/relay/binding/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
  console.log(translate(language, "deleteRelaySuccess"));
}

async function waitFor(
  probe: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs: number
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await probe()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

async function requestJson<T>(
  baseUrl: string,
  path: string,
  init: {
    method: string;
    body?: unknown;
    headers?: Record<string, string>;
  }
): Promise<T> {
  const url = new URL(path, baseUrl);
  const client = url.protocol === "https:" ? https : http;
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);

  return new Promise<T>((resolve, reject) => {
    const request = client.request(
      url,
      {
        method: init.method,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(body ? { "Content-Length": Buffer.byteLength(body).toString() } : {}),
          ...(init.headers ?? {})
        },
        ...(url.protocol === "https:" ? { rejectUnauthorized: false } : {})
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((response.statusCode ?? 500) >= 400) {
            reject(new Error(text || `Request failed with status ${response.statusCode}`));
            return;
          }
          try {
            resolve((text ? JSON.parse(text) : null) as T);
          } catch (error) {
            reject(error instanceof Error ? error : new Error("Invalid JSON response"));
          }
        });
      }
    );

    request.on("error", reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
