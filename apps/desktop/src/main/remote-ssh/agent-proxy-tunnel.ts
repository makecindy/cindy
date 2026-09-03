/**
 * agent-proxy-tunnel — 「Cindy 代建隧道」模式的独立 SSH 连接保活器。
 *
 * 为什么独立连接而不复用控制面 (ConnectionPool 里的那条):
 *   Agent 的 LLM 流量是持续的大流量 (prompt 上传 + 流式响应, 协同时多
 *   worker 并发), 与 MCP forward / codex ws transport 同连接时会互相拖累 —
 *   一次拥塞/断链让协同工具与会话控制流陪葬 (用户实测: 同网络下不承载
 *   bulk 流量的连接稳定得多)。隧道断了只影响 LLM 请求 (agent 自己重试),
 *   控制面毫发无损; 反之亦然。
 *
 * 生命周期与保活:
 *   - 只在「主连接 ready + pref 开启 (mode=tunnel)」时保活 — 主连接断开时
 *     挂起重试 (不空转), 主连接恢复 ready 由 applyAgentProxyForHost 重新
 *     ensure。存活的隧道不因主连接断开而被拆 (它还在服务 LLM 流量)。
 *   - RemoteHost 自带 5 次退避重连; 耗尽进 'failed' 后由本模块以无上限
 *     退避 (3s→60s cap) 继续拉起, 用户无需任何手动操作。
 *
 * 固定端口 (exactRemotePort):
 *   远端 daemon env 写死 http://127.0.0.1:<remotePort>, 端口漂移 = env 失效
 *   + 必须重启 daemon (断 live turn), 所以被占时**原地等**而不是顺延。
 *   非干净断链后旧 sshd 会话可能残留占着端口 (远端 sshd 默认无 ClientAlive
 *   检测): 连续 arm 失败 2 次后尝试定点清理 — 经隧道连接找到监听该端口的
 *   sshd 会话进程, 校验它既不是本连接也不是主控制连接的 sshd 后 kill。
 *   校验不过 / 工具缺失时退回等待 (远端 TCP 超时后 sshd 自行释放)。
 *   设计取舍 (产品裁决): 固定端口由用户显式指定, 该端口上「非本连接的
 *   sshd 监听」按残留处理并清理 — 若用户把别的活跃隧道 (另一实例 / 自建
 *   ssh -R) 配在同一端口上, 被清理属预期行为, 端口归属由用户自己保证。
 *
 * 生命周期归属 (R1 review P1): 拆除/重建隧道会打断存活 daemon 经它跑的
 * 流量, 与「不 mid-turn 杀 daemon」同级 — 所以 stop/rebuild 的触发点收敛
 * 在 agent-proxy 的 reconcile (live-turn gate 之后), 本模块的 ensure 默认
 * **不** rebuild (allowRebuild=false 时 pref 变化只沿用旧隧道)。
 */

import {
  effectiveAuthenticationFingerprint,
  type HostConfig,
  type RemoteHost,
} from '@cindy/maker-remote-ssh';

import type { AgentProxyTunnelState } from '../../shared/agentProxyConfig.js';
import type { SshHostAgentProxyPref } from './ssh-host-prefs-store.js';

/** 保活器汇报的状态就是 UI 状态本身 (类型真源在 shared)。 */
export type TunnelKeeperState = AgentProxyTunnelState;

interface TunnelKeeperLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export interface TunnelKeeperDeps {
  /** 用主 host 的 config 起一条隧道专用 RemoteHost (共享 host key store)。 */
  createTunnelHost: (cfg: HostConfig) => RemoteHost;
  getPref: (hostId: string) => SshHostAgentProxyPref | null;
  /** 主控制连接是否 ready — 保活的前提 (不 ready 时挂起重试)。 */
  isMainHostReady: (hostId: string) => boolean;
  /** 主控制连接实例 (残留监听清理需要在它上面查自己的 sshd pid)。 */
  getMainHost: (hostId: string) => RemoteHost | null;
  /** 状态推送 (UI 卡片); null = 已拆除。 */
  onState: (hostId: string, state: TunnelKeeperState | null) => void;
  logger: TunnelKeeperLogger;
}

