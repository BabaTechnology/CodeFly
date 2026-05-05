import { nowIso, publicKeyFingerprint, type PairingBundle } from "./shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildDirectPublicUrl, normalizeDirectPublicHost } from "./config";
import {
  getGitBranchListSnapshot,
  getGitCommitDetailSnapshot,
  getGitCommitListSnapshot,
  getGitSummarySnapshot,
  GitWorkspaceError
} from "./git";
import type {
  GlobalConfigPatchInput,
  ProviderConfigManager,
  ProviderName,
  SessionConfigPatchInput
} from "./provider-config";

export function registerHostClientRoutes(context: Record<string, any>): void {
  const app = context.app as FastifyInstance;
  const {
    config,
    hostStore,
    identity,
    managerByName,
    providerConfigs,
    runtimeConfigStore,
    notificationPublisher,
    requireLoopbackRequest,
    isLoopbackRequest,
    listProviderCapabilities,
    listRelayBindingViews,
    relayBindingSummaryView,
    activeRelaySeatIds,
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
    refreshSessionListItems,
    requireConfigurableProvider,
    detectProviderAuthMode,
    resolveProviderSessionId,
    maybeReloadRuntime,
    maybeApplySessionConfig,
    resolveRoutingTargetForCreate,
    resolveRoutingTargetForSession,
    resolveDefaultProvider,
    sliceHistoryEntries,
    collectHostHardwareSnapshot,
    MAX_SESSION_LIST_LIMIT,
    MAX_SESSION_HISTORY_LIMIT,
    MAX_EDITABLE_TEXT_BYTES,
    MAX_UPLOAD_FILE_BYTES,
    MAX_UPLOAD_REQUEST_BODY_BYTES
  } = context;

  app.get("/health", async () => ({
    ok: true,
    hostId: identity.hostId,
    adapter: config.adapter,
    providers: listProviderCapabilities(),
    relaySeatId: activeRelaySeatIds()[0] ?? null,
    relaySeatIds: activeRelaySeatIds()
  }));

  app.get<{ Querystring: { sessionLimit?: string; includeSessions?: string } }>(
    "/api/host/overview",
    async (request) => {
      const sessionLimit = Math.min(
        Math.max(Number(request.query?.sessionLimit ?? "120"), 1),
        MAX_SESSION_LIST_LIMIT
      );
      const includeSessions = request.query?.includeSessions !== "false";
      return {
        health: {
          ok: true,
          hostId: identity.hostId,
          adapter: config.adapter,
          providers: listProviderCapabilities(),
          relaySeatId: activeRelaySeatIds()[0] ?? null,
          relaySeatIds: activeRelaySeatIds()
        },
        info: {
          hostId: identity.hostId,
          hostName: config.hostName,
          adapter: config.adapter,
          providers: listProviderCapabilities(),
          defaultProvider: resolveDefaultProvider(),
          bindHost: config.bindHost,
          bindHosts: config.bindHosts,
          port: config.port,
          transport: "tcp",
          directPublicUrl: config.directPublicUrl,
          serviceBaseUrl: hostStore.getServiceBaseUrl() ?? config.serviceBaseUrl ?? null,
          hostPublicKey: identity.keyPair.publicKey,
          hostPublicKeyFingerprint: identity.publicKeyFingerprint,
          platform: process.platform,
          pathSeparator: path.sep,
          userHomeDirectory: os.homedir(),
          defaultWorkspaceDirectory: config.defaultWorkspaceDir
        },
        sessions: includeSessions ? await refreshSessionListItems(undefined, sessionLimit) : []
      };
    }
  );

  app.get("/api/host/info", async () => ({
    hostId: identity.hostId,
    hostName: config.hostName,
    adapter: config.adapter,
    providers: listProviderCapabilities(),
    defaultProvider: resolveDefaultProvider(),
    bindHost: config.bindHost,
    bindHosts: config.bindHosts,
    port: config.port,
    transport: "tcp",
    directPublicUrl: config.directPublicUrl,
    serviceBaseUrl: hostStore.getServiceBaseUrl() ?? config.serviceBaseUrl ?? null,
    hostPublicKey: identity.keyPair.publicKey,
    hostPublicKeyFingerprint: identity.publicKeyFingerprint,
    platform: process.platform,
    pathSeparator: path.sep,
    userHomeDirectory: os.homedir(),
    defaultWorkspaceDirectory: config.defaultWorkspaceDir
  }));

  app.get("/api/host/hardware", async () => collectHostHardwareSnapshot());

  app.post<{ Body: { workspacePath?: string } }>(
    "/api/workspace/validate",
    async (request, reply) => {
      try {
        const workspacePath = await resolveSessionWorkspacePath(request.body?.workspacePath);
        return {
          ok: true,
          workspacePath
        };
      } catch (error) {
        return sendWorkspacePathError(reply, error);
      }
    }
  );

  app.get("/api/host/connections", async (request, reply) => {
    if (!requireLoopbackRequest(request, reply)) {
      return;
    }

    return {
      directDevices: hostStore.listPairedDevices(),
      relay: relayBindingSummaryView(),
      relayBindings: listRelayBindingViews()
    };
  });

  app.get<{ Querystring: { path?: string; rootPath?: string; includeFiles?: string } }>(
    "/api/filesystem/browse",
    async (request, reply) => {
      let currentPath: string;
      let rootPath: string | undefined;
      try {
        const resolved = resolveScopedPath(request.query?.path, request.query?.rootPath);
        currentPath = resolved.targetPath;
        rootPath = resolved.rootPath;
      } catch (error) {
        if (isWorkspacePathError(error)) {
          return sendWorkspacePathError(reply, error);
        }
        return reply.code(403).send({ error: "Path is outside the allowed root" });
      }
      try {
        await assertDirectoryAccessible(currentPath, { writable: false });
      } catch (error) {
        return sendWorkspacePathError(reply, error);
      }

      const includeFiles = request.query?.includeFiles === "true";
      const dirents = await readdir(currentPath, { withFileTypes: true });
      const entries = dirents
        .filter((entry) => includeFiles || entry.isDirectory())
        .map((entry) => ({
          name: entry.name,
          path: path.join(currentPath, entry.name),
          isDirectory: entry.isDirectory()
        }))
        .sort((left, right) => {
          if (left.isDirectory !== right.isDirectory) {
            return left.isDirectory ? -1 : 1;
          }
          return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
        });

      const parentPath = path.dirname(currentPath);
      const resolvedParentPath =
        parentPath === currentPath
          ? null
          : rootPath && !isPathWithinRoot(rootPath, parentPath)
            ? null
            : parentPath;
      return {
        currentPath,
        rootPath: rootPath ?? null,
        homePath: os.homedir(),
        parentPath: resolvedParentPath,
        pathSeparator: path.sep,
        entries
      };
    }
  );

  app.get<{ Querystring: { path?: string; rootPath?: string } }>("/api/filesystem/file", async (request, reply) => {
    let filePath: string;
    let rootPath: string | undefined;
    try {
      const resolved = resolveScopedPath(request.query?.path, request.query?.rootPath);
      filePath = resolved.targetPath;
      rootPath = resolved.rootPath;
    } catch (error) {
      if (isWorkspacePathError(error)) {
        return sendWorkspacePathError(reply, error);
      }
      return reply.code(403).send({ error: "Path is outside the allowed root" });
    }
    try {
      await assertFileExists(filePath);
      const fileStats = await stat(filePath);
      if (fileStats.size > MAX_EDITABLE_TEXT_BYTES) {
        return {
          path: filePath,
          name: path.basename(filePath),
          rootPath: rootPath ?? null,
          sizeBytes: fileStats.size,
          updatedAt: fileStats.mtime.toISOString(),
          access: buildWorkspaceFileAccess(false, "too_large")
        };
      }
      const contentBuffer = await readFile(filePath);
      if (!isLikelyUtf8Text(contentBuffer)) {
        return {
          path: filePath,
          name: path.basename(filePath),
          rootPath: rootPath ?? null,
          sizeBytes: fileStats.size,
          updatedAt: fileStats.mtime.toISOString(),
          access: buildWorkspaceFileAccess(false, "not_text")
        };
      }
      return {
        path: filePath,
        name: path.basename(filePath),
        rootPath: rootPath ?? null,
        content: contentBuffer.toString("utf8"),
        sizeBytes: fileStats.size,
        updatedAt: fileStats.mtime.toISOString(),
        access: buildWorkspaceFileAccess(true, "ok")
      };
    } catch {
      return reply.code(404).send({ error: "File not found" });
    }
  });

  app.put<{ Body: { path?: string; rootPath?: string; content?: string } }>(
    "/api/filesystem/file",
    async (request, reply) => {
      let filePath: string;
      try {
        filePath = resolveScopedPath(request.body?.path, request.body?.rootPath).targetPath;
      } catch (error) {
        if (isWorkspacePathError(error)) {
          return sendWorkspacePathError(reply, error);
        }
        return reply.code(403).send({ error: "Path is outside the allowed root" });
      }
      const content = typeof request.body?.content === "string" ? request.body.content : "";
      try {
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, content, "utf8");
        const fileStats = await stat(filePath);
        return {
          ok: true,
          path: filePath,
          sizeBytes: fileStats.size,
          updatedAt: fileStats.mtime.toISOString()
        };
      } catch {
        return reply.code(500).send({ error: "Failed to save file" });
      }
    }
  );

  app.delete<{ Querystring: { path?: string; rootPath?: string } }>(
    "/api/filesystem/file",
    async (request, reply) => {
      let filePath: string;
      try {
        filePath = resolveScopedPath(request.query?.path, request.query?.rootPath).targetPath;
      } catch (error) {
        if (isWorkspacePathError(error)) {
          return sendWorkspacePathError(reply, error);
        }
        return reply.code(403).send({ error: "Path is outside the allowed root" });
      }
      try {
        await assertFileExists(filePath);
        await unlink(filePath);
        return { ok: true };
      } catch {
        return reply.code(404).send({ error: "File not found" });
      }
    }
  );

  app.post<{
    Body: { directoryPath?: string; rootPath?: string; fileName?: string; contentBase64?: string };
  }>("/api/filesystem/upload", { bodyLimit: MAX_UPLOAD_REQUEST_BODY_BYTES }, async (request, reply) => {
    let directoryPath: string;
    try {
      directoryPath = resolveScopedPath(
        request.body?.directoryPath,
        request.body?.rootPath
      ).targetPath;
    } catch (error) {
      if (isWorkspacePathError(error)) {
        return sendWorkspacePathError(reply, error);
      }
      return reply.code(403).send({ error: "Path is outside the allowed root" });
    }
    const rawFileName = typeof request.body?.fileName === "string" ? request.body.fileName.trim() : "";
    const fileName = path.basename(rawFileName);
    const contentBase64 =
      typeof request.body?.contentBase64 === "string" ? request.body.contentBase64 : "";

    if (!fileName || !contentBase64) {
      return reply.code(400).send({ error: "Missing file payload" });
    }

    try {
      const fileBuffer = Buffer.from(contentBase64, "base64");
      if (fileBuffer.byteLength > MAX_UPLOAD_FILE_BYTES) {
        return reply.code(413).send({ error: "File exceeds 10 MB limit" });
      }
      await mkdir(directoryPath, { recursive: true });
      await assertDirectoryExists(directoryPath);
      const targetPath = path.join(directoryPath, fileName);
      await writeFile(targetPath, fileBuffer);
      const fileStats = await stat(targetPath);
      return {
        ok: true,
        path: targetPath,
        name: fileName,
        sizeBytes: fileStats.size,
        updatedAt: fileStats.mtime.toISOString()
      };
    } catch {
      return reply.code(500).send({ error: "Failed to upload file" });
    }
  });

  app.get<{ Querystring: { workspacePath?: string } }>("/api/git/summary", async (request, reply) => {
    const workspacePath = resolveWorkspacePath(request.query?.workspacePath);
    try {
      return await getGitSummarySnapshot(workspacePath);
    } catch (error) {
      if (error instanceof GitWorkspaceError) {
        if (error.code === "git_not_installed") {
          return {
            workspacePath,
            repoRoot: null,
            gitInstalled: false,
            isGitRepository: false,
            head: null,
            currentBranch: null,
            detachedHead: false,
            upstream: null,
            ahead: 0,
            behind: 0,
            statusCounts: { staged: 0, unstaged: 0, untracked: 0 },
            changedFiles: []
          };
        }
      }
      return reply.code(500).send({ error: "Failed to read git summary" });
    }
  });

  app.get<{ Querystring: { workspacePath?: string } }>("/api/git/branches", async (request, reply) => {
    const workspacePath = resolveWorkspacePath(request.query?.workspacePath);
    try {
      return await getGitBranchListSnapshot(workspacePath);
    } catch (error) {
      if (error instanceof GitWorkspaceError && error.code === "git_not_installed") {
        return {
          workspacePath,
          repoRoot: null,
          gitInstalled: false,
          isGitRepository: false,
          branches: []
        };
      }
      return reply.code(500).send({ error: "Failed to read git branches" });
    }
  });

  app.get<{ Querystring: { workspacePath?: string; limit?: string; before?: string } }>(
    "/api/git/commits",
    async (request, reply) => {
      const workspacePath = resolveWorkspacePath(request.query?.workspacePath);
      const limit = Math.min(Math.max(Number(request.query?.limit ?? "50"), 1), 100);
      try {
        return await getGitCommitListSnapshot(workspacePath, limit, request.query?.before);
      } catch (error) {
        if (error instanceof GitWorkspaceError && error.code === "git_not_installed") {
          return {
            workspacePath,
            repoRoot: null,
            gitInstalled: false,
            isGitRepository: false,
            commits: [],
            nextCursor: null
          };
        }
        return reply.code(500).send({ error: "Failed to read git commits" });
      }
    }
  );

  app.get<{ Params: { commitId: string }; Querystring: { workspacePath?: string } }>(
    "/api/git/commits/:commitId",
    async (request, reply) => {
      const workspacePath = resolveWorkspacePath(request.query?.workspacePath);
      try {
        return await getGitCommitDetailSnapshot(workspacePath, request.params.commitId);
      } catch (error) {
        if (error instanceof GitWorkspaceError && error.code === "not_git_repository") {
          return reply.code(400).send({ error: "Current workspace is not a git repository" });
        }
        if (error instanceof GitWorkspaceError && error.code === "git_not_installed") {
          return reply.code(400).send({ error: "git is not installed" });
        }
        return reply.code(500).send({ error: "Failed to read git commit detail" });
      }
    }
  );

  app.get("/api/direct/paired-devices", async () => ({
    devices: hostStore.listPairedDevices()
  }));

  app.delete<{ Params: { deviceId: string } }>(
    "/api/direct/paired-devices/:deviceId",
    async (request, reply) => {
      if (!requireLoopbackRequest(request, reply)) {
        return;
      }

      return {
        ok: hostStore.removePairedDevice(request.params.deviceId)
      };
    }
  );

  app.post<{ Body: { ttlSeconds?: number; publicHost?: string } }>(
    "/api/direct/pairings/issue",
    async (request, reply) => {
      if (!isLoopbackRequest(request)) {
        throw new Error("This endpoint is only available from localhost");
      }
      const ttlSeconds = Math.min(Math.max(request.body?.ttlSeconds ?? 300, 60), 1800);
      let publicHost = config.directPublicHost;
      if (request.body?.publicHost) {
        try {
          publicHost = normalizeDirectPublicHost(request.body.publicHost);
        } catch (error) {
          return reply.code(400).send({
            error: error instanceof Error ? error.message : "Invalid public host"
          });
        }
      }
      const directUrl = buildDirectPublicUrl(publicHost, config.port);
      const issued = hostStore.issuePairingCode(ttlSeconds, nowIso(), directUrl);
      const bundle: PairingBundle = {
        hostId: identity.hostId,
        hostName: config.hostName,
        directUrl,
        hostPublicKey: identity.keyPair.publicKey,
        hostPublicKeyFingerprint: publicKeyFingerprint(identity.keyPair.publicKey),
        pairingCode: issued.code,
        expiresAt: issued.expiresAt
      };

      return bundle;
    }
  );

  app.get<{ Params: { provider: string } }>(
    "/api/runtime/providers/:provider",
    async (request, reply) => {
      const provider = requireConfigurableProvider(request.params.provider, reply);
      if (!provider) {
        return reply;
      }
      return runtimeConfigStore.getProviderSnapshot(
        provider,
        config,
        detectProviderAuthMode(provider)
      );
    }
  );

  app.get<{
    Params: { provider: string };
    Querystring: { force?: string };
  }>("/api/runtime/providers/:provider/metadata", async (request, reply) => {
    const provider = requireConfigurableProvider(request.params.provider, reply);
    if (!provider) {
      return reply;
    }
    const manager = managerByName.get(provider);
    if (!manager) {
      return reply.code(404).send({ error: "Provider manager is unavailable" });
    }

    const metadata = await manager.getRuntimeMetadata({
      force: request.query?.force === "true"
    });
    if (!metadata) {
      return reply.code(404).send({ error: "Provider runtime metadata is unavailable" });
    }
    return {
      ...metadata,
      authMode: detectProviderAuthMode(provider)
    };
  });

  app.patch<{
    Params: { provider: string };
    Body: { values?: Record<string, unknown> };
  }>("/api/runtime/providers/:provider", async (request, reply) => {
    const provider = requireConfigurableProvider(request.params.provider, reply);
    if (!provider) {
      return reply;
    }
    const values = request.body?.values ?? {};
    const previousCodexProviderName = config.codex.providerName;
    runtimeConfigStore.patchProvider(provider, values, config);
    syncRuntimeValuesToProviderConfig(provider, values, providerConfigs, config, previousCodexProviderName);
    const reloaded = await maybeReloadRuntime(provider, true);
    return {
      ...runtimeConfigStore.getProviderSnapshot(
      provider,
      config,
      detectProviderAuthMode(provider)
      ),
      reloaded
    };
  });

  app.get<{ Params: { provider: string } }>(
    "/api/config/providers/:provider/global",
    async (request, reply) => {
      const provider = requireConfigurableProvider(request.params.provider, reply);
      if (!provider) {
        return reply;
      }
      return providerConfigs.getGlobalSnapshot(provider);
    }
  );

  app.patch<{
    Params: { provider: string };
    Body: GlobalConfigPatchInput;
  }>("/api/config/providers/:provider/global", async (request, reply) => {
    const provider = requireConfigurableProvider(request.params.provider, reply);
    if (!provider) {
      return reply;
    }
    const snapshot = providerConfigs.patchGlobal(provider, request.body ?? {});
    const reloaded = await maybeReloadRuntime(provider, request.body?.reloadRuntime);
    return {
      ...snapshot,
      reloaded
    };
  });

  app.post<{ Params: { provider: string } }>(
    "/api/config/providers/:provider/global/reload",
    async (request, reply) => {
      const provider = requireConfigurableProvider(request.params.provider, reply);
      if (!provider) {
        return reply;
      }
      return {
        ok: true,
        reloaded: await maybeReloadRuntime(provider, true)
      };
    }
  );

  app.get<{ Params: { provider: string; sessionId: string } }>(
    "/api/config/providers/:provider/sessions/:sessionId",
    async (request, reply) => {
      const provider = requireConfigurableProvider(request.params.provider, reply);
      if (!provider) {
        return reply;
      }
      return providerConfigs.getSessionSnapshot(
        provider,
        resolveProviderSessionId(provider, request.params.sessionId)
      );
    }
  );

  app.patch<{
    Params: { provider: string; sessionId: string };
    Body: SessionConfigPatchInput;
  }>("/api/config/providers/:provider/sessions/:sessionId", async (request, reply) => {
    const provider = requireConfigurableProvider(request.params.provider, reply);
    if (!provider) {
      return reply;
    }
    const resolvedSessionId = resolveProviderSessionId(provider, request.params.sessionId);
    const snapshot = providerConfigs.patchSession(provider, resolvedSessionId, request.body ?? {});
    const applied = await maybeApplySessionConfig(
      provider,
      resolvedSessionId,
      request.body?.applyImmediately
    );
    return {
      ...snapshot,
      applied
    };
  });

  app.delete<{ Params: { provider: string; sessionId: string } }>(
    "/api/config/providers/:provider/sessions/:sessionId",
    async (request, reply) => {
      const provider = requireConfigurableProvider(request.params.provider, reply);
      if (!provider) {
        return reply;
      }
      const resolvedSessionId = resolveProviderSessionId(provider, request.params.sessionId);
      providerConfigs.clearSession(provider, resolvedSessionId);
      const applied = await maybeApplySessionConfig(provider, resolvedSessionId, true);
      return { ok: true, applied };
    }
  );

  app.get(
    "/api/sessions",
    async (request: FastifyRequest<{ Querystring: { adapter?: string; limit?: string } }>) => {
      const limit = Math.min(
        Math.max(Number(request.query?.limit ?? "100"), 1),
        MAX_SESSION_LIST_LIMIT
      );
      const adapterFilter = request.query?.adapter;
      return {
        sessions: await refreshSessionListItems(adapterFilter, limit)
      };
    }
  );

  app.post<{ Body: { workspacePath?: string; provider?: string } }>(
    "/api/sessions",
    async (request, reply) => {
      let workspacePath: string;
      try {
        workspacePath = await resolveSessionWorkspacePath(request.body?.workspacePath);
      } catch (error) {
        return sendWorkspacePathError(reply, error);
      }
      const target = await resolveRoutingTargetForCreate(request.body?.provider);
      const session = await target.manager.startSession(workspacePath);
      const snapshot = await target.manager.getSessionSnapshot(session.id, 100);
      return {
        session,
        snapshot: snapshot ?? null
      };
    }
  );

  app.post<{
    Params: { sessionId: string };
    Body: { provider?: string };
  }>("/api/sessions/:sessionId/attach", async (request) => {
    const target = await resolveRoutingTargetForSession(
      request.params.sessionId,
      request.body?.provider
    );
    const attachedSession = await target.manager.attachSession(request.params.sessionId);
    const session = target.manager.markSessionRead(attachedSession.id) ?? attachedSession;
    const snapshot = await target.manager.getSessionSnapshot(session.id, 100);
    return {
      session,
      snapshot: snapshot ?? null
    };
  });

  app.post<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/read",
    async (request, reply) => {
      try {
        const target = await resolveRoutingTargetForSession(request.params.sessionId);
        const session = target.manager.markSessionRead(request.params.sessionId);
        if (!session) {
          return reply.code(404).send({ error: "Session not found" });
        }
        return {
          ok: true,
          session
        };
      } catch {
        return reply.code(404).send({ error: "Session not found" });
      }
    }
  );

  app.get<{ Params: { sessionId: string }; Querystring: { limit?: string } }>(
    "/api/sessions/:sessionId",
    async (request, reply) => {
      try {
        const target = await resolveRoutingTargetForSession(request.params.sessionId);
        const snapshot = await target.manager.getSessionSnapshot(
          request.params.sessionId,
          Number(request.query?.limit ?? "100")
        );
        if (!snapshot) {
          return reply.code(404).send({ error: "Session not found" });
        }
        return snapshot;
      } catch {
        return reply.code(404).send({ error: "Session not found" });
      }
    }
  );

  app.get<{ Params: { sessionId: string }; Querystring: { limit?: string } }>(
    "/api/sessions/:sessionId/events",
    async (request, reply) => {
      try {
        const target = await resolveRoutingTargetForSession(request.params.sessionId);
        const resolvedSessionId = target.manager.resolveSessionId(request.params.sessionId);
        return {
          sessionId: resolvedSessionId,
          events: target.manager.listSessionEvents(
            resolvedSessionId,
            Number(request.query?.limit ?? "100")
          )
        };
      } catch {
        return reply.code(404).send({ error: "Session not found" });
      }
    }
  );

  app.patch<{
    Params: { sessionId: string };
    Body: { title?: string };
  }>("/api/sessions/:sessionId/title", async (request, reply) => {
    const nextTitle = request.body?.title?.trim() ?? "";
    if (!nextTitle) {
      return reply.code(400).send({ error: "Session title is required" });
    }

    try {
      const target = await resolveRoutingTargetForSession(request.params.sessionId);
      const session = await target.manager.renameSessionTitle(request.params.sessionId, nextTitle);
      const snapshot = await target.manager.getSessionSnapshot(session.id, 100);
      return {
        session,
        snapshot: snapshot ?? null
      };
    } catch {
      return reply.code(404).send({ error: "Session not found" });
    }
  });

  app.get<{
    Params: { sessionId: string };
    Querystring: {
      limit?: string;
      dialogueLimit?: string;
      loadAll?: string;
      beforeTimestamp?: string;
      afterTimestamp?: string;
    };
  }>(
    "/api/sessions/:sessionId/history",
    async (request, reply) => {
      try {
        const target = await resolveRoutingTargetForSession(request.params.sessionId);
        const loadAll = request.query?.loadAll === "true";
        const dialogueLimit = Number(request.query?.dialogueLimit ?? "");
        const entryLimit = Math.min(
          Math.max(Number(request.query?.limit ?? "200"), 1),
          MAX_SESSION_HISTORY_LIMIT
        );
        const history = await target.manager.getSessionHistory(
          request.params.sessionId,
          MAX_SESSION_HISTORY_LIMIT
        );
        if (!history) {
          return reply.code(404).send({ error: "Session history not found" });
        }
        const sliced = sliceHistoryEntries(history, {
          limit: entryLimit,
          dialogueLimit: Number.isFinite(dialogueLimit) ? dialogueLimit : undefined,
          loadAll,
          beforeTimestamp: request.query?.beforeTimestamp,
          afterTimestamp: request.query?.afterTimestamp
        });
        if (!sliced) {
          return reply.code(404).send({ error: "Session history not found" });
        }
        request.log.info(
          {
            sessionId: request.params.sessionId,
            historyQuery: {
              limit: request.query?.limit ?? null,
              dialogueLimit: request.query?.dialogueLimit ?? null,
              loadAll,
              beforeTimestamp: request.query?.beforeTimestamp ?? null,
              afterTimestamp: request.query?.afterTimestamp ?? null
            },
            historyResult: {
              entryCount: sliced.entries.length,
              range: sliced.range
            }
          },
          "session history response"
        );
        return sliced;
      } catch {
        return reply.code(404).send({ error: "Session history not found" });
      }
    }
  );

  app.post<{ Params: { sessionId: string }; Body: { text?: string } }>(
    "/api/sessions/:sessionId/input",
    async (request) => {
      const directTarget = getDirectRequestTarget(request, request.params.sessionId);
      if (directTarget?.installationTokenHash) {
        notificationPublisher.rememberDirectSessionTarget({
          connectionKey: directTarget.connectionKey,
          sessionId: request.params.sessionId,
          installationTokenHash: directTarget.installationTokenHash
        });
      }
      const target = await resolveRoutingTargetForSession(request.params.sessionId);
      const text = request.body?.text?.trim() ?? "";
      const session = await target.manager.sendInput(request.params.sessionId, text);
      target.manager.markSessionRead(session.id, nowIso(), { broadcast: false });
      const snapshot = await target.manager.getSessionSnapshot(session.id, 100);
      return {
        session,
        snapshot: snapshot ?? null
      };
    }
  );

  app.post<{
    Params: { sessionId: string };
    Body: { approvalId: string; decision: "approve" | "deny" };
  }>("/api/sessions/:sessionId/approval", async (request) => {
    const directTarget = getDirectRequestTarget(request, request.params.sessionId);
    if (directTarget?.installationTokenHash) {
      notificationPublisher.rememberDirectSessionTarget({
        connectionKey: directTarget.connectionKey,
        sessionId: request.params.sessionId,
        installationTokenHash: directTarget.installationTokenHash
      });
    }
    const target = await resolveRoutingTargetForSession(request.params.sessionId);
    await target.manager.respondToApproval(
      request.params.sessionId,
      String(request.body?.approvalId ?? ""),
      request.body?.decision === "approve" ? "approve" : "deny"
    );
    const snapshot = await target.manager.getSessionSnapshot(request.params.sessionId, 100);
    return {
      ok: true,
      snapshot: snapshot ?? null
    };
  });

  app.post<{
    Params: { sessionId: string };
    Body: { choiceId: string; answers?: Array<{ fieldId: string; value: unknown }> };
  }>("/api/sessions/:sessionId/choice", async (request) => {
    const directTarget = getDirectRequestTarget(request, request.params.sessionId);
    if (directTarget?.installationTokenHash) {
      notificationPublisher.rememberDirectSessionTarget({
        connectionKey: directTarget.connectionKey,
        sessionId: request.params.sessionId,
        installationTokenHash: directTarget.installationTokenHash
      });
    }
    const target = await resolveRoutingTargetForSession(request.params.sessionId);
    const answers = Array.isArray(request.body?.answers)
      ? request.body.answers.map((answer) => ({
          fieldId: String(answer.fieldId ?? ""),
          value:
            typeof answer.value === "string" ||
            typeof answer.value === "number" ||
            typeof answer.value === "boolean" ||
            answer.value === null ||
            (Array.isArray(answer.value) && answer.value.every((item) => typeof item === "string"))
              ? (answer.value as string | number | boolean | string[] | null)
              : null
        }))
      : [];

    await target.manager.respondToChoice(
      request.params.sessionId,
      String(request.body?.choiceId ?? ""),
      answers
    );
    const snapshot = await target.manager.getSessionSnapshot(request.params.sessionId, 100);
    return {
      ok: true,
      snapshot: snapshot ?? null
    };
  });

  app.post<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/resume",
    async (request) => {
      const target = await resolveRoutingTargetForSession(request.params.sessionId);
      await target.manager.resumeSession(request.params.sessionId);
      const snapshot = await target.manager.getSessionSnapshot(request.params.sessionId, 100);
      return {
        ok: true,
        snapshot: snapshot ?? null
      };
    }
  );

  app.post<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/interrupt",
    async (request) => {
      const target = await resolveRoutingTargetForSession(request.params.sessionId);
      await target.manager.interruptSession(request.params.sessionId);
      const snapshot = await target.manager.getSessionSnapshot(request.params.sessionId, 100);
      return {
        ok: true,
        snapshot: snapshot ?? null
      };
    }
  );
}

