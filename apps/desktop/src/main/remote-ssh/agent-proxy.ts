/**
 * agent-proxy —— 「Agent 流量经 SSH 隧道走本地 Proxy」的策略层。
 *
 * 链路与职责切分:
 *
 *   远端 codex daemon / claude CLI
 *     │  HTTPS_PROXY=http://127.0.0.1:<remotePort>   (env 注入)
 *     ▼
 *   远端 127.0.0.1:<remotePort>                     (sshd remote forwarding, ssh -R)
 *     │  SSH 连接内多路复用 channel                    (RemoteHost.ensureRemoteForward)
 *     ▼
 *   本机 pipe → 用户自己的本地 Proxy (如 127.0.0.1:7890)
 *
 * Cindy 不提供 Proxy, 只提供隧道。域名解析发生在用户 Proxy 那一端
 * (HTTP CONNECT 语义), 远端完全不需要能解 chatgpt.com / api.anthropic.com。
 *
 * 两个 agent 的 env 注入方式不同:
 *   - claude-code: cc-mgr daemon 按 session spawn SDK, startParams.env 每
 *     次会话重建 — 直接在 remoteCcQueryFactory 里 merge, 即时生效。
 *   - codex: app-server daemon 是远端常驻进程, env 只能在 daemon 启动时
 *     生效。所以写一个 marker 文件 ($INSTALL_ROOT/agent-proxy.env),
 *     daemon wrapper 启动前 source 它; marker 漂移时 pkill daemon
 *     (daemon version 探活失败 → 下次 transport bootstrap 重新拉起,
 *     与 auth sync 的 daemonRestart 同套路)。
 */

import {
  REMOTE_AGENT_PROXY_ENV_PATH,
  REMOTE_INSTALL_ROOT,
  type RemoteHost,
} from '@cindy/maker-remote-ssh';

import { createLogger } from '../logger.js';
import { getSshHostAgentProxy } from './ssh-host-prefs-store.js';

const log = createLogger('remote-ssh/agent-proxy');

/** UI 展示用的隧道实时状态 (内存态, 不持久化)。 */
export interface AgentProxyTunnelState {
  active: boolean;
  remotePort?: number;
  lastError?: string;
}

const tunnelStates = new Map<string, AgentProxyTunnelState>();

export function getAgentProxyTunnelState(hostId: string): AgentProxyTunnelState | null {
  return tunnelStates.get(hostId) ?? null;
}

/** host 删除时同步清掉内存态。 */
export function clearAgentProxyTunnelState(hostId: string): void {
  tunnelStates.delete(hostId);
}

/**
 * 断连时把隧道标记为非活跃 (review: PR #715 copilot R3): 状态只在内存,
 * 断连后 forward 已 disarm, UI 不应继续显示「已建立」。愿望仍在 —
 * reconnect ready 时 applyAgentProxyForHost 会重建并重新标活跃。
 * 仅在确实有 active 记录时动作 (避免无意义 broadcast 刷屏)。
 */
export function markAgentProxyTunnelInactive(hostId: string): void {
  const cur = tunnelStates.get(hostId);
  if (!cur?.active) return;
  tunnelStates.set(hostId, { active: false });
  emitState(hostId);
}

// broadcast 由 index.ts 注入 (避免循环依赖): 隧道状态变化后推一版
// status snapshot 给 renderer, HostSnapshotWithPrefs 会带上最新 tunnel state。
let broadcaster: ((hostId: string) => void) | null = null;
export function initAgentProxy(deps: { broadcast: (hostId: string) => void }): void {
  broadcaster = deps.broadcast;
}
function emitState(hostId: string): void {
  try {
    broadcaster?.(hostId);
  } catch { /* broadcast must not throw into ssh paths */ }
}

/* ============================== env 构造 ============================== */

