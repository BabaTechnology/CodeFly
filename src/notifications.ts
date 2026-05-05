import { nowIso, type NotificationCategory, type RelayControlFrame } from "./shared";

interface ViewerState {
  connectionKey: string;
  deviceId: string;
  routeMode: "direct" | "relay";
  relaySeatId?: string | null;
  sessionId?: string | null;
  installationId?: string | null;
  installationTokenHash?: string | null;
  detachedAt?: number | null;
}

interface PendingDirectTarget {
  connectionKey: string;
  installationTokenHash: string;
  updatedAt: string;
}

export interface PublishNotificationInput {
  category: NotificationCategory;
  occurredAt?: string;
  sessionId?: string | null;
  sessionTitle?: string | null;
  provider?: string | null;
  actionKind?: "approval" | "choice" | null;
  dedupeKey: string;
}

export interface HostNotificationPublisherOptions {
  hostName: string;
  hostFingerprint: string;
  getServiceBaseUrl: () => string | undefined;
  getRelaySeatIds: () => string[];
  sendRelayControl: (seatId: string, frame: RelayControlFrame) => void;
  onError?: (error: Error, context: "direct" | "relay") => void;
}

export class HostNotificationPublisher {
  private readonly viewers = new Map<string, ViewerState>();
  private readonly pendingDirectTargets = new Map<string, Map<string, PendingDirectTarget>>();

  public constructor(private readonly options: HostNotificationPublisherOptions) {}

  public markSessionAttached(input: {
    connectionKey: string;
    deviceId: string;
    routeMode: "direct" | "relay";
    relaySeatId?: string | null;
    sessionId: string;
    installationId?: string | null;
    installationTokenHash?: string | null;
  }): void {
    this.viewers.set(input.connectionKey, {
      connectionKey: input.connectionKey,
      deviceId: input.deviceId,
      routeMode: input.routeMode,
      relaySeatId: input.relaySeatId ?? null,
      sessionId: input.sessionId,
      installationId: input.installationId ?? null,
      installationTokenHash: input.installationTokenHash ?? null,
      detachedAt: null
    });
  }

  public rememberDirectSessionTarget(input: {
    connectionKey: string;
    sessionId: string;
    installationTokenHash?: string | null;
  }): void {
    const installationTokenHash = input.installationTokenHash?.trim() ?? "";
    if (!installationTokenHash) {
      return;
    }
    const existing = this.pendingDirectTargets.get(input.sessionId) ?? new Map<string, PendingDirectTarget>();
    existing.set(input.connectionKey, {
      connectionKey: input.connectionKey,
      installationTokenHash,
      updatedAt: nowIso()
    });
    this.pendingDirectTargets.set(input.sessionId, existing);
  }

  public markConnectionDetached(connectionKey: string): void {
    const current = this.viewers.get(connectionKey);
    if (current) {
      current.detachedAt = Date.now();
    }
  }

  public markSessionDetached(connectionKey: string, sessionId: string): void {
    const current = this.viewers.get(connectionKey);
    if (current?.sessionId === sessionId) {
      current.detachedAt = Date.now();
    }
  }

  public replaceSessionId(previousSessionId: string, nextSessionId: string): void {
    const previous = previousSessionId.trim();
    const next = nextSessionId.trim();
    if (!previous || !next || previous === next) {
      return;
    }

    for (const [connectionKey, viewer] of this.viewers.entries()) {
      if (viewer.sessionId === previous) {
        this.viewers.set(connectionKey, {
          ...viewer,
          sessionId: next
        });
      }
    }

    const pending = this.pendingDirectTargets.get(previous);
    if (!pending) {
      return;
    }
    const existing = this.pendingDirectTargets.get(next) ?? new Map<string, PendingDirectTarget>();
    for (const [connectionKey, target] of pending.entries()) {
      existing.set(connectionKey, target);
    }
    this.pendingDirectTargets.set(next, existing);
    this.pendingDirectTargets.delete(previous);
  }

