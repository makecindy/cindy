/**
 * RSB sidebar imperative visibility command.
 *
 * Owner of the right-sidebar collapsed/open state is MainLayout (per-session
 * persisted via writeCollapsedFor). Distant call-sites — notably the
 * RsbWebviewBackend tab-op bridge — need to drive that visibility from far
 * away in the tree without threading refs or context through five layers.
 *
 * Single channel, single payload: `'open' | 'close'` plus optional request
 * metadata. Callers compute the desired visibility in PLAIN CODE (e.g.
 * "open tab → ensure open", "closed the last tab → ensure close") and
 * dispatch through this emitter. The subscriber (MainLayout) handles
 * "already in that state → no-op" so the caller never has to know current
 * state.
 *
 * Animation is also caller-owned intent. MainLayout owns the actual
 * RightSidebarHandle, but the event source knows whether the change is a
 * user/direct reveal (animate) or a passive route restore that should be
 * instantly in place (skip animation).
 *
 * Why a single channel with an argument instead of two separate functions
 * (request-open + request-close): the call site already knows the target
 * state from its own deterministic logic; forcing two functions just
 * duplicates the listener wiring and invites drift. One channel, one
 * argument, one subscriber: deterministic, easy to reason about, easy to
 * test.
 */

export type SidebarVisibilityRequest = 'open' | 'close';

/**
 * Optional context the caller attaches to a visibility request.
 *
 * `sessionId`: the RSB session this request is *about*. RsbWebviewBackend
 * passes the session that owns the affected tab (the request was triggered by
 * an agent action against THAT session, not necessarily whichever session the
 * user is currently looking at). The subscriber (MainLayout) decides:
 *   - request.sessionId === current session → drive UI + persist
 *   - request.sessionId !== current session → only persist, don't touch UI
 *
 * Why this matters: agent triggers `open` for session A → user instantly
 * switches to session B before the bridge dispatch reaches MainLayout. If the
 * listener naively setIsRightSidebarCollapsed(false), session B's sidebar pops
 * open (user sees a panel they didn't ask for) AND the new tab lives in
 * session A's bucket (which is collapsed). Solution: tag every request with
 * its target sessionId so MainLayout can update the right archive instead.
 *
 * Omitting `sessionId` means "current session" — used by direct UI buttons
 * (e.g. the toggle in ContentHeader doesn't know about cross-session state).
 *
 * `animate`: false tells the subscriber not to prime the RightSidebar 250ms
 * transition for this request. Omitted keeps the existing behavior and is
 * equivalent to true.
 */
export interface SidebarVisibilityRequestOptions {
  sessionId?: string;
  animate?: boolean;
  /**
   * 这次请求是不是用户当次手势直接要求的。缺省 true —— 既有调用点几乎全是
   * 用户手势(点链接 / 菜单 / 按钮),观感不变。
   *
   * 程序自发的请求(插件 preview 槽开页、agent 浏览器自动化 tab-op)必须传
   * false:detached 形态下订阅方只更新折叠存档 / 送内容,**不得**把子窗口
   * show + focus 抢走用户当前前台应用(Windows 上 focus() 就是抢前台)。
   */
  userInitiated?: boolean;
}

type Listener = (
  visibility: SidebarVisibilityRequest,
  opts: SidebarVisibilityRequestOptions,
) => void;

const listeners = new Set<Listener>();

/** Default animation policy for command-driven visibility changes. */
export function shouldAnimateSidebarVisibilityRequest(
  opts: SidebarVisibilityRequestOptions,
): boolean {
  return opts.animate !== false;
}

/**
 * Signal that the sidebar's visibility should change. Idempotent at the
 * delivery layer — subscribers compare against current state and skip the
 * no-op themselves. Listener throws are swallowed (a buggy subscriber must
 * not poison-pill the caller).
 */
export function requestRightSidebarVisibility(
  visibility: SidebarVisibilityRequest,
  opts: SidebarVisibilityRequestOptions = {},
): void {
  for (const l of listeners) {
    try {
      l(visibility, opts);
    } catch {
      // Listener throws are non-fatal — they shouldn't break the caller.
    }
  }
}

/** Subscribe for visibility-change requests. */
export function onRequestRightSidebarVisibility(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only reset. */
export function _resetSidebarCommandsForTests(): void {
  listeners.clear();
}
