/** Cindy-owned durable Subagent workspace tab. */

import { Bot } from 'lucide-react';
import type { TFunction } from 'i18next';

import { registerTabKind } from '../../registry';
import type { TabKindPlugin } from '../../types';
import { SubagentsBody } from './SubagentsBody';

export interface SubagentsState {
  selectedRunId?: string | null;
}

function SubagentsTabPillTitle({ t }: { state: SubagentsState; t: TFunction }) {
  return <>{t('rightSidebar.tabs.kinds.subagents')}</>;
}

function SubagentsTabPillIcon() {
  return <Bot size={13} />;
}

const plugin: TabKindPlugin<SubagentsState> = {
  kind: 'subagents',
  menu: {
    kind: 'subagents',
    labelKey: 'rightSidebar.tabs.kinds.subagents',
    icon: Bot,
    order: 16,
    enabled: true,
    singleton: true,
  },
  TabPillTitle: SubagentsTabPillTitle,
  TabPillIcon: SubagentsTabPillIcon,
  TabBody: SubagentsBody,
  defaultState: () => ({ selectedRunId: null }),
  serializeState: (state) => ({
    selectedRunId:
      typeof state.selectedRunId === 'string' && state.selectedRunId
        ? state.selectedRunId
        : null,
  }),
  hydrateState: (raw): SubagentsState => {
    if (!raw || typeof raw !== 'object') return { selectedRunId: null };
    const selectedRunId = (raw as Record<string, unknown>).selectedRunId;
    return {
      selectedRunId: typeof selectedRunId === 'string' && selectedRunId ? selectedRunId : null,
    };
  },
};

registerTabKind(plugin as unknown as TabKindPlugin, import.meta.hot);
