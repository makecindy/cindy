import { addGlobalPluginTab, setActiveGlobalTabId } from '../globalTabs';
import { openPluginTaskTab } from './openPluginTaskTab';
import { requestRightSidebarVisibility } from './sidebarCommands';
import { routeSidebarCommand } from './detachedSidebarRouting';
import { readInstalledGhostsSnapshot } from '@/cindy-brain/useInstalledGhosts';
import { getApprovedGhostHostUi } from '../../../../shared/ghost';
import { installedGhostStoragePart } from '../../../../shared/pluginIdentity';

/** Named resources use existing global/task tab owners and stable identity. */
export async function openPluginUiView(instanceId: string, viewId: string, sessionId: string | null, input?: Record<string, unknown>): Promise<void> {
  const ghost = readInstalledGhostsSnapshot().find(ghost => installedGhostStoragePart(ghost) === instanceId);
  const view = ghost?.enabled && getApprovedGhostHostUi(ghost)?.views?.find(view => view.id === viewId);
  if (!ghost || !view) throw new Error('MCP_APP_SOURCE_UNAVAILABLE');
  if (view.scope !== 'task') {
    const route = await routeSidebarCommand({ type: 'open-plugin-view', instanceId, resourceViewId: viewId,
      ...(input === undefined ? {} : { resourceInput: input }) });
    if (route !== 'attached' && route !== 'routed') throw new Error('MCP_APP_HOST_NOT_READY');
    if (route === 'attached') {
      const tab = addGlobalPluginTab(instanceId, { ghost, resourceViewId: viewId, resourceInput: input });
      if (!tab) throw new Error('MCP_APP_VIEW_LIMIT');
      setActiveGlobalTabId(tab.id);
    }
    requestRightSidebarVisibility('open');
    return;
  }
  if (!sessionId) throw new Error('MCP_APP_TASK_REQUIRED');
  await openPluginTaskTab(sessionId, instanceId, { resourceViewId: viewId, resourceInput: input });
}
