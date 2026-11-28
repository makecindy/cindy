import { MessagesSquare } from 'lucide-react';
import { registerTabKind } from '../../registry';
import { hasTabCloseInterceptor, setActiveTab } from '../../store';
import type { TabKindPlugin } from '../../types';
import { SideChatTabBody } from './SideChatTabBody';
import { cancelPendingSideChat, getPendingSideChat } from './pendingSideChat';
import { hydrateSideChatState, type SideChatState } from './state';

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
    const pending = getPendingSideChat(ctx.tabId);
    if (pending?.status === 'creating' || (!state.sessionId && !pending?.childSession)) {
      cancelPendingSideChat(ctx.tabId);
      return true;
    }
    if (hasTabCloseInterceptor(ctx.tabId)) return true;
    // Recovered, unmounted tabs must install the close handler before a task
    // can be reclaimed.
    await setActiveTab(ctx.sessionId, ctx.tabId);
    return false;
  },
};

registerTabKind(plugin as unknown as TabKindPlugin, import.meta.hot);
