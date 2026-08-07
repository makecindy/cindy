import {
  addOrFocusSingletonTab,
  ensureHydrated,
  patchTabState,
} from '../store';
import { routeSidebarCommand } from './detachedSidebarRouting';
import { requestRightSidebarVisibility } from './sidebarCommands';

let nextRequestNonce = 0;

export async function openTurnReview(
  sessionId: string,
  changeSetIds: string[],
  opts: { selectedDiffId?: string | null; selectedPath?: string | null; requestNonce?: number } = {},
): Promise<void> {
  const requestNonce = opts.requestNonce ?? ++nextRequestNonce;
  const command = {
    type: 'open-turn-review' as const,
    sessionId,
    changeSetIds,
    selectedDiffId: opts.selectedDiffId ?? null,
    selectedPath: opts.selectedPath ?? null,
    requestNonce,
  };
  const routeResult = await routeSidebarCommand(command);
  if (routeResult !== 'attached') {
    if (routeResult === 'routed') requestRightSidebarVisibility('open', { sessionId });
    return;
  }

  await ensureHydrated(sessionId);
  const tab = await addOrFocusSingletonTab(sessionId, 'review', null);
  await patchTabState(sessionId, tab.id, (current) => ({
    ...(current && typeof current === 'object' ? current as Record<string, unknown> : {}),
    turnTarget: {
      changeSetIds,
      selectedDiffId: opts.selectedDiffId ?? null,
      selectedPath: opts.selectedPath ?? null,
      requestNonce,
    },
  }));
  requestRightSidebarVisibility('open', { sessionId });
}