/** 重试退避表 (ms); 超出取末位。无上限次数 — 保活到 pref 关闭/主连接断开。 */
const RETRY_BACKOFF_MS = [3_000, 5_000, 10_000, 20_000, 30_000, 60_000];
/** 连续 arm 失败达到该次数后尝试一次残留监听清理。 */
const STALE_CLEANUP_AFTER_FAILURES = 2;
/** ensureTunnelUp 缺省等待上限。 */
const DEFAULT_ENSURE_UP_TIMEOUT_MS = 20_000;

interface Waiter {
  resolve: (v: { remotePort: number }) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

interface Entry {
  hostId: string;
  /** pref 快照键 — 变化时整条隧道重建。 */
  key: string;
  localHost: string;
  localPort: number;
  remotePort: number;
  conn: RemoteHost;
  offStatus: () => void;
  desired: boolean;
  paused: boolean;
  cycleRunning: boolean;
  /** cycle 进行中收到的 kick — 收尾后立即补跑一轮, 不丢事件。 */
  kickPending: boolean;
  retryTimer: NodeJS.Timeout | null;
  backoffIdx: number;
  armFailStreak: number;
  /** 本轮 busy-streak 内是否已尝试过残留清理 (成功 arm 后复位)。 */
  staleCleanupTried: boolean;
  waiters: Waiter[];
  state: TunnelKeeperState;
}

let deps: TunnelKeeperDeps | null = null;
const entries = new Map<string, Entry>();

export function initAgentProxyTunnelKeeper(d: TunnelKeeperDeps): void {
  deps = d;
}

/**
 * keeper 是否已装配 (app 启动期 registerRemoteSshIpc 完成 initAgentProxy
 * 之后恒为 true)。reconcile 的 fail-closed 隧道校验以此为闸 — 未装配时
 * (单测 / 极早期启动) 跳过, 不把「keeper 还没 init」误报成隧道故障。
 */
export function isAgentProxyTunnelKeeperInitialized(): boolean {
  return deps != null;
}

/**
 * entry 身份键 = 主机连接指纹 + 隧道目标。主机连接字段 (hostname/port/
 * user/auth/identityFile) 变更后, 旧 entry 的独立连接还连着**旧机器** —
 * 不进 key 的话 reconcile 会认为无漂移而继续复用, 新机器上的 agent env
 * 指着一个不存在的 listener, fail-closed 校验也校验错了主机
 * (R3 review P1)。
 */
function entryKey(
  cfg: HostConfig,
  pref: Extract<SshHostAgentProxyPref, { mode: 'tunnel' }>,
): string {
  return [
    cfg.hostname,
    cfg.port,
    cfg.user,
    effectiveAuthenticationFingerprint(cfg),
    pref.localHost,
    pref.localPort,
    pref.remotePort,
  ].join('|');
}

/**
 * 现役隧道与「pref 目标 + 主机连接配置」是否已脱节 (需要迁移)。marker 只
 * 编码远端端口 — localHost/localPort 或主机连接字段变更都不产生 marker
 * 漂移, reconcile 用本判定把「隧道漂移」纳入同一个 live-turn gate
 * (R2/R3 review P1)。无现役 entry 时返回 false (ensureTunnelUp 会按当前
 * pref 直接新建, 无迁移语义)。
 */
export function tunnelNeedsRebuild(
  mainHost: RemoteHost,
  pref: SshHostAgentProxyPref | null,
): boolean {
  if (!pref?.enabled || pref.mode !== 'tunnel') return false;
  const entry = entries.get(mainHost.id);
  return entry != null && entry.key !== entryKey(mainHost.config, pref);
}

function setState(entry: Entry, state: TunnelKeeperState): void {
  entry.state = state;
  // stop/rebuild 后迟到的 in-flight cycle 回写不得污染「已拆除」或新 entry
  // 的对外状态 (R1 review P1): 只有仍在登记表里的 entry 才对外汇报。
  if (entries.get(entry.hostId) !== entry) return;
  try {
    deps?.onState(entry.hostId, state);
  } catch {
    /* state push must not break the keeper */
  }
}

/** entry 是否仍是该 host 的现役登记 (stop/rebuild 后为 false)。 */
function isCurrent(entry: Entry): boolean {
  return entries.get(entry.hostId) === entry;
}

function settleWaiters(entry: Entry, err: Error | null): void {
  const ws = entry.waiters.splice(0);
  for (const w of ws) {
    clearTimeout(w.timer);
    if (err) w.reject(err);
    else w.resolve({ remotePort: entry.remotePort });
  }
}

/**
 * 主入口 (幂等): pref=tunnel 且开启 → 确保隧道在保活; pref 关/env 模式则
 * 不动现有隧道 (拆除是 reconcile 在 live-turn gate 后的职责)。
 *
 * allowRebuild: pref 目标变化时是否拆旧建新。**默认 false** — 旧隧道可能
 * 还在服务存活 daemon 的流量, 只有 reconcile 确认无 live turn 并要重启
 * daemon 时才允许迁移 (R1 review P1); 其余调用方 (ready 钩子 resume /
 * CC env 注入 / one-shot) 沿用现役隧道。
 */
export function ensureTunnelForHost(
  mainHost: RemoteHost,
  opts?: { allowRebuild?: boolean },
): void {
  if (!deps) return;
  const pref = deps.getPref(mainHost.id);
  if (!pref?.enabled || pref.mode !== 'tunnel') return;
  const key = entryKey(mainHost.config, pref);
  let entry = entries.get(mainHost.id);
  if (entry && entry.key !== key) {
    if (!opts?.allowRebuild) {
      // pref 已变但未获准迁移: 沿用旧隧道 (env/marker 仍指旧端口, 语义
      // 自洽), reconcile 会在安全时机完成迁移。
      entry.desired = true;
      entry.paused = false;
      kick(entry);
      return;
    }
    void stopTunnelForHost(mainHost.id);
    entry = undefined;
  }
  if (!entry) {
    const conn = deps.createTunnelHost(mainHost.config);
    const created: Entry = {
      hostId: mainHost.id,
      key,
      localHost: pref.localHost,
      localPort: pref.localPort,
      remotePort: pref.remotePort,
      conn,
      offStatus: () => {},
      desired: true,
      paused: false,
      cycleRunning: false,
      kickPending: false,
      retryTimer: null,
      backoffIdx: 0,
      armFailStreak: 0,
      staleCleanupTried: false,
      waiters: [],
      state: { phase: 'connecting', remotePort: pref.remotePort },
    };
    created.offStatus = conn.onStatus((snap) => handleConnStatus(created, snap.status, snap.lastError));
    entries.set(mainHost.id, created);
    entry = created;
  }
  entry.desired = true;
  entry.paused = false;
  kick(entry);
}

/** 主连接断开: 挂起重试 (存活隧道不拆 — 它可能还在正常服务)。 */
export function pauseTunnelForHost(hostId: string): void {
  const entry = entries.get(hostId);
  if (!entry) return;
  entry.paused = true;
  clearRetry(entry);
  // phase==='active' 蕴含「forward 已 arm 且隧道连接 ready」— 存活隧道保持
  // active 展示, 其余翻 paused。
  if (entry.state.phase !== 'active') {
    setState(entry, { phase: 'paused', remotePort: entry.remotePort, lastError: entry.state.lastError });
  }
}

/** 彻底拆除 (pref 关闭 / mode 切换 / host 删除 / app 退出)。幂等。 */
export async function stopTunnelForHost(hostId: string): Promise<void> {
  const entry = entries.get(hostId);
  if (!entry) return;
  entries.delete(hostId);
  entry.desired = false;
  clearRetry(entry);
  entry.offStatus();
  settleWaiters(entry, new Error('agent-proxy tunnel torn down'));
  // 状态清空在 disconnect **之前**同步推送: rebuild 场景新 entry 随后创建
  // 并推 connecting/active, 若把 null 推迟到 disconnect 完成后, 迟到的
  // null 会把新隧道的 active 状态清掉 (R3 review P2)。
  try {
    deps?.onState(hostId, null);
  } catch {
    /* ignore */
  }
  try {
    await entry.conn.disconnect();
  } catch {
    /* already dead */
  }
}

export async function disposeAllTunnels(): Promise<void> {
  await Promise.all(Array.from(entries.keys()).map((id) => stopTunnelForHost(id)));
}

/** 当前保活态 (诊断/测试)。 */
export function getTunnelKeeperState(hostId: string): TunnelKeeperState | null {
  return entries.get(hostId)?.state ?? null;
}

/**
 * 等待隧道就绪 (session 路径: CC env 注入 / one-shot quick test)。
 * 不在保活中会先 ensure; 超时/拆除时 reject。
 */
export function ensureTunnelUp(
  mainHost: RemoteHost,
  timeoutMs = DEFAULT_ENSURE_UP_TIMEOUT_MS,
): Promise<{ remotePort: number }> {
  ensureTunnelForHost(mainHost);
  const entry = entries.get(mainHost.id);
  if (!entry) {
    return Promise.reject(new Error('agent-proxy tunnel pref is not enabled (mode=tunnel)'));
  }
  if (entry.state.phase === 'active') {
    return Promise.resolve({ remotePort: entry.remotePort });
  }
  return new Promise<{ remotePort: number }>((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = entry.waiters.findIndex((w) => w.timer === timer);
      if (idx >= 0) entry.waiters.splice(idx, 1);
      reject(
        new Error(
          `agent-proxy tunnel not ready within ${timeoutMs}ms (${entry.state.phase}${entry.state.lastError ? `: ${entry.state.lastError}` : ''})`,
        ),
      );
    }, timeoutMs);
    timer.unref?.();
    entry.waiters.push({ resolve, reject, timer });
  });
}