function syncRuntimeValuesToProviderConfig(
  provider: ProviderName,
  values: Record<string, unknown>,
  providerConfigs: ProviderConfigManager,
  config: Record<string, any>,
  previousCodexProviderName: string
): void {
  if (provider === "codex") {
    const set: Record<string, unknown> = {};
    const unset: string[] = [];
    const codex = config.codex as Record<string, any>;
    const providerName = String(codex.providerName ?? "openai");

    if (
      hasOwn(values, "providerName") ||
      hasOwn(values, "baseUrl") ||
      providerName !== previousCodexProviderName
    ) {
      set.model_provider = providerName;
      set.model_providers = {
        [providerName]: {
          name: providerName,
          base_url: String(codex.baseUrl ?? ""),
          wire_api: "responses",
          requires_openai_auth: true,
          env_key: "OPENAI_API_KEY"
        }
      };
      if (previousCodexProviderName && previousCodexProviderName !== providerName) {
        unset.push(`model_providers.${previousCodexProviderName}`);
      }
    }

    if (hasOwn(values, "model")) {
      set.model = codex.model;
    }
    if (hasOwn(values, "reasoningEffort")) {
      if (codex.reasoningEffort) {
        set.model_reasoning_effort = codex.reasoningEffort;
      } else {
        unset.push("model_reasoning_effort", "reasoning_effort");
      }
    }
    if (hasOwn(values, "approvalPolicy")) {
      set.approval_policy = codex.approvalPolicy;
    }
    if (hasOwn(values, "approvalsReviewer")) {
      set.approvals_reviewer = codex.approvalsReviewer;
    }
    if (hasOwn(values, "sandbox")) {
      set.sandbox_mode = codex.sandbox;
    }

    if (Object.keys(set).length > 0 || unset.length > 0) {
      providerConfigs.patchGlobal("codex", {
        documents: {
          config: {
            set,
            unset
          }
        }
      });
    }
    return;
  }

  const claude = config.claude as Record<string, any>;
  const settingsSet: Record<string, unknown> = {};
  const settingsUnset: string[] = [];

  if (hasOwn(values, "model")) {
    settingsSet.model = claude.model;
  }
  if (hasOwn(values, "permissionMode")) {
    settingsSet.defaultMode = claude.permissionMode;
    settingsSet.permissionMode = claude.permissionMode;
  }
  if (hasOwn(values, "reasoningEffort")) {
    if (claude.reasoningEffort) {
      settingsSet.env = {
        CLAUDE_CODE_EFFORT_LEVEL: claude.reasoningEffort
      };
    } else {
      settingsUnset.push("env.CLAUDE_CODE_EFFORT_LEVEL");
    }
  }

  if (Object.keys(settingsSet).length > 0 || settingsUnset.length > 0) {
    providerConfigs.patchGlobal("claude", {
      documents: {
        settings: {
          set: settingsSet,
          unset: settingsUnset
        }
      }
    });
  }
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
