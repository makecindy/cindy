/** Cindy-owned durable Subagent workspace tab. */

import { Bot } from 'lucide-react';
import type { TFunction } from 'i18next';
import type { SubagentProvider } from '@cindy/maker-shared/subagent-workspace';

import { registerTabKind } from '../../registry';
import type { TabKindPlugin } from '../../types';
import { SubagentsBody } from './SubagentsBody';

export interface SubagentsState {
  selectedRunId?: string | null;
  selectedProvider?: SubagentProvider | null;
}

const SUBAGENT_PROVIDERS = new Set<SubagentProvider>(['claude-code', 'codex', 'pi']);

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
  defaultState: () => ({ selectedRunId: null, selectedProvider: null }),
  serializeState: (state) => ({
    selectedRunId:
      typeof state.selectedRunId === 'string' && state.selectedRunId
        ? state.selectedRunId
        : null,
    selectedProvider:
      state.selectedProvider && SUBAGENT_PROVIDERS.has(state.selectedProvider)
        ? state.selectedProvider
        : null,
  }),
  hydrateState: (raw): SubagentsState => {
    if (!raw || typeof raw !== 'object') {
      return { selectedRunId: null, selectedProvider: null };
    }
    const selectedRunId = (raw as Record<string, unknown>).selectedRunId;
    const selectedProvider = (raw as Record<string, unknown>).selectedProvider;
    return {
      selectedRunId: typeof selectedRunId === 'string' && selectedRunId ? selectedRunId : null,
      selectedProvider:
        typeof selectedProvider === 'string'
        && SUBAGENT_PROVIDERS.has(selectedProvider as SubagentProvider)
          ? selectedProvider as SubagentProvider
          : null,
    };
  },
};

registerTabKind(plugin as unknown as TabKindPlugin, import.meta.hot);