// ── 保活循环 ────────────────────────────────────────────────────────────────

function clearRetry(entry: Entry): void {
  if (entry.retryTimer) {
    clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
  }
}

function scheduleRetry(entry: Entry): void {
  if (!isCurrent(entry) || !entry.desired || entry.paused) return;
  clearRetry(entry);
  const delay = RETRY_BACKOFF_MS[Math.min(entry.backoffIdx, RETRY_BACKOFF_MS.length - 1)];
  entry.backoffIdx += 1;
  entry.retryTimer = setTimeout(() => {
    entry.retryTimer = null;
    kick(entry);
  }, delay);
  entry.retryTimer.unref?.();
}

function handleConnStatus(entry: Entry, status: string, lastError?: string): void {
  if (!entry.desired) return;
  if (status === 'ready') {
    // RemoteHost 自己的 rearmForwards 会尝试重挂; kick 里的 ensure 幂等对齐。
    clearRetry(entry);
    kick(entry);
    return;
  }
  if (status === 'failed') {
    // RemoteHost 内部 5 次重连耗尽 — 本模块接管无上限退避。
    setState(entry, { phase: 'error', remotePort: entry.remotePort, lastError });
    scheduleRetry(entry);
    return;
  }
  if (status === 'connecting' || status === 'reconnecting') {
    setState(entry, { phase: 'connecting', remotePort: entry.remotePort });
  }
}

