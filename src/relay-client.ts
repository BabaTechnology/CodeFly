import { EventEmitter } from "node:events";
import WebSocket from "ws";
import {
  CODEFLY_MAX_TRANSPORT_PACKET_BYTES,
  EncryptedTransportReassembler,
  isEncryptedTransportFrame,
  type EncryptedTransportFrame,
  type RelayControlFrame
} from "./shared";

const RELAY_IDLE_REBALANCE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const RELAY_IDLE_REBALANCE_RETRY_MS = 30 * 60 * 1000;

export interface RelayClientOptions {
  relayUrl: string;
  hostName: string;
  hostFingerprint: string;
  hostPublicKey: string;
  credential: string;
}

export class RelayUpstreamClient extends EventEmitter {
  private ws?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private activeSeatId?: string;
  private hostCredential?: string;
  private reconnectAttempt = 0;
  private forcedReconnectDelayMs?: number;
  private stopped = false;
  private readonly reassembler = new EncryptedTransportReassembler();
  private readonly attachedDeviceIds = new Set<string>();
  private idleRebalanceTimer?: NodeJS.Timeout;

  public constructor(private readonly options: RelayClientOptions) {
    super();
    this.hostCredential = options.credential;
  }

  public start(): void {
    this.stopped = false;
    this.connect();
  }

  public stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.clearIdleRebalanceTimer();
    this.ws?.close();
  }

  public isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  public seatId(): string | undefined {
    return this.activeSeatId;
  }

  public sendEncrypted(frame: EncryptedTransportFrame): void {
    if (!this.isConnected()) {
      throw new Error("Relay upstream is not connected");
    }
    const payload = JSON.stringify(frame);
    if (Buffer.byteLength(payload, "utf8") > CODEFLY_MAX_TRANSPORT_PACKET_BYTES) {
      throw new Error("Relay upstream packet exceeds the maximum allowed size");
    }
    this.ws!.send(payload);
  }

  public sendControl(frame: RelayControlFrame): void {
    if (!this.isConnected()) {
      throw new Error("Relay upstream is not connected");
    }
    this.ws!.send(JSON.stringify(frame));
  }

  private connect(): void {
    if (this.stopped) {
      return;
    }
    const baseUrl = this.options.relayUrl.replace(/^http/, "ws").replace(/\/$/, "");
    this.ws = new WebSocket(`${baseUrl}/ws/host`);

    this.ws.on("open", () => {
      const authFrame: RelayControlFrame = {
        kind: "host_auth",
        credential: this.hostCredential ?? this.options.credential,
        hostName: this.options.hostName,
        hostFingerprint: this.options.hostFingerprint,
        hostPublicKey: this.options.hostPublicKey
      };
      this.ws?.send(JSON.stringify(authFrame));
    });

    this.ws.on("message", (data) => {
      try {
        const parsed = JSON.parse(data.toString()) as RelayControlFrame | EncryptedTransportFrame;
        if (isEncryptedTransportFrame(parsed)) {
          const frame = this.reassembler.accept(parsed);
          if (frame) {
            this.emit("frame", frame);
          }
          return;
        }

        this.handleControl(parsed as RelayControlFrame);
      } catch (error) {
        this.emit("error", error instanceof Error ? error : new Error("Invalid relay upstream frame"));
      }
    });

    this.ws.on("close", () => {
      this.reassembler.reset();
      this.attachedDeviceIds.clear();
      this.emit("disconnected");
      this.scheduleReconnect();
    });

    this.ws.on("error", (error) => {
      this.emit("error", error);
    });
  }

  private handleControl(frame: RelayControlFrame): void {
    const kind = (frame as { kind: string }).kind;
    switch (kind) {
      case "host_authenticated": {
        const authenticated = frame as {
          seatId: string;
          hostCredential?: string;
        };
        this.activeSeatId = authenticated.seatId;
        this.reconnectAttempt = 0;
        this.forcedReconnectDelayMs = undefined;
        this.scheduleIdleRebalance(RELAY_IDLE_REBALANCE_INTERVAL_MS);
        this.emit("authenticated", frame);
        break;
      }
      case "host_unbind": {
        const unbindFrame = frame as unknown as {
          seatId: string;
          reason: "user_removed" | "system_removed";
          message?: string;
        };
        this.stopped = true;
        this.emit("unbind", unbindFrame);
        this.ws?.close();
        break;
      }
      case "relay_backoff": {
        const backoffFrame = frame as unknown as {
          seatId: string;
          reason: "subscription_required";
          retryAfterSeconds: number;
          message?: string;
        };
        this.forcedReconnectDelayMs = Math.max(60_000, backoffFrame.retryAfterSeconds * 1000);
        this.emit("backoff", backoffFrame);
        this.ws?.close();
        break;
      }
      case "device_attached":
        if ((frame as { deviceId?: string }).deviceId) {
          this.attachedDeviceIds.add((frame as { deviceId: string }).deviceId);
        }
        this.emit(kind, frame);
        break;
      case "device_detached":
        if ((frame as { deviceId?: string }).deviceId) {
          this.attachedDeviceIds.delete((frame as { deviceId: string }).deviceId);
        }
        this.emit(kind, frame);
        break;
      case "host_presence":
      case "device_authenticated":
        this.emit(kind, frame);
        break;
      case "heartbeat":
        break;
      case "error": {
        const errorFrame = frame as { code: string; message: string };
        this.emit("error", new Error(`${errorFrame.code}: ${errorFrame.message}`));
        break;
      }
      default:
        break;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) {
      return;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    const delayMs = this.consumeReconnectDelayMs();
    this.reconnectTimer = setTimeout(() => this.connect(), delayMs);
  }

  private scheduleIdleRebalance(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    this.clearIdleRebalanceTimer();
    this.idleRebalanceTimer = setTimeout(() => this.rebalanceWhenIdle(), delayMs);
  }

  private clearIdleRebalanceTimer(): void {
    if (this.idleRebalanceTimer) {
      clearTimeout(this.idleRebalanceTimer);
      this.idleRebalanceTimer = undefined;
    }
  }

  private rebalanceWhenIdle(): void {
    if (this.stopped) {
      return;
    }
    if (this.attachedDeviceIds.size > 0) {
      this.scheduleIdleRebalance(RELAY_IDLE_REBALANCE_RETRY_MS);
      return;
    }
    this.ws?.close(4005, "Scheduled relay rebalance");
  }

  private consumeReconnectDelayMs(): number {
    if (this.forcedReconnectDelayMs != null) {
      const delayMs = this.forcedReconnectDelayMs;
      this.forcedReconnectDelayMs = undefined;
      return delayMs;
    }

    const attempt = this.reconnectAttempt;
    this.reconnectAttempt += 1;
    if (attempt === 0) {
      return 5_000;
    }
    if (attempt === 1) {
      return randomDelayMs(5_000, 10_000);
    }
    if (attempt === 2) {
      return randomDelayMs(20_000, 60_000);
    }
    return randomDelayMs(60_000, 120_000);
  }
}

function randomDelayMs(minMs: number, maxMs: number): number {
  return Math.floor(minMs + Math.random() * (maxMs - minMs + 1));
}
