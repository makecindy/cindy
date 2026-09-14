/**
 * agent-proxy —— 「Agent 流量走 Proxy」的策略层。两种模式 (pref.mode):
 *
 *   mode='tunnel' (Cindy 代建隧道, 固定端口):
 *     远端 codex daemon / claude CLI
 *       │  HTTPS_PROXY=http://127.0.0.1:<remotePort>   (env 注入, remotePort 固定)
 *       ▼
 *     远端 127.0.0.1:<remotePort>            (sshd remote forwarding, ssh -R)
 *       │  **独立的** SSH 隧道连接            (agent-proxy-tunnel.ts 保活)
 *       ▼
 *     本机 pipe → 用户自己的本地 Proxy (如 127.0.0.1:7890)
 *
 *   mode='env' (仅注入环境变量):
 *     远端 agent env 直接指向用户给的 proxyUrl (远端可达: 远端本机代理 /
 *     局域网代理 / 用户自建 autossh 隧道)。Cindy 不建任何隧道。
 *
 * 与旧方案 (PR #715, 动态端口 + 控制面连接承载) 的两个关键差异:
 *   1. env 是**静态**的 — 只随用户改设置而变, SSH 重连不再触发 marker
 *      漂移 / daemon 重启 (旧方案重连端口重绑会 pkill 正在跑的 daemon)。
 *   2. bulk 流量走独立连接 — 控制面 (MCP forward / codex ws transport)
 *      不再与 LLM 大流量同命。
 *
 * Cindy 不提供 Proxy, 只提供通路。域名解析发生在用户 Proxy 那一端
 * (HTTP CONNECT 语义), 远端不需要能解 chatgpt.com / api.anthropic.com。
 *
 * 两个 agent 的 env 注入方式不同:
 *   - claude-code: cc-mgr daemon 按 session spawn SDK, startParams.env 每
 *     次会话重建 — 直接在 remoteCcQueryFactory 里 merge, 即时生效。
 *   - codex: app-server daemon 是远端常驻进程, env 只能在 daemon 启动时
 *     生效。所以写一个 marker 文件 ($INSTALL_ROOT/agent-proxy.env),
 *     daemon wrapper 启动前 source 它; marker 漂移时 pkill daemon
 *     (daemon version 探活失败 → 下次 transport bootstrap 重新拉起,
 *     与 auth sync 的 daemonRestart 同套路)。marker 漂移只会由用户改
 *     设置触发; 若此刻 host 上有 live turn, 对账推迟 (turn-done 与下次
 *     session start 的 reconcile 都会补刀), 不 mid-turn 杀 daemon。
 */

import type { HostConfig, RemoteHost } from '@cindy/maker-remote-ssh';
import { REMOTE_AGENT_PROXY_ENV_PATH, REMOTE_INSTALL_ROOT } from '@cindy/maker-remote-ssh';

import type { AgentProxyTunnelState } from '../../shared/agentProxyConfig.js';
import { createLogger } from '../logger.js';
import {
  ensureTunnelForHost,
  ensureTunnelUp,
  initAgentProxyTunnelKeeper,
  isAgentProxyTunnelKeeperInitialized,
  pauseTunnelForHost,
  stopTunnelForHost,
  tunnelNeedsRebuild,
} from './agent-proxy-tunnel.js';
import { getSshHostAgentProxy, type SshHostAgentProxyPref } from './ssh-host-prefs-store.js';

const log = createLogger('remote-ssh/agent-proxy');

// UI 展示用的实时状态 (内存态, 不持久化)。类型真源在 shared (preload /
// renderer 共用), 这里 re-export 保持既有引用点不变。
export type { AgentProxyTunnelState };

const tunnelStates = new Map<string, AgentProxyTunnelState>();

export function getAgentProxyTunnelState(hostId: string): AgentProxyTunnelState | null {
  return tunnelStates.get(hostId) ?? null;
}

/** host 删除时同步清掉内存态 + 拆隧道。 */
export function clearAgentProxyTunnelState(hostId: string): void {
  tunnelStates.delete(hostId);
  void stopTunnelForHost(hostId);
}

/** Awaited endpoint-edit variant so a late tunnel stop cannot race rehydrate. */
export async function clearAgentProxyTunnelStateAndWait(hostId: string): Promise<void> {
  tunnelStates.delete(hostId);
  await stopTunnelForHost(hostId);
}

