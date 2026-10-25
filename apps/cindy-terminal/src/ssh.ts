import { terminalNodeExecutable } from './version.js';
import path from "node:path";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { statSync } from "node:fs";
import { createCcManagerInstall } from "@cindy/app-runtime/cc-manager-install";
import { createPiManagerClient } from "@cindy/app-runtime/pi-manager-client";
import { createPiRemoteTransport } from "@cindy/app-runtime/pi-remote-transport";
import { createSshPiHost } from "@cindy/app-runtime/sshPiHost";
import { createSshCodexHost } from "@cindy/app-runtime/sshCodexHost";
import { listSshCodexProviders } from "@cindy/app-runtime/sshCodexModelReader";
import { readSshCodexModelList } from "@cindy/app-runtime/sshCodexModelList";
import { createSshHostPrefs } from "@cindy/app-runtime/ssh-host-prefs-store";
import { createAgentProxyTunnelKeeper } from "@cindy/app-runtime/agent-proxy-tunnel";
import { createAgentProxy } from "@cindy/app-runtime/agent-proxy";
import { createSshAgentInstaller } from "@cindy/app-runtime/sshAgentInstaller";
import { prepareRemoteAgentInstall } from "@cindy/app-runtime/codex-install-lifecycle";
import {
  statRemotePath,
  listRemoteDir,
  mkdirPRemote,
} from "@cindy/app-runtime/sshPaths";
import { RemoteFileBrowserManager } from "@cindy/app-runtime/remoteFileBrowser";
import { createRemoteFileCache } from "@cindy/app-runtime/remoteFileCache";
import { createSshMedia } from "@cindy/app-runtime/sshMedia";
import { CodexAgent, type Logger, type AuthAdapter } from "@cindy/maker-core";
import {
  ConnectionPool,
  RemoteHost,
  FileHostKeyStore,
  installRemoteAgent,
  probeRemoteAgent,
  defaultSshConfigPath,
  defaultManagedSshConfigPath,
  readSshConfigDetailed,
  addManagedHostWithInclude,
  updateManagedHostFields,
  removeManagedHost,
  installFileServiceBundle,
  REMOTE_INSTALL_ROOT,
  probeFileService,
  type HostConfig,
  type ReadSshConfigResult,
} from "@cindy/maker-remote-ssh";
import type { InvocationContext } from "./contracts.js";
import type { RemoteResourceRegistry } from "@cindy/device-link";
import { privateDirectory } from "./platform.js";

const text = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim() || /[\r\n\0]/.test(value))
    throw new Error("INVALID_SSH_ARGUMENT");
  return value.trim();
};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_SSH_ARGUMENT");
  return value as Record<string, unknown>;
};

