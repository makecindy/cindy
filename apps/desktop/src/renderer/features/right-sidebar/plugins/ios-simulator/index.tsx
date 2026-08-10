/**
 * iOS Simulator plugin — session-scoped view over the main-owned instance actor.
 * Apple tooling remains in main; this renderer plugin only consumes typed IPC.
 */

import { Smartphone } from 'lucide-react';
import type { TFunction } from 'i18next';

import { registerTabKind } from '../../registry';
import type { TabKindPlugin } from '../../types';
import { IOSSimulatorTabBody } from './IOSSimulatorTabBody';

export interface IOSSimulatorTabState {
  instanceId: string | null;
}

function IOSSimulatorTabPillTitle({ t }: { t: TFunction }) {
  return <>{t('rightSidebar.tabs.kinds.iosSimulator')}</>;
}

function IOSSimulatorTabPillIcon() {
  return <Smartphone size={13} />;
}

const plugin: TabKindPlugin<IOSSimulatorTabState> = {
  kind: 'ios-simulator',
  menu: {
    kind: 'ios-simulator',
    labelKey: 'rightSidebar.tabs.kinds.iosSimulator',
    icon: Smartphone,
    order: 25,
    enabled: true,
  },
  TabPillTitle: IOSSimulatorTabPillTitle,
  TabPillIcon: IOSSimulatorTabPillIcon,
  TabBody: IOSSimulatorTabBody,
  defaultState: () => ({ instanceId: null }),
  hydrateState: (raw) => ({
    instanceId:
      raw &&
      typeof raw === 'object' &&
      typeof (raw as { instanceId?: unknown }).instanceId === 'string'
        ? (raw as { instanceId: string }).instanceId
        : null,
  }),
};

registerTabKind(plugin as unknown as TabKindPlugin, import.meta.hot);