/**
 * 主控制连接断开时的处理: 隧道保活挂起 (不空转重试), 但**存活的隧道不拆**
 * — 独立连接可能还在正常服务 LLM 流量, 主连接的断链不该牵连它。主连接
 * 恢复 ready 后 applyAgentProxyForHost 会恢复保活。
 */
export function handleAgentProxyMainHostDown(hostId: string): void {
  pauseTunnelForHost(hostId);
}

/**
 * 用户**显式**断开 (Settings → Disconnect) 时拆除隧道: 该动作的语义是
 * 「切断这台机器的全部 SSH 连通」, 独立隧道连接也算 (review: PR #992
 * codex-connector P1)。与断线/重连的 pause 路径区分 — 那种是网络抖动,
 * 存活隧道值得保留; 用户点断开则是明确授权终结。
 */
export async function teardownAgentProxyOnUserDisconnect(hostId: string): Promise<void> {
  await stopTunnelForHost(hostId);
}

// broadcast 由 index.ts 注入 (避免循环依赖): 状态变化后推一版 status
// snapshot 给 renderer, HostSnapshotWithPrefs 会带上最新 tunnel state。
let broadcaster: ((hostId: string) => void) | null = null;

export function initAgentProxy(deps: {
  broadcast: (hostId: string) => void;
  /** 用主 host 的 config 起隧道专用 RemoteHost (共享 host key store)。 */
  createTunnelHost: (cfg: HostConfig) => RemoteHost;
  getMainHost: (hostId: string) => RemoteHost | null;
}): void {
  broadcaster = deps.broadcast;
  const { getMainHost } = deps;
  initAgentProxyTunnelKeeper({
    createTunnelHost: deps.createTunnelHost,
    getPref: (hostId) => getSshHostAgentProxy(hostId),
    isMainHostReady: (hostId) => getMainHost(hostId)?.getStatus() === 'ready',
    getMainHost,
    onState: (hostId, state) => {
      if (!state) tunnelStates.delete(hostId);
      else tunnelStates.set(hostId, state);
      emitState(hostId);
    },
    logger: log,
  });
}

function emitState(hostId: string): void {
  try {
    broadcaster?.(hostId);
  } catch { /* broadcast must not throw into ssh paths */ }
}

// ── live-turn 守卫 (marker 对账不 mid-turn 杀 daemon) ───────────────────────

/**
 * codex 远端 live-turn 判定 — maker-ipc/register.ts 装配 (真源是 agent
 * input coordinator)。未装配时视为无 live turn (与历史行为一致; 装配点
 * 在 IPC 注册期, 早于任何 session 路径)。
 */
let liveTurnChecker: ((hostId: string) => boolean) | null = null;

export function setAgentProxyLiveTurnChecker(fn: (hostId: string) => boolean): void {
  liveTurnChecker = fn;
}

/**
 * 对账被推迟/未完成的 host 集合 — turn-done 挂钩据此决定要不要补刀,
 * 避免每次 turn 结束都白付一次远端 marker cat RTT (稳态下 marker 不漂移)。
 * 成员在 reconcile 的 defer / pkill 失败路径加入, 收敛成功后移除。
 */
const pendingReconcileHosts = new Set<string>();

export function hasPendingAgentProxyReconcile(hostId: string): boolean {
  return pendingReconcileHosts.has(hostId);
}

/* ============================== env 构造 ============================== */

/** pref → 远端 agent 应使用的代理 URL (env 模式原样; tunnel 模式固定端口)。 */
export function resolveAgentProxyUrl(pref: SshHostAgentProxyPref): string {
  return pref.mode === 'env' ? pref.proxyUrl : `http://127.0.0.1:${pref.remotePort}`;
}

/**
 * 注入远端 agent 进程的代理 env。大小写两份: Rust (reqwest) / Node /
 * Go / curl 对 HTTPS_PROXY vs https_proxy 的读取习惯不一致, 全给最稳。
 * NO_PROXY 只排除 loopback — 用户自己的 Proxy 规则决定内网域名直连与否,
 * 那是 Proxy 软件的职责, 不是我们的。
 *
 * 本函数是 env 键集与取值的唯一真源: uppercase 子集与 marker 序列化都从
 * 它派生, 加键/改 NO_PROXY 只动这里。
 */