/** One OpenSSH configuration graph and the existing host-key/authentication rules. */
export class TerminalSshService {
  readonly pool: ConnectionPool;
  readonly files: RemoteFileBrowserManager;
  readonly cache: ReturnType<typeof createRemoteFileCache>;
  readonly media: ReturnType<typeof createSshMedia>;
  readonly preferences: ReturnType<typeof createSshHostPrefs>;
  readonly agentProxy: ReturnType<typeof createAgentProxy>;
  readonly managers: ReturnType<typeof createCcManagerInstall>;
  readonly piManager: ReturnType<typeof createPiManagerClient>;
  readonly piTransport: ReturnType<typeof createPiRemoteTransport>;
  readonly pi: ReturnType<typeof createSshPiHost>;
  readonly codex: ReturnType<typeof createSshCodexHost>;
  private readonly codexReaders = new Map<string, CodexAgent>();
  readonly installer: ReturnType<typeof createSshAgentInstaller>;
  private hasLiveTurn: (hostId: string) => boolean = () => true;
  private discovery?: ReadSshConfigResult;
  private pending: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(
    private profileDir: string,
    emit: (channel: string, payload: unknown) => void,
    private options: {
      logger: Logger;
      runtimeDirectory: string;
      ownerScope(): string;
      assertCurrent(): void;
    },
  ) {
    const hostKeys = new FileHostKeyStore(
      path.join(profileDir, "ssh-known-hosts.json"),
    );
    this.pool = new ConnectionPool({
      hostKeys,
      logger: options.logger,
    });
    this.preferences = createSshHostPrefs({
      userDataDirectory: () => profileDir,
      logger: options.logger,
    });
    this.agentProxy = createAgentProxy({
      ...createAgentProxyTunnelKeeper(),
      logger: options.logger,
      getSshHostAgentProxy: this.preferences.getSshHostAgentProxy,
    });
    this.agentProxy.setAgentProxyLiveTurnChecker((id) => this.hasLiveTurn(id));
    this.agentProxy.initAgentProxy({
      createTunnelHost: (config) =>
        new RemoteHost(config, { hostKeys, logger: options.logger }),
      getMainHost: (id) => this.pool.get(id) ?? null,
      broadcast: (id) => {
        const value = this.pool.get(id);
        if (value)
          emit("maker:remote-ssh:status-changed", this.snapshot(value));
      },
    });
    this.pool.onAnyStatus((snapshot) => {
      emit(
        "maker:remote-ssh:status-changed",
        this.snapshot(this.pool.get(snapshot.config.id)!),
      );
      if (this.closed) return;
      const value = this.pool.get(snapshot.config.id);
      if (value?.getStatus() === "ready")
        void this.agentProxy.applyAgentProxyForHost(value);
      else this.agentProxy.handleAgentProxyMainHostDown(snapshot.config.id);
    });
    const bundle = (name: string, optional = false) => {
      const file = path.join(options.runtimeDirectory, name);
      try {
        const value = statSync(file);
        if (value.isFile() && value.size) return file;
      } catch {}
      if (optional) return null;
      throw new Error(`SSH_RUNTIME_BUNDLE_MISSING: ${name}`);
    };
    const silent = (payload: unknown) =>
      emit("maker:remote-ssh:silent-install-status", payload);
    this.managers = createCcManagerInstall({
      logger: options.logger,
      resolveCcManagerBundlePath: () => bundle("cc-mgr.mjs")!,
      resolveProxyBundlePath: () => bundle("proxy.mjs", true),
      broadcastCcMgrUpgradeAvailable: (payload) =>
        emit("maker:remote-ssh:cc-mgr-upgrade-available", payload),
      broadcastSilentInstallStatus: silent,
    });
    this.piManager = createPiManagerClient({
      ...this.managers,
      resolvePiManagerBundlePath: () => bundle("pi-manager.mjs")!,
    });
    this.piTransport = createPiRemoteTransport(this.piManager);
    this.codex = createSshCodexHost({
      getRemoteSshPool: () => this.pool,
      desktopMakerLogger: options.logger,
      reconcileCodexAgentProxyEnv: this.agentProxy.reconcileCodexAgentProxyEnv,
    });
    this.pi = createSshPiHost({
      ...this.piTransport,
      ...this.piManager,
      getRemoteSshPool: () => this.pool,
      desktopMakerLogger: options.logger,
      broadcastSilentInstallStatus: silent,
      getRemoteAgentProxyEnv: this.agentProxy.getRemoteAgentProxyEnv,
    });
    this.installer = createSshAgentInstaller({
      getPool: () => this.pool,
      log: options.logger,
      broadcastSilentInstallStatus: silent,
      broadcastInstallProgress: (payload) =>
        emit("maker:remote-ssh:install-progress", payload),
      installRemoteAgent: async (host, kind, progress) => {
        this.assertCurrent();
        await prepareRemoteAgentInstall(kind, {
          isInstalled: async () =>
            (await probeRemoteAgent(host, "codex")).installed,
          hasLiveTurn: () => this.hasLiveTurn(host.id),
          stopDaemon: () => this.agentProxy.killRemoteCodexDaemon(host),
        });
        this.assertCurrent();
        return installRemoteAgent(host, kind, progress);
      },
    });
    const host = (id: string) => {
      this.assertCurrent();
      const value = this.pool.get(id);
      if (!value) throw new Error("SSH_HOST_NOT_FOUND");
      return value;
    };
    this.files = new RemoteFileBrowserManager({
      logger: options.logger,
      ensureHostReady: async (id) => {
        this.assertCurrent();
        if (!this.pool.get(id)) await this.reload();
        if (host(id).getStatus() !== "ready") await this.pool.connect(id);
        this.assertCurrent();
      },
      getHost: host,
      probe: (id) => probeFileService(host(id)),
      install: async (id) => {
        const bundlePath = path.join(
          options.runtimeDirectory,
          "file-service.mjs",
        );
        const bundle = await stat(bundlePath);
        if (!bundle.isFile() || !bundle.size)
          throw new Error("FILE_SERVICE_BUNDLE_MISSING");
        const result = await installFileServiceBundle(host(id), { bundlePath });
        this.assertCurrent();
        return result;
      },
    });
    this.cache = createRemoteFileCache({
      userDataDirectory: () => profileDir,
      activeOwnerScopeKey: () =>
        this.closed ? "closed" : options.ownerScope(),
      dataOwnerStorageKey: (id) =>
        createHash("sha256").update(id).digest("hex").slice(0, 20),
      logger: options.logger,
    });
    this.media = createSshMedia({
      logger: options.logger,
      fetchToCache: this.cache.fetchRemoteFileToCache,
      request: async (id, method, params) => {
        const value = await this.files.request(id, method, params as never, {
          beforeSend: () => this.assertCurrent(),
        });
        this.assertCurrent();
        return value as never;
      },
    });
  }
  private assertCurrent() {
    if (this.closed) throw new Error("SERVICE_STOPPING");
    this.options.assertCurrent();
  }
  private snapshot(host: RemoteHost) {
    return {
      ...host.snapshot(),
      ...this.preferences.readSshHostPrefs()[host.id],
      agentProxyTunnel: this.agentProxy.getAgentProxyTunnelState(host.id),
    };
  }
  setLiveTurnChecker(check: (hostId: string) => boolean) {
    this.hasLiveTurn = check;
  }
  async getHydratedPool() {
    this.assertCurrent();
    if (!this.discovery) await this.reload();
    this.assertCurrent();
    return this.pool;
  }
  async ensureHostReady(hostId: string) {
    this.assertCurrent();
    if (!this.pool.get(hostId)) await this.reload();
    const host = this.pool.get(hostId);
    if (!host) throw new Error("SSH_HOST_NOT_FOUND");
    if (host.getStatus() !== "ready") await this.pool.connect(hostId);
    this.assertCurrent();
    return host;
  }
  async statPath(hostId: string, inputPath: string) {
    const result = await statRemotePath(
      await this.ensureHostReady(hostId),
      inputPath,
    );
    this.assertCurrent();
    return result;
  }
  /** The native remote login owns this auth boundary. Never read local tokens
   * or ask the controller's CLI whether a different SSH host is logged in. */
  codexAuth(hostId: string): AuthAdapter {
    return {
      getState: async () => {
        this.assertCurrent();
        const host = this.pool.get(hostId);
        if (!host || host.getStatus() !== "ready")
          return { authenticated: false, errorReason: "ssh_not_connected" };
        const state = await host.exec(
          `export CODEX_HOME="${REMOTE_INSTALL_ROOT}/codex-home"; "$CODEX_HOME/packages/standalone/current/codex" login status >/dev/null 2>&1`,
          { timeoutMs: 15_000, label: "codex-login-status" },
        );
        this.assertCurrent();
        if (this.pool.get(hostId) !== host || host.getStatus() !== "ready")
          throw new Error("SSH_AUTH_REQUEST_STALE");
        return { authenticated: state.exitCode === 0, ...(state.exitCode === 0 ? { authSource: "oauth" as const } : { errorReason: "remote_native_login_required" }) };
      },
      getAuthEnv: async () => ({}),
      triggerLogin: async () => { throw new Error("USE_REMOTE_NATIVE_CLI_LOGIN"); },
      logout: async () => { throw new Error("USE_REMOTE_NATIVE_CLI_LOGOUT"); },
    };
  }
  async codexProviders(hostId: string) {
    this.assertCurrent();
    return listSshCodexProviders(hostId, {
      getActiveAppSession: () => { this.assertCurrent(); return { generation: this.options.ownerScope() }; },
      getRemoteSshPool: () => this.pool,
      ensureRemoteAgentInstalledOrInstall: (id, kind) => this.installer.ensureRemoteAgentInstalledOrInstall(id, kind),
      getAgent: () => {
        this.assertCurrent();
        let agent = this.codexReaders.get(hostId);
        if (!agent) {
          agent = new CodexAgent({ ...this.codex, binaryPath: terminalNodeExecutable(), logger: this.options.logger,
            runtimeConfig: {}, auth: this.codexAuth(hostId) });
          this.codexReaders.set(hostId, agent);
        }
        return agent;
      },
    });
  }
  async ensureAgentReady(
    hostId: string,
    kind: import("@cindy/maker-core").AgentKind,
  ) {
    const host = await this.ensureHostReady(hostId);
    if (kind === "claude-code")
      await this.managers.ensureCcManagerInstalledOrInstall({ host });
    else await this.installer.ensureRemoteAgentInstalledOrInstall(hostId, kind);
    this.assertCurrent();
    return host;
  }
  async forwardRuntimeEndpoint(hostId: string, localUrl: string) {
    this.assertCurrent();
    const host = this.pool.get(hostId);
    if (!host) throw new Error("SSH_HOST_NOT_FOUND");
    const local = new URL(localUrl);
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(local.hostname) ||
      !Number(local.port)
    )
      throw new Error("SSH_RUNTIME_ENDPOINT_INVALID");
    const forward = await host.ensureRemoteForward({
      localHost: local.hostname.replace(/^\[|\]$/g, ""),
      localPort: Number(local.port),
      preferredRemotePort: 47989,
    });
    try {
      this.assertCurrent();
    } catch (error) {
      await forward.close();
      throw error;
    }
    local.hostname = "127.0.0.1";
    local.port = String(forward.remotePort);
    return {
      url: local.toString(),
      hostProxyForward: { localUrl, remotePort: forward.remotePort },
      close: () => forward.close(),
    };
  }
  async open() {
    await privateDirectory(this.profileDir);
    await this.cache.sweepCacheOnStartup();
    await this.reload();
  }
  async reload() {
    if (this.closed) throw new Error("SERVICE_STOPPING");
    const result = await readSshConfigDetailed(defaultSshConfigPath(), {
      managedConfigPath: defaultManagedSshConfigPath(),
    });
    if (result.diagnostic) throw new Error("SSH_CONFIGURATION_INVALID");
    if (this.closed) throw new Error("SERVICE_STOPPING");
    await this.pool.hydrate(result.hosts);
    this.discovery = result;
    return this.pool
      .list()
      .map((value) => this.snapshot(this.pool.get(value.config.id)!));
  }
  private parse(input: unknown, previous?: HostConfig): HostConfig {
    const data = object(input);
    const id = text(data.id ?? previous?.id);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(id))
      throw new Error("INVALID_SSH_ALIAS");
    const port =
      data.port === undefined ? (previous?.port ?? 22) : Number(data.port);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
      throw new Error("INVALID_SSH_PORT");
    const authMethod = data.authMethod ?? previous?.authMethod ?? "agent";
    if (authMethod !== "agent" && authMethod !== "key")
      throw new Error("INVALID_SSH_AUTH_METHOD");
    const identityFile =
      data.identityFile === undefined
        ? previous?.identityFile
        : data.identityFile === ""
          ? undefined
          : text(data.identityFile);
    if (authMethod === "key" && !identityFile)
      throw new Error("SSH_KEY_PATH_REQUIRED");
    return {
      id,
      hostname: text(data.hostname ?? previous?.hostname),
      user: text(data.user ?? previous?.user),
      port,
      authMethod,
      ...(identityFile ? { identityFile } : {}),
      source: "ssh-config",
      managedByCindy: true,
    };
  }
  async invoke(
    operation: string,
    args: unknown[],
    context: InvocationContext,
  ): Promise<unknown> {
    const guard = () => {
      if (this.closed) throw new Error("SERVICE_STOPPING");
      context.assertCurrent?.();
    };
    guard();
    if (operation === "list-codex-models") {
      const result = await readSshCodexModelList(args[0], id => this.codexProviders(id));
      guard(); return result;
    }
    if (operation === "list" || operation === "reload-config")
      return this.reload();
    if (operation === "connect" || operation === "disconnect") {
      const id = text(args[0]);
      if (!this.pool.get(id)) throw new Error("SSH_HOST_NOT_FOUND");
      if (operation === "disconnect") {
        await this.agentProxy.teardownAgentProxyOnUserDisconnect(id);
        await this.files.disposeHost(id);
      }
      await this.pool[operation](id);
      guard();
      return this.snapshot(this.pool.get(id)!);
    }
    const mutation = this.pending.then(async () => {
      await this.reload();
      guard();
      const managed = defaultManagedSshConfigPath();
      if (operation === "add") {
        const host = this.parse(args[0]);
        await addManagedHostWithInclude(host, defaultSshConfigPath(), managed);
      } else if (operation === "update" || operation === "remove") {
        const id = text(args[0]);
        const previous = this.pool.get(id)?.config;
        if (!previous) throw new Error("SSH_HOST_NOT_FOUND");
        if (
          !previous.managedByCindy ||
          !this.discovery?.managedConfigWriteToken
        )
          throw new Error("SSH_HOST_NOT_MANAGED");
        const token = this.discovery.managedConfigWriteToken;
        await this.files.disposeHost(id);
        guard();
        if (operation === "remove") {
          await this.pool.disconnect(id);
          guard();
          await removeManagedHost(id, managed, token);
        } else
          await updateManagedHostFields(
            this.parse({ ...object(args[1]), id }, previous),
            managed,
            token,
          );
      } else throw new Error("UNKNOWN_SSH_OPERATION");
      guard();
      return this.reload();
    });
    this.pending = mutation.catch(() => {});
    return mutation;
  }
  registerResources(registry: RemoteResourceRegistry) {
    const title = {
      fallback: "SSH computers",
      translations: {
        "zh-CN": "SSH 电脑",
        "zh-TW": "SSH 電腦",
        ja: "SSH コンピューター",
        ko: "SSH 컴퓨터",
      },
    };
    const item = (id: string) => {
      const host = this.pool.get(id)?.snapshot();
      if (!host) throw new Error("SSH_HOST_NOT_FOUND");
      return {
        ref: { collectionId: "ssh", kind: "ssh-host", id },
        revision: String(host.statusChangedAt),
        links: [],
        display: {
          title: host.config.displayName ?? id,
          subtitle: `${host.config.user}@${host.config.hostname}:${host.config.port}`,
          status: { label: host.status },
        },
        actions: [
          {
            id: host.status === "ready" ? "disconnect" : "connect",
            label:
              host.status === "ready"
                ? {
                    fallback: "Disconnect",
                    translations: {
                      "zh-CN": "断开",
                      "zh-TW": "中斷",
                      ja: "切断",
                      ko: "연결 끊기",
                    },
                  }
                : {
                    fallback: "Connect",
                    translations: {
                      "zh-CN": "连接",
                      "zh-TW": "連線",
                      ja: "接続",
                      ko: "연결",
                    },
                  },
          },
        ],
      };
    };
    registry.register({
      collection: {
        id: "ssh",
        resourceKind: "ssh-host",
        title,
        placement: "settings",
      },
      list: async () => {
        await this.reload();
        return {
          collectionId: "ssh",
          revision: "1",
          items: this.pool.list().map((host) => item(host.config.id)),
        };
      },
      get: async (_context, request) => item(request.ref.id),
      invoke: async (context, request) => {
        if (
          !request.resourceRef ||
          !["connect", "disconnect"].includes(request.actionId)
        )
          throw new Error("INVALID_SSH_ACTION");
        await this.invoke(request.actionId, [request.resourceRef.id], {
          source: "local",
          assertCurrent: context.assertCurrent,
        });
        return {
          effects: [{ kind: "refresh-resource", ref: request.resourceRef }],
        };
      },
    });
  }
  async close() {
    this.closed = true;
    await this.pending;
    await Promise.all([...this.codexReaders.values()].map(agent => agent.dispose()));
    this.codexReaders.clear();
    await this.files.disposeAll();
    await this.agentProxy.disposeAllTunnels();
    await this.pool.dispose();
  }
}
