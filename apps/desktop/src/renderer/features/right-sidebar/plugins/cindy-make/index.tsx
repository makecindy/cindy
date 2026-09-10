/**
 * Cindy Make sidebar plugin.
 *
 * The first iteration deliberately owns one task: the tab is a stable entry
 * point and its body is backed by the current task's normal message store.
 * Multi-task management can be added later without changing the tab contract.
 */

import { Wrench } from 'lucide-react';
import type { TFunction } from 'i18next';

import { registerTabKind } from '../../registry';
import type { TabKindPlugin } from '../../types';
import { CindyMakeTabBody } from './CindyMakeTabBody';

export interface CindyMakeState {
  /** Reserved for the first persisted task binding. */
  taskSessionId: string | null;
}

const DEFAULT_STATE: CindyMakeState = { taskSessionId: null };

function CindyMakeTabPillTitle({ t }: { state: CindyMakeState; t: TFunction }) {
  return <>{t('settings.cindyMake.title')}</>;
}

function CindyMakeTabPillIcon() {
  return <Wrench size={13} />;
}

const plugin: TabKindPlugin<CindyMakeState> = {
  kind: 'cindy-make',
  menu: {
    kind: 'cindy-make',
    labelKey: 'settings.cindyMake.title',
    icon: Wrench,
    order: 12,
    enabled: true,
    singleton: true,
  },
  TabPillTitle: CindyMakeTabPillTitle,
  TabPillIcon: CindyMakeTabPillIcon,
  TabBody: CindyMakeTabBody,
  defaultState: () => ({ ...DEFAULT_STATE }),
  hydrateState: (raw): CindyMakeState => {
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_STATE };
    const taskSessionId = (raw as Record<string, unknown>).taskSessionId;
    return { taskSessionId: typeof taskSessionId === 'string' ? taskSessionId : null };
  },
};

registerTabKind(plugin as unknown as TabKindPlugin, import.meta.hot);
