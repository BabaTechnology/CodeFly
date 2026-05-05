import type { EncryptedAppFrame, EncryptedTransportFrame } from "./shared";
import type { FastifyInstance } from "fastify";
import type { RelayBindingRecord } from "./host-store";
import { RelayUpstreamClient } from "./relay-client";

interface RelayConnectionTarget {
  connectionKey: string;
  deviceId: string;
  label: string;
  publicKey: string;
  routeMode: "relay";
  relayBindingId?: string | null;
  relaySeatId?: string | null;
  installationId?: string | null;
  installationTokenHash?: string | null;
  appVersion?: string | null;
  sendRaw: (frame: EncryptedTransportFrame) => void;
}

export interface RelayUpstreamRoutesController {
  startAllRelayUpstreams: () => void;
}

export function registerRelayUpstreamRoutes(context: Record<string, any>): RelayUpstreamRoutesController {
  const app = context.app as FastifyInstance;
  const {
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
  } = context;

function attachRelayEventBindings(binding: RelayBindingRecord, client: RelayUpstreamClient): void {
  client.on("frame", (frame: EncryptedAppFrame) => {
    const seatId = client.seatId() ?? binding.seatId ?? frame.seatId ?? null;
    const connectionKey = relayConnectionKey(binding.id, frame.senderId);
    const target = relayTargets.get(connectionKey) ?? {
      connectionKey,
      deviceId: frame.senderId,
      label: frame.senderId,
      publicKey: frame.senderPublicKey,
      routeMode: "relay" as const,
      relayBindingId: binding.id,
      relaySeatId: seatId,
      sendRaw: (outboundFrame: EncryptedTransportFrame) => client.sendEncrypted(outboundFrame)
    };
    target.publicKey = frame.senderPublicKey;
    target.relaySeatId = seatId;
    relayTargets.set(connectionKey, target);
    handleEncryptedInbound(target, frame);
  });

  client.on(
    "device_attached",
    (frame: { deviceId: string; deviceLabel: string; devicePublicKey: string; appVersion?: string }) => {
      const seatId = client.seatId() ?? binding.seatId ?? null;
      const connectionKey = relayConnectionKey(binding.id, frame.deviceId);
      const target: RelayConnectionTarget = {
        connectionKey,
        deviceId: frame.deviceId,
        label: frame.deviceLabel,
        publicKey: frame.devicePublicKey,
        routeMode: "relay",
        relayBindingId: binding.id,
        relaySeatId: seatId,
        appVersion: frame.appVersion ?? null,
        sendRaw: (outboundFrame: EncryptedTransportFrame) => client.sendEncrypted(outboundFrame)
      };
      relayTargets.set(connectionKey, target);
      void emitInitialState(target);
    }
  );

  client.on("device_detached", (frame: { deviceId: string }) => {
    const connectionKey = relayConnectionKey(binding.id, frame.deviceId);
    notificationPublisher.markConnectionDetached(connectionKey);
    relayTargets.delete(connectionKey);
  });

  client.on("authenticated", (frame: { seatId: string }) => {
    hostStore.updateRelayBindingSeat(binding.id, frame.seatId);
    app.log.info({ bindingId: binding.id, seatId: frame.seatId }, "Relay upstream authenticated");
  });

  client.on("unbind", (frame: { seatId: string; reason: string; message?: string }) => {
    app.log.warn(
      { bindingId: binding.id, seatId: frame.seatId, reason: frame.reason },
      frame.message ?? "Relay binding removed"
    );
    void clearRelayUpstream(binding.id, { notifyServer: false }).catch((error) => {
      app.log.error(
        { err: error instanceof Error ? error : new Error(String(error)), bindingId: binding.id },
        "Failed to clear removed relay binding"
      );
    });
  });

  client.on(
    "backoff",
    (frame: { seatId: string; retryAfterSeconds: number; reason: string; message?: string }) => {
      app.log.warn(
        {
          bindingId: binding.id,
          seatId: frame.seatId,
          reason: frame.reason,
          retryAfterSeconds: frame.retryAfterSeconds
        },
        frame.message ?? "Relay upstream paused before retry"
      );
    }
  );

  client.on("disconnected", () => {
    app.log.warn({ bindingId: binding.id, seatId: client.seatId() ?? binding.seatId }, "Relay upstream disconnected");
  });

  client.on("error", (error: unknown) => {
    app.log.error(
      { err: error instanceof Error ? error : new Error(String(error)), bindingId: binding.id },
      "Relay upstream error"
    );
  });
}

function pruneRelayTargetsForBinding(bindingId: string): void {
  for (const key of relayTargets.keys()) {
    if (key.startsWith(`${bindingId}:`)) {
      relayTargets.delete(key);
    }
  }
}

function startRelayUpstream(binding: RelayBindingRecord): void {
  if (!binding.relayUrl || !binding.hostCredential) {
    return;
  }

  relayClients.get(binding.id)?.stop();
  const client = new RelayUpstreamClient({
    relayUrl: binding.relayUrl,
    hostName: config.hostName,
    hostFingerprint: identity.publicKeyFingerprint,
    hostPublicKey: identity.keyPair.publicKey,
    credential: binding.hostCredential
  });

  relayClients.set(binding.id, client);
  attachRelayEventBindings(binding, client);
  client.start();
}

function startAllRelayUpstreams(): void {
  for (const binding of hostStore.listRelayBindings()) {
    startRelayUpstream(binding);
  }
}

function stopRelayUpstream(bindingId: string): void {
  relayClients.get(bindingId)?.stop();
  relayClients.delete(bindingId);
  pruneRelayTargetsForBinding(bindingId);
}

function stopAllRelayUpstreams(): void {
  for (const bindingId of [...relayClients.keys()]) {
    stopRelayUpstream(bindingId);
  }
}

async function configureRelayCredential(input: {
  relayUrl: string;
  credential: string;
  seatId?: string | null;
  label?: string | null;
}): Promise<RelayBindingRecord> {
  const binding = hostStore.upsertRelayBinding({
    relayUrl: input.relayUrl,
    serviceBaseUrl: config.serviceBaseUrl,
    hostCredential: input.credential,
    seatId: input.seatId,
    label: input.label
  });
  config.relayUrl = input.relayUrl;
  config.relayCredential = input.credential;
  stopRelayUpstream(binding.id);
  startRelayUpstream(binding);
  return binding;
}

async function notifyRelayBindingReleased(binding: RelayBindingRecord): Promise<void> {
  const credential = binding.hostCredential?.trim();
  if (!credential) {
    return;
  }
  const response = await fetch(`${binding.relayUrl.replace(/\/$/, "")}/api/relay/host-bindings/release`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      credential,
      hostFingerprint: identity.publicKeyFingerprint
    })
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
}