function kick(entry: Entry): void {
  if (!isCurrent(entry) || !entry.desired || entry.paused) return;
  if (entry.cycleRunning) {
    // cycle 正在跑 (或在收尾的微任务窗口里): 不能丢 kick — resume/ready
    // 事件撞上收尾窗口被静默吞掉的话, 隧道会停在旧状态等下一个事件才动。
    // 记 pending, finally 里补跑。
    entry.kickPending = true;
    return;
  }
  entry.cycleRunning = true;
  void runCycle(entry)
    .catch(() => {
      /* runCycle 自己收口所有错误 — 这里只兜底 */
    })
    .finally(() => {
      entry.cycleRunning = false;
      if (entry.kickPending) {
        entry.kickPending = false;
        kick(entry);
      }
    });
}

async function runCycle(entry: Entry): Promise<void> {
  if (!deps) return;
  if (!deps.isMainHostReady(entry.hostId)) {
    // 主连接不在 — 挂起, 主连接 ready 钩子会重新 ensure。存活隧道
    // (phase==='active') 保持展示, 不翻 paused。
    entry.paused = true;
    if (entry.state.phase !== 'active') {
      setState(entry, { phase: 'paused', remotePort: entry.remotePort });
    }
    return;
  }
  if (entry.conn.getStatus() !== 'ready') {
    setState(entry, { phase: 'connecting', remotePort: entry.remotePort });
    try {
      await entry.conn.connect();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState(entry, { phase: 'error', remotePort: entry.remotePort, lastError: msg });
      scheduleRetry(entry);
      return;
    }
    // stop/rebuild 可能发生在 connect 在飞期间 — 孤儿 entry 不再继续
    // (setState/scheduleRetry 也有各自的 isCurrent 守卫兜底)。
    if (!isCurrent(entry) || !entry.desired || entry.paused) return;
  }
  try {
    await entry.conn.ensureRemoteForward({
      localHost: entry.localHost,
      localPort: entry.localPort,
      preferredRemotePort: entry.remotePort,
      exactRemotePort: true,
    });
  } catch (err) {
    // stop/rebuild 后的孤儿 cycle 不得继续 — 尤其不能再跑残留监听清理
    // (远端 kill 副作用): 用户可能已关闭 proxy / 切走端口, 授权已收回
    // (R2 review P2)。
    if (!isCurrent(entry) || !entry.desired) return;
    const msg = err instanceof Error ? err.message : String(err);
    entry.armFailStreak += 1;
    deps.logger.warn('agent-proxy tunnel arm failed', {
      hostId: entry.hostId,
      remotePort: entry.remotePort,
      streak: entry.armFailStreak,
      error: msg,
    });
    setState(entry, { phase: 'port-busy', remotePort: entry.remotePort, lastError: msg });
    if (entry.armFailStreak >= STALE_CLEANUP_AFTER_FAILURES && !entry.staleCleanupTried) {
      entry.staleCleanupTried = true;
      const cleaned = await tryCleanupStaleListener(entry).catch(() => false);
      if (cleaned) {
        // 立即重试一次, 不吃退避 (cycle 内 kick 记 pending, finally 补跑)。
        setState(entry, { phase: 'connecting', remotePort: entry.remotePort });
        entry.backoffIdx = 0;
        kick(entry);
        return;
      }
    }
    scheduleRetry(entry);
    return;
  }
  if (!isCurrent(entry) || !entry.desired) return; // arm 在飞期间被 stop/rebuild
  entry.backoffIdx = 0;
  entry.armFailStreak = 0;
  entry.staleCleanupTried = false;
  setState(entry, { phase: 'active', remotePort: entry.remotePort });
  settleWaiters(entry, null);
  deps.logger.info('agent-proxy tunnel armed', {
    hostId: entry.hostId,
    remotePort: entry.remotePort,
    localTarget: `${entry.localHost}:${entry.localPort}`,
  });
}