export function buildAgentProxyEnv(proxyUrl: string): Record<string, string> {
  const noProxy = 'localhost,127.0.0.1,::1';
  return {
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    NO_PROXY: noProxy,
    https_proxy: proxyUrl,
    http_proxy: proxyUrl,
    no_proxy: noProxy,
  };
}

/**
 * 仅大写版本 — env-block.ts 的 gatekeeper 拒小写 key (防 stdin 协议注入),
 * one-shot 的 envBlock 路径只能拿大写; claude/codex 都认大写。
 */
export function buildAgentProxyEnvUppercase(proxyUrl: string): Record<string, string> {
  const { HTTPS_PROXY, HTTP_PROXY, NO_PROXY } = buildAgentProxyEnv(proxyUrl);
  return { HTTPS_PROXY, HTTP_PROXY, NO_PROXY };
}

/**
 * codex daemon wrapper source 的 marker 文件内容 (buildAgentProxyEnv 的
 * shell 序列化)。首行注释沿用 #715 的原文 — tunnel 模式迁移后 URL 不变时
 * marker 逐字节一致, 升级不触发无谓的 daemon 重启。
 */
export function buildAgentProxyMarkerContent(proxyUrl: string): string {
  const lines = ['# Written by Cindy — agent proxy tunnel env. Sourced by the codex daemon wrapper.'];
  for (const [key, value] of Object.entries(buildAgentProxyEnv(proxyUrl))) {
    lines.push(`export ${key}='${value}'`);
  }
  lines.push('');
  return lines.join('\n');
}

/* ============================== session 路径 ============================== */

/**
 * session 路径的代理就绪确保: 返回远端应使用的代理 URL。
 *   - pref 关闭 → null;
 *   - env 模式 → 直接返回 (远端可达性由用户保证);
 *   - tunnel 模式 → 等隧道 armed (保活器起隧道; 超时抛错, fail-closed —
 *     不静默回落直连, 与旧行为一致)。
 */
export async function ensureAgentProxyReady(host: RemoteHost): Promise<string | null> {
  const pref = getSshHostAgentProxy(host.id);
  if (!pref?.enabled) return null;
  if (pref.mode === 'env') return pref.proxyUrl;
  // 用 armed 隧道的实际端口而非 pref: pref 刚被编辑而迁移尚未获准 (live
  // turn 挡着 reconcile) 时, 现役隧道还在旧端口上 — 按现役真值注入才可用,
  // 迁移由 reconcile 在安全时机完成 (R1 review P1)。
  const { remotePort } = await ensureTunnelUp(host);
  return `http://127.0.0.1:${remotePort}`;
}

/**
 * claude-code session 路径: pref 开启 → 返回要 merge 进 startParams.env 的
 * 代理 env; 关闭 → null (调用方原样透传 startParams)。
 */
export async function getRemoteAgentProxyEnv(
  host: RemoteHost,
): Promise<Record<string, string> | null> {
  const proxyUrl = await ensureAgentProxyReady(host);
  if (!proxyUrl) return null;
  return buildAgentProxyEnv(proxyUrl);
}

/** one-shot quick test 路径 (envBlock 只收大写)。 */
export async function getRemoteAgentProxyEnvUppercase(
  host: RemoteHost,
): Promise<Record<string, string> | null> {
  const proxyUrl = await ensureAgentProxyReady(host);
  if (!proxyUrl) return null;
  return buildAgentProxyEnvUppercase(proxyUrl);
}

/* ============================== codex daemon env marker ============================== */

async function readRemoteMarker(host: RemoteHost): Promise<string | null> {
  const result = await host.exec(
    `bash -c 'cat "${REMOTE_AGENT_PROXY_ENV_PATH}" 2>/dev/null || true'`,
    { timeoutMs: 10_000, label: 'read-agent-proxy-marker' },
  );
  const content = result.stdout.trim();
  return content ? content : null;
}

