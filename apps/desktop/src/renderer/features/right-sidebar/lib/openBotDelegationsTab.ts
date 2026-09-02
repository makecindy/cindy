import { ensureSingletonTab, getBucket, patchTabState, setActiveTab } from '../store';
import { routeSidebarCommand } from './detachedSidebarRouting';
import { requestRightSidebarVisibility } from './sidebarCommands';

export async function openBotDelegationsTab(
  sessionId: string,
  opts?: {
    focusDelegationId?: string;
    userInitiated?: boolean;
    focusTab?: boolean;
    revealSidebar?: boolean;
  },
): Promise<void> {
  const focusTab = opts?.focusTab !== false;
  const revealSidebar = opts?.revealSidebar !== false;
  const command = {
    type: 'open-bot-delegations-tab' as const,
    sessionId,
    focusDelegationId: opts?.focusDelegationId ?? null,
    focusTab,
    revealSidebar,
  };
  const routeOptions = {
    allowOpen: revealSidebar,
    userInitiated: opts?.userInitiated !== false,
  };
  const handleRouted = (result: Awaited<ReturnType<typeof routeSidebarCommand>>): boolean => {
    if (result === 'attached') return false;
    if (result === 'routed' && revealSidebar) {
      requestRightSidebarVisibility('open', {
        sessionId,
        userInitiated: opts?.userInitiated !== false,
      });
    }
    return true;
  };
  const rerouteIfOwnershipMoved = async (): Promise<boolean> =>
    handleRouted(await routeSidebarCommand(command, routeOptions));

  const routeResult = await routeSidebarCommand(command, routeOptions);
  if (routeResult !== 'attached') {
    handleRouted(routeResult);
    return;
  }

  let tab = await ensureSingletonTab(sessionId, 'bot-delegations', {
    selectedDelegationId: null,
  });
  if (await rerouteIfOwnershipMoved()) return;

  let bucket = getBucket(sessionId);
  if (!bucket.tabs.some((candidate) => candidate.id === tab.id)) {
    tab = await ensureSingletonTab(sessionId, 'bot-delegations', {
      selectedDelegationId: null,
    });
    bucket = getBucket(sessionId);
  }
  if (opts?.focusDelegationId) {
    await patchTabState(sessionId, tab.id, (current) => ({
      ...(current && typeof current === 'object' ? (current as Record<string, unknown>) : {}),
      selectedDelegationId: opts.focusDelegationId,
    }));
    if (await rerouteIfOwnershipMoved()) return;
  }
  if ((focusTab || bucket.activeTabId === null) && bucket.activeTabId !== tab.id) {
    await setActiveTab(sessionId, tab.id);
    if (await rerouteIfOwnershipMoved()) return;
  }
  if (revealSidebar) {
    requestRightSidebarVisibility('open', {
      sessionId,
      userInitiated: opts?.userInitiated !== false,
    });
  }
}
