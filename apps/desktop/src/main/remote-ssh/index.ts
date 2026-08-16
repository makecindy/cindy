/**
 * registerRemoteSshIpc — main-side handlers for SSH remote host management.
 *
 * Phase A surface:
 *
 *   maker:remote-ssh:list           list hosts + status snapshots
 *   maker:remote-ssh:reload-config  re-read ~/.ssh/config, refresh registry
 *   maker:remote-ssh:add            add a host (also writes ~/.ssh/config)
 *   maker:remote-ssh:remove         remove a host (also strips ~/.ssh/config)
 *   maker:remote-ssh:connect        open the SSH connection
 *   maker:remote-ssh:disconnect     close the SSH connection
 *   maker:remote-ssh:status-changed (push) host status fan-out
 *
 * All host writes round-trip through ~/.ssh/config so the user can still
 * run `ssh <alias>` from the terminal. The pool itself is in-memory; on
 * app restart, hydrate() rebuilds it from disk.
 */

import { app, ipcMain, BrowserWindow } from 'electron';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  ConnectionPool,
  readSshConfig,
  upsertHost,
  updateHostFields,
  removeHost as removeHostFromConfig,
  installRemoteAgent,
  PINNED_PI_VERSION,
  probeRemoteAgent,
  uninstallRemoteAgent,
  checkRemoteCodexAuth,
  pushRemoteCodexAuth,
  expandHome,
  FileHostKeyStore,
  RemoteHost,
  type AddHostInput,
  type CodexAuthState,
  type HostConfig,
  type HostSnapshot,
  type InstallProgressEvent,
  type InstallResult,
  type RemoteAgentKind,
} from '@cindy/maker-remote-ssh';

import { createLogger } from '../logger.js';
import { throwIpcError, requireString, requireObject, requireEnum } from '../utils/ipcValidate.js';
import { isIpcErrorCode } from '../../shared/ipc-errors.js';
// 轮 42 P1(codex-connector):remove host 的 DB 引用检查改**顶部静态导入** ——
// 之前动态 await import() 把 drizzle/localDb 的打包/加载失败推迟到用户
// remove host 时才暴露, 违反 main-process 依赖规则(须静态 import)。
import { eq } from 'drizzle-orm';
import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import { getRemoteClaudeEnv } from './claude-env.js';
import { readClaudeApiKey } from '../maker-host/auth-adapters.js';
import { claudeUpstreamEndpoint } from '../maker-host/runtime-configs.js';
import { piManagerKill, piManagerList, runPiManagerUpgrade } from '../maker-host/pi-manager-client.js';
import { ensurePiManagerDaemon } from '@cindy/maker-remote-ssh';
import { PROTOCOL_VERSION as PI_MANAGER_PROTOCOL_VERSION } from '@cindy/maker-pi-manager';
import { invalidateRemotePiPathCaches, redactCredentialText } from '../maker-host/pi-remote-transport.js';
import { serializeEnvBlock } from './env-block.js';
import { classifyConnectFailure } from './connect-failure.js';
import {
  addKeyToAgent,
  buildInstallCommand,
  generateNewKey,
  listLocalSshKeys,
  readPubkey,
} from './ssh-keys.js';
import {
  getSshHostAgentProxy,
  getSshHostAutoConnect,
  hasAnyAutoConnectHost,
  isAllowedAgentProxyRemotePort,
  LEGACY_AGENT_PROXY_REMOTE_PORT,
  normalizeAgentProxyUrl,
  readSshHostPrefs,
  removeSshHostPref,
  setSshHostAgentProxy,
  setSshHostAutoConnect,
  type SshHostAgentProxyPref,
} from './ssh-host-prefs-store.js';
import {
  applyAgentProxyForHost,
  clearAgentProxyTunnelState,
  disposeAllTunnels,
  getAgentProxyTunnelState,
  getRemoteAgentProxyEnvUppercase,
  handleAgentProxyMainHostDown,
  initAgentProxy,
  killRemoteCodexDaemon,
  reconcileCodexAgentProxyEnv,
  teardownAgentProxyOnUserDisconnect,
  type AgentProxyTunnelState,
} from './agent-proxy.js';
import {
  clearCcManagerInstallCache,
  runCcMgrUpgrade,
  listPendingCcMgrUpgrades,
  dismissPendingCcMgrUpgrade,
  ensureCcManagerInstalledOrInstall,
} from './cc-manager-install.js';
import { removeRemoteMcpForwardPref } from './codex-remote-mcp.js';
import { ensureDaemonRunning } from '../maker-host/cc-manager-client.js';
import { getMakerIfReady, softCloseCcSessionsForHost } from '../maker-host/index.js';
import { withRehydrateCloseSuppressed } from '../maker-host/rehydrateCloseSuppression.js';

const log = createLogger('remote-ssh/ipc');
/**
 * pi-manager daemon 的空闲回收阈值(与 packages/maker-pi-manager 的
 * PiSessionRegistry 默认 idleTimeoutMs 对齐, 1_800_000 = 30min)。
 * cleanup 用它判定「daemon 自己都会回收的会话」—— 低于该阈值的会话
 * 交给 daemon 的 idle 回收, cleanup 不主动杀(轮 42 P1)。
 */
const PI_MANAGER_IDLE_TIMEOUT_MS = 1_800_000;

export const REMOTE_SSH_INVOKE = {
  LIST: 'maker:remote-ssh:list',
  RELOAD_CONFIG: 'maker:remote-ssh:reload-config',
  ADD: 'maker:remote-ssh:add',
  UPDATE: 'maker:remote-ssh:update',
  REMOVE: 'maker:remote-ssh:remove',
  CONNECT: 'maker:remote-ssh:connect',
  DISCONNECT: 'maker:remote-ssh:disconnect',
  // Phase B
  PROBE_AGENT: 'maker:remote-ssh:probe-agent',
  INSTALL_AGENT: 'maker:remote-ssh:install-agent',
  UNINSTALL_AGENT: 'maker:remote-ssh:uninstall-agent',
  RUN_AGENT_ONE_SHOT: 'maker:remote-ssh:run-agent-one-shot',
  // Phase B+ — Codex credential sync
  CHECK_CODEX_AUTH: 'maker:remote-ssh:check-codex-auth',
  SYNC_CODEX_AUTH: 'maker:remote-ssh:sync-codex-auth',
  // Phase B++ — SSH key setup wizard
  LIST_LOCAL_KEYS: 'maker:remote-ssh:list-local-keys',
  GENERATE_KEY: 'maker:remote-ssh:generate-key',
  READ_PUBKEY: 'maker:remote-ssh:read-pubkey',
  BUILD_INSTALL_CMD: 'maker:remote-ssh:build-install-cmd',
  /**
   * Inline variant that doesn't require the host to exist in the pool.
   * Renderer can use it while still composing a new / unsaved host form,
   * so the key-picker dialog can surface the ssh-copy-id command before
   * the user actually submits the host.
   */
  BUILD_INSTALL_CMD_INLINE: 'maker:remote-ssh:build-install-cmd-inline',
  ADD_KEY_TO_AGENT: 'maker:remote-ssh:add-key-to-agent',
  // Phase C — generic remote fs primitives (reusable by a future remote
  // file browser; currently consumed by StartRemoteSessionPanel for the
  // "workdir doesn't exist → confirm + mkdir" UX).
  STAT_REMOTE_PATH: 'maker:remote-ssh:stat-remote-path',
  MKDIR_P_REMOTE: 'maker:remote-ssh:mkdir-p-remote',
  // Phase D — per-host autoConnect preference + lightweight remote dir
  // browser (powers the "添加远程项目" entry in NewMaker chat composer).
  SET_AUTO_CONNECT: 'maker:remote-ssh:set-auto-connect',
  HAS_ANY_AUTO_CONNECT_HOST: 'maker:remote-ssh:has-any-auto-connect-host',
  LIST_REMOTE_DIR: 'maker:remote-ssh:list-remote-dir',
  // cc-mgr 版本管理 — UpgradeBanner 后端。force-upgrade 触发 kill + re-upload
  // (会中断 host 上所有 alive cc session);list-pending 给 renderer 启动时
  // 同步 push 之前的 pending 状态;dismiss-pending 用户点 banner X 关掉。
  CC_MGR_FORCE_UPGRADE: 'maker:remote-ssh:cc-mgr-force-upgrade',
  CC_MGR_LIST_PENDING_UPGRADES: 'maker:remote-ssh:cc-mgr-list-pending-upgrades',
  CC_MGR_DISMISS_PENDING_UPGRADE: 'maker:remote-ssh:cc-mgr-dismiss-pending-upgrade',
} as const;

/**
 * cc-mgr force-upgrade 在飞的 **session** 集合(升级窗口,仅 banner-clicker)。
 * 窗口内该 session 的 reason='remote_daemon_closed' 终止错误是**计划内**的
 * (soft-close 与 pkill 的竞态窗口里 U2 兜底可能抢先发出),register 的
 * coordinator error 转发据此跳过 paired-done 保留——否则升级完成后 projection
 * 里保留的 [REMOTE_DAEMON_CLOSED] 会复现成 error banner(PR #485 review)。
 * 范围刻意与 renderer ccMgrUpgradeStore 一致按 session(不是 host):同 host
 * 其它会话被 daemon kill 的中断**必须**照真实失败浮现(force-upgrade handler
 * 有意不关它们);窗口外的 daemon 死亡同样不受影响。
 */
const inflightCcMgrUpgradeSessions = new Set<string>();
export function isCcMgrUpgradeInFlight(sessionId: string | null | undefined): boolean {
  return !!sessionId && inflightCcMgrUpgradeSessions.has(sessionId);
}

export const REMOTE_SSH_PUSH = {
  STATUS_CHANGED: 'maker:remote-ssh:status-changed',
  INSTALL_PROGRESS: 'maker:remote-ssh:install-progress',
  // Phase D — maker:send 触发的静默 install 状态推送 (粗粒度: started/progress/done/failed)。
  // 跟 INSTALL_PROGRESS 解耦: 后者是逐行 log (RemoteHostDetail 消费),
  // 这条是 toast 状态机用的高层 phase, 避免 toast 跟每条 log 同频更新刷屏。
  SILENT_INSTALL_STATUS: 'maker:remote-ssh:silent-install-status',
  // cc-mgr 版本管理: silent install pipeline 探到远端 daemon 版本 != desktop
  // 手里的 bundle 版本, 且 daemon 上有 alive session 时, 不强升, push 这条让
  // 该 host 上每个 cc remote ChatView 顶部显示一条 UpgradeBanner 提示用户主动升。
  // payload.available=null 表示 pending 被清空 (升级完成 / 显式 dismiss), banner 自己消失。
  CC_MGR_UPGRADE_AVAILABLE: 'maker:remote-ssh:cc-mgr-upgrade-available',
} as const;

/** silent-install push payload — renderer-side 状态机消费这条切 toast 文案。 */
export interface SilentInstallStatusPushPayload {
  hostId: string;
  agentKind: RemoteAgentKind;
  phase: 'started' | 'progress' | 'done' | 'failed';
  /** phase=progress 时附 InstallProgressEvent 的 kind, 给 toast 切阶段文案。
   *  轮 32 MEDIUM:'install-upload' 是 PiManagerInstallProgress 的 kind, 不经过
   *  SILENT_INSTALL_STATUS 广播(pi-manager 安装走独立通道) —— 从 union 移除,
   *  与 renderer 侧 vite-env.d.ts 的类型对齐。 */
  eventKind?: InstallProgressEvent['kind'];
  /** phase=failed 时附错误信息, 给 error toast 显示。 */
  message?: string;
}

/** cc-mgr / pi-manager 升级提示 push payload。available=null = 该 host 的 pending 已清空。 */
export interface CcMgrUpgradeAvailablePushPayload {
  hostId: string;
  available: {
    /** daemon 当前在跑的 bundle 版本 (sha256:12) */
    currentVersion: string;
    /** desktop 手里 packaged bundle 版本 (升级后的目标) */
    availableVersion: string;
  } | null;
  /** 轮 22-F2:哪个 daemon 的 pending —— 'cc' | 'pi'(available=null 时也要能定位)。 */
  agent: 'cc' | 'pi';
}

const VALID_AGENT_KINDS: ReadonlyArray<RemoteAgentKind> = ['claude-code', 'codex', 'pi'];

let pool: ConnectionPool | null = null;
let initPromise: Promise<void> | null = null;
let registered = false;
/** 与 pool 共享的 host-key store — agent-proxy 隧道专用连接也用它做 TOFU 校验。 */
let sharedHostKeyStore: FileHostKeyStore | null = null;

