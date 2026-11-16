import { useEffect } from 'react';
import { Route, Routes, useOutletContext } from 'react-router-dom';
import { ctx, mountPage } from '../../ui-page/harness';
import { MainLayout } from '../../../src/renderer/components/layout/MainLayout';
import { openPluginUiView } from '../../../src/renderer/features/right-sidebar/lib/openPluginUiView';
import { removeGlobalTab, useGlobalTabs } from '../../../src/renderer/features/right-sidebar/globalTabs';
import { createDefaultLayout } from '../../../src/shared/layoutTree';
import type { InstalledGhost } from '../../../src/shared/ghost';

const ghost = { enabled: true, dir: '/fixture/board', approval: { state: 'approved', revision: 'one' },
  manifest: { id: 'board', name: 'Board', version: '1', mcpApps: {
    ui: { resources: [{ uri: 'ui://board', file: 'board.html' }], tools: {} },
    host: { views: [{ id: 'board', title: 'Board', resourceUri: 'ui://board', scope: 'global' }] },
  } } } as InstalledGhost;
let layout = createDefaultLayout();
const layoutListeners = new Set<(state: { layout: typeof layout }) => void>();

function Scene() {
  const tabs = useGlobalTabs();
  const { setRightSidebarAvailable, setRightSidebarSessionId } = useOutletContext<{
    setRightSidebarAvailable: (available: boolean) => void;
    setRightSidebarSessionId: (id: string | null) => void;
  }>();
  useEffect(() => {
    if (ctx.case !== 'task') return;
    setRightSidebarSessionId('fixture');
    setRightSidebarAvailable(true);
    return () => { setRightSidebarSessionId(null); setRightSidebarAvailable(false); };
  }, [setRightSidebarAvailable, setRightSidebarSessionId]);
  return <div className="p-6">
      <p className="text-12 text-[var(--text-secondary)]">隔离验收场景，非产品默认界面</p>
      <button data-ui-page-control onClick={() => { void openPluginUiView('board', 'board', null); }}>打开全局页</button>
      <button data-ui-page-control onClick={() => tabs.forEach(tab => removeGlobalTab(tab.id))}>关闭全局页</button>
  </div>;
}

const noopSubscription = () => () => {};
void mountPage({ route: ctx.case === 'task' ? '/cc-agent/fixture' : '/plugins', host: {
  ghosts: { listSync: () => ({ ghosts: [ghost] }), onChanged: noopSubscription,
    onRetirementOpen: noopSubscription },
  layout: { getStateSync: () => ({ layout }), onChanged: listener => {
    layoutListeners.add(listener);
    return () => layoutListeners.delete(listener);
  }, set: async next => {
    layout = next;
    layoutListeners.forEach(listener => listener({ layout }));
  } },
  rightSidebarWindow: { getState: async () => ({ detached: false, open: false }),
    sendCommand: async () => 'attached',
    onStateChanged: noopSubscription, setContext: async () => {}, onCommand: noopSubscription,
    onTabHandoff: noopSubscription },
  sidebarTabWindow: { getState: async () => ({}), onStateChanged: noopSubscription },
  agentIsland: {}, takePendingDeepLink: async () => null,
  onNotificationFocusSession: noopSubscription, onDeepLinkNavigate: noopSubscription,
  onApplicationMenuCommand: noopSubscription,
}, render: () => <Routes><Route element={<MainLayout />}><Route path="*" element={<Scene />} /></Route></Routes> });
