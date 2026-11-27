/**
 * ccMgrUpgradeStore — 远端 cc-manager bundle 版本不匹配的 pending state。
 *
 * Main 端 silent install pipeline 探到 daemon 报的版本 != desktop 手里 packaged
 * bundle 的 sha256 时, 不强升 (会 kill daemon 中断 alive session), 而是 push 一条
 * UPGRADE_AVAILABLE 事件让 renderer 在该 host 的 cc remote ChatView 顶部显示
 * UpgradeBanner, 让用户决策。
 *
 * 这个 store 持有 per-hostId 的 pending state, React 组件用 `useCcMgrUpgrade(hostId)`
 * hook 订阅。状态变更触发渲染 (顶部 banner 出现 / 消失)。
 *
 * 跟 silentInstallToast 的差异:
 *   - silentInstallToast 是 stateless 监听器 (push 直接转 toast API)
 *   - 本 store 持有状态, 因为 banner 是组件依赖 state 渲染的; 多个 cc remote
 *     session ChatView 共享同一 host 的 banner 状态。
 *
 * 启动时 (`installCcMgrUpgradeListener`) 调一次 `ccMgrListPendingUpgrades` IPC
 * 拉 main 端当前 snapshot — 防止 main 在 renderer listener 挂载前已经 push 了
 * 一条事件 (race window 很小但理论存在)。
 */

interface PendingUpgrade {
  currentVersion: string;
  availableVersion: string;
  /** 轮 22:哪个 daemon 需要升级 —— 'cc' | 'pi'。 */
  agent: 'cc' | 'pi';
}

// ============================================================
// Store internals
// ============================================================

// 轮 22-F2 MEDIUM 修复:同 host 的 cc/pi 两个 daemon 可能同时有版本差 ——
// 按 `${hostId}:${agent}` 双键存, 各自独立渲染 banner。
const state = new Map<string, PendingUpgrade>();
const listeners = new Set<() => void>();

function hostAgentKey(hostId: string, agent: string): string {
  return `${hostId}:${agent}`;
}

// inflightUpgradeHosts: 用户点了「立即升级」从 UpgradeBanner 触发 force-upgrade
// IPC 期间, 这条 hostId 进集合; finally 出。
//
// makerChatStore 的 'error' reducer 在 reason='remote_daemon_closed' 时检查这个
// 集合, 命中 → 不写 error 进 store (仍然正常 finalize stream / 复位 UI), 避免
// "用户主动升级" 也弹"远端 daemon 被中断"误报 banner (codex 审视报告 #问题3)。
// 不命中 (daemon 突死 / 网络断 / 远端 kill) 仍然报 error, 给用户感知。
//
// 纯 client-side flag, 不动 protocol / maker-core / daemon, trade-off:不区分
// CLIENT_REPLACED / completed / killed / error 等更细分的 reason — 这些场景仍
// fall through 到默认 error banner (符合预期)。
const inflightUpgradeSessions = new Set<string>();
export function isSessionUpgrading(sessionId: string): boolean {
  return inflightUpgradeSessions.has(sessionId);
}
function setInflightUpgrade(sessionId: string | undefined, inflight: boolean): void {
  if (!sessionId) return;
  if (inflight) inflightUpgradeSessions.add(sessionId);
  else inflightUpgradeSessions.delete(sessionId);
}

function notify(): void {
  listeners.forEach((l) => l());
}

function setState(hostId: string, next: PendingUpgrade | null, agent?: 'cc' | 'pi'): void {
  // 轮 22-G4 HIGH:clear 路径(next === null)必须显式传 agent —— next?.agent
  // 在 null 时永远取 'cc', 导致 ${hostId}:pi 永远清不掉, pi banner 不消失。
  const key = hostAgentKey(hostId, agent ?? next?.agent ?? 'cc');
  if (next === null) {
    if (!state.delete(key)) return; // no-op if was absent
  } else {
    const prev = state.get(key);
    // Skip notify if shallow-equal (avoid re-rendering banner unnecessarily)
    if (prev && prev.currentVersion === next.currentVersion && prev.availableVersion === next.availableVersion && prev.agent === next.agent) {
      return;
    }
    state.set(key, next);
  }
  notify();
}