function getSharedHostKeyStore(): FileHostKeyStore {
  if (!sharedHostKeyStore) {
    // Maker-owned host-key TOFU store. Kept out of the user's real
    // ~/.ssh/known_hosts so we never mutate their OpenSSH state.
    sharedHostKeyStore = new FileHostKeyStore(
      path.join(app.getPath('userData'), 'remote-ssh', 'known-hosts.json'),
    );
  }
  return sharedHostKeyStore;
}

const poolLogger = {
  debug: (msg: string, ctx?: Record<string, unknown>) => log.debug(msg, ctx),
  info: (msg: string, ctx?: Record<string, unknown>) => log.info(msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown>) => log.warn(msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => log.error(msg, ctx),
};

function getPool(): ConnectionPool {
  if (!pool) {
    pool = new ConnectionPool({
      logger: poolLogger,
      hostKeys: getSharedHostKeyStore(),
    });
  }
  return pool;
}

/**
 * Public accessor for the singleton ConnectionPool — used by maker-host
 * (Codex remote transport) to look up a connected RemoteHost by id when
 * starting a remote session.
 */
export function getRemoteSshPool(): ConnectionPool {
  return getPool();
}

/**
 * Like getRemoteSshPool() but guarantees the pool has been hydrated from
 * ~/.ssh/config first. Required by callers that read `pool.list()` before any
 * connect happens (e.g. cindy_ssh MCP tools resolving an alias on cold start) —
 * plain getRemoteSshPool() returns an empty pool until Settings → Remote or a
 * connect path triggers hydration.
 */
export async function getRemoteSshPoolHydrated(): Promise<ConnectionPool> {
  await ensureHydrated();
  return getPool();
}

/**
 * Ensure a remote SSH host is hydrated into the pool AND in 'ready' state.
 * Idempotent: cheap when already ready, blocks on hydrate + connect when not.
 *
 * Used by `maker:send` to auto-reconnect a remote codex session's host on
 * app restart — without this the renderer hits "host not found in pool" the
 * first message after launch because pool hydrate only happens lazily when
 * the user visits Settings → Remote.
 */
export async function ensureRemoteHostReady(id: string): Promise<void> {
  await ensureHydrated();
  const pool = getPool();
  const host = pool.get(id);
  if (!host) {
    throwIpcError('SSH_HOST_NOT_FOUND', `unknown ssh host: ${id} — add it under Settings → Remote first`);
  }
  if (host.getStatus() === 'ready') return;
  try {
    await pool.connect(id);
  } catch (err) {
    const { code, msg } = classifyConnectFailure(err);
    throwIpcError(code, msg);
  }
}

/**
 * 已知"该 host 上某 agent 已经装好"的内存 cache。命中后跳过 probe,避免每条
 * 消息发送前都跑 ~80ms 的 SSH stat。卸载/重装不通过这里走的话会 stale,但
 * 重装路径(InstallRemoteAgentPanel)结束时会刷新 hosts list, 那条路径不依赖
 * 本 cache, 用户不会卡。
 * 版本维度:pi 记录 probe 时的 installedVersion —— pin 变化(客户端升级)后
 * 旧版本不得命中 cache, 必须穿透重新 probe 触发升级(R5 配置审计 H-6)。
 */
const remoteAgentInstalledCache = new Map<
  string,
  Map<RemoteAgentKind, { installedVersion: string | null }>
>();

/** cache 命中判定:pi 额外要求版本与 pin 一致(v 前缀两种写法都认)。 */
function isAgentCacheHit(
  cached: Map<RemoteAgentKind, { installedVersion: string | null }> | undefined,
  agentKind: RemoteAgentKind,
): boolean {
  if (!cached || !cached.has(agentKind)) return false;
  if (agentKind !== 'pi') return true;
  const v = cached.get(agentKind)?.installedVersion ?? null;
  return v !== null && (v === PINNED_PI_VERSION || v === `v${PINNED_PI_VERSION}`);
}

/**
 * Ensure a remote agent binary exists on the host. Called from maker:send 前置,
 * 把"binary not installed"这类问题从 daemon 启动失败的 stack trace 转成 renderer
 * 能正确 toast 的 SSH_AGENT_NOT_INSTALLED IPC error, 引导用户去 Settings 安装。
 *
 * Claude Code 首次检查走完整 probeRemoteAgent,确保 Cindy 管理的远端 runtime
 * 与当前 pin 一致；否则客户端升级后旧 binary 会永久命中 `test -x`。Codex 仍
 * 只做存在性检查。两者命中内存 cache 后续都是 ~0ms。
 */
export async function ensureRemoteAgentInstalled(
  hostId: string,
  agentKind: RemoteAgentKind,
): Promise<void> {
  const cached = remoteAgentInstalledCache.get(hostId);
  if (isAgentCacheHit(cached, agentKind)) return;

  const host = getPool().get(hostId);
  if (!host || host.getStatus() !== 'ready') {
    // ensureRemoteHostReady 必须先调过 — 这里不主动连, 让上层显式处理 ssh 错误。
    throwIpcError('SSH_NOT_CONNECTED', `ssh host ${hostId} not connected`);
  }

  let ok: boolean;
  let installedVersion: string | null = null;
  if (agentKind === 'claude-code' || agentKind === 'pi') {
    const probe = await probeRemoteAgent(host, agentKind);
    ok = probe.installed;
    installedVersion = probe.installedVersion;
  } else {
    const binPath = '$HOME/.xdt-server/v1/codex-home/packages/standalone/current/codex';
    const result = await host.exec(`test -x ${binPath} && echo OK || echo MISSING`, {
      timeoutMs: 5_000,
      label: 'check-agent-installed',
    });
    ok = result.stdout.trim() === 'OK';
  }
  if (!ok) {
    const friendlyKind = agentKind === 'codex' ? 'Codex' : agentKind === 'pi' ? 'Pi' : 'Claude Code';
    throwIpcError(
      'SSH_AGENT_NOT_INSTALLED',
      `远端 ${hostId} 还没安装 ${friendlyKind}。请到 设置 → 远端机器 → 展开 ${hostId} → ${friendlyKind} 那行点"安装"。`,
    );
  }
  const entry = { installedVersion };
  if (!cached) remoteAgentInstalledCache.set(hostId, new Map([[agentKind, entry]]));
  else cached.set(agentKind, entry);
}

/**
 * 同一 (hostId, agentKind) 正在跑的 silent install Promise. 命中就 await 已有的,
 * 避免并发场景下 (用户连发两条消息 / silent install 跟手动 install 同时撞) 重复
 * 跑 install.sh。Promise resolve/reject 后会 delete, 下次没装会重新跑一次。
 */
const inFlightInstall = new Map<string, Promise<InstallResult>>();
function inFlightKey(hostId: string, agentKind: RemoteAgentKind): string {
  return `${hostId}::${agentKind}`;
}

// Exported so cc-manager-install.ts (separate silent install pipeline) can push
// the same channel and reuse the renderer's toast state machine — otherwise
// the first cc-mgr install on a host runs silently for 10-20s with no UX.
export function broadcastSilentInstallStatus(payload: SilentInstallStatusPushPayload): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(REMOTE_SSH_PUSH.SILENT_INSTALL_STATUS, payload);
  }
}

/** Broadcast cc-mgr upgrade-available state change (set / clear). */
export function broadcastCcMgrUpgradeAvailable(payload: CcMgrUpgradeAvailablePushPayload): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(REMOTE_SSH_PUSH.CC_MGR_UPGRADE_AVAILABLE, payload);
  }
}

function broadcastInstallProgress(payload: InstallProgressPushPayload): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(REMOTE_SSH_PUSH.INSTALL_PROGRESS, payload);
  }
}

/**
 * "确保装好, 没装就装" — 给 maker:send 路径用。已装 (cache / stat) 直接 return,
 * 没装则自动跑一次 installRemoteAgent + 推 SILENT_INSTALL_STATUS 让 renderer
 * toast 给阶段进度反馈; 同时把 InstallProgressEvent 推到 INSTALL_PROGRESS channel,
 * 这样用户正好打开 Settings → 该 host 详情时, RemoteHostDetail 的 log 区会实时
 * 展示逐行 install 输出 (跟手动 install 同源)。
 *
 * 失败抛 SSH_INSTALL_FAILED IpcError, 上层 maker:send 透传给 renderer, toast
 * 状态机收到 phase=failed 后再把 error toast 弹出来。
 *
 * 并发: 同 (hostId, agentKind) 只跑一次 install, 通过 inFlightInstall Map 拦截。
 */
export async function ensureRemoteAgentInstalledOrInstall(
  hostId: string,
  agentKind: RemoteAgentKind,
): Promise<InstallResult> {
  // 已装 cache 命中 — 微秒级返回, 不发任何 event
  const cached = remoteAgentInstalledCache.get(hostId);
  if (isAgentCacheHit(cached, agentKind)) {
    return {
      agentKind,
      ready: true,
      nodeReady: true,
      nodeVersion: null,
      installed: true,
      installedVersion: cached?.get(agentKind)?.installedVersion ?? null,
      installDir: '',
      binaryPath: null,
      error: null,
    };
  }

  // 复用 ensureRemoteAgentInstalled 的 stat 检查 (它内部也会写 cache)
  try {
    await ensureRemoteAgentInstalled(hostId, agentKind);
    return {
      agentKind,
      ready: true,
      nodeReady: true,
      nodeVersion: null,
      installed: true,
      installedVersion: null,
      installDir: '',
      binaryPath: null,
      error: null,
    };
  } catch (err) {
    // 只接 SSH_AGENT_NOT_INSTALLED 这条 — 其它 (SSH_NOT_CONNECTED 等) 直接透传抛出
    const code = (err as { code?: string }).code;
    if (code !== 'SSH_AGENT_NOT_INSTALLED') throw err;
  }

  // 并发拦截
  // ⚠️ get → set 之间必须保持纯同步块(无 await):Node 事件循环 FIFO 保证并发
  // 调用者中先到的先 set, 后到的 join in-flight promise。若未来在此插入 await
  // (如 host readiness 复核), 竞争窗口会变成真实并发冲突(R7 并发审计 LOW)。
  const key = inFlightKey(hostId, agentKind);
  const existing = inFlightInstall.get(key);
  if (existing) return existing;

  const host = getPool().get(hostId);
  if (!host) throwIpcError('SSH_HOST_NOT_FOUND', `unknown ssh host: ${hostId}`);
  if (host.getStatus() !== 'ready') {
    throwIpcError('SSH_NOT_CONNECTED', `ssh host ${hostId} not connected`);
  }

  const promise = (async () => {
    log.info('silent-install: starting', { hostId, agentKind });
    broadcastSilentInstallStatus({ hostId, agentKind, phase: 'started' });
    // 累积 install-log / error 行尾, 失败时拼到 toast message — 这样用户看 toast
    // 就能直接看到 "curl: (56) ... 403" 这种关键诊断行, 不用打开 Settings 翻 log。
    // 只保留最后 6 条避免 message 太长 (toast 现已支持 whitespace-pre-wrap 多行)。
    const TAIL_LIMIT = 6;
    const logTail: string[] = [];
    try {
      const result = await installRemoteAgent(host, agentKind, (progress) => {
        // 维护尾部 log 串 — 只收 install-log 行做诊断补充。error event 不收:
        // installer.ts 已经把 ERROR 行的 message 写到 state.error, 失败时作为
        // result.error 透出来当 baseMsg, 这里再 push 就会跟 baseMsg 重复显示。
        if (progress.kind === 'install-log') {
          // 轮 20-V4 HIGH:install-log 行来自远端安装脚本原样输出(stderr/ls/file/
          // head 诊断), 可能含绝对路径/命令片段/文件列表/凭证。所有用户可见出口
          // (toast composedMsg + Settings installLog)统一脱敏后再进 —— 既保诊断
          // 价值(curl 403 这类行), 又不外泄敏感细节。
          const redacted = redactCredentialText(progress.line).slice(0, 500);
          logTail.push(redacted);
          if (logTail.length > TAIL_LIMIT) logTail.shift();
        }
        // (1) 推 INSTALL_PROGRESS — Settings 里 RemoteHostDetail 已订阅, 自动累积
        //     到 installLog, 用户正好打开就能看实时日志。
        broadcastInstallProgress({
          hostId,
          agentKind,
          event: progress.kind === 'install-log'
            ? { ...progress, line: redactCredentialText(progress.line).slice(0, 500) }
            : progress,
        });
        // (2) 推 SILENT_INSTALL_STATUS — toast 状态机切阶段文案。
        broadcastSilentInstallStatus({
          hostId,
          agentKind,
          phase: 'progress',
          eventKind: progress.kind,
        });
      });
      if (!result.ready) {
        const baseMsg = result.error ?? 'install did not reach ready state';
        // 拼上最近 install log 尾, 让 renderer toast 直接显示根因 (curl 403 / 网络等)。
        const composedMsg = logTail.length > 0
          ? `${baseMsg}\n${logTail.join('\n')}`
          : baseMsg;
        log.warn('silent-install: failed (not ready)', { hostId, agentKind, error: composedMsg });
        broadcastSilentInstallStatus({ hostId, agentKind, phase: 'failed', message: composedMsg });
        throwIpcError('SSH_INSTALL_FAILED', composedMsg);
      }
      // 装好后标 cache, 后续 ensureRemoteAgentInstalled 短路返回。
      // pi 记录 install 结果的 installedVersion, 供版本一致判定(R5 H-6)。
      const map = remoteAgentInstalledCache.get(hostId)
        ?? new Map<RemoteAgentKind, { installedVersion: string | null }>();
      map.set(agentKind, { installedVersion: result.installedVersion });
      remoteAgentInstalledCache.set(hostId, map);
      log.info('silent-install: done', { hostId, agentKind });
      broadcastSilentInstallStatus({ hostId, agentKind, phase: 'done' });
      return result;
    } catch (err) {
      // 轮 40-w4-t9 MEDIUM:透传的 code 必须是共享 IpcErrorCode 白名单 ——
      // RpcClient 的内部传输码(STREAM_CLOSED/STREAM_DESTROYED)不在表里,
      // renderer 的 extractIpcError 认不出会变成不可路由的通用失败。
      // 轮 18-U4 HIGH:非白名单 code 收口到 INTERNAL 而非 SSH_INSTALL_FAILED ——
      // daemon/RPC 语义码(SESSION_KILL_SURVIVED / SERVER_BUSY /
      // SESSION_LIMIT_EXCEEDED / STREAM_* / TIMEOUT)是「运行时/传输」错误,
      // 不是安装失败;改写成 SSH_INSTALL_FAILED 会误导调用方走安装重试分支。
      const msg = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: string }).code;
      if (!code || !isIpcErrorCode(code)) {
        log.error('silent-install: unexpected error', { hostId, agentKind, error: msg });
        broadcastSilentInstallStatus({ hostId, agentKind, phase: 'failed', message: msg });
        throwIpcError('INTERNAL', msg);
      }
      // 已有白名单 code (比如上面手动 throwIpcError 走到这) — broadcast 已发, 直接 rethrow
      throw err;
    }
  })();

  inFlightInstall.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlightInstall.delete(key);
  }
}

