/**
 * hermes-manager host-side client — desktop 侧本机 hermes-mgr daemon 生命周期。
 *
 * 职责:
 *  1. resolveHermesManagerBundlePath — 定位打包的 hermes-mgr.mjs(dev/packaged)
 *  2. resolveHermesHome — 专用 HERMES_HOME(~/.hermes-cindy), 拒绝日常 ~/.hermes
 *  3. ensureHermesManagerDaemon — 探活 + utilityProcess fork + READY/hello 校验
 *  4. hermesManagerSocketPath — 供 AgentDeps.resolveHermesManagerSocketPath 注入
 *
 * 进程模型: 正式包关闭 RunAsNode fuse(见 cindy-brain/nodeRuntimeWorkerProcess.ts
 * 顶部), process.execPath 不能再当 node 二进制用。daemon 因此通过 Electron
 * utilityProcess.fork 以 **app-owned** Node service process 运行:
 *  - 随 app 退出(不 detached、无 pid 文件、不用 process.kill);
 *  - stop 只 child.kill() 并等 'exit';
 *  - 与 pi-manager 不同, pi 的 daemon 在远端(SSH bridge), 本模块的 daemon
 *    就在本机; socket 位置从 userData 派生(pi 没有本机 socket 可镜像)。
 *
 * socket 信任边界: 同用户 only。protocol/hello 只做版本协商, 不是认证。
 *
 * 已知 v1 限制: 若启动时发现一个 hello 版本不兼容的**外部** daemon(手工/崩溃
 * 残留), 我们只能 unlink 它的 socket 再 fork 自己的; 那个外部进程稍后退出时
 * 它的 stop() 会 rm 同一路径, 可能把新 daemon 的 socket 文件删掉(监听 inode
 * 仍活着, 但新连接会 ENOENT)。app-owned 模型下这种外部 daemon 已属边缘情况。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { app, utilityProcess } from 'electron';
import yaml from 'js-yaml';

import {
  METHODS as HERMES_MGR_METHODS,
  PROTOCOL_VERSION,
  RpcClient,
  RpcClientError,
  readHermesMcpServers,
  writeHermesMcpServer as writeConfigMcpServer,
  removeHermesMcpServer as removeConfigMcpServer,
  type HermesMcpServerConfig,
} from '@cindy/maker-hermes-manager';

import { desktopMakerLogger } from './logger-adapter.js';

const log = desktopMakerLogger.child('hermes-manager-client');

const DEFAULT_PROBE_TIMEOUT_MS = 1_500;
const DEFAULT_READY_TIMEOUT_MS = 10_000;
const STOP_GRACE_MS = 2_000;
const STDERR_TAIL_CHARS = 2_048;
const READY_MARKER = 'HERMES_MGR_READY socket=';
const PROBE_CLIENT_ID = 'desktop-hermes-manager-probe';
const SERVICE_NAME = 'cindy-hermes-mgr';

/**
 * daemon 只需要定位 `hermes` 二进制和用户配置路径的变量。不透传 full env:
 * provider key 等凭证由 query/start 的 env 逐会话显式送入, 不应常驻 daemon。
 */
const INHERITED_ENV_KEYS = [
  'PATH',
  'SystemRoot',
  'WINDIR',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  // 代理 / TLS 配置: daemon spawn 的 Hermes CLI 继承这里的 env, 漏传会让
  // 企业代理或自签 CA 环境静默失败。均为配置, 不含凭证。
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  // CLI 的配置/缓存定位(含 Hermes 之外的依赖工具), 同样只是路径。
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
] as const;

export type HermesEnsureResult = { ok: true; socketPath: string } | { ok: false; message: string };

/** fork seam: 生产用 utilityProcess.fork; 单测注入 fake, 绝不真实拉起 daemon。 */
export type HermesManagerFork = typeof utilityProcess.fork;
type HermesUtilityProcess = ReturnType<HermesManagerFork>;

/**
 * @internal 小测试缝(socket/fork/timeout), 不是对外配置面。生产调用方
 * 永远用 ensureHermesManagerDaemon() 的默认参数。
 */