  public hasActiveSessionViewer(sessionId: string): boolean {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      return false;
    }
    return [...this.viewers.values()].some(
      (viewer) => viewer.sessionId === normalizedSessionId && viewer.detachedAt == null
    );
  }

  public async publish(input: PublishNotificationInput): Promise<void> {
    const occurredAt = input.occurredAt ?? nowIso();
    this.emitRelay(input, occurredAt, this.collectRelaySuppression(input.sessionId ?? null));
    await this.emitDirect(input, occurredAt);
  }

  private collectRelaySuppression(sessionId: string | null): string[] {
    if (!sessionId) {
      return [];
    }

    return [...this.viewers.values()]
      .filter((viewer) => {
        if (viewer.routeMode !== "relay" || viewer.sessionId !== sessionId) {
          return false;
        }
        return viewer.detachedAt == null;
      })
      .map((viewer) => viewer.installationId?.trim() ?? "")
      .filter(Boolean);
  }

  private async emitDirect(input: PublishNotificationInput, occurredAt: string): Promise<void> {
    const sessionId = input.sessionId?.trim();
    if (!sessionId) {
      return;
    }

    const serviceBaseUrl = this.options.getServiceBaseUrl()?.trim();
    if (!serviceBaseUrl) {
      return;
    }

    const sessionTargets = this.pendingDirectTargets.get(sessionId);
    if (!sessionTargets || sessionTargets.size === 0) {
      return;
    }
    this.pendingDirectTargets.delete(sessionId);

    const targets = [...sessionTargets.values()].filter(
      (target) => !this.hasActiveDirectViewer(sessionId, target)
    );

    const results = await Promise.allSettled(
      targets.map(async (target) => {
        const response = await fetch(`${serviceBaseUrl.replace(/\/$/, "")}/api/push/direct/emit`, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            installationTokenHash: target.installationTokenHash,
            event: {
              category: input.category,
              occurredAt,
              hostName: this.options.hostName,
              hostFingerprint: this.options.hostFingerprint,
              sessionId,
              sessionTitle: input.sessionTitle ?? null,
              provider: input.provider ?? null,
              actionKind: input.actionKind ?? null,
              dedupeKey: input.dedupeKey
            }
          })
        });
        if (!response.ok) {
          throw new Error(await response.text());
        }
      })
    );

    results.forEach((result) => {
      if (result.status === "rejected") {
        const error =
          result.reason instanceof Error
            ? result.reason
            : new Error(String(result.reason ?? "Unknown direct push failure"));
        this.options.onError?.(error, "direct");
      }
    });
  }

  private hasActiveDirectViewer(
    sessionId: string,
    target: PendingDirectTarget
  ): boolean {
    return [...this.viewers.values()].some((viewer) => {
      if (viewer.routeMode !== "direct" || viewer.sessionId !== sessionId) {
        return false;
      }
      if (viewer.detachedAt != null) {
        return false;
      }
      const sameConnection = viewer.connectionKey === target.connectionKey;
      const sameInstallation =
        Boolean(viewer.installationTokenHash) &&
        viewer.installationTokenHash === target.installationTokenHash;
      return sameConnection || sameInstallation;
    });
  }

  private emitRelay(
    input: PublishNotificationInput,
    occurredAt: string,
    excludeInstallationIds: string[]
  ): void {
    const seatIds = this.options.getRelaySeatIds();
    if (seatIds.length === 0) {
      return;
    }

    for (const seatId of seatIds) {
      try {
        this.options.sendRelayControl(seatId, {
          kind: "push_publish",
          category: input.category,
          occurredAt,
          hostName: this.options.hostName,
          hostFingerprint: this.options.hostFingerprint,
          seatId,
          sessionId: input.sessionId ?? null,
          sessionTitle: input.sessionTitle ?? null,
          provider: input.provider ?? null,
          actionKind: input.actionKind ?? null,
          dedupeKey: input.dedupeKey,
          excludeInstallationIds
        });
      } catch (error) {
        const resolved =
          error instanceof Error ? error : new Error(String(error ?? "Unknown relay push failure"));
        this.options.onError?.(resolved, "relay");
      }
    }
  }
}