/** Read ~/.ssh/config and seed the pool. Idempotent — subsequent calls refresh. */
async function ensureHydrated(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      const hosts = await readSshConfig();
      await getPool().hydrate(hosts);
      log.info('ssh hosts hydrated', { count: hosts.length });
    } catch (err) {
      log.warn('failed to read ~/.ssh/config (continuing with empty pool)', {
        error: String(err),
      });
      // Don't throw — empty pool is a valid starting state.
    }
  })();
  return initPromise;
}

/**
 * Snapshot wrapper used in IPC payloads. `HostSnapshot` lives in the
 * transport-only package (@cindy/maker-remote-ssh) and stays free of
 * desktop-side prefs; we wrap it here so renderer gets autoConnect +
 * agentProxy (+ tunnel 实时状态) in a single round-trip instead of having
 * to call a second IPC per row.
 */
export type HostSnapshotWithPrefs = HostSnapshot & {
  autoConnect: boolean;
  /** 未开启 / 未配置 → null。 */
  agentProxy: SshHostAgentProxyPref | null;
  /** 隧道实时状态 (仅内存); pref 关闭或无记录 → null。 */
  agentProxyTunnel: AgentProxyTunnelState | null;
};

function withPrefs(snapshot: HostSnapshot): HostSnapshotWithPrefs {
  const id = snapshot.config.id;
  return {
    ...snapshot,
    autoConnect: getSshHostAutoConnect(id),
    agentProxy: getSshHostAgentProxy(id),
    agentProxyTunnel: getAgentProxyTunnelState(id),
  };
}

function broadcastStatus(snapshot: HostSnapshot): void {
  const payload = withPrefs(snapshot);
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(REMOTE_SSH_PUSH.STATUS_CHANGED, payload);
  }
}

function normalizeAgentProxyInput(raw: unknown): SshHostAgentProxyPref | null | undefined {
  if (raw === undefined) return undefined; // 调用方没提这个字段 — 不动现有 pref
  if (raw === null) return null; // 显式关闭
  const obj = requireObject(raw, 'agentProxy');
  const enabled = obj.enabled === true;
  if (!enabled) return null;
  const mode = obj.mode === 'env' ? 'env' : 'tunnel'; // 缺省 tunnel (旧 renderer 兼容)
  if (mode === 'env') {
    const proxyUrl = normalizeAgentProxyUrl(obj.proxyUrl);
    if (!proxyUrl) {
      throwIpcError(
        'INVALID_PARAMS',
        'agentProxy.proxyUrl must be a remote-reachable http(s)/socks5 URL without whitespace/quotes, e.g. http://127.0.0.1:7890',
      );
    }
    return { enabled: true, mode: 'env', proxyUrl };
  }
  const localHost = requireString(obj.localHost, 'agentProxy.localHost').trim();
  // localHost 是本机隧道转发目标 (net.connect 的目的地; 远端 env 永远指向
  // 127.0.0.1:<隧道口>, 不含这个值)。空白/引号在这里虽无注入面, 但必然是
  // 用户填错 — 直接拒, 免得隧道建起来却转到一个荒诞地址 (review: PR #715
  // copilot R3 注释修正)。
  if (!localHost || /\s/.test(localHost) || localHost.includes("'") || localHost.includes('"')) {
    throwIpcError('INVALID_PARAMS', 'agentProxy.localHost must be a plain host (no whitespace/quotes), e.g. 127.0.0.1');
  }
  const localPort = typeof obj.localPort === 'number' && Number.isInteger(obj.localPort) && obj.localPort > 0 && obj.localPort < 65536
    ? obj.localPort
    : NaN;
  if (!Number.isInteger(localPort)) {
    throwIpcError('INVALID_PARAMS', 'agentProxy.localPort must be an integer in 1..65535');
  }
  // 固定远端端口 — env 静态化的关键; 旧 renderer 不传时沿用迁移缺省。
  const remotePortRaw = obj.remotePort === undefined ? LEGACY_AGENT_PROXY_REMOTE_PORT : obj.remotePort;
  if (!isAllowedAgentProxyRemotePort(remotePortRaw)) {
    throwIpcError('INVALID_PARAMS', 'agentProxy.remotePort must be an integer in 1024..65535 (privileged/service ports are rejected)');
  }
  return { enabled: true, mode: 'tunnel', localHost, localPort, remotePort: remotePortRaw };
}

function normalizeAddInput(raw: unknown): AddHostInput & { agentProxy?: SshHostAgentProxyPref | null } {
  const obj = requireObject(raw, 'host');
  const id = requireString(obj.id, 'id').trim();
  // Alias must be safe to drop into ~/.ssh/config Host directive.
  if (/\s/.test(id) || id.includes('*') || id.includes('?') || id.startsWith('!')) {
    throwIpcError('INVALID_PARAMS', 'id must not contain whitespace or wildcards');
  }
  const hostname = requireString(obj.hostname, 'hostname').trim();
  const user = requireString(obj.user, 'user').trim();
  const port = typeof obj.port === 'number' && Number.isInteger(obj.port) && obj.port > 0 && obj.port < 65536
    ? obj.port
    : 22;
  const authMethod = obj.authMethod === 'key' ? 'key' as const : 'agent' as const;
  // identityFile is meaningful for both modes:
  //   key   → required, the private key file we read directly
  //   agent → optional, when set it pins the agent to that one key
  //           (FilteredAgent — solves MaxAuthTries with busy agents)
  const identityFile = typeof obj.identityFile === 'string' && obj.identityFile.trim()
    ? expandHome(obj.identityFile.trim())
    : undefined;
  if (authMethod === 'key' && !identityFile) {
    throwIpcError('INVALID_PARAMS', 'identityFile required when authMethod is "key"');
  }
  const agentProxy = normalizeAgentProxyInput(obj.agentProxy);
  return { id, hostname, port, user, authMethod, identityFile, ...(agentProxy !== undefined ? { agentProxy } : {}) };
}

