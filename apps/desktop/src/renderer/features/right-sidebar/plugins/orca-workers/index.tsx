/**
 * orca-workers plugin —— 右侧栏「协同」tab。
 *
 * 协同 tab 不出现在 AddTabDropdown;只由 reveal / ensure 入口自动创建。
 * 关闭 tab 等价于结束协同,由 TabBody 注册 close interceptor 弹确认并执行
 * disableOrca；body 未挂载时 onBeforeClose fail-closed,拒绝误关协同。
 */

import { lazy, Suspense } from 'react';
import { UsersRound } from 'lucide-react';
import type { TFunction } from 'i18next';

import { isOrcaLeadSession } from '@/lib/orcaSessionIdentity';
import * as sessionService from '@/lib/sessionService';
import { registerTabKind } from '../../registry';
import { hasTabCloseInterceptor } from '../../store';
import type { TabKindPlugin } from '../../types';
import {
  hydrateOrcaWorkersState,
  type OrcaWorkersState,
} from './actions';

const OrcaWorkersTabBody = lazy(() =>
  import('./OrcaWorkersTabBody').then((module) => ({ default: module.OrcaWorkersTabBody })),
);
const OrcaWorkersAttentionIcon = lazy(() =>
  import('./OrcaWorkersAttentionIcon').then((module) => ({
    default: module.OrcaWorkersAttentionIcon,
  })),
);

function OrcaWorkersTabPillTitle({ t }: { state: OrcaWorkersState; t: TFunction }) {
  return <>{t('rightSidebar.tabs.kinds.collaboration')}</>;
}

function OrcaWorkersTabPillIcon({
  sessionId,
  active,
}: {
  state: OrcaWorkersState;
  sessionId: string | null;
  active: boolean;
}) {
  return (
    <Suspense fallback={<UsersRound size={13} />}>
      <OrcaWorkersAttentionIcon sessionId={sessionId} active={active} />
    </Suspense>
  );
}

const plugin: TabKindPlugin<OrcaWorkersState> = {
  kind: 'orca-workers',
  menu: {
    kind: 'orca-workers',
    labelKey: 'rightSidebar.tabs.kinds.collaboration',
    icon: UsersRound,
    order: 18,
    enabled: true,
    hiddenFromMenu: true,
    singleton: true,
  },
  TabPillTitle: OrcaWorkersTabPillTitle,
  TabPillIcon: OrcaWorkersTabPillIcon,
  TabBody: OrcaWorkersTabBody,
  defaultState: () => ({}),
  hydrateState: hydrateOrcaWorkersState,
  onBeforeClose: async (_state, ctx) => {
    if (hasTabCloseInterceptor(ctx.tabId)) return true;
    const leadSession = await sessionService.get(ctx.sessionId).catch(() => null);
    if (leadSession && !isOrcaLeadSession(leadSession)) return true;
    return false;
  },
};

registerTabKind(plugin as unknown as TabKindPlugin, import.meta.hot);
