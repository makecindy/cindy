import { Puzzle } from 'lucide-react';
import { parseGhostNativeUi } from '@cindy/plugin-protocol';
import { GhostPanelError, GhostWebviewBody } from '@/cindy-brain/ghostPanelBody';
import { useGhostRuntimeState } from '@/cindy-brain/runtimeStates';
import { useInstalledGhosts } from '@/cindy-brain/useInstalledGhosts';
import { installedGhostStoragePart } from '../../../../../shared/pluginIdentity';
import { parsePluginTabViewState, type PluginTabViewState } from '../../../../../shared/pluginUi';
import { registerTabKind } from '../../registry';
import type { TabKindBodyProps, TabKindPlugin } from '../../types';

function useView(state: PluginTabViewState) {
  const ghost = useInstalledGhosts().find(candidate => installedGhostStoragePart(candidate) === state.instanceId);
  const ui = parseGhostNativeUi(ghost?.manifest.ui);
  const view = ui?.version === 1 ? ui.tabViews?.find(view => view.id === state.id && view.scope === state.scope) : undefined;
  return { ghost, view };
}

function PluginTabViewBody({ state, ctx, active, shellVisible }: TabKindBodyProps<PluginTabViewState>) {
  const { ghost, view } = useView(state);
  const runtime = useGhostRuntimeState(state.instanceId);
  if (state.scope === 'session' && (ctx.remoteHostId || ctx.deviceLinkDeviceId !== null)) return null;
  if (!ghost || !view || ghost.enabled === false) return null;
  if (runtime === 'crashed' || runtime === 'fused') return <GhostPanelError ghost={ghost} state={runtime} />;
  return <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
    <GhostWebviewBody ghost={ghost} html={view.page} tabView={{ tabId: ctx.tabId, id: state.id,
      sessionId: state.scope === 'session' ? ctx.sessionId : null, visible: active !== false && shellVisible !== false }} />
  </div>;
}

const plugin: TabKindPlugin<PluginTabViewState> = {
  kind: 'plugin-tab-view',
  menu: { kind: 'plugin-tab-view', labelKey: 'rightSidebar.tabs.kinds.pluginView', icon: Puzzle,
    order: 92, enabled: true, hiddenFromMenu: true },
  TabPillTitle: ({ state }) => { const { view } = useView(state); return <>{view?.title ?? state.id}</>; },
  TabPillIcon: () => <Puzzle size={13} />,
  TabBody: PluginTabViewBody,
  defaultState: () => ({ instanceId: '', id: '', scope: 'global' }),
  hydrateState: raw => parsePluginTabViewState(raw) ?? { instanceId: '', id: '', scope: 'global' },
  serializeState: raw => parsePluginTabViewState(raw),
};
registerTabKind(plugin as unknown as TabKindPlugin, import.meta.hot);
