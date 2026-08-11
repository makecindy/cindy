/** Programmatic entry for the per-task durable Subagent workspace. */

import type { SubagentProvider } from '@cindy/maker-shared/subagent-workspace';

import { ensureSingletonTab, getBucket, patchTabState, setActiveTab } from '../store';
import { routeSidebarCommand } from './detachedSidebarRouting';
import { requestRightSidebarVisibility } from './sidebarCommands';

export async function openSubagentsTab(
  sessionId: string,
  /** focusRunId accepts a Cindy run id or any stable harness/tool-call alias. */
  opts?: {
    focusRunId?: string;
    focusProvider?: SubagentProvider;
    userInitiated?: boolean;
    focusTab?: boolean;
    revealSidebar?: boolean;
  },
): Promise<void> {
  if (Boolean(opts?.focusRunId) !== Boolean(opts?.focusProvider)) {
    throw new Error('focusRunId and focusProvider must be provided together');
  }
  const focusTab = opts?.focusTab !== false;
  const revealSidebar = opts?.revealSidebar !== false;
  const command = {
    type: 'open-subagents-tab' as const,
    sessionId,
    focusRunId: opts?.focusRunId ?? null,
    focusProvider: opts?.focusProvider ?? null,
    focusTab,
    revealSidebar,
  };
  const routeOptions = {
    allowOpen: revealSidebar,
    userInitiated: opts?.userInitiated !== false,
  };
  const handleRouted = (routeResult: Awaited<ReturnType<typeof routeSidebarCommand>>): boolean => {
    if (routeResult === 'attached') return false;
    if (routeResult === 'routed' && revealSidebar) {
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

  let tab = await ensureSingletonTab(sessionId, 'subagents', {
    selectedRunId: null,
    selectedProvider: null,
  });

  // Host ownership may change while hydrate/SQLite work is in flight. Ask
  // main again before mutating this renderer's active tab or selection; if a
  // detached host won, the same command is delivered there against the one
  // canonical DB row.
  if (await rerouteIfOwnershipMoved()) return;

  let bucket = getBucket(sessionId);
  if (!bucket.tabs.some((candidate) => candidate.id === tab.id)) {
    tab = await ensureSingletonTab(sessionId, 'subagents', {
      selectedRunId: null,
      selectedProvider: null,
    });
    bucket = getBucket(sessionId);
  }
  if (opts?.focusRunId) {
    await patchTabState(sessionId, tab.id, (current) => ({
      ...(current && typeof current === 'object' ? (current as Record<string, unknown>) : {}),
      selectedRunId: opts.focusRunId,
      selectedProvider: opts.focusProvider,
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