async function writeRemoteMarker(host: RemoteHost, content: string | null): Promise<void> {
  if (content == null) {
    const result = await host.exec(`bash -c 'rm -f "${REMOTE_AGENT_PROXY_ENV_PATH}"'`, {
      timeoutMs: 10_000,
      label: 'delete-agent-proxy-marker',
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `delete agent-proxy marker failed (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 200)}`,
      );
    }
    return;
  }
  // mkdir -p 兜底: install root 通常在 codex 安装时已建, 但 proxy-only
  // 场景 (只开了 claude 没装 codex) 目录可能还不存在。内容走 stdin,
  // 不进 cmd (与 repo 的 secret-hygiene 惯例一致, 虽然 marker 本身无密钥)。
  const result = await host.exec(
    `bash -c 'mkdir -p "${REMOTE_INSTALL_ROOT}" && cat > "${REMOTE_AGENT_PROXY_ENV_PATH}"'`,
    { timeoutMs: 10_000, label: 'write-agent-proxy-marker', input: content },
  );
  // exec 对非零退出码 resolve 不 throw — 写失败必须显式挡 (review: PR #715
  // codex R7 P1): 否则 reconcile 会继续 pkill, daemon 起来没 marker 直连,
  // fail-closed 破。throw 由调用方收口 (apply 落 tunnel state / probe 中断)。
  if (result.exitCode !== 0) {
    throw new Error(
      `write agent-proxy marker failed (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 200)}`,
    );
  }
}

/**
 * pkill 远端 codex app-server daemon (含 sock proxy 子进程)。
 *
 * 从 SYNC_CODEX_AUTH handler 抽出的共享实现 — daemon 启动时 in-memory 缓存
 * auth.json / env, 不支持 hot-reload; 变了只能杀, 下次探活失败自动 bootstrap。
 *
 * pattern 设计 (与 auth sync 原实现一致, review 后收紧):
 * - 匹配 `codex app-server` 两词而非 `codex app-server daemon`: daemon 主进程
 *   的 cmdline 是 `codex app-server --remote-control --listen unix://`, 不含
 *   "daemon" 字 (只有 worker 子进程 cmdline 含 `daemon pid-update-loop`)。
 *   早期 pattern 带 daemon 只杀到 worker, 主进程活着继续用旧 auth/env。
 * - 要求 cmdline 同时含 `.xdt-server` 与 `codex-home` 两段路径 (顺序):
 *   只杀我们 isolated CODEX_HOME 里装的 daemon 家族 (主进程 + pid-update-loop
 *   worker + sock proxy 子进程), 不误伤 (review: PR #715 五轮审核 P1):
 *   · 用户自己装在别处的 codex (无 .xdt-server 段);
 *   · .xdt-server 树下非 codex-home 的进程;
 *   · 用户手动维护的同名 codex-home standalone install (无 .xdt-server 前缀)。
 *   一次性 `codex --print` / `codex exec` 不命中。短暂探活命令
 *   `codex app-server daemon version` 理论命中但只跑几毫秒, 即使命中也无害
 *   (desktop 探活失败会自动 bootstrap)。同一远端账号的多台 Cindy 客户端
 *   共享这一个 daemon singleton, 一侧 pkill 会影响另一侧的 in-flight turn —
 *   这是 daemon 单例语义的固有边界, 不是 pattern 能解决的 (与 auth sync 相同)。
 * - `[c]odex` 字符类 trick: pkill 自己的 cmdline 字面含 `[c]odex` (带方括号),
 *   不匹配连续 5 字符 `codex`, 不会自杀。
 * - `id -un` 而非 `$USER` 取用户名 + `-u` 限定只杀当前 SSH user 的进程。
 * - rc=0 杀到 / rc=1 没匹配 (从没启过 daemon, 也算成功) / rc>1 真错误。
 */