export interface HermesManagerEnsureOptions {
  socketPathOverride?: string;
  forkOverride?: HermesManagerFork;
  /** @internal 单测跳过 resolveHermesManagerBundlePath(dist 未必已构建)。 */
  bundlePathOverride?: string;
  probeTimeoutMs?: number;
  readyTimeoutMs?: number;
}

let cachedSocketPath: string | undefined;
let ensureInFlight: Promise<HermesEnsureResult> | null = null;
let stopInFlight: Promise<void> | null = null;
/** app-owned: 只持有本进程 fork 的 daemon; 它随 app 生命周期结束。 */
let ownedChild: HermesUtilityProcess | null = null;
/**
 * 每次 stop 递增。ensure 捕获启动时的 generation, 在每个异步边界后校验 ——
 * quit 与首次 spawn 竞争时, 旧 ensure 不能在 stop 完成后重新缓存 socket。
 */
let lifecycleGeneration = 0;
const exitedChildren = new WeakSet<HermesUtilityProcess>();

/** 本地打包的 hermes-mgr.mjs 路径(dev 源码 dist 或 packaged resources)。 */
export function resolveHermesManagerBundlePath(): string | null {
  const candidates: string[] = [];
  try {
    // app.getAppPath() 在 dev 是 apps/desktop, 两次 .. 到 repo root。
    candidates.push(
      path.join(
        app.getAppPath(),
        '..',
        '..',
        'packages',
        'maker-hermes-manager',
        'dist',
        'hermes-mgr.mjs',
      ),
    );
  } catch {
    // 非 Electron 环境(纯 Node 测试工具)没有 app — 只试 packaged 路径。
  }
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'hermes-manager', 'hermes-mgr.mjs'));
  }
  for (const candidate of candidates) {
    try {
      const st = fs.statSync(candidate);
      if (st.isFile() && st.size > 0) return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

/** darwin(通常大小写不敏感文件系统)与 win32 做大小写折叠后比较/前缀判断。 */
function foldPathCase(value: string): string {
  return process.platform === 'darwin' || process.platform === 'win32'
    ? value.toLowerCase()
    : value;
}

/**
 * Cindy 专用 Hermes home。默认 ~/.hermes-cindy; HERMES_HOME 可覆盖(空串按未设
 * 处理)。~/.hermes 及其任何子路径都是用户日常 Hermes, host 侧主动拒绝
 * (daemon 另有一道 fail-closed 守卫, 这里是 defense in depth)。
 */
export function resolveHermesHome(): string {
  const configured = process.env.HERMES_HOME?.trim();
  const home = path.resolve(
    configured && configured.length > 0 ? configured : path.join(os.homedir(), '.hermes-cindy'),
  );
  const dailyHome = path.resolve(os.homedir(), '.hermes');
  const homeFolded = foldPathCase(home);
  const dailyFolded = foldPathCase(dailyHome);
  if (homeFolded === dailyFolded || homeFolded.startsWith(`${dailyFolded}${path.sep}`)) {
    throw new Error(
      `refusing to use the daily Hermes home (or any path inside it) as Cindy's HERMES_HOME ` +
        `(${dailyHome}); set HERMES_HOME to a dedicated directory (default ~/.hermes-cindy)`,
    );
  }
  return home;
}

/**
 * AgentDeps.resolveHermesManagerSocketPath 的注入点: ensure 成功前返回
 * undefined(hermes Agent 会 fail loud 而不是猜一个不存在的 socket)。
 */
export function hermesManagerSocketPath(): string | undefined {
  return cachedSocketPath;
}

/**
 * 确保本机 hermes-mgr daemon 在跑。幂等 + 并发去重:
 *  - live (connect + protocol/hello 通过) → 复用并缓存 socket, 绝不 sweep/重启
 *  - dead → 清理 stale socket + utilityProcess.fork, 等 READY 行, 再 hello 校验
 *  - 协议不兼容 → 清理自己的旧 child + 重启一次; 仍不兼容则返回升级提示
 *  - 任何失败 → kill child、清缓存、返回带 stderr tail 的 typed failure
 */
export function ensureHermesManagerDaemon(
  options: HermesManagerEnsureOptions = {},
): Promise<HermesEnsureResult> {
  if (stopInFlight) {
    // stop 与 ensure 串行化: stop 进行中绝不允许新的 fork/缓存(否则 quit 后
    // 可能把 daemon 复活)。stop 完成后的新 ensure 仍可正常重启。
    return Promise.resolve({
      ok: false,
      message: 'hermes-mgr startup aborted: daemon stop in progress',
    });
  }
  if (ensureInFlight) return ensureInFlight;
  const generation = lifecycleGeneration;
  const inFlight = ensureInner(options, generation).finally(() => {
    if (ensureInFlight === inFlight) ensureInFlight = null;
  });
  ensureInFlight = inFlight;
  return inFlight;
}

/**
 * 关闭本进程 fork 的 daemon(step 5 挂到 app quit)。app-owned 模型下只
 * child.kill(), 等 'exit'; 非本进程 fork 的 → no-op。
 */
export function stopHermesManagerDaemon(): Promise<void> {
  if (stopInFlight) return stopInFlight;
  const inFlight = stopInner().finally(() => {
    if (stopInFlight === inFlight) stopInFlight = null;
  });
  stopInFlight = inFlight;
  return inFlight;
}

export interface HermesDaemonRequestOptions {
  timeoutMs?: number;
}

/**
 * 对已确保运行的 hermes-mgr daemon 发一次短请求(config 级 RPC:get/set 默认
 * 模型路由)。ensure → connect → protocol/hello → request → dispose;不与
 * Agent 的会话级 transport 共享连接。默认 10s 超时,写 config 足够。
 */
export async function withHermesManagerDaemon<T>(
  run: (client: RpcClient) => Promise<T>,
  options: HermesDaemonRequestOptions = {},
): Promise<T> {
  const ensure = await ensureHermesManagerDaemon();
  if (!ensure.ok) {
    throw new Error(`hermes-mgr daemon not ready: ${ensure.message}`);
  }
  const socketPath = hermesManagerSocketPath();
  if (!socketPath) {
    throw new Error('hermes-mgr socket path unavailable after ensure');
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let socket: net.Socket | null = null;
    let client: RpcClient | null = null;
    let timer: NodeJS.Timeout | undefined;

    const finish = (err: Error | null, value?: T): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        client?.dispose();
      } catch {
        /* best effort */
      }
      try {
        socket?.destroy();
      } catch {
        /* best effort */
      }
      if (err) reject(err);
      else resolve(value as T);
    };

    timer = setTimeout(() => finish(new Error('hermes-mgr request timed out')), timeoutMs);
    try {
      socket = net.createConnection(socketPath);
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    socket.once('error', (err) => finish(err));
    socket.once('connect', () => {
      client = new RpcClient(socket!, { clientId: 'desktop-config' });
      client
        .hello({ timeoutMs })
        .then(() => run(client!))
        .then((value) => finish(null, value))
        .catch((err: unknown) => finish(err instanceof Error ? err : new Error(String(err))));
    });
  });
}