async function clearRelayUpstream(
  bindingId: string,
  options: { notifyServer: boolean }
): Promise<RelayBindingRecord | undefined> {
  const binding = hostStore.getRelayBinding(bindingId);
  stopRelayUpstream(bindingId);
  if (binding && options.notifyServer) {
    await notifyRelayBindingReleased(binding).catch((error) => {
      app.log.warn(
        { err: error instanceof Error ? error : new Error(String(error)), bindingId },
        "Failed to notify relay service about local binding removal"
      );
    });
  }
  return hostStore.removeRelayBinding(bindingId);
}

async function clearAllRelayUpstreams(options: { notifyServer: boolean }): Promise<void> {
  const bindings = hostStore.listRelayBindings();
  for (const binding of bindings) {
    await clearRelayUpstream(binding.id, options);
  }
  stopAllRelayUpstreams();
  config.relayUrl = undefined;
  config.relayCredential = undefined;
}

app.post<{ Body: { relayUrl?: string; credential?: string; seatId?: string; label?: string } }>(
  "/api/relay/binding",
  async (request, reply) => {
    if (!requireLoopbackRequest(request, reply)) {
      return;
    }

    const relayUrl = String(request.body?.relayUrl ?? config.relayUrl ?? "").trim();
    const credential = String(request.body?.credential ?? "").trim();
    const seatId = String(request.body?.seatId ?? "").trim();
    const label = String(request.body?.label ?? "").trim();
    if (!relayUrl || !credential) {
      return reply.code(400).send({ error: "relayUrl and credential are required" });
    }

    const binding = await configureRelayCredential({
      relayUrl,
      credential,
      seatId: seatId || null,
      label: label || null
    });
    return { ok: true, bindingId: binding.id };
  }
);

app.delete<{ Params: { bindingId: string } }>("/api/relay/binding/:bindingId", async (request, reply) => {
  if (!requireLoopbackRequest(request, reply)) {
    return;
  }
  const bindingId = String(request.params.bindingId ?? "").trim();
  if (!bindingId) {
    return reply.code(400).send({ error: "bindingId is required" });
  }
  await clearRelayUpstream(bindingId, { notifyServer: true });
  return { ok: true };
});

app.delete("/api/relay/binding", async (request, reply) => {
  if (!requireLoopbackRequest(request, reply)) {
    return;
  }
  await clearAllRelayUpstreams({ notifyServer: true });
  return { ok: true };
});


  return { startAllRelayUpstreams };
}