export async function killRemoteCodexDaemon(
  host: RemoteHost,
): Promise<{ ok: true } | { ok: false; reason: 'pkill_failed'; detail?: string }> {
  // TERM 后必须等到进程真正消失 (review: PR #715 greptile R6): pkill 只保证
  // 信号送达 — 旧 daemon 若在 dying 窗口里响应 daemon version 探活,
  // transport 会复用它 (旧 env), marker 变更静默落空。先 TERM + 轮询 5s,
  // 没死透再 KILL + 轮询 2s; 仍活着按失败上报 (调用方走降级提示)。
  // pgrep 不会匹配自身; bash 包装进程 cmdline 里的 pattern 文本经 [c]odex
  // trick 处理后同样不命中 (与 pkill 的自排除同理)。
  const killScript = `
USER_NAME=$(id -un 2>/dev/null)
if [ -z "$USER_NAME" ]; then echo "id -un returned empty" >&2; exit 2; fi
PAT='\\.xdt-server.*codex-home.*[c]odex app-server'
pkill -u "$USER_NAME" -f "$PAT"
rc=$?
case "$rc" in
  0) ;;
  1) exit 0 ;;
  *) echo "pkill rc=$rc" >&2; exit "$rc" ;;
esac
i=0
while [ $i -lt 5 ]; do
  pgrep -u "$USER_NAME" -f "$PAT" >/dev/null 2>&1 || exit 0
  i=$((i+1)); sleep 1
done
pkill -9 -u "$USER_NAME" -f "$PAT" 2>/dev/null || true
i=0
while [ $i -lt 2 ]; do
  pgrep -u "$USER_NAME" -f "$PAT" >/dev/null 2>&1 || exit 0
  i=$((i+1)); sleep 1
done
echo "daemon still alive after TERM(5s)+KILL(2s)" >&2
exit 3
`;
  try {
    const result = await host.exec(`bash -c ${shellQuote(killScript)}`, {
      // 脚本最坏路径: TERM 轮询 5s + KILL 轮询 2s + ssh/exec 开销 — 给 15s。
      timeoutMs: 15_000,
      label: 'kill-codex-daemon',
    });
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim().slice(0, 200);
      log.warn('failed to kill remote codex daemon', { hostId: host.id, exitCode: result.exitCode, stderr: detail });
      return { ok: false, reason: 'pkill_failed', detail };
    }
    return { ok: true };
  } catch (err) {
    const detail = String((err as Error).message ?? err);
    log.warn('failed to kill remote codex daemon (exec error)', { hostId: host.id, error: detail });
    return { ok: false, reason: 'pkill_failed', detail };
  }
}

export interface ReconcileCodexAgentProxyResult {
  markerChanged: boolean;
  daemonRestarted: boolean;
  /**
   * true = marker 已漂移但 host 上有 live turn, 本次不写不杀 (重启 daemon
   * 会断 turn)。漂移是持久事实 — turn-done 挂钩与下次 session start 的
   * reconcile 都会重试, 不依赖本次。
   */
  deferredForLiveTurn?: boolean;
}

/**
 * codex 路径的 env 对账: 比较远端 marker 与期望值 (由 pref 静态派生),
 * 漂移则重写 marker + pkill daemon (下次 transport bootstrap 时 daemon
 * version 探活失败 → 重新 bootstrap, wrapper source 新 marker, env 生效)。
 *
 * 期望值只随用户改设置而变 — SSH 重连不再制造漂移 (固定端口), 所以命中
 * 慢路径的时机基本只有「用户刚改完设置」与「首次开启」。此时若 host 上
 * 有 live turn, 推迟对账 (deferredForLiveTurn), 不 mid-turn 杀 daemon。
 *
 * 调用点:
 *   1. codex-remote-transport bootstrap 的 beforeDaemonProbe (每个新
 *      app-server host 建立前) — 兜底所有路径 (app 重启 / 远端被别的
 *      客户端动过)。
 *   2. pref 变更 / host ready 的 applyAgentProxyForHost — 即时生效。
 *   3. turn-done 挂钩 (register.ts) — live-turn defer 的补刀点。
 *
 * marker 一致时零副作用 (1 次 cat RTT)。pkill 失败不抛错 — marker 回滚到
 * 原值 (与存活 daemon 的 env 保持一致, 否则下次 reconcile 命中 fast path
 * 永不重试 kill, codex R10 P1/P2), 调用方按 markerChanged && !daemonRestarted
 * 组合上报失败。
 */
export async function reconcileCodexAgentProxyEnv(
  host: RemoteHost,
): Promise<ReconcileCodexAgentProxyResult> {
  // per-host 串行链 (codex R9 P2): 并发 reconcile (两个 transport 的
  // beforeDaemonProbe 与 ready-hook 同时触发) 时, 若第一个还在等
  // killRemoteCodexDaemon 而第二个走 marker-match fast path, 第二个会直接去
  // probe 旧 daemon — attach 到 stale-env daemon, 或握手途中被 pkill。
  // 所有调用按 host 排队, 后来者等前一个写完 marker + 杀完 daemon 再走自己
  // 的对账 (那时 fast path 才真的代表「环境已一致」)。
  const prev = reconcileChains.get(host.id) ?? Promise.resolve();
  const run = prev.then(() => reconcileCodexAgentProxyEnvSerialized(host));
  // 链上只存 settled 版 (前一个失败不堵后一个); 调用方拿自己的 run 结果。
  const tracked = run.then(
    () => undefined,
    () => undefined,
  );
  reconcileChains.set(host.id, tracked);
  void tracked.then(() => {
    if (reconcileChains.get(host.id) === tracked) reconcileChains.delete(host.id);
  });
  return run;
}