export function registerRemoteSshIpc(): void {
  if (registered) return;
  registered = true;

  // Wire pool status → renderer broadcast (once, at registration time).
  // ready 转换时顺带应用 agent-proxy 愿望 (建隧道 + codex env 对账): 这是
  // 所有路径 (手动 connect / autoConnect / 断线重连) 的统一点, 失败只落
  // tunnel state 不阻断连接, session 路径会显式重试。
  getPool().onAnyStatus((snap) => {
    if (snap.status === 'ready') {
      broadcastStatus(snap);
      const host = getPool().get(snap.config.id);
      if (host) void applyAgentProxyForHost(host);
    } else {
      // 主连接断连 / 重连中: 隧道保活挂起 (存活的独立隧道连接不拆 — 它
      // 可能还在正常服务 LLM 流量); 主连接恢复 ready 时上面的 apply 恢复
      // 保活。状态帧由 keeper 经 onState 汇报, 不在这里手工翻转。
      handleAgentProxyMainHostDown(snap.config.id);
      const host = getPool().get(snap.config.id);
      broadcastStatus(host ? host.snapshot() : snap);
    }
  });
  // agent-proxy 内部状态 (隧道成败 / 端口) 变化 → 推一版最新 snapshot,
  // 让 detail 面板的隧道状态行即时刷新。隧道走独立 SSH 连接 (与控制面
  // 隔离, 大流量不拖累 MCP/transport), 共享同一个 host-key store。
  initAgentProxy({
    broadcast: (hostId) => {
      const host = getPool().get(hostId);
      if (host) broadcastStatus(host.snapshot());
    },
    createTunnelHost: (cfg) =>
      new RemoteHost(cfg, { logger: poolLogger, hostKeys: getSharedHostKeyStore() }),
    getMainHost: (hostId) => getPool().get(hostId) ?? null,
  });

  ipcMain.handle(REMOTE_SSH_INVOKE.LIST, async () => {
    await ensureHydrated();
    return { hosts: getPool().list().map(withPrefs) };
  });

  ipcMain.handle(REMOTE_SSH_INVOKE.RELOAD_CONFIG, async () => {
    try {
      const hosts = await readSshConfig();
      await getPool().hydrate(hosts);
      return { hosts: getPool().list().map(withPrefs) };
    } catch (err) {
      throwIpcError('SSH_CONFIG_IO_FAILED', `read ~/.ssh/config failed: ${String(err)}`);
    }
  });

  ipcMain.handle(REMOTE_SSH_INVOKE.ADD, async (_event, rawHost: unknown) => {
    const input = normalizeAddInput(rawHost);
    const cfg: HostConfig = {
      id: input.id,
      hostname: input.hostname,
      port: input.port ?? 22,
      user: input.user,
      authMethod: input.authMethod ?? 'agent',
      identityFile: input.identityFile,
      source: 'manual',
    };

    const existing = getPool().get(cfg.id);
    if (existing) {
      throwIpcError('ALREADY_EXISTS', `host already exists: ${cfg.id}`);
    }

    try {
      await upsertHost(cfg);
    } catch (err) {
      throwIpcError('SSH_CONFIG_IO_FAILED', `write ~/.ssh/config failed: ${String(err)}`);
    }

    const host = getPool().add(cfg);
    if (input.agentProxy !== undefined) {
      setSshHostAgentProxy(cfg.id, input.agentProxy);
    }
    // 轮 40-w4-t8 HIGH:host 配置变更(凭证/端点相关)成功路径需审计。
    log.info('audit: remote ssh host added', {
      operation: 'remote_ssh_host_add',
      hostId: cfg.id,
      hostname: cfg.hostname,
      user: cfg.user,
      port: cfg.port ?? null,
      authMethod: cfg.authMethod ?? null,
    });
    return { host: withPrefs(host.snapshot()) };
  });

  ipcMain.handle(REMOTE_SSH_INVOKE.UPDATE, async (_event, rawHost: unknown) => {
    const input = normalizeAddInput(rawHost);
    const existing = getPool().get(input.id);
    if (!existing) {
      throwIpcError('SSH_HOST_NOT_FOUND', `unknown host: ${input.id}`);
    }
    // Edit is allowed regardless of source. We update only the directives
    // xdt-maker owns (HostName / User / Port / IdentityFile / IdentitiesOnly)
    // and leave everything else in the block (ProxyJump / ServerAliveInterval /
    // comments / ...) untouched — see updateHostFields. `source` is a
    // disk-vs-UI provenance hint only; after a restart, hydrate() flips
    // every host back to 'ssh-config' so the old "manual only" gate
    // would lock out everything the user had just added.
    const cfg: HostConfig = {
      id: input.id,
      hostname: input.hostname,
      port: input.port ?? 22,
      user: input.user,
      authMethod: input.authMethod ?? 'agent',
      identityFile: input.identityFile,
      // Preserve original source — editing doesn't change provenance.
      source: existing.config.source,
    };

    // 仅当连接字段真的变了才断开 — 只改 agentProxy 偏好不该打断正在用的
    // SSH 连接 (隧道/会话都在上面)。
    const prev = existing.config;
    const connectionFieldsChanged =
      prev.hostname !== cfg.hostname ||
      prev.user !== cfg.user ||
      prev.port !== cfg.port ||
      prev.authMethod !== cfg.authMethod ||
      prev.identityFile !== cfg.identityFile;
    // 轮 42 P1(codex-connector):引用检查必须在 disconnect **之前** ——
    // 有活跃会话时编辑被拒绝, 但断开已发生会中断正在用的会话/隧道。
    if (connectionFieldsChanged) {
      try {
        const db = getDbClient().drizzle;
        const refs = await db
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.remoteHostId, input.id))
          .limit(1);
        if (refs.length > 0) {
          throwIpcError(
            'PRECONDITION_FAILED',
            `host "${input.id}" 仍被远端会话引用 — 修改连接字段会重定向到新机器, 请先迁移这些会话, 或保留原配置`,
          );
        }
      } catch (err) {
        if ((err as { code?: string })?.code === 'PRECONDITION_FAILED') throw err;
        throwIpcError(
          'INTERNAL',
          `host "${input.id}" 引用检查失败, 未修改 — 请重试: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // 轮 42 P1(codex-connector):旧 host 的 Pi daemon 清理必须在 disconnect
    // **之前** —— cleanupRemotePiDaemonsOnHost 内部用 RemoteHost.exec()
    // (piManagerList/probe), exec 立即 requireReady(), 断开的 host 会抛错。
    // 顺序: 引用检查 → 清理旧 daemon(连接还在) → 清 cache → disconnect。
    if (connectionFieldsChanged) {
      // 无活跃会话引用 → 清理旧 host 的 Pi daemon(含凭证 env-file)。
      if (existing.getStatus() === 'ready') {
        await cleanupRemotePiDaemonsOnHost(existing).catch(() => undefined);
      }
      remoteAgentInstalledCache.delete(input.id);
      clearCcManagerInstallCache(input.id);
      invalidateRemotePiPathCaches(input.id);
    }
    if (connectionFieldsChanged && existing.getStatus() !== 'disconnected') {
      await existing.disconnect();
    }

    try {
      await updateHostFields(cfg);
    } catch (err) {
      throwIpcError('SSH_CONFIG_IO_FAILED', `update ~/.ssh/config failed: ${String(err)}`);
    }
    existing.updateConfig(cfg);

    // agentProxy 偏好: 写盘 + host 活着就立即应用 (建/拆隧道 + codex daemon
    // env 对账)。host 未连时只落 pref, 下次 ready 时由 ready hook 应用。
    if (input.agentProxy !== undefined) {
      setSshHostAgentProxy(cfg.id, input.agentProxy);
      if (existing.getStatus() === 'ready') {
        await applyAgentProxyForHost(existing);
      }
    }
    // 轮 40-w4-t8 HIGH:update(端点/凭证字段可能变更)成功路径需审计。
    log.info('audit: remote ssh host updated', {
      operation: 'remote_ssh_host_update',
      hostId: cfg.id,
      connectionFieldsChanged,
      hostname: cfg.hostname,
      user: cfg.user,
      port: cfg.port ?? null,
      authMethod: cfg.authMethod ?? null,
    });
    return { host: withPrefs(existing.snapshot()) };
  });

  ipcMain.handle(REMOTE_SSH_INVOKE.REMOVE, async (_event, args: unknown) => {
    const obj = requireObject(args);
    const id = requireString(obj.id, 'id');

    const host = getPool().get(id);
    if (!host) {
      throwIpcError('SSH_HOST_NOT_FOUND', `unknown host: ${id}`);
    }

    // 轮 40-w4-t15 HIGH:host 被活跃 PI remote 会话引用时 fail-closed 拒绝删除
    // —— 否则 sessions.remote_host_id 悬空, 会话永久指向不可达 alias, 恢复
    // 稳定失败(UI 建议的 remove+readd 改名路径正是踩这个坑)。提示用户先迁移
    // 会话或保留该 host。
    try {
      const db = getDbClient().drizzle;
      const refs = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.remoteHostId, id))
        .limit(1);
      if (refs.length > 0) {
        throwIpcError(
          'PRECONDITION_FAILED',
          `host "${id}" 仍被远端会话引用 — 请先在设置中迁移这些会话, 或保留该 host`,
        );
      }
    } catch (err) {
      if ((err as { code?: string })?.code === 'PRECONDITION_FAILED') throw err;
      // 轮 42 P2(codex-connector):DB 查询失败也 fail-closed —— 无法证明没有
      // 会话引用该 host 时继续删, 会留下悬空 remote_host_id(会话永久不可恢复)。
      // 查询失败 ≠ 可以跳过引用守卫; 报错让用户重试(删错不可逆, 删不了可重试)。
      throwIpcError(
        'INTERNAL',
        `host "${id}" 引用检查失败, 未删除 — 请重试: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Only strip the config block when the host was added via maker. Hosts
    // imported from existing ~/.ssh/config are left intact — the user owns
    // that file; we don't yank entries they wrote themselves.
    if (host.config.source === 'manual') {
      try {
        await removeHostFromConfig(id);
      } catch (err) {
        throwIpcError('SSH_CONFIG_IO_FAILED', `strip ~/.ssh/config failed: ${String(err)}`);
      }
    }

    // 清理远端 pi daemon 会话(host 移除后 setsid daemon 仍会跑,孤儿进程 —
    // R1 安装 M4)。**必须在 getPool().remove(id) 之前** —— remove 后 pool 里
    // 拿不到 host, 清理永不执行(R4-4 问题 2: 之前的实现是死代码)。
    // best-effort:daemon 脚本未上传/未连接则跳过。
    if (host.getStatus() === 'ready') {
      try {
        // host remove 前先 soft-close 该 host 上活跃的 pi 会话:直接 kill
        // daemon 会让本地 session 收到"意外退出"式 error, 干净关闭避免
        // crash-like UX(R6 审计 M-10, 对齐 CC 的 softCloseCcSessionsForHost)。
        await softClosePiSessionsForHost(id);
      } catch (err) {
        log.warn('pi session soft-close before host remove failed (non-fatal)', {
          hostId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        await cleanupRemotePiDaemonsOnHost(host);
      } catch (err) {
        log.warn('pi daemon cleanup on host remove failed (non-fatal)', {
          hostId: id,
          error: String((err as Error)?.message ?? err),
        });
      }
    } else {
      // host 已断开:kill 命令发不出去, 残留由 daemon 空闲超时兜底回收
      // (R6 审计 F7/M-5 —— 不能静默, 留日志便于诊断)。
      log.warn('host not connected — pi daemon cleanup skipped; remote daemons will be reclaimed by idle timeout', {
        hostId: id,
      });
    }
    await getPool().remove(id);
    // 同步清掉 prefs 里的孤儿 autoConnect 标志, 避免后续重新 add 同名 host 时
    // 拿到旧偏好造成"莫名其妙又自动连了"。同步清 agent install cache、agent
    // proxy 隧道状态与 per-host MCP 转发端口记录。
    removeSshHostPref(id);
    clearAgentProxyTunnelState(id);
    removeRemoteMcpForwardPref(id);
    remoteAgentInstalledCache.delete(id);
    clearCcManagerInstallCache(id);
    // 轮 40-w4-t4 MEDIUM:清 pi 远端路径 cache —— 否则同名 host 重建(不同
    // user/home/port)会串到旧远端路径。
    invalidateRemotePiPathCaches(id);
    // 轮 40-w4-t8 HIGH:host 移除(剥离配置 + 清理 daemon)成功路径需审计。
    log.info('audit: remote ssh host removed', {
      operation: 'remote_ssh_host_remove',
      hostId: id,
    });
    return { ok: true as const };
  });

  ipcMain.handle(REMOTE_SSH_INVOKE.CONNECT, async (_event, args: unknown) => {
    const obj = requireObject(args);
    const id = requireString(obj.id, 'id');

    const host = getPool().get(id);
    if (!host) {
      throwIpcError('SSH_HOST_NOT_FOUND', `unknown host: ${id}`);
    }

    try {
      await getPool().connect(id);
    } catch (err) {
      // classifyConnectFailure produces SSH_AUTH_FAILED | SSH_KEY_FILE_NOT_FOUND
      // | SSH_CONNECT_FAILED. RemoteHost rewrites auth failures to actionable
      // text (ssh-copy-id hint) verbatim so the toast matches the host-row
      // subtitle; a local identityFile ENOENT is classified off `.code`.
      const { code, msg } = classifyConnectFailure(err);
      throwIpcError(code, msg);
    }

    return { host: getPool().get(id)?.snapshot() ?? null };
  });

  ipcMain.handle(REMOTE_SSH_INVOKE.DISCONNECT, async (_event, args: unknown) => {
    const obj = requireObject(args);
    const id = requireString(obj.id, 'id');
    // 显式断开 = 切断这台机器的全部 SSH 连通 — 独立隧道连接一并拆
    // (与断线/重连的 pause 语义区分, review: PR #992 codex-connector P1)。
    await teardownAgentProxyOnUserDisconnect(id).catch((err) => {
      log.warn('agent-proxy tunnel teardown on user disconnect failed', {
        hostId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    // 显式断开 = 用户主动放弃该 host:先 soft-close 本 host 活跃 pi 会话(干净
    // 关闭, 本地 session 收正常 exit 而非 crash-like error —— 轮 9 发现 1,
    // 与 REMOVE 路径对齐), 再兜底清理 daemon 残留(soft-close 失败时 daemon
    // 继续跑 + env-file 凭证残留 —— R6 审计 M-5)。网络波动走 pause/reconnect
    // 路径, 不触发 DISCONNECT, 不会误杀持久会话(轮 9 发现 4 语义澄清)。
    const host = getPool().get(id);
    if (host?.getStatus() === 'ready') {
      try {
        await softClosePiSessionsForHost(id);
      } catch (err) {
        log.warn('pi session soft-close before disconnect failed (non-fatal)', {
          hostId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        await cleanupRemotePiDaemonsOnHost(host);
      } catch (err) {
        log.warn('pi daemon cleanup on user disconnect failed (idle timeout will reclaim)', {
          hostId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    await getPool().disconnect(id);
    return { host: getPool().get(id)?.snapshot() ?? null };
  });

  // ── Phase B: agent on remote ─────────────────────────────────────────────

  ipcMain.handle(REMOTE_SSH_INVOKE.PROBE_AGENT, async (_event, args: unknown) => {
    const { host, agentKind } = pickHostAndAgent(args);
    try {
      const probe = await probeRemoteAgent(host, agentKind);
      return { probe };
    } catch (err) {
      throwIpcError('SSH_EXEC_FAILED', `probe failed: ${String((err as Error).message ?? err)}`);
    }
  });

  ipcMain.handle(REMOTE_SSH_INVOKE.INSTALL_AGENT, async (event, args: unknown) => {
    const { host, agentKind } = pickHostAndAgent(args);
    const sender = event.sender;
    // 与 silent install 共享并发锁(inFlightInstall):手动安装与 silent 并发时
    // await 同一个安装, 避免两个 PI_INSTALL_SH 并发跑损坏安装(R4-1 R3 / R4-4 问题1)。
    const key = inFlightKey(host.id, agentKind);
    const existing = inFlightInstall.get(key);
    if (existing) {
      const joined = await existing;
      // 轮 42 P2:join 已有安装也要带 result(renderer 读 result.*)。
      return { ok: true as const, result: joined } as const;
    }
    const promise: Promise<InstallResult> = (async () => {
      const result = await installRemoteAgent(host, agentKind, (progress) => {
        if (sender.isDestroyed()) return;
        sender.send(REMOTE_SSH_PUSH.INSTALL_PROGRESS, {
          hostId: host.id,
          agentKind,
          event: progress,
        } satisfies InstallProgressPushPayload);
      });
      if (!result.ready) {
        throwIpcError('SSH_INSTALL_FAILED', result.error ?? 'install did not reach ready state');
      }
      return result;
    })();
    let installResult: InstallResult | undefined;
    inFlightInstall.set(key, promise);
    try {
      installResult = await promise;
    } finally {
      inFlightInstall.delete(key);
    }
    // 装好后清 cache, 下次 maker:send 前置检查会重 stat 一次确认。
    remoteAgentInstalledCache.get(host.id)?.delete(agentKind);

    try {
      // claude-code 远端走 cc-mgr daemon —— 装完 CLI 顺手把 cc-mgr.mjs bundle 也
      // 推上去, 让 Settings「已安装」就 = 真能跑 remote cc。否则用户首次发消息时
      // 仍要 silent install pipeline 跑一遍, 体感上 Settings 显示装好但发消息又
      // 卡几秒 toast, 语义不一致。
      // 用 ensureCcManagerInstalledOrInstall: 幂等 (已最新版本直接 ~80ms 返回),
      // 失败不阻断主结果 — installRemoteAgent 已经把 npm CLI 装好了, cc-mgr 缺失
      // 不影响"用户可以 fall back 到 silent install 那条路", 只是失去了"settings
      // 一站式" 的优势。所以失败时只 log warn + push 进度提示, 不 throwIpc。
      if (agentKind === 'claude-code') {
        try {
          await ensureCcManagerInstalledOrInstall({ host });
        } catch (err) {
          log.warn('INSTALL_AGENT: cc-mgr piggy-back install failed (CLI still installed)', {
            hostId: host.id,
            error: String((err as Error)?.message ?? err),
          });
        }
      }

      // 轮 42 P2:成功必须带 result —— renderer 的 RemoteHostDetail.install()
      // 读 result.nodeVersion/installed/installedVersion, 缺失会让安装成功却
      // 落进 catch 报 TypeError(UI 误报失败)。
      return { ok: true as const, result: installResult } as const;
    } catch (err) {
      // Distinguish "already an IPC error" (don't double-wrap) from transport errors.
      if (err instanceof Error && (err as { code?: string }).code) throw err;
      throwIpcError('SSH_INSTALL_FAILED', String((err as Error).message ?? err));
    }
  });

  ipcMain.handle(REMOTE_SSH_INVOKE.UNINSTALL_AGENT, async (_event, args: unknown) => {
    const { host, agentKind } = pickHostAndAgent(args);
    try {
      // pi:卸载前先清理 daemon 会话(installer 内部已先 kill 再 rm, 这里是
      // 双保险 —— 确保 env-file/进程都清掉, 不留"用户以为卸载了但 daemon
      // 还在跑"的残留窗口, R6 审计 M-6)。best-effort 失败不阻断 uninstall。
      if (agentKind === 'pi') {
        try {
          await cleanupRemotePiDaemonsOnHost(host);
        } catch (err) {
          log.warn('pi daemon cleanup before uninstall failed (installer will re-attempt)', {
            hostId: host.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      await uninstallRemoteAgent(host, agentKind);
      // 卸载后清 cache, 避免下次 send 命中 stale "已装" 跳过检查。
      remoteAgentInstalledCache.get(host.id)?.delete(agentKind);
      return { ok: true as const };
    } catch (err) {
      throwIpcError('SSH_EXEC_FAILED', String((err as Error).message ?? err));
    }
  });

  ipcMain.handle(REMOTE_SSH_INVOKE.RUN_AGENT_ONE_SHOT, async (_event, args: unknown) => {
    const obj = requireObject(args);
    const id = requireString(obj.id, 'id');
    const agentKind = requireEnum(obj.agentKind, VALID_AGENT_KINDS, 'agentKind');
    const prompt = requireString(obj.prompt, 'prompt');
    const host = requireConnectedHost(id);

    // Verify agent is installed first so we can give a precise error.
    const probe = await probeRemoteAgent(host, agentKind);
    if (!probe.installed || !probe.binaryPath) {
      throwIpcError(
        'SSH_AGENT_NOT_INSTALLED',
        `${agentKind} is not installed on ${id}; click Install first`,
      );
    }

    // Claude: inject local API key + upstream endpoint via STDIN (not cmd
    // args) — see claude-env.ts header for security model. Codex relies on
    // ~/.codex/auth.json on the remote (synced via "Sync auth").
    //
    // agentProxy pref 开启时把代理 env 一并注入 (quick test 因此同时验证
    // 代理链路是否可用): claude 走 envBlock (gatekeeper 只收大写), codex
    // 的 wrapper 统一 source agent-proxy.env marker, 与 daemon 行为一致。
    let envBlock: string | null = null;
    if (agentKind === 'claude-code') {
      const env = getRemoteClaudeEnv();
      if (!env) {
        throwIpcError(
          'SSH_AGENT_NOT_INSTALLED',
          'Cindy AI is not connected in Cindy; connect it in Settings → Model Providers first',
        );
      }
      // tunnel 模式内部会等隧道 armed (超时抛错, fail-closed 不静默直连);
      // env 模式直接注入用户给的 URL。
      const proxyEnv = await getRemoteAgentProxyEnvUppercase(host);
      const envWithProxy = proxyEnv ? { ...env, ...proxyEnv } : env;
      envBlock = serializeEnvBlock(envWithProxy);
    } else if (agentKind === 'pi') {
      // pi one-shot:远端临时生成 models.json(上游端点 + 网关 key 经 env 注入,不落盘),
      // `pi --print` 跑一轮。models.json 只含 `cindy` provider,与真实远端会话同源
      // (上游端点 + $CINDY_PI_API_KEY 插值,密钥不进远端磁盘)。
      const apiKey = readClaudeApiKey();
      const endpoint = claudeUpstreamEndpoint().trim();
      if (!apiKey || !endpoint) {
        throwIpcError(
          'SSH_AGENT_NOT_INSTALLED',
          'Cindy AI is not connected in Cindy; connect it in Settings → Model Providers first',
        );
      }
      // heredoc 注入防御:endpoint 进 bash heredoc(<<'PIEOF'),含换行会提前终止
      // heredoc 改变后续内容语义(R5 安全审计 M-2)。endpoint 来源受信(网关配置),
      // 这里是纵深防御 —— URL 本身不可能含换行。
      if (/[\r\n]/.test(endpoint)) {
        throwIpcError('SSH_EXEC_FAILED', 'pi endpoint contains newline — refusing to build remote models.json');
      }
      const modelsDir = '$HOME/.xdt-server/v1/pi-oneshot';
      // models.json 经 bash heredoc 写远端(内容无密钥;key 走 env 插值)。
      const modelsJson = JSON.stringify({
        providers: {
          cindy: {
            baseUrl: endpoint,
            api: 'anthropic-messages',
            apiKey: '$CINDY_PI_API_KEY',
            models: [{ id: 'dummy-quick', name: 'Quick Test' }],
          },
        },
      });
      const mkModelsCmd = [
        `mkdir -p ${modelsDir}`,
        `cat > ${modelsDir}/models.json <<'PIEOF'`,
        modelsJson,
        'PIEOF',
      ].join('\n');
      const mkResult = await host.exec(`bash -c ${shellQuoteSh(mkModelsCmd)}`, {
        timeoutMs: 15_000,
        label: 'pi-oneshot-mkmodels',
      });
      if (mkResult.exitCode !== 0) {
        throwIpcError('SSH_EXEC_FAILED', `pi models.json write failed: ${mkResult.stderr.trim().slice(0, 200)}`);
      }
      const proxyEnv = await getRemoteAgentProxyEnvUppercase(host);
      envBlock = serializeEnvBlock({
        CINDY_PI_API_KEY: apiKey,
        PI_CODING_AGENT_DIR: modelsDir,
        ...(proxyEnv ?? {}),
      });
    } else {
      // codex one-shot: wrapper 读的是 marker 文件而非直接 env — 先跑
      // reconcile (marker 对账), 保证 quick test 与真实 daemon 链路一致。
      // markerChanged && !daemonRestarted = 旧 daemon 活着跑旧 env, marker 已
      // 回滚 — one-shot 若继续会 source 不到新 proxy marker 而直连, 与
      // daemon-probe 路径的 fail-closed 不一致 (codex R12 P1): 显式失败。
      // deferredForLiveTurn = 有远端任务在跑, 对账推迟 — quick test 会以
      // 旧 env 运行, 提示用户稍后再试而不是 mid-turn 杀 daemon。
      const reconciled = await reconcileCodexAgentProxyEnv(host);
      if (reconciled.deferredForLiveTurn) {
        throwIpcError(
          'INTERNAL',
          'agent-proxy settings changed while a remote turn is running; quick test deferred — retry after the current task finishes',
        );
      }
      if (reconciled.markerChanged && !reconciled.daemonRestarted) {
        throwIpcError(
          'INTERNAL',
          'codex daemon survived pkill after agent-proxy env change; quick test would run with the wrong network route (retry or restart the host)',
        );
      }
    }

    const cmd = oneShotCommand(agentKind, probe.binaryPath, envBlock != null);
    // STDIN protocol when envBlock present: <KEY=value>\n...\n\n<prompt>
    //                       when absent:    <prompt>
    // Note: serializeEnvBlock returns lines joined with '\n' (no trailing
    // newline). We append '\n\n' so bash sees: last-env-line\n, then \n
    // (the blank-line separator that `read` returns as empty -> break),
    // then the prompt for claude to consume via exec'd stdin inheritance.
    const input = envBlock != null ? `${envBlock}\n\n${prompt}` : prompt;
    const started = Date.now();
    try {
      const result = await host.exec(cmd, {
        input,
        // Real one-shot can take a while (model latency); cap at 2 minutes.
        timeoutMs: 120_000,
        label: `${agentKind} one-shot`,
      });
      return {
        result: {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          signal: result.signal,
          durationMs: Date.now() - started,
        },
      };
    } catch (err) {
      throwIpcError('SSH_EXEC_FAILED', String((err as Error).message ?? err));
    }
  });

  // ── Codex auth sync (Phase B+) ───────────────────────────────────────────

  ipcMain.handle(REMOTE_SSH_INVOKE.CHECK_CODEX_AUTH, async (_event, args: unknown) => {
    const obj = requireObject(args);
    const id = requireString(obj.id, 'id');
    const host = requireConnectedHost(id);

    const localAuthPath = await resolveLocalCodexAuthPath();
    const localExists = localAuthPath != null;
    let remote: CodexAuthState;
    try {
      remote = await checkRemoteCodexAuth(host);
    } catch (err) {
      throwIpcError('SSH_EXEC_FAILED', `check remote codex auth failed: ${String((err as Error).message ?? err)}`);
    }
    return {
      localExists,
      remoteExists: remote.remoteExists,
      remoteMtime: remote.remoteMtime,
    };
  });

  ipcMain.handle(REMOTE_SSH_INVOKE.SYNC_CODEX_AUTH, async (_event, args: unknown) => {
    const obj = requireObject(args);
    const id = requireString(obj.id, 'id');
    const host = requireConnectedHost(id);

    const localAuthPath = await resolveLocalCodexAuthPath();
    if (!localAuthPath) {
      throwIpcError(
        'SSH_AGENT_NOT_INSTALLED',
        'no local Codex auth.json found; log in via Cindy (or `codex login`) first',
      );
    }

    let content: string;
    try {
      content = await fs.readFile(localAuthPath, 'utf-8');
    } catch (err) {
      throwIpcError('INTERNAL', `failed to read local Codex auth: ${String((err as Error).message ?? err)}`);
    }

    try {
      await pushRemoteCodexAuth(host, content);
    } catch (err) {
      throwIpcError('SSH_EXEC_FAILED', `push to remote failed: ${String((err as Error).message ?? err)}`);
    }

    // 推完 auth 还得 kill 远端 codex app-server daemon 进程: daemon 启动时 in-memory
    // 缓存 auth.json 内容, 不支持 hot-reload — 文件更新了 daemon 仍用空 auth, 用户
    // Retry 还是撞同一个 401。pkill 杀掉后, desktop 端下次 send 走 ensureStarted →
    // `daemon version` 探活失败 → bootstrap 新 daemon → 读到新 auth.json → 成功。
    //
    // pkill 实现抽成了共享 helper (agent-proxy.ts:killRemoteCodexDaemon) —
    // agent-proxy 的 env marker 漂移时也要走同一条 daemon 重启路径。pattern 的
    // 设计考量 ([c]odex 自排除 / .xdt-server 路径限定 / id -un 取用户) 见 helper 注释。
    //
    // pkill 失败时不再 silently swallow — propagate 给 renderer 显示软提示 "auth
    // 已推上去, 但 daemon 没重启成功, 要 reconnect / 手动重启 daemon 后才能用新
    // auth"。auth.json 已成功落盘所以 ok=true; daemonRestart 字段告诉 renderer
    // 是否需要降级显示。
    const daemonRestart = await killRemoteCodexDaemon(host);
    if (!daemonRestart.ok) {
      log.warn('failed to kill remote codex daemon after auth sync (auth.json pushed ok, but daemon may still use old auth)', {
        hostId: id,
        detail: daemonRestart.detail,
      });
    }

    // 轮 40-w4-t8 CRITICAL:凭证复制到远端是敏感操作 —— 成功路径必须有审计
    // 记录(何时/哪个 host/daemon 重启结果), 否则安全复盘无法区分用户主动同步
    // vs 误触发/未授权调用。禁止记录 auth 内容/token 原文。
    log.info('audit: remote codex auth synced', {
      operation: 'remote_codex_auth_sync',
      hostId: id,
      hostname: host.snapshot()?.config?.hostname ?? null,
      user: host.snapshot()?.config?.user ?? null,
      port: host.snapshot()?.config?.port ?? null,
      authBytes: content.length,
      daemonRestartOk: daemonRestart.ok,
    });

    return { ok: true as const, daemonRestart };
  });

  // ── SSH key setup wizard (Phase B++) ────────────────────────────────────
  //
  // Backed by ssh-keys.ts. None of these IPCs read private key contents;
  // the wizard works on metadata + pubkey content only.

  ipcMain.handle(REMOTE_SSH_INVOKE.LIST_LOCAL_KEYS, async () => {
    try {
      const keys = await listLocalSshKeys();
      return { keys };
    } catch (err) {
      throwIpcError('INTERNAL', `list local keys failed: ${String((err as Error).message ?? err)}`);
    }
  });

  ipcMain.handle(REMOTE_SSH_INVOKE.GENERATE_KEY, async (_event, args: unknown) => {
    const obj = requireObject(args);
    const name = typeof obj.name === 'string' ? obj.name : undefined;
    const comment = typeof obj.comment === 'string' ? obj.comment : undefined;
    const passphrase = typeof obj.passphrase === 'string' ? obj.passphrase : undefined;
    try {
      const result = await generateNewKey({ name, comment, passphrase });
      // If user gave a passphrase, immediately register the key with the
      // ssh-agent (we have the passphrase in hand) so they don't have to
      // do `ssh-add` themselves. We swallow agent failures into the result
      // so the UI can show "key generated but not added to agent" + hint.
      const addRes = await addKeyToAgent({
        privateKeyPath: result.privateKeyPath,
        passphrase,
      });
      return {
        result,
        agentLoaded: addRes.success,
        agentErrorHint: addRes.errorHint,
        agentFailureReason: addRes.failureReason,
      };
    } catch (err) {
      throwIpcError(
        'INTERNAL',
        `ssh-keygen failed: ${String((err as Error).message ?? err)}`,
      );
    }
  });

  ipcMain.handle(REMOTE_SSH_INVOKE.ADD_KEY_TO_AGENT, async (_event, args: unknown) => {
    const obj = requireObject(args);
    const privateKeyPath = requireString(obj.privateKeyPath, 'privateKeyPath');
    const passphrase = typeof obj.passphrase === 'string' ? obj.passphrase : undefined;
    // We deliberately return success/failure as a structured value rather
    // than throwIpcError — `addKeyToAgent` already classifies common
    // failures into actionable hints. Renderer surfaces the hint as a toast.
    const result = await addKeyToAgent({ privateKeyPath, passphrase });
    return { result };
  });

  ipcMain.handle(REMOTE_SSH_INVOKE.READ_PUBKEY, async (_event, args: unknown) => {
    const obj = requireObject(args);
    const pubkeyPath = requireString(obj.pubkeyPath, 'pubkeyPath');
    try {
      const content = await readPubkey(pubkeyPath);
      return { content };
    } catch (err) {
      throwIpcError('NOT_FOUND', `read pubkey failed: ${String((err as Error).message ?? err)}`);
    }
  });

  ipcMain.handle(REMOTE_SSH_INVOKE.BUILD_INSTALL_CMD, async (_event, args: unknown) => {
    const obj = requireObject(args);
    const id = requireString(obj.id, 'id');
    const pubkeyPath = requireString(obj.pubkeyPath, 'pubkeyPath');
    const host = getPool().get(id);
    if (!host) {
      throwIpcError('SSH_HOST_NOT_FOUND', `unknown host: ${id}`);
    }
    const cfg = host.config;
    return {
      command: buildInstallCommand(cfg.user, cfg.hostname, cfg.port, pubkeyPath, process.platform),
      // platform tag lets the renderer pick the matching i18n helper note
      // (e.g. "requires Git for Windows" on win32).
      platform: process.platform,
    };
  });

  ipcMain.handle(REMOTE_SSH_INVOKE.BUILD_INSTALL_CMD_INLINE, async (_event, args: unknown) => {
    const obj = requireObject(args);
    const user = requireString(obj.user, 'user').trim();
    const hostname = requireString(obj.hostname, 'hostname').trim();
    const pubkeyPath = requireString(obj.pubkeyPath, 'pubkeyPath');
    // Port is optional (default 22). Same range checks as ADD/UPDATE.
    const portRaw = obj.port;
    const port = typeof portRaw === 'number' && Number.isInteger(portRaw)
      && portRaw > 0 && portRaw < 65536
      ? portRaw
      : 22;
    return {
      command: buildInstallCommand(user, hostname, port, pubkeyPath, process.platform),
      platform: process.platform,
    };
  });

  // ── Generic remote fs primitives (Phase C) ───────────────────────────────
  //
  // These are intentionally low-level and generic — a future remote file
  // browser UI will lean on the same handlers (plus list-remote-dir /
  // read-remote-file / delete-remote-path / rename-remote-path when added).
  // Don't bake "for session create" semantics into them.

  ipcMain.handle(REMOTE_SSH_INVOKE.STAT_REMOTE_PATH, async (_event, args: unknown) => {
    const obj = requireObject(args);
    const id = requireString(obj.id, 'id');
    const inputPath = requireString(obj.path, 'path');
    const host = requireConnectedHost(id);
    try {
      return await statRemotePath(host, inputPath);
    } catch (err) {
      throwIpcError('SSH_EXEC_FAILED', `stat remote path failed: ${String((err as Error).message ?? err)}`);
    }
  });

  ipcMain.handle(REMOTE_SSH_INVOKE.MKDIR_P_REMOTE, async (_event, args: unknown) => {
    const obj = requireObject(args);
    const id = requireString(obj.id, 'id');
    const inputPath = requireString(obj.path, 'path');
    const host = requireConnectedHost(id);
    try {
      return await mkdirPRemote(host, inputPath);
    } catch (err) {
      throwIpcError('SSH_EXEC_FAILED', `mkdir -p on remote failed: ${String((err as Error).message ?? err)}`);
    }
  });

  // Phase D — autoConnect pref toggle. Writes ssh-host-prefs-store + pushes
  // a status snapshot so renderer's host list updates the checkbox without
  // a round-trip back to LIST.
  ipcMain.handle(REMOTE_SSH_INVOKE.SET_AUTO_CONNECT, async (_event, args: unknown) => {
    const obj = requireObject(args);
    const id = requireString(obj.id, 'id');
    if (typeof obj.autoConnect !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'autoConnect required (boolean)');
    }
    const host = getPool().get(id);
    if (!host) {
      throwIpcError('SSH_HOST_NOT_FOUND', `unknown host: ${id}`);
    }
    setSshHostAutoConnect(id, obj.autoConnect);
    // 推一次最新 snapshot, 让所有 renderer (Settings + NewMaker 入口可见性) 同步刷新。
    broadcastStatus(host.snapshot());
    return { ok: true as const, autoConnect: obj.autoConnect };
  });

  ipcMain.handle(REMOTE_SSH_INVOKE.HAS_ANY_AUTO_CONNECT_HOST, () => {
    return { hasAny: hasAnyAutoConnectHost() };
  });

  // Phase D — list a directory on a remote host. Powers the "添加远程项目"
  // dialog's folder browser. We list ONLY directory children (and symlinks
  // to dirs) — the picker only ever picks a folder, so files would be
  // dead clicks.
  ipcMain.handle(REMOTE_SSH_INVOKE.LIST_REMOTE_DIR, async (_event, args: unknown) => {
    const obj = requireObject(args);
    const id = requireString(obj.id, 'id');
    const inputPath = requireString(obj.path, 'path');
    const host = requireConnectedHost(id);
    try {
      return await listRemoteDir(host, inputPath);
    } catch (err) {
      throwIpcError('SSH_REMOTE_LS_FAILED', `list remote dir failed: ${String((err as Error).message ?? err)}`);
    }
  });

  // cc-mgr 版本管理 IPC。这 3 个 handler 一组:
  //   force-upgrade  — banner 上「立即升级」按钮触发, 跑 runCcMgrUpgrade
  //                    (kill daemon + re-upload + clear cache + re-install)。
  //                    会中断该 host 上所有 alive cc session 的 in-flight turn。
  //   list-pending   — renderer 启动时拉一次 snapshot, 弥补 push 在 listener
  //                    挂载之前已经发送的 pending 状态 (race condition)。
  //   dismiss-pending— banner X 关掉, 本 desktop session 不再提示该 host
  //                    (下次 desktop 重启 + 探到版本不匹配会再提)。
  ipcMain.handle(REMOTE_SSH_INVOKE.CC_MGR_FORCE_UPGRADE, async (event, args: unknown) => {
    // 轮 43 P1(codex-connector):用 assertTrustedAppRendererEvent 统一校验
    // sender 是顶层 Cindy renderer(非 child frame/webview/别的窗口), 比
    // BrowserWindow.fromWebContents 更严格(还校验 frame + window 身份)。
    assertTrustedAppRendererEvent(event);
    const obj = requireObject(args);
    const id = requireString(obj.hostId, 'hostId');
    // 轮 22:agent 参数区分 cc-mgr / pi-manager 升级(banner 复用同一通道)。
    const agent: 'cc' | 'pi' = obj.agent === 'pi' ? 'pi' : 'cc';
    // sessionId 是触发 upgrade 的那个 banner-clicker session — 只关它一个, 它有
    // UpgradeBanner 做的 retry snapshot 下次 send 会重发。其它同 host session 没
    // retry snapshot, 不能一并关 (否则 in-flight turn 静默丢)。daemon 被 kill 后它们
    // 通过 subscribeClose 自然 surface error, 用户至少看得见 session 被中断。
    const sessionId = typeof obj.sessionId === 'string' ? obj.sessionId : undefined;
    const host = requireConnectedHost(id);
    // 升级窗口标记(见 isCcMgrUpgradeInFlight): 必须在 requireConnectedHost 成功后
    // 才加(早抛会泄漏永久窗口),finally 确保关闭;仅标记 banner-clicker session。
    if (sessionId) inflightCcMgrUpgradeSessions.add(sessionId);
    try {
      // 第一步 — soft-close banner-clicker session handle。
      // 必须在 pkill daemon 之前做: 否则 agent 还握着指向**老 daemon** 的
      // ssh exec + nc + RpcClient, daemon 死后消息队列会 end → for-await 退出。
      // 这里主动关一次让升级期间该 session 下次 send 一定走 lazy create-session
      // 路径(重建 handle / transport / client / daemon channel), 不留半死状态。
      if (agent === 'pi') {
        await softClosePiSessionsForHost(id, { onlySessionId: sessionId });
        await runPiManagerUpgrade(host, log);
      } else {
        await softCloseCcSessionsForHost(id, { onlySessionId: sessionId });
        await runCcMgrUpgrade(host);
      }
      // 主动起新 daemon — 用户点了升级 = 期望 "升级完就能用"。
      // daemonReady 单独返出来: U3 auto-retry 必须知道 daemon 是否真的能接 turn,
      // 否则 retry sendMessage 会先在 UI 落一条 user bubble, 然后在 open session
      // 时 daemon 没起来 → ssh exec 卡住 → sock 等待 timeout → 用户看到一次无效
      // 重发。返 daemonReady=false 让 renderer 改成 toast 引导用户手动重发。
      // bundle 安装这步已经成 (run*Upgrade 通过了), 所以 outer ok 仍是 true。
      let daemonReady = true;
      try {
        if (agent === 'pi') {
          await ensurePiManagerDaemon(host, { protocolVersion: PI_MANAGER_PROTOCOL_VERSION });
        } else {
          await ensureDaemonRunning(host);
        }
      } catch (err) {
        daemonReady = false;
        log.warn(`${agent}-mgr force upgrade: post-upgrade daemon spawn failed (will retry on next send)`, {
          hostId: id,
          error: String((err as Error)?.message ?? err),
        });
      }
      return { ok: true as const, daemonReady };
    } catch (err) {
      throwIpcError('SSH_INSTALL_FAILED', `${agent}-mgr upgrade failed: ${String((err as Error)?.message ?? err)}`);
    } finally {
      if (sessionId) inflightCcMgrUpgradeSessions.delete(sessionId);
    }
  });

  ipcMain.handle(REMOTE_SSH_INVOKE.CC_MGR_LIST_PENDING_UPGRADES, () => {
    return { pending: listPendingCcMgrUpgrades() };
  });

  ipcMain.handle(REMOTE_SSH_INVOKE.CC_MGR_DISMISS_PENDING_UPGRADE, (_event, args: unknown) => {
    const obj = requireObject(args);
    const id = requireString(obj.hostId, 'hostId');
    // 轮 22-F2:agent 参数 —— 只 dismiss 该 agent 的 pending(cc/pi 独立)。
    const agent: 'cc' | 'pi' = obj.agent === 'pi' ? 'pi' : 'cc';
    dismissPendingCcMgrUpgrade(id, agent);
    return { ok: true as const };
  });

  log.info('remote-ssh IPC registered', { home: os.homedir() });
}

/**
 * stat-remote-path — POSIX-bash-driven stat that also expands a leading `~`
 * or `~/...` to `$HOME` safely (no `eval`, no command injection).
 *
 * Output protocol (single line on stdout):
 *   `KIND <resolved-abs-path>`   where KIND ∈ {dir, file, missing}
 *
 * Tilde handling is intentionally done INSIDE the bash script (rather than
 * pre-expanded in TS) because we don't know the remote's $HOME at the
 * callsite — and asking the remote for $HOME just to inline-substitute
 * would be an extra round trip. The `case` pattern matches only `~` or
 * `~/anything` literally; `~user` is left as-is (uncommon; ssh user is
 * already the remote user). `${1:1}` parameter expansion is shell-safe
 * even with hostile input because $1 stays inside double quotes the whole
 * time it's compared/concatenated.
 */
async function statRemotePath(
  host: RemoteHost,
  inputPath: string,
): Promise<{ kind: 'dir' | 'file' | 'missing'; resolvedPath: string }> {
  // 归一化为绝对路径:
  // - 存在的目录 → cd && pwd -P (展开 symlink 与相对路径,与 daemon cwd 契约一致)
  // - 存在的文件 → parent cd && pwd -P + basename
  // - missing → 同 file 路径策略;parent 也不存在时退回原值 (用户输的本就没意义,
  //   交给上层 UI 报错)
  // session.workingDir 直接走这里返回的 resolvedPath,远端 codex daemon 的 cwd
  // 契约要求绝对路径,否则 thread/start 会失败或落到错误目录。
  const script = `
case "$1" in
  '~'|'~/'*) p="$HOME${'$'}{1:1}" ;;
  *)         p="$1" ;;
esac
abs_for() {
  local target="$1"
  if [ -d "$target" ]; then
    (cd "$target" && pwd -P)
  else
    local parent base
    parent="$(dirname -- "$target")"
    base="$(basename -- "$target")"
    if [ -d "$parent" ]; then
      printf '%s/%s' "$(cd "$parent" && pwd -P)" "$base"
    else
      printf '%s' "$target"
    fi
  fi
}
if [ -d "$p" ]; then
  printf 'dir %s\\n' "$(abs_for "$p")"
elif [ -e "$p" ]; then
  printf 'file %s\\n' "$(abs_for "$p")"
else
  printf 'missing %s\\n' "$(abs_for "$p")"
fi
`;
  const result = await host.exec(
    `bash -c ${shellQuoteSh(script)} _ ${shellQuoteSh(inputPath)}`,
    { timeoutMs: 10_000, label: 'stat-remote-path' },
  );
  if (result.exitCode !== 0) {
    throw new Error(`bash exit=${result.exitCode}: ${result.stderr.trim().slice(0, 200) || '(no stderr)'}`);
  }
  const line = result.stdout.trim().split(/\r?\n/).pop() ?? '';
  // Allow spaces in the resolved path — only split on the first space.
  const spaceIdx = line.indexOf(' ');
  if (spaceIdx < 0) {
    throw new Error(`unexpected stat output: "${line.slice(0, 200)}"`);
  }
  const kindRaw = line.slice(0, spaceIdx);
  const resolvedPath = line.slice(spaceIdx + 1);
  if (kindRaw !== 'dir' && kindRaw !== 'file' && kindRaw !== 'missing') {
    throw new Error(`unexpected stat kind: "${kindRaw}"`);
  }
  return { kind: kindRaw, resolvedPath };
}

/**
 * mkdir-p-remote — POSIX `mkdir -p` with the same safe tilde-expansion as
 * `statRemotePath`. Idempotent — succeeds if the directory already exists.
 * Errors (permission denied, parent is a file, etc.) come through the IPC
 * error channel via stderr.
 *
 * Returns the resolved (tilde-expanded) absolute path so callers can show
 * the user exactly what was created.
 */
async function mkdirPRemote(
  host: RemoteHost,
  inputPath: string,
): Promise<{ resolvedPath: string }> {
  // 跟 statRemotePath 一致地归一化为绝对路径。mkdir -p 后目录必存在,直接
  // cd && pwd -P 即可,无需处理 missing 分支。
  const script = `
case "$1" in
  '~'|'~/'*) p="$HOME${'$'}{1:1}" ;;
  *)         p="$1" ;;
esac
mkdir -p "$p"
abs="$(cd "$p" && pwd -P)"
printf '%s\\n' "$abs"
`;
  const result = await host.exec(
    `bash -c ${shellQuoteSh(script)} _ ${shellQuoteSh(inputPath)}`,
    { timeoutMs: 15_000, label: 'mkdir-p-remote' },
  );
  if (result.exitCode !== 0) {
    throw new Error(`bash exit=${result.exitCode}: ${result.stderr.trim().slice(0, 200) || '(no stderr)'}`);
  }
  const resolvedPath = result.stdout.trim().split(/\r?\n/).pop() ?? '';
  if (!resolvedPath) {
    throw new Error('mkdir succeeded but resolved path is empty');
  }
  return { resolvedPath };
}

/**
 * list-remote-dir — POSIX-bash directory listing for the project picker.
 *
 * Returns the resolved absolute path of the dir + the child directories.
 * Tilde expansion done in-bash (same trick as statRemotePath). Output:
 *   first line:    `OK <resolved-abs-path>`
 *   then one line per child:  `D <name>`  (D = real dir, L = symlink to dir)
 *
 * We never list files — picker can only pick a directory, so files are
 * dead clicks. Symlink targets are resolved via `-L` so symlinked dirs
 * appear as L-prefixed children (UI can show a different glyph if needed).
 *
 * Bash-quoting: the entire script is single-quoted via shellQuoteSh, then
 * the user-supplied path is passed as $1 — never interpolated into the
 * script body — so a path like `; rm -rf /` is just a literal arg.
 */
async function listRemoteDir(
  host: RemoteHost,
  inputPath: string,
): Promise<{ resolvedPath: string; entries: Array<{ name: string; kind: 'dir' | 'symlink' }> }> {
  const script = `
case "$1" in
  '~'|'~/'*) p="$HOME${'$'}{1:1}" ;;
  *)         p="$1" ;;
esac
if [ ! -d "$p" ]; then
  printf 'ERR not a directory\\n' >&2
  exit 2
fi
# Resolve to canonical absolute path. cd in a subshell so we don't change
# the parent shell's cwd if anyone later reuses this connection.
abs="$(cd "$p" && pwd -P)"
printf 'OK %s\\n' "$abs"
# -A skips . and ..; -1 forces one entry per line; we then probe each
# child with test -d. -L means "follow symlinks for the test".
for entry in "$abs"/.* "$abs"/*; do
  [ -e "$entry" ] || continue
  name="${'$'}{entry##*/}"
  case "$name" in '.'|'..') continue ;; esac
  if [ -L "$entry" ] && [ -d "$entry" ]; then
    printf 'L %s\\n' "$name"
  elif [ -d "$entry" ]; then
    printf 'D %s\\n' "$name"
  fi
done
`;
  const result = await host.exec(
    `bash -c ${shellQuoteSh(script)} _ ${shellQuoteSh(inputPath)}`,
    { timeoutMs: 5_000, label: 'list-remote-dir' },
  );
  if (result.exitCode !== 0) {
    throw new Error(`bash exit=${result.exitCode}: ${result.stderr.trim().slice(0, 200) || '(no stderr)'}`);
  }
  const lines = result.stdout.split(/\r?\n/).filter(Boolean);
  const header = lines.shift() ?? '';
  if (!header.startsWith('OK ')) {
    throw new Error(`unexpected ls output: ${header.slice(0, 80)}`);
  }
  const resolvedPath = header.slice(3);
  const entries: Array<{ name: string; kind: 'dir' | 'symlink' }> = [];
  for (const line of lines) {
    if (line.startsWith('D ')) entries.push({ name: line.slice(2), kind: 'dir' });
    else if (line.startsWith('L ')) entries.push({ name: line.slice(2), kind: 'symlink' });
  }
  // 大小写不敏感的 locale-aware 排序, 跟 Finder/Explorer 接近
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return { resolvedPath, entries };
}

/**
 * 启动时自动连接 — 读取 prefs, 把所有 autoConnect=true 的 host 并发连一下。
 *
 * 在 bootstrap-electron.ts 调用方完全 fire-and-forget (no await), 这里
 * 内部 ensureHydrated 后用 Promise.allSettled, 任一 host 失败 (网络不通 /
 * key 过期 / agent 没就绪) 都不影响其它 host, 也不影响 app 启动 —— 失败
 * 只 log.warn, 用户后续可手动到 Settings 重连, 或第一条消息 lazy-connect
 * (ensureRemoteHostReady) 兜底。
 */
export async function startAutoConnectHostsBackground(): Promise<void> {
  // **先读 prefs (本地 JSON, 微秒级), 一台都没勾就早 return** — 不勾任何
  // remote / 纯本地用户不该为 ensureHydrated 的磁盘 IO (~/.ssh/config) 买单。
  // 这样 autoConnect feature 对"从不用远端"的用户完全 0 成本。
  const prefs = readSshHostPrefs();
  const autoConnectIds = Object.entries(prefs)
    .filter(([, p]) => p?.autoConnect)
    .map(([id]) => id);
  if (autoConnectIds.length === 0) {
    log.info('autoConnect: no autoConnect prefs set, skipping');
    return;
  }
  // 至少一台勾了, 才需要 hydrate pool + 找对应 host 实例。
  await ensureHydrated();
  const targets: string[] = [];
  for (const hostId of autoConnectIds) {
    const host = getPool().get(hostId);
    if (!host) continue;
    if (host.getStatus() === 'ready') continue;
    targets.push(hostId);
  }
  if (targets.length === 0) {
    log.info('autoConnect: all prefs hosts already ready or missing');
    return;
  }
  log.info('autoConnect: starting background connect', { hostIds: targets });
  const results = await Promise.allSettled(targets.map((id) => getPool().connect(id)));
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      log.warn('autoConnect: connect failed (non-fatal)', {
        hostId: targets[i],
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    } else {
      log.info('autoConnect: connected', { hostId: targets[i] });
    }
  });
}

/**
 * Find the local Codex auth.json. Preference order:
 *   1. xdt-maker's own copy at userData/codex-home/auth.json — what xdt-maker
 *      uses for its own Codex sessions, kept in sync via the reconcile path.
 *   2. System Codex CLI default at ~/.codex/auth.json — if the user only ever
 *      ran `codex login` outside xdt-maker, this is where the token lives.
 *
 * Returns null if neither exists. Callers should surface a "log in first"
 * error rather than pushing nothing.
 */
async function resolveLocalCodexAuthPath(): Promise<string | null> {
  const candidates = [
    path.join(app.getPath('userData'), 'codex-home', 'auth.json'),
    path.join(os.homedir(), '.codex', 'auth.json'),
  ];
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile() && stat.size > 0) return candidate;
    } catch {
      // ENOENT etc. — try next.
    }
  }
  return null;
}

interface InstallProgressPushPayload {
  hostId: string;
  agentKind: RemoteAgentKind;
  event: InstallProgressEvent;
}

function pickHostAndAgent(args: unknown): { host: RemoteHost; agentKind: RemoteAgentKind } {
  const obj = requireObject(args);
  const id = requireString(obj.id, 'id');
  const agentKind = requireEnum(obj.agentKind, VALID_AGENT_KINDS, 'agentKind');
  const host = requireConnectedHost(id);
  return { host, agentKind };
}

function requireConnectedHost(id: string): RemoteHost {
  const host = getPool().get(id);
  if (!host) throwIpcError('SSH_HOST_NOT_FOUND', `unknown host: ${id}`);
  if (host.getStatus() !== 'ready') {
    throwIpcError('SSH_NOT_CONNECTED', `host "${id}" is not connected (status=${host.getStatus()})`);
  }
  return host;
}

function oneShotCommand(
  agentKind: RemoteAgentKind,
  binaryPath: string,
  /**
   * true → wrapper script first reads env vars from stdin (KEY=value lines
   *        separated from prompt by a blank line) and exports them before
   *        execing the agent. The cmd string contains NO secrets in either
   *        case — secrets only live in stdin.
   */
  expectEnvBlock: boolean,
): string {
  // Resolve env / PATH setup per-agent.
  //   claude-code: binaryPath looks like
  //     <installDir>/node_modules/.bin/claude
  //   We PATH-prepend <installDir>/node/bin so the agent shim shebang
  //   `#!/usr/bin/env node` finds bundled node regardless of remote's default PATH.
  //
  //   codex: binaryPath looks like
  //     <installDir>/codex-home/packages/standalone/current/codex
  //   The standalone codex binary is self-contained (no Node dep at runtime),
  //   so PATH-prepend is unnecessary. We DO export CODEX_HOME so the binary
  //   reads its rollouts / auth / config from our isolated tree (same path
  //   the daemon uses — see codex-remote-transport.ts:codexCmd).
  let envSetup: string;
  if (agentKind === 'codex') {
    const codexHome = binaryPath.replace(/\/packages\/standalone\/current\/codex$/, '');
    const installRoot = codexHome.replace(/\/codex-home$/, '');
    const markerPath = `${installRoot}/agent-proxy.env`;
    // source agent-proxy marker (agentProxy pref 开启时由 reconcile 写入) —
    // 与 daemon wrapper 同源, quick test 走的就是真实会话的代理链路。
    envSetup = [
      `export CODEX_HOME=${shellQuoteSh(codexHome)}`,
      `if [ -f ${shellQuoteSh(markerPath)} ]; then . ${shellQuoteSh(markerPath)}; fi`,
    ].join('\n');
  } else if (agentKind === 'pi') {
    // pi 是 bun 编译自包含二进制,无需 PATH-prepend;PI_CODING_AGENT_DIR 由
    // env block 注入(指向远端 one-shot models.json)。
    envSetup = '';
  } else {
    const installDir = binaryPath.replace(/\/node_modules\/\.bin\/[^/]+$/, '');
    const nodeBinDir = `${installDir}/node/bin`;
    envSetup = `export PATH=${shellQuoteSh(nodeBinDir)}:"$PATH"`;
  }

  const agentArgs = agentKind === 'codex' ? 'exec --skip-git-repo-check -' : agentKind === 'pi' ? '--print --model cindy/dummy-quick --offline' : '--print';
  // Trailing remote command after env-read loop. Both Claude / Codex read
  // remaining stdin as the prompt (no positional arg = read stdin).
  const exec = `exec ${shellQuoteSh(binaryPath)} ${agentArgs}`;

  let script: string;
  if (expectEnvBlock) {
    // Read KEY=value lines until blank line (the marker between env block
    // and prompt). `export "$LINE"` safely handles `=` in values. Then exec
    // the agent — `exec` replaces the bash process so remaining stdin
    // flows straight into the agent (no shell buffering).
    script = `
      while IFS= read -r LINE; do
        [ -z "$LINE" ] && break
        # 轮 42 P2(codex-connector):export "$LINE" 赋值时不递归展开 \$HOME,
        # 值为 \$HOME/... 的 env(如 PI_CODING_AGENT_DIR)会以字面 \$HOME 传给
        # 远端 agent(找不到 models.json → Unknown provider)。对 \$HOME/ 前缀
        # 显式展开为 \$HOME/... (只改前缀, 无 eval, 注入安全)。
        # 注意: pattern 用纯 POSIX glob(*=\$HOME/*), **禁用 extglob**(?(...)
        # 在 Bash 默认 extglob=off 时是语法错误, 会让整个 wrapper 失败)。
        # 注意2(轮 42 P2 fresh evidence):pattern/参数展开里的 \$HOME 必须转义成
        # 字面 \$ —— 不转义时 bash 会把 pattern 里的 \$HOME 先展开成 /home/user,
        # 匹配不到 env 值里的字面 \$HOME 前缀(KEY 取整行, models.json 仍找不到)。
        # KEY/value 里的 \$KEY / \$HOME 保持展开(前者取变量名, 后者取实际 home)。
        # 转义层级:JS 模板里反斜杠+左花括号输出参数展开标记, 反斜杠+反斜杠+美元符
        # 输出字面美元符(bash 不展开)。
        case "$LINE" in
          *=\\$HOME/*)
            KEY="\${LINE%%=\\$HOME/*}"
            export "\$KEY"="$HOME/\${LINE#*=\\$HOME/}"
            ;;
          *) export "$LINE" ;;
        esac
      done
      ${envSetup}
      ${exec}
    `;
  } else {
    script = `
      ${envSetup}
      ${exec}
    `;
  }
  // Single-line + bash -c so `ps` on remote shows the wrapper script (which
  // contains no secrets) rather than args with env vars baked in.
  return `bash -c ${shellQuoteSh(script.trim())}`;
}

function shellQuoteSh(s: string): string {
  // POSIX-safe single-quote escape.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Tear down all live connections (含 agent-proxy 隧道专用连接). Hook into onQuit. */
export async function disposeRemoteSshPool(): Promise<void> {
  await disposeAllTunnels().catch(() => undefined);
  if (!pool) return;
  await pool.dispose();
  pool = null;
  initPromise = null;
  clearCcManagerInstallCache();
}

/**
 * host remove 前 soft-close 该 host 上活跃的 pi 会话。直接 kill 远端 daemon 会让
 * 本地 session 收到"pi 进程意外退出"式 error —— 先走 maker.closeSession 干净关闭
 * (本地 onExit 正常清理, 用户看到的是会话结束而非 crash-like 错误), 再杀 daemon。
 * 对齐 CC 的 softCloseCcSessionsForHost(R6 审计 M-10)。
 * best-effort:maker 未构造(null-safe)或 close 失败都不阻断 remove。
 */
async function softClosePiSessionsForHost(hostId: string, opts?: { onlySessionId?: string }): Promise<void> {
  const maker = getMakerIfReady();
  if (!maker) return;
  const livePi = maker
    .listActiveSessions()
    .filter((s) => s.agentKind === 'pi' && s.remoteHostId === hostId)
    .filter((s) => (opts?.onlySessionId ? s.id === opts.onlySessionId : true));
  if (livePi.length === 0) return;
  log.info('soft-close pi sessions before host remove', {
    hostId,
    count: livePi.length,
    sessionIds: livePi.map((s) => s.id),
  });
  for (const s of livePi) {
    try {
      // 轮 9 发现 2:对齐 CC 的 softCloseCcSessionsForHost —— withRehydrateCloseSuppressed
      // 抑制 close 时的 worktree 回收 / 临时附件清理等副作用。这是「软关」,
      // 会话记录还在, 用户重加 host 后可 lazy-resume; 不抑制会把会话"废掉"。
      await withRehydrateCloseSuppressed(s.id, async () => {
        await maker.closeSession(s.id, 'requested');
      });
    } catch (err) {
      log.warn('pi session soft-close failed (non-fatal)', {
        hostId,
        sessionId: s.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export async function cleanupRemotePiDaemonsOnHost(host: RemoteHost): Promise<void> {
  // pi-manager RPC 清理(唯一 daemon 形态 —— python daemon 已退役)。
  // list 失败(未装/daemon 挂)留日志, 残留由 daemon 空闲超时兜底回收。
  try {
    const list = await piManagerList(host, log);
    // 轮 9 发现 3(缓解):daemon 是 per-remote-user 的, 同物理机多个 host 条目
    // 共享同一 daemon —— list 返回所有 host 的会话, 直接全杀会误杀其它 host
    // 条目正在跑的会话。过滤掉本地 Maker 当前活跃的 pi 会话(它们由各自 host
    // 的生命周期管理), 只杀本 host 的残留/孤儿会话。孤儿(本地无 session 记录)
    // 会话被杀可接受 —— 空闲回收也会收, 且 kill 幂等。
    const activePiIds = new Set(
      getMakerIfReady()
        ?.listActiveSessions()
        .filter((s) => s.agentKind === 'pi')
        .map((s) => s.id) ?? [],
    );
    for (const session of list.sessions) {
      if (activePiIds.has(session.sessionId)) continue;
      // 轮 40-w2 HIGH:跨窗口保护 —— daemon 是 per-remote-user 单例, 另一 desktop
      // 窗口/进程可能正通过 bridge 使用该会话(本地 activePiIds 看不到它)。
      // isAttached(daemon 侧 attachedSocket 非空 = 有活跃 bridge 连接)是「会话
      // 正在被使用」的可靠信号 —— 跳过, 由持有方生命周期 / 断链后空闲回收兜底。
      // 误杀另一窗口的活跃会话是毁任务, 漏清理有 30min idle 兜底, 宁保守。
      if (session.isAttached) {
        log.debug('cleanup skips attached session (in use by another window)', {
          hostId: host.id,
          sessionId: session.sessionId,
        });
        continue;
      }
      // 轮 12 MEDIUM-4:pi/ensure 完成(daemon 侧 session 已建)到 maker 注册
      // 活跃列表之间约有 1-3s 窗口 —— 该窗口内新会话不在 activePiIds, 直接
      // kill 会误杀刚建立的会话。只清理年龄 > 30s 的会话。
      // 轮 23-H1 HIGH:年龄用 **daemon 侧算好的 ageMs**(本机时钟)—— 不再
      // desktop Date.now() - daemon startedAt 跨机器减(时钟偏移会让 30s 新生
      // 保护失效 → 误杀新建会话)。缺失 ageMs(旧 daemon/畸形 list)= 年龄未知
      // → 不清理(宁保守, 由空闲回收兜底)。
      if (typeof session.ageMs !== 'number' || !Number.isFinite(session.ageMs)) {
        log.debug('cleanup skips session with unknown age (idle timeout will reclaim)', {
          hostId: host.id,
          sessionId: session.sessionId,
        });
        continue;
      }
      if (session.ageMs < 30_000) {
        log.debug('cleanup skips young session (may still be registering)', {
          hostId: host.id,
          sessionId: session.sessionId,
          ageMs: session.ageMs,
        });
        continue;
      }
      // 轮 42 P1(codex-connector):detached(无 bridge 连接)不代表进程死了 ——
      // 另一窗口/实例的 detached turn 里 pi 仍在跑, daemon 的 lastActivityMs
      // (pi 输出 / bridge 写入更新)是「会话活着」的信号。长模型/工具调用可能
      // 数分钟无 stdout, 短截止(60s)会误杀; 对齐 **daemon 自己的 idle 阈值**
      // (默认 30min): 只清理「daemon 自己都会空闲回收」的会话 —— 低于阈值
      // 的会话交给 daemon 的 idle 回收处理, cleanup 不主动杀(误杀另一实例
      // 正在跑的任务是毁任务, 漏清理由 daemon idle 兜底)。
      if (
        typeof session.lastActivityMs === 'number'
        && Number.isFinite(session.lastActivityMs)
        && session.lastActivityMs < PI_MANAGER_IDLE_TIMEOUT_MS
      ) {
        log.debug('cleanup skips recently-active session (daemon child still running)', {
          hostId: host.id,
          sessionId: session.sessionId,
          lastActivityMs: session.lastActivityMs,
        });
        continue;
      }
      try {
        await piManagerKill(host, log, session.sessionId);
      } catch (err) {
        log.warn('cleanup pi-manager session kill failed (idle timeout will reclaim)', {
          hostId: host.id,
          sessionId: session.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    log.warn('pi-manager cleanup unavailable (idle timeout will reclaim)', {
      hostId: host.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export type { HostSnapshot, HostConfig } from '@cindy/maker-remote-ssh';
