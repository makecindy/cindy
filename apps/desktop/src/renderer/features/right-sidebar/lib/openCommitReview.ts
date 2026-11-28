import { addOrFocusSingletonTab, ensureHydrated, patchTabState } from '../store';
import { routeSidebarCommand } from './detachedSidebarRouting';
import { requestRightSidebarVisibility } from './sidebarCommands';

export async function openCommitReview(sessionId: string, commitOid: string): Promise<void> {
  const routeResult = await routeSidebarCommand({
    type: 'open-commit-review',
    sessionId,
    commitOid,
  });
  if (routeResult !== 'attached') {
    if (routeResult === 'routed') requestRightSidebarVisibility('open', { sessionId });
    return;
  }

  await ensureHydrated(sessionId);
  const tab = await addOrFocusSingletonTab(sessionId, 'review', null);
  await patchTabState(sessionId, tab.id, (current) => ({
    ...(current && typeof current === 'object' ? (current as Record<string, unknown>) : {}),
    descriptor: { kind: 'commit' as const, commitOid },
    commitSourcePinned: true,
  }));
  requestRightSidebarVisibility('open', { sessionId });
}