/**
 * 注入远端 agent 进程的代理 env。大小写两份: Rust (reqwest) / Node /
 * Go / curl 对 HTTPS_PROXY vs https_proxy 的读取习惯不一致, 全给最稳。
 * NO_PROXY 只排除 loopback — 用户自己的 Proxy 规则决定内网域名直连与否,
 * 那是 Proxy 软件的职责, 不是我们的。
 */
export function buildAgentProxyEnv(remotePort: number): Record<string, string> {
  const url = `http://127.0.0.1:${remotePort}`;
  const noProxy = 'localhost,127.0.0.1,::1';
  return {
    HTTPS_PROXY: url,
    HTTP_PROXY: url,
    NO_PROXY: noProxy,
    https_proxy: url,
    http_proxy: url,
    no_proxy: noProxy,
  };
}

/**
 * 仅大写版本 — env-block.ts 的 gatekeeper 拒小写 key (防 stdin 协议注入),
 * one-shot 的 envBlock 路径只能拿大写; claude/codex 都认大写。
 */
export function buildAgentProxyEnvUppercase(remotePort: number): Record<string, string> {
  const url = `http://127.0.0.1:${remotePort}`;
  return {
    HTTPS_PROXY: url,
    HTTP_PROXY: url,
    NO_PROXY: 'localhost,127.0.0.1,::1',
  };
}

/** codex daemon wrapper source 的 marker 文件内容。 */
export function buildAgentProxyMarkerContent(remotePort: number): string {
  const url = `http://127.0.0.1:${remotePort}`;
  return [
    '# Written by Cindy — agent proxy tunnel env. Sourced by the codex daemon wrapper.',
    `export HTTPS_PROXY='${url}'`,
    `export HTTP_PROXY='${url}'`,
    `export NO_PROXY='localhost,127.0.0.1,::1'`,
    `export https_proxy='${url}'`,
    `export http_proxy='${url}'`,
    `export no_proxy='localhost,127.0.0.1,::1'`,
    '',
  ].join('\n');
}

/* ============================== 隧道管理 ============================== */

export interface AgentProxyTunnelInfo {
  remotePort: number;
  /** 与新 pref 不匹配的旧 forward (rebind 场景), 由调用方决定拆除时机。 */
  staleForwards: Array<{ localHost: string; localPort: number }>;
}

/**
 * pref 开启时确保隧道在跑, 返回远端端口; pref 关闭返回 null。
 * host 必须 ready (调用方保证); arm 失败抛错并记录到 tunnel state。
 *
 * rebind (目标被编辑) 场景**先建后拆** (codex R17 P2): 新 forward 建立
 * 失败时旧 forward 原样保留, 存活 daemon 流量不断。closeStale !== false
 * (默认) 建成功后立即拆旧 (R5 语义: 不拆会残留并随重连 re-arm, 远端
 * 多暴露一个隧道口); reconcile 传 closeStale: false, 把拆旧推迟到
 * daemon 重启成功之后 (pkill 失败时旧隧道保留兜底)。
 */
export async function ensureAgentProxyTunnel(
  host: RemoteHost,
  opts?: { closeStale?: boolean },
): Promise<AgentProxyTunnelInfo | null> {
  const pref = getSshHostAgentProxy(host.id);
  if (!pref) return null;
  try {
    const fwd = await host.ensureRemoteForward({
      localHost: pref.localHost,
      localPort: pref.localPort,
    });
    const staleForwards = host
      .listRemoteForwards()
      .filter((f) => f.localHost !== pref.localHost || f.localPort !== pref.localPort);
    if (opts?.closeStale !== false) {
      for (const f of staleForwards) {
        try {
          await host.closeRemoteForward(f.localHost, f.localPort);
        } catch (err) {
          log.warn('close stale remote forward failed (best-effort)', {
            hostId: host.id,
            staleTarget: `${f.localHost}:${f.localPort}`,
            error: String((err as Error)?.message ?? err),
          });
        }
      }
    }
    tunnelStates.set(host.id, { active: true, remotePort: fwd.remotePort });
    emitState(host.id);
    return { remotePort: fwd.remotePort, staleForwards };
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    tunnelStates.set(host.id, { active: false, lastError: msg });
    emitState(host.id);
    throw err;
  }
}

