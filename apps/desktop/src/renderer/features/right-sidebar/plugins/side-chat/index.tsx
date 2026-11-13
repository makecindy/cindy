import { lazy } from 'react';
import { MessagesSquare } from 'lucide-react';
import { registerTabKind } from '../../registry';
import { hasTabCloseInterceptor, setActiveTab } from '../../store';
import type { TabKindPlugin } from '../../types';
import { hydrateSideChatState, type SideChatState } from './state';

const SideChatTabBody = lazy(() => import('./SideChatTabBody').then(module => ({ default: module.SideChatTabBody })));

const plugin: TabKindPlugin<SideChatState> = {
  kind: 'side-chat',
  menu: {
    kind: 'side-chat',
    labelKey: 'chat.sideChat.new',
    descriptionKey: 'rightSidebar.tabs.descriptions.sideChat',
    icon: MessagesSquare,
    order: 19,
    enabled: true,
  },
  TabPillTitle: ({ t }) => <>{t('chat.sideChat.title')}</>,
  TabPillIcon: () => <MessagesSquare size={13} />,
  TabBody: SideChatTabBody,
  defaultState: () => ({ sessionId: null, deviceId: null }),
  hydrateState: hydrateSideChatState,
  serializeState: hydrateSideChatState,
  onBeforeClose: async (state, ctx) => {
    if (!state.sessionId || hasTabCloseInterceptor(ctx.tabId)) return true;
    // Recovered, unmounted tabs must install their confirmation before deletion.
    await setActiveTab(ctx.sessionId, ctx.tabId);
    return false;
  },
};

registerTabKind(plugin as unknown as TabKindPlugin, import.meta.hot);
