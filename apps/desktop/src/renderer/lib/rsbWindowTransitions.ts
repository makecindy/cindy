import type { RsbWindowUiState } from './rightSidebarWindowState';

/** 用户真正关 detached 窗口时记录 collapsed；合并回 attached 和启动 unknown 不算。 */
export function sessionIdForDetachedSidebarClose(
  detachedHostSessionId: string | null | undefined,
  focusedSessionId: string | null | undefined,
): string | null {
  return detachedHostSessionId || focusedSessionId || null;
}

/** 用户切到被 pin 的宿主后，关窗归属改回跟随焦点。 */
export function nextDetachedHostAfterFocus(
  detachedHostSessionId: string | null | undefined,
  focusedSessionId: string | null | undefined,
): string | null {
  if (focusedSessionId && focusedSessionId === detachedHostSessionId) return null;
  return detachedHostSessionId ?? null;
}

/** 只有真正跨会话 pin 才记录关窗宿主；同会话 open 不会制造陈旧 ref。 */
export function detachedHostAfterOpen(params: {
  currentSessionId: string | null | undefined;
  targetSessionId: string;
  previousHostSessionId: string | null | undefined;
}): string | null {
  if (params.targetSessionId !== params.currentSessionId) return params.targetSessionId;
  if (
    params.previousHostSessionId &&
    params.previousHostSessionId !== params.targetSessionId
  ) {
    return null;
  }
  return params.previousHostSessionId ?? null;
}

export function didUserCloseDetachedSidebarWindow(
  previous: RsbWindowUiState,
  next: RsbWindowUiState,
  isPrimaryWindow = true,
): boolean {
  return Boolean(
    isPrimaryWindow &&
    previous.loaded &&
    previous.detached &&
    previous.open &&
    next.loaded &&
    next.detached &&
    !next.open &&
    next.userClose !== false,
  );
}
