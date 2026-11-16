import { useState } from 'react';
import { ctx, mountPage } from '../../ui-page/harness';
import { RightSidebar } from '../../../src/renderer/components/layout/RightSidebar';
import { useRetainedRightSidebarMount } from '../../../src/renderer/hooks/useRetainedRightSidebarMount';
import { useTabGroupPanes } from '../../../src/renderer/features/right-sidebar/tabGroupPanes';
import { addGlobalPluginTab, setActiveGlobalTabId } from '../../../src/renderer/features/right-sidebar/globalTabs';
import { createDefaultLayout } from '../../../src/shared/layoutTree';
import type { InstalledGhost } from '../../../src/shared/ghost';

const ghost = { enabled: true, dir: '/fixture/board', approval: { state: 'approved', revision: 'one' },
  manifest: { id: 'board', name: 'Board', version: '1', mcpApps: {
    ui: { resources: [{ uri: 'ui://board', file: 'board.html' }], tools: {} },
    host: { views: [{ id: 'board', title: 'Board', resourceUri: 'ui://board', scope: 'global' }] },
  } } } as InstalledGhost;
let layout = createDefaultLayout();

function Scene() {
  const [onChatRoute, setOnChatRoute] = useState(true);
  const globalPage = useTabGroupPanes({ sessionId: null, enabled: true, onChatRoute, remoteHostId: null });
  const presence = useRetainedRightSidebarMount({ available: onChatRoute || globalPage, loaded: true, detached: false });
  return <div className="flex h-screen min-w-0 bg-content-area text-[var(--text-primary)]">
    <main className="min-w-[400px] flex-1 p-6">
      <p className="text-12 text-[var(--text-secondary)]">隔离验收场景，非产品默认界面</p>
      <button data-ui-page-control onClick={() => {
        setOnChatRoute(ctx.case === 'task');
        window.location.hash = ctx.case === 'task' ? '/cc-agent/fixture' : '/plugins';
        const tab = addGlobalPluginTab('board', { ghost, resourceViewId: 'board' });
        if (tab) setActiveGlobalTabId(tab.id);
      }}>打开全局页</button>
    </main>
    {presence.mounted && <RightSidebar isCollapsed={presence.forceCollapsed} width={500} isMac={false}
      sessionId={null} workdir="" remoteHostId={null} />}
  </div>;
}

void mountPage({ route: '/plugins', host: {
  ghosts: { listSync: () => ({ ghosts: [ghost] }), onChanged: () => () => {} },
  layout: { getStateSync: () => ({ layout }), onChanged: () => () => {}, set: async next => { layout = next; } },
  sidebarTabWindow: { getAllStatesSync: () => ({}), onChanged: () => () => {} },
}, render: () => <Scene /> });
