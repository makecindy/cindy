import { lazy } from 'react';
import { Package } from 'lucide-react';
import type { TFunction } from 'i18next';

import { registerTabKind } from '../../registry';
import type { TabKindPlugin } from '../../types';

const BotArtifactsBody = lazy(() =>
  import('./BotArtifactsBody').then((module) => ({ default: module.BotArtifactsBody })),
);

export interface BotArtifactsState {
  /** 当前过滤 chip;'all' 或某一型。 */
  filter?: string | null;
  /** 从对话里「在仓库中查看」跳过来时要高亮的那件(BotArtifactItem.id)。 */
  focusArtifactId?: string | null;
}

function TabTitle({ t }: { state: BotArtifactsState; t: TFunction }) {
  return <>{t('rightSidebar.tabs.kinds.botArtifacts')}</>;
}

function TabIcon() {
  return <Package size={13} />;
}

function readOptionalString(raw: unknown, key: string): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = (raw as Record<string, unknown>)[key];
  return typeof value === 'string' && value ? value : null;
}

const plugin: TabKindPlugin<BotArtifactsState> = {
  kind: 'bot-artifacts',
  menu: {
    kind: 'bot-artifacts',
    labelKey: 'rightSidebar.tabs.kinds.botArtifacts',
    icon: Package,
    order: 16,
    enabled: true,
    singleton: true,
    // 只由伙伴会话自动创建 —— 普通任务没有「伙伴的交付物」这个概念。
    hiddenFromMenu: true,
  },
  TabPillTitle: TabTitle,
  TabPillIcon: TabIcon,
  TabBody: BotArtifactsBody,
  defaultState: () => ({ filter: 'all', focusArtifactId: null }),
  serializeState: (state) => ({
    filter: typeof state.filter === 'string' && state.filter ? state.filter : 'all',
    // 高亮是一次性导航意图,不跨重启保留。
    focusArtifactId: null,
  }),
  hydrateState: (raw) => ({
    filter: readOptionalString(raw, 'filter') ?? 'all',
    focusArtifactId: null,
  }),
};

registerTabKind(plugin as unknown as TabKindPlugin, import.meta.hot);
