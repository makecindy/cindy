import { createContext, useContext } from 'react';
import { matchPath, useMatch, useNavigate } from 'react-router-dom';
import { resolveAgentIslandVisibleSessionIdFromPath } from '@/lib/agentIslandVisibleSessionRoute';
import { isProjectDraftRightSidebarSessionId, makeProjectDraftRightSidebarSessionId } from '@/features/cc-agent/newMakerDraftRightSidebar';
import type { TabKindHostContext } from '@/features/right-sidebar/types';
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { hasApprovedGhostViewDirectoryContext } from '../../shared/ghost';
import type { GhostMainViewItem } from './ghostMainViews';
import type { PluginViewDirectorySource } from '../../shared/pluginViewDirectoryContext';

export const PluginNavigationDirectorySource = createContext<PluginViewDirectorySource | null>(null);

type DirectoryHost = Omit<Pick<TabKindHostContext, 'sessionId' | 'workdir' | 'remoteHostId' | 'deviceLinkDeviceId'>, 'sessionId'> &
  { sessionId: string | null };

export function sidebarPluginDirectorySource(ctx: DirectoryHost): PluginViewDirectorySource | null {
  if (!ctx.sessionId || ctx.remoteHostId || ctx.deviceLinkDeviceId !== null) return null;
  if (isProjectDraftRightSidebarSessionId(ctx.sessionId)) {
    return ctx.workdir && makeProjectDraftRightSidebarSessionId(ctx.workdir) === ctx.sessionId
      ? { kind: 'project', projectDir: ctx.workdir } : null;
  }
  return { kind: 'task', sessionId: ctx.sessionId };
}

export function navigationPluginDirectorySource(pathname: string, host: DirectoryHost): PluginViewDirectorySource | null {
  const source = sidebarPluginDirectorySource(host);
  if (source?.kind === 'project') return pathname === '/cc-agent/new' ? source : null;
  if (source?.kind !== 'task') return null;
  const routeId = resolveAgentIslandVisibleSessionIdFromPath(pathname) ??
    matchPath('/cc-agent/orca/:sessionId', pathname)?.params.sessionId ??
    matchPath('/bots/:botId/session/:sessionId', pathname)?.params.sessionId;
  return routeId === source.sessionId ? source : null;
}


export function useOpenPluginMainView() {
  const navigate = useNavigate();
  const activeInstance = useMatch('/apps/:ghostId')?.params.ghostId;
  const directorySource = useContext(PluginNavigationDirectorySource);
  return (item: GhostMainViewItem) => {
    const contextual = item.installedGhost && hasApprovedGhostViewDirectoryContext(item.installedGhost);
    if (contextual && activeInstance === item.instanceId) return;
    navigate(`/apps/${encodeURIComponent(item.instanceId)}`, contextual && directorySource
      ? { state: { directorySource, directoryOwner: getDataOwnerGeneration() } }
      : undefined);
  };
}
