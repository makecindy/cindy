import { addOrFocusSingletonTab, ensureHydrated, patchTabState } from '../store';
import { routeSidebarCommand } from './detachedSidebarRouting';
import { requestRightSidebarVisibility } from './sidebarCommands';

let nextRequestNonce = 0;

export async function openTurnReview(
  sessionId: string,
  changeSetIds: string[],
  opts: {
    selectedDiffId?: string | null;
    selectedPath?: string | null;
    requestNonce?: number;
    /**
     * 承载 review tab 的 RSB 桶(缺省 = sessionId 自身)。协同面板里 worker 流
     * 的入口传 lead sessionId —— worker 自己的桶在协同视图下不可见,tab 开进去
     * 用户看不到任何反应。
     */
    hostSessionId?: string | null;
  } = {},
): Promise<void> {
  const requestNonce = opts.requestNonce ?? ++nextRequestNonce;
  const hostSessionId = opts.hostSessionId ?? sessionId;
  const command = {
    type: 'open-turn-review' as const,
    sessionId,
    changeSetIds,
    selectedDiffId: opts.selectedDiffId ?? null,
    selectedPath: opts.selectedPath ?? null,
    requestNonce,
    hostSessionId,
  };
  const routeResult = await routeSidebarCommand(command);
  if (routeResult !== 'attached') {
    if (routeResult === 'routed')
      requestRightSidebarVisibility('open', { sessionId: hostSessionId });
    return;
  }

  await ensureHydrated(hostSessionId);
  const tab = await addOrFocusSingletonTab(hostSessionId, 'review', null);
  await patchTabState(hostSessionId, tab.id, (current) => {
    const preserved =
      current && typeof current === 'object' ? { ...(current as Record<string, unknown>) } : {};
    const messageSnapshot = {
      kind: 'turn-set' as const,
      changeSetIds,
      // 目标会话与宿主桶不同(跨会话审查 worker 的轮次)时,review 插件按它取数。
      targetSessionId: sessionId,
    };
    delete preserved.turnTarget;
    return {
      ...preserved,
      descriptor: messageSnapshot,
      messageSnapshot,
      jumpTarget: {
        diffId: opts.selectedDiffId ?? null,
        path: opts.selectedPath ?? null,
        nonce: requestNonce,
      },
    };
  });
  requestRightSidebarVisibility('open', { sessionId: hostSessionId });
}
