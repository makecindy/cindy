import { LayoutGrid } from 'lucide-react';
import { registerTabKind } from '../../registry';
import type { TabKindPlugin, TabKindBodyProps } from '../../types';
import { BotWorkbench } from '@/features/bots/BotWorkbench';

interface BotWorkbenchTabState {
  botId: string;
}

/**
 * 伙伴工作台:只由伙伴主任务页自动创建(不进「+」菜单),每个任务至多一个。
 * 只在已确认是本机的任务里渲染;device-link 远程或归属未解析时不显示内容。
 */
const plugin: TabKindPlugin<BotWorkbenchTabState> = {
  kind: 'bot-workbench',
  menu: {
    kind: 'bot-workbench',
    labelKey: 'bots.workbench.title',
    icon: LayoutGrid,
    order: 0,
    enabled: true,
    singleton: true,
    hiddenFromMenu: true,
  },
  TabPillTitle: ({ t }) => <>{t('bots.workbench.title')}</>,
  TabPillIcon: () => <LayoutGrid size={13} />,
  TabBody: ({ state, ctx }: TabKindBodyProps<BotWorkbenchTabState>) =>
    state.botId && ctx.deviceLinkDeviceId === null && !ctx.remoteHostId ? (
      <BotWorkbench key={state.botId} botId={state.botId} sessionId={ctx.sessionId} />
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
