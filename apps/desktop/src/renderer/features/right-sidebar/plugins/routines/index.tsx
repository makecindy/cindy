import { Clock3 } from 'lucide-react';
import { registerTabKind } from '../../registry';
import type { TabKindPlugin, TabKindBodyProps } from '../../types';
import { BotRoutines } from '@/features/bots/BotRoutines';

/** Per-teammate routine editor, carried by the normal sidebar and detached-window host. */
const plugin: TabKindPlugin<{ botId: string }> = {
  kind: 'routines',
  menu: {
    kind: 'routines',
    labelKey: 'routines.title',
    icon: Clock3,
    order: 16,
    enabled: true,
    singleton: true,
    hiddenFromMenu: true,
  },
  TabPillTitle: ({ t }) => <>{t('routines.title')}</>,
  TabPillIcon: () => <Clock3 size={13} />,
  TabBody: ({ state, ctx }: TabKindBodyProps<{ botId: string }>) =>
    state.botId && ctx.deviceLinkDeviceId === null ? (
      <BotRoutines key={state.botId} botId={state.botId} />
    ) : null,
  defaultState: () => ({ botId: '' }),
  hydrateState: (raw) => ({
    botId:
      raw && typeof raw === 'object' && typeof (raw as { botId?: unknown }).botId === 'string'
        ? (raw as { botId: string }).botId
        : '',
  }),
};
registerTabKind(plugin as unknown as TabKindPlugin, import.meta.hot);