// ── 残留监听清理 ────────────────────────────────────────────────────────────

/**
 * 在主控制连接上查出它自己的会话 sshd pid (清理脚本的保护名单):
 * 隧道端口若被主连接上的其他 forward (如用户把固定端口配成了 MCP 转发口)
 * 占用, kill 那个 sshd 等于杀掉整个控制连接 — 必须排除。
 * 查不出来 (工具缺失等) 返回 null, 调用方放弃清理 (保守优先)。
 */
async function lookupSessionSshdPid(host: RemoteHost): Promise<string | null> {
  const script = `
P=$$
i=0
while [ $i -lt 8 ]; do
  PP=$(awk '{print $4}' "/proc/$P/stat" 2>/dev/null) || exit 1
  [ -z "$PP" ] && exit 1
  C=$(ps -o comm= -p "$PP" 2>/dev/null | tr -d ' ')
  case "$C" in sshd|sshd-session) printf '%s' "$PP"; exit 0;; esac
  [ "$PP" = "1" ] && exit 1
  P=$PP
  i=$((i+1))
done
exit 1
`;
  try {
    const result = await host.exec(`bash -c ${shellQuote(script)}`, {
      timeoutMs: 10_000,
      label: 'agent-proxy-lookup-sshd-pid',
    });
    const pid = result.stdout.trim();
    return result.exitCode === 0 && /^[0-9]+$/.test(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * 定点清理占着固定端口的残留 sshd 会话。全部校验通过才 kill:
 *   - 端口确有监听者且能解析出 pid (ss 可用);
 *   - 监听者进程是 sshd / sshd-session (非 root 本来也只能杀自己用户的);
 *   - 监听者不在本连接自身的进程链上, 也不是主控制连接的会话 sshd。
 * 返回 true = 已 kill (调用方立即重试 arm); false = 未清理 (继续退避等待,
 * 远端 TCP 超时后 sshd 会自行释放)。
 */
async function tryCleanupStaleListener(entry: Entry): Promise<boolean> {
  if (!deps) return false;
  const mainHost = deps.getMainHost(entry.hostId);
  if (!mainHost || mainHost.getStatus() !== 'ready') return false;
  const protectPid = await lookupSessionSshdPid(mainHost);
  if (!protectPid) {
    deps.logger.warn('agent-proxy stale-listener cleanup skipped: cannot resolve control-connection sshd pid', {
      hostId: entry.hostId,
      remotePort: entry.remotePort,
    });
    return false;
  }
  // PORT/PROTECT 都是内部产生的纯数字, 直接内插安全 (双保险再校验一次)。
  if (!/^[0-9]+$/.test(protectPid) || !Number.isInteger(entry.remotePort)) return false;
  const script = `
PORT=${entry.remotePort}
PROTECT=${protectPid}
HOLDER=$(ss -H -tlnp "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | head -n1 | cut -d= -f2)
if [ -z "$HOLDER" ]; then echo "no-holder" >&2; exit 10; fi
if [ "$HOLDER" = "$PROTECT" ]; then echo "holder-is-control-connection" >&2; exit 11; fi
C=$(ps -o comm= -p "$HOLDER" 2>/dev/null | tr -d ' ')
case "$C" in sshd|sshd-session) ;; *) echo "holder-not-sshd:$C" >&2; exit 12;; esac
P=$$
i=0
while [ $i -lt 8 ]; do
  PP=$(awk '{print $4}' "/proc/$P/stat" 2>/dev/null) || break
  [ -z "$PP" ] && break
  if [ "$PP" = "$HOLDER" ]; then echo "holder-is-self-chain" >&2; exit 13; fi
  [ "$PP" = "1" ] && break
  P=$PP
  i=$((i+1))
done
kill "$HOLDER" 2>/dev/null || { echo "kill-failed" >&2; exit 14; }
exit 0
`;
  try {
    const result = await entry.conn.exec(`bash -c ${shellQuote(script)}`, {
      timeoutMs: 10_000,
      label: 'agent-proxy-cleanup-stale-listener',
    });
    if (result.exitCode === 0) {
      deps.logger.info('agent-proxy stale listener killed, retrying fixed-port bind', {
        hostId: entry.hostId,
        remotePort: entry.remotePort,
      });
      return true;
    }
    deps.logger.warn('agent-proxy stale-listener cleanup declined', {
      hostId: entry.hostId,
      remotePort: entry.remotePort,
      exitCode: result.exitCode,
      reason: result.stderr.trim().slice(0, 120),
    });
    return false;
  } catch (err) {
    deps.logger.warn('agent-proxy stale-listener cleanup failed', {
      hostId: entry.hostId,
      remotePort: entry.remotePort,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