/** 拆旧 forward (rebind 残留) — best-effort, 单个失败不阻塞其余。 */
async function closeStaleForwards(
  host: RemoteHost,
  staleForwards: Array<{ localHost: string; localPort: number }>,
): Promise<void> {
  for (const f of staleForwards) {
    try {
      await host.closeRemoteForward(f.localHost, f.localPort);
    } catch (err) {
      log.warn('close stale remote forward failed (best-effort)', {
        hostId: host.id,
        staleTarget: `${f.localHost}:${f.localPort}`,
        error: String((err as Error)?.message ?? err),
      });
    }
  }
}

/**
 * claude-code session 路径: pref 开启 → 确保隧道 + 返回要 merge 进
 * startParams.env 的代理 env; 关闭 → null (调用方原样透传 startParams)。
 */
export async function getRemoteAgentProxyEnv(
  host: RemoteHost,
): Promise<Record<string, string> | null> {
  const tunnel = await ensureAgentProxyTunnel(host);
  if (!tunnel) return null;
  return buildAgentProxyEnv(tunnel.remotePort);
}

/** 拆除本 host 的所有 forward (pref 关闭时调用)。 */
async function closeAllForwards(host: RemoteHost): Promise<void> {
  try {
    await host.closeAllRemoteForwards();
  } catch (err) {
    log.warn('close remote forwards failed (best-effort)', {
      hostId: host.id,
      error: String((err as Error)?.message ?? err),
    });
  }
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

/**
 * codex 路径的 env 对账: 比较远端 marker 与期望值, 漂移则重写 marker +
 * pkill daemon (下次 transport bootstrap 时 daemon version 探活失败 →
 * 重新 bootstrap, wrapper source 新 marker, env 生效)。
 *
 * 调用点:
 *   1. codex-remote-transport bootstrap 的 beforeDaemonProbe (每个新
 *      app-server host 建立前) — 兜底所有路径 (app 重启 / 端口变化 /
 *      远端被别的客户端动过)。
 *   2. pref 变更 / host ready 的 applyAgentProxyForHost — 即时生效。
 *
 * marker 一致时零副作用 (1 次 cat RTT)。pkill 失败不抛错 — marker 回滚到
 * 原值 (与存活 daemon 的 env 保持一致, 否则下次 reconcile 命中 fast path
 * 永不重试 kill, codex R10 P1/P2), 调用方按 markerChanged && !daemonRestarted
 * 组合上报失败。
 */
export async function reconcileCodexAgentProxyEnv(
  host: RemoteHost,
): Promise<{ markerChanged: boolean; daemonRestarted: boolean }> {
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
): Promise<{ markerChanged: boolean; daemonRestarted: boolean }> {
  const pref = getSshHostAgentProxy(host.id);
  let desired: string | null = null;
  let staleForwards: Array<{ localHost: string; localPort: number }> = [];
  if (pref) {
    // 拆旧推迟到 daemon 重启成功后 (codex R17 P2): pkill 失败时旧隧道保留,
    // 存活 daemon 仍指旧端口, 流量不断; 新 forward 闲置在 pref 目标上
    // (语义正确, 下次 reconcile 直接用)。
    const tunnel = await ensureAgentProxyTunnel(host, { closeStale: false });
    if (!tunnel) throw new Error('agentProxy pref enabled but tunnel refused to start');
    desired = buildAgentProxyMarkerContent(tunnel.remotePort);
    staleForwards = tunnel.staleForwards;
  }

  const current = await readRemoteMarker(host);
  if (current === (desired ? desired.trim() : null)) {
    // marker 一致 (fast path): daemon env 已是新目标, rebind 残留的旧
    // forward 可以安全拆 (R5 语义; pref 关路径由 closeAllForwards 统一拆)。
    if (staleForwards.length > 0) await closeStaleForwards(host, staleForwards);
    return { markerChanged: false, daemonRestarted: false };
  }

  log.info('codex agent-proxy env marker drifted, rewriting + restarting daemon', {
    hostId: host.id,
    enabled: pref != null,
  });
  await writeRemoteMarker(host, desired);
  const kill = await killRemoteCodexDaemon(host);
  if (!kill.ok) {
    // daemon 没死透 → marker 回滚到原值 (codex R10 P1/P2): 存活 daemon 的
    // env 仍来自原 marker; 若让 marker 停在新值, 下次 reconcile 命中
    // marker-match fast path 永不重试 kill — disable 后旧 daemon 握着指向
    // 已拆隧道的 proxy env 跑到手动重启, enable 后旧 daemon 一直跑旧 env。
    // 回滚后 marker 与存活 daemon env 一致, 下次 reconcile 仍 drift →
    // 重写 + 重试 kill, 可自愈。回滚失败仅 warn: 调用方已按失败上报。
    // 不拆任何 forward (codex R17 P2): 旧 forward 保留兜底, 存活 daemon
    // 仍指旧端口, 流量不断。
    try {
      await writeRemoteMarker(host, current);
    } catch (rollbackErr) {
      log.warn('agent-proxy marker rollback after pkill failure failed', {
        hostId: host.id,
        error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
      });
    }
    return { markerChanged: true, daemonRestarted: false };
  }
  // daemon 重启成功: 拆旧 (R5 语义, 时机后移到重启成功后, codex R17 P2)。
  if (staleForwards.length > 0) await closeStaleForwards(host, staleForwards);
  return { markerChanged: true, daemonRestarted: true };
}

/**
 * host ready / pref 变更后的统一应用入口 (幂等):
 *   - pref 开 → 建隧道 + codex marker 对账
 *   - pref 关 → 拆隧道 + 清 marker (有残留 daemon 时重启之)
 * 失败不抛 — 状态落 tunnelStates 给 UI, session 路径会再显式重试并拿到错误。
 */
export async function applyAgentProxyForHost(host: RemoteHost): Promise<void> {
  const pref = getSshHostAgentProxy(host.id);
  try {
    if (!pref) {
      await closeAllForwards(host);
      const reconciled = await reconcileCodexAgentProxyEnv(host);
      // 隧道已拆但旧 daemon 没死透 = 它还握着指向已关闭端口的 proxy env,
      // 后续 codex turn 全部 proxy-connect 失败, 而 marker/隧道状态已清、
      // UI 显示 proxy 已关 (codex R9 P2) — 按 apply 失败上报, 让用户在
      // 卡片上看到错误而不是一个说谎的「已关闭」。
      if (reconciled.markerChanged && !reconciled.daemonRestarted) {
        throw new Error(
          'codex daemon survived pkill after proxy disable; it still holds the old proxy env (retry disable or restart the host)',
        );
      }
      tunnelStates.delete(host.id);
      emitState(host.id);
      return;
    }
    await ensureAgentProxyTunnel(host);
    const reconciled = await reconcileCodexAgentProxyEnv(host);
    // 隧道建好但旧 daemon 没死透 = 它还跑着旧 env (无 proxy / 旧端口), 不得
    // 按成功落 active 状态 (codex R10 P1) — 与 disable 分支同款按失败上报,
    // 让卡片显示错误而不是说谎的「已开启」。
    if (reconciled.markerChanged && !reconciled.daemonRestarted) {
      throw new Error(
        'codex daemon survived pkill after proxy enable/rebind; it still runs with the previous env (retry or restart the host)',
      );
    }
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    log.warn('apply agent-proxy failed (will retry on next session)', { hostId: host.id, error: msg });
    tunnelStates.set(host.id, { active: false, lastError: msg });
    emitState(host.id);
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
