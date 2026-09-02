import { lazy } from 'react';
import { Share2 } from 'lucide-react';
import type { TFunction } from 'i18next';

import { registerTabKind } from '../../registry';
import type { TabKindPlugin } from '../../types';

const BotDelegationsBody = lazy(() =>
  import('./BotDelegationsBody').then((module) => ({ default: module.BotDelegationsBody })),
);

export interface BotDelegationsState {
  selectedDelegationId?: string | null;
}

function TabTitle({ t }: { state: BotDelegationsState; t: TFunction }) {
  return <>{t('rightSidebar.tabs.kinds.botDelegations')}</>;
}

function TabIcon() {
  return <Share2 size={13} />;
}

const plugin: TabKindPlugin<BotDelegationsState> = {
  kind: 'bot-delegations',
  menu: {
    kind: 'bot-delegations',
    labelKey: 'rightSidebar.tabs.kinds.botDelegations',
    icon: Share2,
    order: 17,
    enabled: true,
    singleton: true,
    hiddenFromMenu: true,
  },
  TabPillTitle: TabTitle,
  TabPillIcon: TabIcon,
  TabBody: BotDelegationsBody,
  defaultState: () => ({ selectedDelegationId: null }),
  serializeState: (state) => ({
    selectedDelegationId:
      typeof state.selectedDelegationId === 'string' && state.selectedDelegationId
        ? state.selectedDelegationId
        : null,
  }),
  hydrateState: (raw) => {
    const selectedDelegationId = raw && typeof raw === 'object'
      ? (raw as Record<string, unknown>).selectedDelegationId
      : null;
    return {
      selectedDelegationId:
        typeof selectedDelegationId === 'string' && selectedDelegationId
          ? selectedDelegationId
          : null,
    };
  },
};

registerTabKind(plugin as unknown as TabKindPlugin, import.meta.hot);