const reconcileChains = new Map<string, Promise<void>>();

async function reconcileCodexAgentProxyEnvSerialized(
  host: RemoteHost,
): Promise<ReconcileCodexAgentProxyResult> {
  try {
    return await doReconcileCodexAgentProxyEnv(host);
  } catch (err) {
    // 任何失败 (marker 读写 / 隧道 armed 超时 / …) 都记 pending — turn-done
    // 补刀是最近的自愈时机, 不能只靠下一次 session start (R2 review P2)。
    pendingReconcileHosts.add(host.id);
    throw err;
  }
}

async function doReconcileCodexAgentProxyEnv(
  host: RemoteHost,
): Promise<ReconcileCodexAgentProxyResult> {
  const pref = getSshHostAgentProxy(host.id);
  const desired = pref?.enabled ? buildAgentProxyMarkerContent(resolveAgentProxyUrl(pref)) : null;
  const keeperReady = isAgentProxyTunnelKeeperInitialized();
  const wantsTunnel = pref?.enabled === true && pref.mode === 'tunnel';

  const current = await readRemoteMarker(host);
  const markerDrift = current !== (desired ? desired.trim() : null);
  // marker 只编码远端固定端口 — localHost/localPort 或主机连接配置变更都
  // 不产生 marker 漂移, 必须单独纳入判定, 且与 marker 漂移共用同一个
  // live-turn gate (R2/R3 review P1: 否则本地代理目标 / 主机变更永远不会
  // 被应用到隧道上)。
  const tunnelDrift = wantsTunnel && keeperReady && tunnelNeedsRebuild(host, pref);

  if (!markerDrift && !tunnelDrift) {
    if (keeperReady) {
      if (wantsTunnel) {
        // fail-closed (R1 review P1): marker 一致也必须隧道真的 armed —
        // 否则 daemon 拿着正确 env 却打不通端口, 表现为 agent 内部网络
        // 静默失败。armed 不上抛错 (外层记 pending), 调用方按各自路径
        // 收口 (probe 中断 / apply 落 error 状态 / quick test 报错),
        // keeper 继续自愈。
        await ensureTunnelUp(host);
      } else {
        // pref 关 / env 模式的残留隧道兜底拆除 (幂等, 常态 no-op):
        // 覆盖「离线期间关了 proxy, 上线时 marker 本就是空」这类路径。
        void stopTunnelForHost(host.id);
      }
    }
    // pending 只在一切收敛 (含隧道 armed) 之后才摘除 (R2 review P2)。
    pendingReconcileHosts.delete(host.id);
    return { markerChanged: false, daemonRestarted: false };
  }

  if (liveTurnChecker?.(host.id)) {
    // 漂移生效要重启 daemon / 迁移隧道, 两者都会打断 live turn — 推迟,
    // 漂移持久 (marker 与隧道都未动), turn-done / 下次 session start 必然
    // 补刀 (R1 review P1)。
    pendingReconcileHosts.add(host.id);
    log.warn('agent-proxy drift deferred: live turn in progress on host', {
      hostId: host.id,
      enabled: pref != null,
      markerDrift,
      tunnelDrift,
    });
    return { markerChanged: false, daemonRestarted: false, deferredForLiveTurn: true };
  }

  if (markerDrift) {
    log.info('codex agent-proxy env marker drifted, rewriting + restarting daemon', {
      hostId: host.id,
      enabled: pref != null,
    });
    await writeRemoteMarker(host, desired);
    const kill = await killRemoteCodexDaemon(host);
    if (!kill.ok) {
      // daemon 没死透 → marker 回滚到原值 (codex R10 P1/P2): 存活 daemon 的
      // env 仍来自原 marker; 若让 marker 停在新值, 下次 reconcile 命中
      // marker-match fast path 永不重试 kill — disable 后旧 daemon 握着旧
      // proxy env 跑到手动重启, enable 后旧 daemon 一直跑旧 env。
      // 回滚后 marker 与存活 daemon env 一致, 下次 reconcile 仍 drift →
      // 重写 + 重试 kill, 可自愈。回滚失败仅 warn: 调用方已按失败上报。
      // 隧道不动 (R2 review P1): 存活 daemon 还指着旧端口, 旧隧道保留兜底。
      try {
        await writeRemoteMarker(host, current);
      } catch (rollbackErr) {
        log.warn('agent-proxy marker rollback after pkill failure failed', {
          hostId: host.id,
          error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
        });
      }
      pendingReconcileHosts.add(host.id);
      return { markerChanged: true, daemonRestarted: false };
    }
  }

  // 隧道迁移/拆除放在 marker 写入 + daemon 重启**成功之后** (R2 review P1):
  // write/kill 任一失败时旧隧道原样保留, 存活 daemon 的流量不断。此刻旧
  // daemon 已死 (或本来就是 tunnel-only 迁移、daemon env 无需变), 迁移不再
  // 打断任何在途消费者; 新隧道 armed 不上则抛错 (外层记 pending), 下次
  // reconcile 的 fast path 恒校验 armed, probe 始终 fail-closed。
  if (keeperReady) {
    if (wantsTunnel) {
      ensureTunnelForHost(host, { allowRebuild: true });
      await ensureTunnelUp(host);
    } else {
      await stopTunnelForHost(host.id);
    }
  }
  pendingReconcileHosts.delete(host.id);
  return { markerChanged: markerDrift, daemonRestarted: markerDrift };
}