// ============================================================
// Public read API (consumed by useSyncExternalStore in hook)
// ============================================================

export function subscribeCcMgrUpgradeStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getCcMgrUpgradeSnapshot(hostId: string, agent: 'cc' | 'pi' = 'cc'): PendingUpgrade | null {
  return state.get(hostAgentKey(hostId, agent)) ?? null;
}

// ============================================================
// Listener install (顶层调用一次)
// ============================================================

/** Install after Maker IPC readiness (MakerBootstrap inside EnvCheckGuard). */
export function installCcMgrUpgradeListener(): () => void {
  let disposed = false;
  // Pushes received while the snapshot is in flight are newer than that
  // snapshot, including clears. Do not resurrect a dismissed upgrade banner.
  const changedDuringSnapshot = new Set<string>();
  let snapshotPending = true;
  const unsubscribe = window.electronAPI.remoteSsh.onCcMgrUpgradeAvailable((payload) => {
    if (disposed) return;
    if (snapshotPending) changedDuringSnapshot.add(hostAgentKey(payload.hostId, payload.agent));
    setState(
      payload.hostId,
      payload.available === null ? null : { ...payload.available, agent: payload.agent },
      payload.agent,
    );
  });

  void window.electronAPI.remoteSsh.ccMgrListPendingUpgrades()
    .then(({ pending }) => {
      if (disposed) return;
      for (const p of pending) {
        if (changedDuringSnapshot.has(hostAgentKey(p.hostId, p.agent))) continue;
        setState(p.hostId, { currentVersion: p.currentVersion, availableVersion: p.availableVersion, agent: p.agent });
      }
    })
    // Snapshot failure does not disable subsequent live upgrade notifications.
    .catch(() => {})
    .finally(() => {
      snapshotPending = false;
      changedDuringSnapshot.clear();
    });

  return () => {
    disposed = true;
    unsubscribe();
  };
}

// ============================================================
// Actions (banner UI 调用)
// ============================================================

/**
 * 用户点 banner「立即升级」: 触发 main 端 kill daemon + re-upload + 重启。
 * 中途 silent install toast 会显示进度。完成后 main 推 available=null,
 * banner 自动消失。
 *
 * 失败时 throw — 调用方 (UpgradeBanner) 显示 inline error 即可, silent toast
 * 的 'failed' phase 也会弹一条独立 error toast 给完整诊断。
 */
export async function forceUpgradeCcMgr(hostId: string, sessionId?: string, agent: 'cc' | 'pi' = 'cc'): Promise<{ daemonReady: boolean }> {
  setInflightUpgrade(sessionId, true);
  try {
    // 把 sessionId 透到 main 端: main 现在只 soft-close 这个 banner-clicker
    // session, 同 host 其它 session 不动 (避免 in-flight turn 静默丢)。
    // 轮 22:agent 参数区分 cc-mgr / pi-manager 升级。
    const r = await window.electronAPI.remoteSsh.ccMgrForceUpgrade(hostId, sessionId, agent);
    return { daemonReady: r.daemonReady };
  } finally {
    setInflightUpgrade(sessionId, false);
  }
}

/**
 * 用户点 banner X: 关闭本 host 的 banner。本 desktop session 不再提示该 host,
 * 直到下次 desktop 重启或显式重连 host (silent install 再次探到版本差距才会
 * 重新写入 pending)。
 */
export async function dismissCcMgrUpgrade(hostId: string, agent: 'cc' | 'pi' = 'cc'): Promise<void> {
  await window.electronAPI.remoteSsh.ccMgrDismissPendingUpgrade(hostId, agent);
}