export interface HermesModelCatalog {
  route: { model?: string; provider?: string; baseUrl?: string };
  models: string[];
  error?: string;
}

/**
 * The active provider's real model ids, for the Hermes picker. Route comes
 * from the home config; the Bearer key comes from THIS process' env (the
 * daemon runs secret-free) and rides the request only — never stored.
 * Also pings `config/status` first so the daemon logs a warning when the
 * installed Hermes CLI differs from the pinned version.
 */
export async function getHermesModelCatalog(
  requestTimeoutMs = 15_000,
): Promise<HermesModelCatalog> {
  return withHermesManagerDaemon(
    async (client) => {
      await client.request(HERMES_MGR_METHODS.CONFIG_STATUS, {}, { timeoutMs: requestTimeoutMs });
      const { route } = await client.request<{
        route: { model?: string; provider?: string; baseUrl?: string };
      }>(HERMES_MGR_METHODS.CONFIG_GET_DEFAULT_ROUTE, {}, { timeoutMs: requestTimeoutMs });
      const provider = route.provider ?? '';
      // Desktop-env key when present; otherwise the daemon falls back to the
      // Hermes home .env (the same file the CLI loads for its turns).
      const envName = `${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
      const key = provider ? (process.env[envName]?.trim() ?? '') : '';
      if (!route.baseUrl) return { route, models: [] };
      const result = await client.request<{
        route: HermesModelCatalog['route'];
        models: string[];
        error?: string;
      }>(HERMES_MGR_METHODS.CONFIG_LIST_MODELS, key ? { key } : {}, {
        timeoutMs: requestTimeoutMs,
      });
      return {
        route: result.route,
        models: result.models,
        ...(result.error ? { error: result.error } : {}),
      };
    },
    { timeoutMs: requestTimeoutMs + 5_000 },
  );
}

/**
 * Plugin ids from the Hermes home config's `plugins.enabled` / `plugins.disabled`
 * lists. Entries look like `superpowers/.hermes-plugin`; the suffix is dropped.
 * Accepts both block lists and inline `[]`. Read-only: Hermes writes this section.
 */
export function parseHermesPluginLists(configYaml: string): {
  enabled: Set<string>;
  disabled: Set<string>;
} {
  const out = { enabled: new Set<string>(), disabled: new Set<string>() };
  let doc: unknown;
  try {
    doc = yaml.load(configYaml);
  } catch {
    return out;
  }
  const plugins = (doc as { plugins?: unknown } | null)?.plugins;
  if (!plugins || typeof plugins !== 'object') return out;
  for (const key of ['enabled', 'disabled'] as const) {
    const list = (plugins as Record<string, unknown>)[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry !== 'string') continue;
      const id = entry.trim().replace(/\/\.hermes-plugin$/, '');
      if (id) out[key].add(id);
    }
  }
  return out;
}

export interface HermesHomePluginInfo {
  id: string;
  source?: string;
  revision?: string;
  enabled: boolean;
}

export interface HermesHomeStatus {
  homePath: string;
  route: { model?: string; provider?: string; baseUrl?: string };
  models: string[];
  mcpServers: Record<string, HermesMcpServerConfig>;
  plugins: HermesHomePluginInfo[];
  skills: string[];
  error?: string;
}

export type { HermesMcpServerConfig };

/**
 * Overview of the Hermes environment for the Settings UI:
 * home directory, model routing, installed plugins, and skills categories.
 */
export async function getHermesHomeStatus(requestTimeoutMs = 15_000): Promise<HermesHomeStatus> {
  const homePath = resolveHermesHome();
  const catalog = await getHermesModelCatalog(requestTimeoutMs).catch((err) => ({
    route: {},
    models: [],
    error: err instanceof Error ? err.message : String(err),
  }));

  const plugins: HermesHomePluginInfo[] = [];
  const skills: string[] = [];

  // Read config.yaml for the plugin enabled/disabled lists (Hermes owns them).
  let pluginLists = { enabled: new Set<string>(), disabled: new Set<string>() };
  try {
    const configContent = await fs.promises.readFile(path.join(homePath, 'config.yaml'), 'utf8');
    pluginLists = parseHermesPluginLists(configContent);
  } catch {
    // Tolerant if config is missing or unreadable
  }
  const enabledPluginNames = new Set(
    [...pluginLists.enabled].filter((name) => !pluginLists.disabled.has(name)),
  );

  // Read installed plugins from plugins/.install-metadata.json
  try {
    const metaPath = path.join(homePath, 'plugins', '.install-metadata.json');
    const metaContent = await fs.promises.readFile(metaPath, 'utf8');
    const meta = JSON.parse(metaContent) as Record<string, { source?: string; revision?: string }>;
    for (const [id, data] of Object.entries(meta)) {
      plugins.push({
        id,
        source: data?.source,
        revision: data?.revision,
        enabled: enabledPluginNames.has(id),
      });
    }
  } catch {
    // If metadata file is absent, list plugin directories directly
    try {
      const pluginsDir = path.join(homePath, 'plugins');
      const entries = await fs.promises.readdir(pluginsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          plugins.push({
            id: entry.name,
            enabled: enabledPluginNames.has(entry.name),
          });
        }
      }
    } catch {}
  }

  // Read skill categories from skills/ directory
  try {
    const skillsDir = path.join(homePath, 'skills');
    const entries = await fs.promises.readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        skills.push(entry.name);
      }
    }
  } catch {}

  const mcpServers = await readHermesMcpServers(homePath).catch(() => ({}));

  return {
    homePath,
    route: catalog.route,
    models: catalog.models,
    mcpServers,
    plugins,
    skills,
    ...(catalog.error ? { error: catalog.error } : {}),
  };
}

export async function setHermesMcpServer(
  name: string,
  server: HermesMcpServerConfig,
): Promise<Record<string, HermesMcpServerConfig>> {
  const homePath = resolveHermesHome();
  return writeConfigMcpServer(homePath, name, server);
}

export async function removeHermesMcpServer(
  name: string,
): Promise<Record<string, HermesMcpServerConfig>> {
  const homePath = resolveHermesHome();
  return removeConfigMcpServer(homePath, name);
}

export async function listHermesMcpServers(): Promise<Record<string, HermesMcpServerConfig>> {
  return readHermesMcpServers(resolveHermesHome());
}

/**
 * hermes-bridge-shim.mjs 路径(cindy-tools `bundle:shim` 产物):dev 取源码 dist,
 * packaged 取 resources/hermes-bridge-shim/。两处都没有 → null,Hermes 不带 Cindy 工具运行
 * (packaged 构建尚未随包携带 shim —— ROADMAP §Debt)。
 */
export function resolveHermesBridgeShimPath(): string | null {
  const candidates: string[] = [];
  try {
    candidates.push(
      path.join(
        app.getAppPath(),
        '..',
        '..',
        'packages',
        'cindy-tools',
        'dist',
        'hermes-bridge-shim.mjs',
      ),
    );
  } catch {
    // 非 Electron 环境:只试 packaged 路径。
  }
  if (process.resourcesPath) {
    candidates.push(
      path.join(process.resourcesPath, 'hermes-bridge-shim', 'hermes-bridge-shim.mjs'),
    );
  }
  for (const candidate of candidates) {
    try {
      const st = fs.statSync(candidate);
      if (st.isFile() && st.size > 0) return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

/** @internal test helper: 清空模块级缓存/持有状态(不杀真实进程)。 */
export function resetHermesManagerClientForTests(): void {
  lifecycleGeneration += 1;
  ensureInFlight = null;
  stopInFlight = null;
  cachedSocketPath = undefined;
  ownedChild = null;
}

/* ============================== private ============================== */

type ProbeOutcome =
  { state: 'ok' } | { state: 'mismatch'; protocolVersion?: number } | { state: 'dead' };

async function stopInner(): Promise<void> {
  lifecycleGeneration += 1;
  cachedSocketPath = undefined;

  const child = ownedChild;
  ownedChild = null;
  if (child) await killAndWait(child);

  // 等 in-flight ensure 收尾: 它的 generation 校验会 abort/kill, 保证 stop
  // resolve 之后不可能再有 ensure 分支把 socket 写回缓存。
  const pendingEnsure = ensureInFlight;
  if (pendingEnsure) await pendingEnsure.catch(() => undefined);

  cachedSocketPath = undefined;
  // 防御: 理论上 generation 校验已阻止 fork 在 stop 后登记 child。
  const lateChild = ownedChild;
  if (lateChild) {
    ownedChild = null;
    await killAndWait(lateChild);
    cachedSocketPath = undefined;
  }
  log.info('hermes-mgr stop complete');
}

async function ensureInner(
  options: HermesManagerEnsureOptions,
  generation: number,
): Promise<HermesEnsureResult> {
  const aborted = (): HermesEnsureResult => ({
    ok: false,
    message: 'hermes-mgr startup aborted: daemon stop requested',
  });
  const stale = (): boolean => generation !== lifecycleGeneration;

  let socketPath: string;
  let home: string;
  try {
    socketPath = options.socketPathOverride ?? hermesManagerSocketPathFor(app.getPath('userData'));
    home = resolveHermesHome();
  } catch (err) {
    const message = errorText(err);
    cachedSocketPath = undefined;
    log.error('hermes-mgr configuration invalid', { error: message });
    return { ok: false, message };
  }

  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

  const live = await probeDaemon(socketPath, probeTimeoutMs);
  if (stale()) return aborted();
  if (live.state === 'ok') {
    cachedSocketPath = socketPath;
    log.debug('hermes-mgr already live', { socketPath });
    return { ok: true, socketPath };
  }

  let mismatchNote = '';
  if (live.state === 'mismatch') {
    log.warn('hermes-mgr protocol mismatch — respawning daemon once', {
      socketPath,
      expectedProtocol: PROTOCOL_VERSION,
      daemonProtocol: live.protocolVersion,
    });
    const observed =
      live.protocolVersion !== undefined ? `v${live.protocolVersion}` : 'an incompatible version';
    mismatchNote =
      `hermes-mgr protocol upgrade required: daemon speaks ${observed}, ` +
      `this app expects v${PROTOCOL_VERSION}; rebuild/repackage the hermes-mgr bundle ` +
      'or stop the manually started daemon. ';
  }

  const forked = await spawnAndVerify({
    socketPath,
    home,
    probeTimeoutMs,
    readyTimeoutMs,
    forkImpl: options.forkOverride ?? utilityProcess.fork,
    bundlePath: options.bundlePathOverride ?? null,
    generation,
  });
  if (forked.ok) return forked;

  cachedSocketPath = undefined;
  const message = `${mismatchNote}${forked.message}`;
  log.error('hermes-mgr ensure failed', { socketPath, error: message });
  return { ok: false, message };
}

function hermesManagerSocketPathFor(userDataDir: string): string {
  if (process.platform === 'win32') {
    // 命名管道没有目录清理这一步; 用 userData 的短 hash 避免超过 256 字符上限,
    // 同时让 dev/正式实例(不同 userData)互不串道。
    const digest = crypto
      .createHash('sha256')
      .update(userDataDir, 'utf8')
      .digest('hex')
      .slice(0, 16);
    return `\\\\.\\pipe\\cindy-hermes-mgr-${digest}`;
  }
  return path.join(userDataDir, 'hermes-mgr', 'hermes-mgr.sock');
}

function hermesDaemonEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

interface SpawnAndVerifyOpts {
  socketPath: string;
  home: string;
  probeTimeoutMs: number;
  readyTimeoutMs: number;
  forkImpl: HermesManagerFork;
  /** null → 走真实 bundle 解析; 非 null 覆盖(单测缝)。 */
  bundlePath: string | null;
  generation: number;
}

async function spawnAndVerify(opts: SpawnAndVerifyOpts): Promise<HermesEnsureResult> {
  const aborted = (): HermesEnsureResult => ({
    ok: false,
    message: 'hermes-mgr startup aborted: daemon stop requested',
  });
  const stale = (): boolean => opts.generation !== lifecycleGeneration;

  if (stale()) return aborted();
  const bundlePath = opts.bundlePath ?? resolveHermesManagerBundlePath();
  if (!bundlePath) {
    return {
      ok: false,
      message:
        'hermes-mgr bundle not found: expected packages/maker-hermes-manager/dist/hermes-mgr.mjs ' +
        '(dev) or resources/hermes-manager/hermes-mgr.mjs (packaged)',
    };
  }

  // 协议升级路径上可能还持有本进程此前 fork 的 child; 先清掉再全新拉起。
  await stopOwnedChild();
  if (stale()) return aborted();

  // 只有 probe 未成功(dead/mismatch)才会走到这里: live daemon 在上面已复用,
  // 绝不 unlink 一个能正常 hello 的 socket。残留 race 见文件头 v1 限制。
  prepareSocketPathForFork(opts.socketPath);
  if (stale()) return aborted();

  const stderrTail = { text: '' };
  let child: HermesUtilityProcess;
  try {
    child = opts.forkImpl(bundlePath, ['--socket', opts.socketPath, '--hermes-home', opts.home, '--per-session-homes'], {
      cwd: os.tmpdir(),
      env: hermesDaemonEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      serviceName: SERVICE_NAME,
      // 与 cindy-brain worker 一致: daemon 的系统权限访问仍归属 Cindy。
      ...(process.platform === 'darwin' ? { disclaim: false } : {}),
    });
  } catch (err) {
    return { ok: false, message: `failed to fork hermes-mgr: ${errorText(err)}` };
  }

  if (stale()) {
    await killAndWait(child);
    return aborted();
  }
  ownedChild = child;
  trackChildExit(child);
  log.info('hermes-mgr forked', {
    pid: child.pid,
    socketPath: opts.socketPath,
    home: opts.home,
    bundlePath,
  });

  const ready = await waitForReady(child, stderrTail, opts.readyTimeoutMs);
  if (stale()) {
    clearOwnedChild(child);
    await killAndWait(child);
    return aborted();
  }
  if (!ready.ok) {
    clearOwnedChild(child);
    await killAndWait(child);
    return {
      ok: false,
      message: withStderrTail(`hermes-mgr failed to start: ${ready.message}`, stderrTail),
    };
  }

  const handshake = await probeDaemon(opts.socketPath, opts.probeTimeoutMs);
  if (stale()) {
    clearOwnedChild(child);
    await killAndWait(child);
    return aborted();
  }
  if (handshake.state === 'ok') {
    cachedSocketPath = opts.socketPath;
    log.info('hermes-mgr ready', { pid: child.pid, socketPath: opts.socketPath });
    return { ok: true, socketPath: opts.socketPath };
  }

  clearOwnedChild(child);
  await killAndWait(child);
  const detail =
    handshake.state === 'mismatch'
      ? `daemon speaks protocol v${handshake.protocolVersion ?? '?'} (expected v${PROTOCOL_VERSION}); ` +
        'the hermes-mgr bundle is stale — rebuild/repackage it'
      : 'daemon did not answer protocol/hello';
  log.error('hermes-mgr handshake failed', {
    socketPath: opts.socketPath,
    expectedProtocol: PROTOCOL_VERSION,
    daemonProtocol: handshake.state === 'mismatch' ? handshake.protocolVersion : undefined,
  });
  return {
    ok: false,
    message: withStderrTail(`hermes-mgr started but handshake failed: ${detail}`, stderrTail),
  };
}

/** 'exit' 时立刻清缓存/把手, 下一次 ensure 会重新 probe/fork。 */
function trackChildExit(child: HermesUtilityProcess): void {
  child.on('exit', (code: number) => {
    exitedChildren.add(child);
    if (ownedChild === child) {
      ownedChild = null;
      cachedSocketPath = undefined;
      log.warn('hermes-mgr daemon exited', { code });
    }
  });
  // 不消费 stdout 会让 daemon 在写满 pipe 后回压; 内容无意义, 只做排空。
  child.stdout?.on('data', () => undefined);
  // logging-only 常驻 error listener: utilityProcess 'error' 是致命 V8 错误
  // (随后仍会 exit)。waitForReady 只在等待期挂 once; READY 成功后若再没有
  // listener, 后续 error 会变成 main 进程的 unhandled 'error' 崩溃。
  child.on('error', (type: string, location: string) => {
    log.error('hermes-mgr utility process fatal error', { type, location });
  });
}

function clearOwnedChild(child: HermesUtilityProcess): void {
  if (ownedChild === child) ownedChild = null;
  cachedSocketPath = undefined;
}

async function stopOwnedChild(): Promise<void> {
  const child = ownedChild;
  if (!child) return;
  ownedChild = null;
  cachedSocketPath = undefined;
  await killAndWait(child);
}

async function killAndWait(child: HermesUtilityProcess): Promise<void> {
  const exited = waitForExit(child, STOP_GRACE_MS);
  try {
    child.kill();
  } catch (err) {
    log.warn('hermes-mgr utility process kill failed', { error: errorText(err) });
  }
  if (!(await exited)) {
    log.warn('hermes-mgr utility process did not exit within grace window', {
      graceMs: STOP_GRACE_MS,
    });
  }
}

/** 探活 = connect + protocol/hello。dead/mismatch 区分升级路径。 */
function probeDaemon(socketPath: string, timeoutMs: number): Promise<ProbeOutcome> {
  return new Promise<ProbeOutcome>((resolve) => {
    let settled = false;
    let socket: net.Socket | null = null;
    let client: RpcClient | null = null;
    let timer: NodeJS.Timeout | undefined;

    const finish = (outcome: ProbeOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        client?.dispose();
      } catch {
        /* best effort */
      }
      try {
        socket?.destroy();
      } catch {
        /* best effort */
      }
      resolve(outcome);
    };

    timer = setTimeout(() => finish({ state: 'dead' }), timeoutMs);
    try {
      socket = net.createConnection(socketPath);
    } catch {
      finish({ state: 'dead' });
      return;
    }

    socket.once('connect', () => {
      client = new RpcClient(socket!, { clientId: PROBE_CLIENT_ID });
      void client
        .hello({ timeoutMs })
        .then((result) => {
          finish(
            result.protocolVersion === PROTOCOL_VERSION
              ? { state: 'ok' }
              : { state: 'mismatch', protocolVersion: result.protocolVersion },
          );
        })
        .catch((err: unknown) => {
          finish(
            err instanceof RpcClientError && err.rpcError.code === 'INVALID_PROTOCOL_VERSION'
              ? { state: 'mismatch' }
              : { state: 'dead' },
          );
        });
    });
    socket.once('error', () => finish({ state: 'dead' }));
    // 服务端 hello 后立刻断开等场景: close 但没有有效握手 → dead。
    socket.once('close', () => finish({ state: 'dead' }));
  });
}

function waitForReady(
  child: HermesUtilityProcess,
  stderrTail: { text: string },
  timeoutMs: number,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const stderr = child.stderr;
  if (!stderr) {
    return Promise.resolve({ ok: false, message: 'utility process has no stderr pipe' });
  }
  if (exitedChildren.has(child)) {
    return Promise.resolve({ ok: false, message: 'daemon exited before READY' });
  }
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (result: { ok: true } | { ok: false; message: string }): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', onError);
      // READY 后保留 stderr 消费:daemon 日志持续写 stderr, 无人读会让 pipe
      // 写满(64KB)后回压阻塞 daemon; 失败路径即将 kill, 可以摘掉。
      if (!result.ok) stderr.off('data', onData);
      resolve(result);
    };
    const onData = (chunk: Buffer | string): void => {
      stderrTail.text = (stderrTail.text + chunk.toString()).slice(-STDERR_TAIL_CHARS);
      if (!settled && stderrTail.text.includes(READY_MARKER)) finish({ ok: true });
    };
    const onExit = (code: number): void => {
      finish({ ok: false, message: `daemon exited before READY (code=${code})` });
    };
    const onError = (type: string, location: string): void => {
      finish({ ok: false, message: `daemon utility process error: ${type} at ${location}` });
    };

    timer = setTimeout(
      () => finish({ ok: false, message: `no READY line within ${timeoutMs}ms` }),
      timeoutMs,
    );
    stderr.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function prepareSocketPathForFork(socketPath: string): void {
  if (process.platform === 'win32') return;
  const dir = path.dirname(socketPath);
  try {
    // socket 信任边界是同用户 only(hello 不是认证) —— 目录不给 group/other
    // 遍历。macOS userData 本来就是 0700; Linux 受 umask 影响, 显式 chmod。
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  } catch (err) {
    log.warn('hermes-mgr socket dir hardening failed', { dir, error: errorText(err) });
  }
  try {
    fs.rmSync(socketPath, { force: true });
  } catch (err) {
    log.warn('hermes-mgr stale socket sweep failed', { socketPath, error: errorText(err) });
  }
}

function waitForExit(child: HermesUtilityProcess, timeoutMs: number): Promise<boolean> {
  if (exitedChildren.has(child)) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.off('exit', onExit);
      resolve(exited);
    };
    const onExit = (): void => finish(true);
    timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
  });
}

function withStderrTail(message: string, stderrTail: { text: string }): string {
  const tail = stderrTail.text.trim();
  return tail.length > 0 ? `${message}; stderr tail: ${tail.slice(-STDERR_TAIL_CHARS)}` : message;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