/**
 * host ready / pref 变更后的统一应用入口 (幂等)。隧道的建/拆/迁移与 marker
 * 一并由 reconcile 在 live-turn gate 内统一执行 (R1 review P1) — 这里只
 * 负责调用 reconcile、收敛 UI 状态与失败上报:
 *   - deferred (live turn) → 一切原样, turn-done 补刀 (pendingReconcile 集合)
 *   - pkill 失败 → 按 apply 失败上报 (卡片显示错误而不是说谎的「已开/关」)
 *   - env 模式成功 → 落 phase='active' (UI 只在确有应用证据时显示「已注入」)
 * 失败不抛 — 状态落 tunnelStates 给 UI, session 路径会再显式重试并拿到错误。
 */
export async function applyAgentProxyForHost(host: RemoteHost): Promise<void> {
  const pref = getSshHostAgentProxy(host.id);
  try {
    const reconciled = await reconcileCodexAgentProxyEnv(host);
    if (reconciled.deferredForLiveTurn) {
      // 配置已变但因 live turn 推迟 — 旧 phase='active' 状态不得继续展示
      // (review: PR #992 codex P2): env 模式会把新 URL 显示成已注入, disable
      // 会连卡片都不显示, 而旧 marker/隧道其实还在服役。改落 pending 态
      // (无 lastError, UI 显示等待), turn-done 补刀后收敛。
      const existing = tunnelStates.get(host.id);
      if (existing?.phase === 'active') {
        tunnelStates.set(host.id, { phase: 'paused', remotePort: existing.remotePort });
        emitState(host.id);
      }
      return;
    }
    // 旧 daemon 没死透 = 它还跑着旧 env, 而 marker 已回滚待重试 — 不得按
    // 成功收口 (codex R9/R10 P1/P2), 让卡片显示错误。
    if (reconciled.markerChanged && !reconciled.daemonRestarted) {
      throw new Error(
        'codex daemon survived pkill after agent-proxy change; it still runs with the previous env (retry or restart the host)',
      );
    }
    if (!pref) {
      tunnelStates.delete(host.id);
      emitState(host.id);
    } else if (pref.mode === 'env') {
      // env 模式无隧道 — 以 phase='active' 记录「已应用」证据, UI 才显示
      // 「已注入」(R1 review P2: 没证据不说谎)。
      tunnelStates.set(host.id, { phase: 'active' });
      emitState(host.id);
    }
    // tunnel 模式: 状态由 keeper 经 onState 持续汇报, 这里不写。
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    log.warn('apply agent-proxy failed (will retry on next session)', { hostId: host.id, error: msg });
    tunnelStates.set(host.id, { phase: 'error', lastError: msg });
    emitState(host.id);
  }
}

/** app 退出清理 (index.ts onQuit 调用)。 */
export { disposeAllTunnels } from './agent-proxy-tunnel.js';

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
