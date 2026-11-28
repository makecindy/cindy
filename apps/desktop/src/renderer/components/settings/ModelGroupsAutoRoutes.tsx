/**
 * 设置 → 智能路由里「整个供应商」这一类来源的界面部件。路由只有一种(一个名字、几个来源、一种选法)：
 * 来源可以是某个供应商的某个模型，也可以是一整个供应商——后者在选模型时像一个合并后的供应商，照常选模型，
 * 由路由决定这次用哪个成员(shared/modelGroups.ts 的 ModelGroupSourceRoute)。同一家的会自动合好。
 *
 * 一个供应商里的几个账号、几台电脑上同一个供应商合成的组，也是同一套选法、同一个选择函数，选法在这里改。
 * 成员可以是本机的供应商，也可以是其他电脑上的或别人分享来的。
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Sparkles, X } from 'lucide-react';
import { useInRouterContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { PluginEngineIcon } from '@/components/icons/PluginEngineIcon';
import { ProviderMark } from '@/components/new-chat/ModelSelector';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  SettingsBlock,
  SettingsCard,
  SettingsPageHeader,
  SettingsPageScope,
  SettingsRow,
  SettingsRowIcon,
  SettingsSection,
} from '@/components/ui/settings-rows';
import { useLocalProviderGroups } from '@/features/provider-group/useLocalProviderGroups';
import { useProviderGroup } from '@/features/provider-group/useProviderGroup';
import { useProviderShareAgentDevices } from '@/features/provider-share/useProviderShareAgentDevices';
import { useSelectableDevices } from '@/hooks/useControllableDevices';
import { useDevicesPluginEngines, usePluginEngines } from '@/hooks/usePluginEngines';
import { useDevicesProviders } from '@/hooks/useDevicesProviders';
import { useModelRouteDevices } from '@/hooks/useModelRouteDevices';
import { useProviders } from '@/hooks/useProviders';
import { isPluginEngineSelectable } from '@/lib/pluginEngineSelection';
import { isSharedTaskPeer } from '@cindy/device-link';
import {
  isPluginEngineOfferedRemotely,
  pluginEngineKeyFromProviderId,
  type PluginEngineView,
} from '../../../shared/pluginEngines';
import { isProviderShareAgentDeviceId } from '../../../shared/providerShare';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

import {
  MODEL_GROUP_LIMITS,
  MODEL_GROUP_STRATEGIES,
  modelGroupAutoSwitchOn,
  modelGroupSourceKey,
  modelGroupWeight,
  type ModelGroupException,
  type ModelGroupsConfig,
  type ModelGroupSource,
  type ModelGroupSourceRoute,
} from '../../../shared/modelGroups';
import { ModelGroupRouteExceptions } from './ModelGroupRouteExceptions';
import { ModelGroupRoutePreview } from './ModelGroupRoutePreview';
import {
  providerGroupDeviceCount,
  withLocalProviderGroupAccounts,
  type ProviderGroupAccountAllocation,
  type ProviderGroupConfig,
} from '../../../shared/providerGroup';
import { SAME_SOURCE_ROUTE_STRATEGIES, type RouteStrategy } from '../../../shared/routeStrategy';
import { routeStrategySelectGroups } from '@/features/model-groups/routeStrategyOptions';
import type { SubscriptionPoolView } from '../../../shared/subscriptionAccounts';
import { RouteNameRow, RouteTypeSection, RowIconButton, WeightInput } from './ModelGroupRowControls';

type Provider = ReturnType<typeof useProviders>['providers'][number];

// Subagent 模型与辅助模型两块设置：路由页画出来以后再取，不拖慢它的第一屏。
const OtherModelSettings = lazy(() => import('./OtherModelSettings').then(module => ({ default: module.OtherModelSettings })));

function StrategySelect({ label, value, disabled, onChange, strategies = SAME_SOURCE_ROUTE_STRATEGIES }: {
  label: string; value: RouteStrategy; disabled?: boolean; onChange(next: RouteStrategy): void;
  /** 默认是同一个供应商的账号／电脑之间能选的那几种；几个供应商之间价格可能不同，再加上「最省钱」。 */
  strategies?: readonly RouteStrategy[];
}) {
  const { t } = useTranslation();
  const groups = useMemo(() => routeStrategySelectGroups(strategies, t), [t, strategies]);
  return (
    <Select data-settings-search-action="Sets how a route, an account pool or a computer group picks its next member" label={label} value={value} groups={groups} width="sm" disabled={disabled}
      onValueChange={(next) => { if (next !== value) onChange(next as RouteStrategy); }} />
  );
}

/** 账号权重能选的值：与供应商页账号行里的同一组。 */
const ACCOUNT_WEIGHTS = [1, 2, 3, 5, 10, 20, 50, 100];

function ProviderLead({ provider, pluginEngine }: { provider?: Provider; pluginEngine?: PluginEngineView }) {
  if (pluginEngine) {
    return (
      <SettingsRowIcon>
        <PluginEngineIcon size={16} iconDataUrl={pluginEngine.iconDataUrl} />
      </SettingsRowIcon>
    );
  }
  if (!provider) return <SettingsRowIcon><Sparkles size={16} aria-hidden /></SettingsRowIcon>;
  return (
    <SettingsRowIcon>
      <ProviderMark providerId={provider.id} name={provider.name} routing={provider.routing} logoKind={provider.logoKind}
        customIcon={provider.customIcon} colorClass="text-[var(--text-primary)]" withMargin={false} />
    </SettingsRowIcon>
  );
}

/**
 * 一个供应商里的几个账号。只在确实有两个以上账号时出现；`plain` 是它作为某条供应商路由的成员时，
 * 账号不足两个或还没读到时显示的那一行(成员本身始终要列出来)。
 */
function AccountsRouteRow({ provider }: { provider: Provider }) {
  const { t } = useTranslation();
  const [view, setView] = useState<SubscriptionPoolView | null>(null);
  const [saving, setSaving] = useState(false);
  // 正在读时再来的变化合成读完后补读一次：账号池连发变化(额度刷新、几个账号依次更新)时不堆起并发读取。
  const reading = useRef<{ providerId: string; again: boolean } | null>(null);
  const read = useCallback(async () => {
    const providerId = provider.id;
    if (reading.current?.providerId === providerId) {
      reading.current.again = true;
      return;
    }
    reading.current = { providerId, again: false };
    try {
      do {
        reading.current.again = false;
        let next: SubscriptionPoolView | null;
        try {
          next = await window.electronAPI.subscriptionAccounts.command({ action: 'read', providerId });
        } catch {
          // 读不到就不列这一行；供应商页里仍能看到账号和原因。
          next = null;
        }
        if (reading.current?.providerId !== providerId) return;
        setView(next);
      } while (reading.current.again);
    } finally {
      if (reading.current?.providerId === providerId) reading.current = null;
    }
  }, [provider.id]);
  useEffect(() => {
    void read();
    // 只响应这个供应商的账号变化：页上每个供应商各有一行，别的连接变了不重读。
    const off = window.electronAPI.subscriptionAccounts.onChanged((event) => { if (event.providerId === provider.id) void read(); });
    return () => {
      off();
      reading.current = null;
    };
  }, [provider.id, read]);
  if (!view || view.accounts.length < 2) return null;
  const change = async (strategy: RouteStrategy) => {
    setSaving(true);
    try {
      await window.electronAPI.subscriptionAccounts.command({ action: 'configure', providerId: provider.id, strategy });
      await read();
    } catch {
      toast.error(t('modelGroups.settings.saveFailed'));
    } finally {
      setSaving(false);
    }
  };
  const setWeight = async (accountId: string, weight: number) => {
    setSaving(true);
    try {
      await window.electronAPI.subscriptionAccounts.command({ action: 'configure', providerId: provider.id, accountId, weight });
      await read();
    } catch {
      toast.error(t('modelGroups.settings.saveFailed'));
    } finally {
      setSaving(false);
    }
  };
  // 账号的先后：整份顺序交给账号池，它只在这个供应商的账号之间重排(2026-11-26 补上)。
  const move = async (index: number, delta: -1 | 1) => {
    const order = view.accounts.map((account) => account.id);
    const [item] = order.splice(index, 1);
    order.splice(index + delta, 0, item!);
    setSaving(true);
    try {
      await window.electronAPI.subscriptionAccounts.command({ action: 'reorder', providerId: provider.id, accountIds: order });
      await read();
    } catch {
      toast.error(t('modelGroups.settings.saveFailed'));
    } finally {
      setSaving(false);
    }
  };
  // 「按顺序」「按权重」要看得见每个账号排第几、权重多少：选了这两种就把账号列出来，先后与权重都在这里改
  // (与供应商页账号行里是同一个设置)。
  const listed = view.strategy === 'weighted' || view.strategy === 'order';
  return (
    <>
      <SettingsRow
        media
        wrap
        data-auto-route={`accounts:${provider.id}`}
        lead={<ProviderLead provider={provider} />}
        title={provider.name}
        hint={`${t('modelGroups.auto.accounts', { count: view.accounts.length })} · ${t(`modelGroups.strategy.${view.strategy}.hint`)}`}
        trailing={<StrategySelect label={t('modelGroups.auto.pickFor', { name: provider.name })} value={view.strategy} disabled={saving} onChange={(next) => void change(next)} />}
      />
      {listed && view.accounts.map((account, index) => {
        const name = account.identity || t('providerGroup.member.accountFallback', { index: index + 1 });
        return (
          <SettingsRow
            key={account.id}
            media
            data-auto-route-account={account.id}
            lead={<span className="flex w-8 justify-center text-12 tabular-nums leading-[1.33] text-[var(--text-tertiary)]">{index + 1}</span>}
            title={name}
            className={cn(account.paused && '[&>span:nth-child(-n+2)]:opacity-60')}
            trailing={
              <span className="flex shrink-0 items-center gap-1">
                {view.strategy === 'weighted' && (
                  <span className="mr-2 flex items-center">
                    <Select
                      data-settings-search-action="Sets how many new tasks one account gets when the pool picks by weight"
                      label={t('providerGroup.member.weightAria', { name })}
                      value={String(account.weight)}
                      disabled={saving}
                      width="xs"
                      // 存着的权重不在那组里时照实列出，不悄悄显示成别的值。
                      options={[...new Set([...ACCOUNT_WEIGHTS, account.weight])].sort((a, b) => a - b)
                        .map((weight) => ({ value: String(weight), label: t('providerGroup.member.weightOption', { weight }) }))}
                      onValueChange={(value) => { if (Number(value) !== account.weight) void setWeight(account.id, Number(value)); }}
                    />
                  </span>
                )}
                <RowIconButton label={t('modelGroups.settings.moveUp')} busy={saving} disabled={index === 0} onClick={() => move(index, -1)}
                  move={{ row: `account:${account.id}`, direction: 'up' }}><ArrowUp size={15} /></RowIconButton>
                <RowIconButton label={t('modelGroups.settings.moveDown')} busy={saving} disabled={index === view.accounts.length - 1} onClick={() => move(index, 1)}
                  move={{ row: `account:${account.id}`, direction: 'down' }}><ArrowDown size={15} /></RowIconButton>
              </span>
            }
          />
        );
      })}
    </>
  );
}

/**
 * 把几台电脑上的同一个供应商合成的一组；也可以是同一个 OpenAI 供应商下本机的几个账号(订阅与 API key 混合，
 * main 2026-11-25 加入)，或两者都有。账号与电脑在同一份组配置里排先后、按同一个选法分配。
 */
function ComputersRouteRow({ provider, initial }: { provider: Provider; initial: ProviderGroupConfig }) {
  const { t } = useTranslation();
  const { providers } = useProviders();
  const group = useProviderGroup(provider.id, { initialConfig: initial });
  const [saving, setSaving] = useState(false);
  const config = group.view?.config ?? initial;
  // 本机的几个账号存在 localAccountIds / localAccountSettings 里，要展开才看得到它们各自的先后与权重。
  const mixed = (config.localAccountIds?.length ?? 0) > 0;
  const members = mixed ? withLocalProviderGroupAccounts(config, provider.id).members : config.members;
  const localCount = members.filter((member) => member.kind === 'local').length;
  const remoteCount = providerGroupDeviceCount(config.members.filter((member) => member.kind !== 'local'));
  const run = async (save: () => Promise<unknown>) => {
    setSaving(true);
    try {
      await save();
    } catch {
      toast.error(t('modelGroups.settings.saveFailed'));
    } finally {
      setSaving(false);
    }
  };
  // 本机账号的设置只能经账号分配命令改(带着读到的那份配置，别处改过就拒绝)，与供应商页同一条路。
  const allocate = (edit: ProviderGroupAccountAllocation) => run(() => window.electronAPI.providerGroup.command({
    action: 'account-allocation', providerId: provider.id, expectedConfig: config, edit,
  }));
  const change = (strategy: RouteStrategy) => (mixed ? allocate({ strategy }) : run(() => group.save({ ...config, strategy })));
  // 组里各台电脑的先后与权重(2026-11-26 补上，原来只能在供应商页改权重、先后不能调)：与供应商页是同一份组配置。
  const saveMembers = (next: ProviderGroupConfig['members']) => run(() => group.save({ ...config, members: next }));
  const setWeight = (member: ProviderGroupConfig['members'][number], weight: number) => (member.kind === 'local' && mixed
    ? allocate({ accountId: member.providerId, weight })
    : saveMembers(config.members.map((item) => (item.key === member.key ? { ...item, weight } : item))));
  // 账号只在账号之间调先后，电脑只在电脑之间调(两种各占各的位置，与供应商页一致)。
  const neighbour = (index: number, delta: -1 | 1) => {
    const member = members[index];
    const other = members[index + delta];
    return member && other && (member.kind === 'local') === (other.kind === 'local') ? other : undefined;
  };
  const move = (index: number, delta: -1 | 1) => {
    const member = members[index]!;
    const other = neighbour(index, delta)!;
    if (member.kind === 'local' && mixed) {
      const order = members.filter((item) => item.kind === 'local').map((item) => item.providerId);
      const from = order.indexOf(member.providerId);
      const to = order.indexOf(other.providerId);
      [order[from], order[to]] = [order[to]!, order[from]!];
      return allocate({ order });
    }
    return saveMembers(swap(config.members, config.members.findIndex((item) => item.key === member.key),
      config.members.findIndex((item) => item.key === other.key)));
  };
  const nameOf = (member: ProviderGroupConfig['members'][number]) => {
    if (member.kind === 'local') {
      return mixed ? providers.find((item) => item.id === member.providerId)?.name ?? member.providerId : t('providerGroup.member.local');
    }
    return member.label || member.providerName || member.providerId;
  };
  const listed = config.strategy === 'weighted' || config.strategy === 'order';
  const size = mixed
    ? [t('modelGroups.auto.accounts', { count: localCount }), ...(remoteCount ? [t('modelGroups.auto.computers', { count: remoteCount + 1 })] : [])].join(' · ')
    : t('modelGroups.auto.computers', { count: providerGroupDeviceCount(config.members) });
  return (
    <>
      <SettingsRow
        media
        wrap
        data-auto-route={`computers:${provider.id}`}
        lead={<ProviderLead provider={provider} />}
        title={provider.name}
        hint={`${size} · ${t(`modelGroups.strategy.${config.strategy}.hint`)}`}
        trailing={<StrategySelect label={t('modelGroups.auto.pickFor', { name: provider.name })} value={config.strategy} disabled={saving} onChange={(next) => void change(next)} />}
      />
      {listed && members.map((member, index) => {
        const name = nameOf(member);
        return (
          <SettingsRow
            key={member.key}
            media
            data-auto-route-member={member.key}
            lead={<span className="flex w-8 justify-center text-12 tabular-nums leading-[1.33] text-[var(--text-tertiary)]">{index + 1}</span>}
            title={name}
            className={cn(member.paused && '[&>span:nth-child(-n+2)]:opacity-60')}
            trailing={
              <span className="flex shrink-0 items-center gap-1">
                {config.strategy === 'weighted' && (
                  <span className="mr-2 flex items-center">
                    <Select
                      data-settings-search-action="Sets how many new tasks one computer or account gets when the group picks by weight"
                      label={t('providerGroup.member.weightAria', { name })}
                      value={String(member.weight)}
                      disabled={saving}
                      width="xs"
                      options={[...new Set([...ACCOUNT_WEIGHTS, member.weight])].sort((a, b) => a - b)
                        .map((weight) => ({ value: String(weight), label: t('providerGroup.member.weightOption', { weight }) }))}
                      onValueChange={(value) => { if (Number(value) !== member.weight) void setWeight(member, Number(value)); }}
                    />
                  </span>
                )}
                <RowIconButton label={t('modelGroups.settings.moveUp')} busy={saving} disabled={!neighbour(index, -1)}
                  move={{ row: `computer:${member.key}`, direction: 'up' }}
                  onClick={() => move(index, -1)}><ArrowUp size={15} /></RowIconButton>
                <RowIconButton label={t('modelGroups.settings.moveDown')} busy={saving} disabled={!neighbour(index, 1)}
                  move={{ row: `computer:${member.key}`, direction: 'down' }}
                  onClick={() => move(index, 1)}><ArrowDown size={15} /></RowIconButton>
              </span>
            }
          />
        );
      })}
    </>
  );
}

function swap<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return next;
}

/** 可以加进供应商路由的独立来源：本机单账号供应商、本机多账号池拆平后的各个账号、插件执行引擎，以及其他电脑与分享来的来源。 */
export interface SourceOption {
  key: string;
  providerId: string;
  agentDeviceId?: string;
  accountId?: string;
  label: string;
  provider?: Provider;
  pluginEngine?: PluginEngineView;
  /** 现在能用(已连接、没暂停)。不能用的也列着，只为成员行照样显示名字、标出「未连接」，不能新加。 */
  usable: boolean;
  /** 本机多账号供应商已拆平为多个单账号项时，原整供应商项仅作历史回退显示，不再放进「添加来源」下拉（避免嵌套两层自动）。 */
  fallbackOnly?: boolean;
}

const optionKey = (source: Pick<ModelGroupSource, 'providerId' | 'agentDeviceId' | 'accountId'>) => modelGroupSourceKey(source);
const usableProvider = (provider: Provider) => provider.connected && !provider.suspended && !provider.removed && !provider.subscriptionPoolAlias;
const usableLocalPluginEngine = (engine: PluginEngineView) =>
  !engine.suspended && isPluginEngineSelectable(engine) && (engine.models.length > 0 || engine.defaultModelAllowed !== false);
const usableRemotePluginEngine = (engine: PluginEngineView) =>
  isPluginEngineOfferedRemotely(engine) && (engine.models.length > 0 || engine.defaultModelAllowed !== false);

export function useSourceOptions(): SourceOption[] {
  const { t } = useTranslation();
  const { providers } = useProviders();
  const { devices } = useModelRouteDevices({ controlledDeviceId: null, leadAgentDeviceId: null });
  const deviceIds = useMemo(() => (devices ?? []).map((device) => device.deviceId), [devices]);
  const catalogs = useDevicesProviders(deviceIds, { retainDisplaySnapshot: true });
  const localPluginEngines = usePluginEngines(true);
  const { devices: selectableDevices } = useSelectableDevices();
  const { pluginEngineDevices: sharedPluginEngineDevices = [] } = useProviderShareAgentDevices();
  const pluginDeviceList = useMemo(() => [
    ...selectableDevices
      .filter((device) => device.online && !isProviderShareAgentDeviceId(device.deviceId) && !isSharedTaskPeer(device.deviceId))
      .map((device) => ({ deviceId: device.deviceId, name: device.name || device.deviceId })),
    ...sharedPluginEngineDevices,
  ], [selectableDevices, sharedPluginEngineDevices]);
  const pluginDeviceIds = useMemo(() => pluginDeviceList.map((device) => device.deviceId), [pluginDeviceList]);
  const { catalogues: remotePluginCatalogues, read: readRemotePluginCatalogues } = useDevicesPluginEngines(pluginDeviceIds, true);
  useEffect(() => {
    if (pluginDeviceIds.length > 0) readRemotePluginCatalogues();
  }, [pluginDeviceIds, readRemotePluginCatalogues]);

  // 读取本机多账号订阅池的账号列表，把每个账号平铺成独立来源选项，彻底消除两层自动。
  const poolProviderKey = useMemo(() => providers
    .filter((provider) => !provider.removed && !provider.subscriptionPoolAlias && ((provider.subscriptionAccountKeys?.length ?? 0) >= 2 || Boolean(provider.subscriptionPool) || Boolean(provider.subscriptionAccountPool)))
    .map((provider) => provider.id)
    .sort()
    .join('\n'), [providers]);
  const [poolViews, setPoolViews] = useState<Record<string, SubscriptionPoolView>>({});
  useEffect(() => {
    const api = window.electronAPI?.subscriptionAccounts;
    const ids = poolProviderKey ? poolProviderKey.split('\n') : [];
    if (!api || ids.length === 0) {
      setPoolViews({});
      return;
    }
    let cancelled = false;
    const readOne = async (providerId: string) => {
      try {
        const view = await api.command({ action: 'read', providerId });
        if (!cancelled && view) {
          setPoolViews((previous) => ({ ...previous, [providerId]: view }));
        }
      } catch {
        // 读不到时保持原供应商显示，不阻断页面。
      }
    };
    for (const id of ids) void readOne(id);
    const off = api.onChanged?.((event) => {
      if (ids.includes(event.providerId)) void readOne(event.providerId);
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [poolProviderKey]);

  return useMemo(() => [
    ...providers.filter((provider) => !provider.removed).flatMap((provider): SourceOption[] => {
      // A detached Key may still have a cached pool view, but no longer owns it.
      const pool = !provider.subscriptionPoolAlias && (provider.subscriptionPool || provider.subscriptionAccountPool || (provider.subscriptionAccountKeys?.length ?? 0) >= 2)
        ? poolViews[provider.id] : undefined;
      // 与主进程拆平口径一致：按账号数决定是否拆开，只列未暂停的账号。
      const activeAccounts = pool?.accounts.filter((account) => !account.paused) ?? [];
      if ((pool?.accounts.length ?? 0) >= 2 && activeAccounts.length > 0) {
        const accountOptions = activeAccounts.map((account, index): SourceOption => {
          const identity = account.identity?.trim() || t('providerGroup.member.accountFallback', { index: index + 1 });
          const label = identity === provider.name ? identity : `${provider.name} · ${identity}`;
          return {
            key: optionKey({ providerId: provider.id, accountId: account.id }),
            providerId: provider.id,
            accountId: account.id,
            label,
            provider,
            usable: usableProvider(provider) && account.status !== 'signed-out' && account.status !== 'unavailable',
          };
        });
        return [
          ...accountOptions,
          {
            key: optionKey({ providerId: provider.id }),
            providerId: provider.id,
            label: provider.name,
            provider,
            usable: usableProvider(provider),
            fallbackOnly: true,
          },
        ];
      }
      return [{
        key: optionKey({ providerId: provider.id }),
        providerId: provider.id,
        label: provider.name,
        provider,
        usable: usableProvider(provider),
      }];
    }),
    ...localPluginEngines.map((engine): SourceOption => ({
      key: optionKey({ providerId: engine.providerId }),
      providerId: engine.providerId,
      label: engine.name,
      pluginEngine: engine,
      usable: usableLocalPluginEngine(engine),
    })),
    ...(devices ?? []).flatMap((device) => (catalogs.get(device.deviceId)?.providers ?? [])
      .filter((provider) => !provider.removed && provider.remoteInvocationEnabled !== false)
      .map((provider): SourceOption => ({
        usable: usableProvider(provider),
        key: optionKey({ providerId: provider.id, agentDeviceId: device.deviceId }),
        providerId: provider.id, agentDeviceId: device.deviceId,
        // 分享的名字已经是「供应商 · 分享者」；其他电脑写「供应商 · 电脑名」。
        label: isProviderShareAgentDeviceId(device.deviceId) ? device.name : `${provider.name} · ${device.name}`,
        provider,
      }))),
    ...pluginDeviceList.flatMap((device) => (remotePluginCatalogues.get(device.deviceId) ?? [])
      .filter((engine) => !!pluginEngineKeyFromProviderId(engine.providerId))
      .map((engine): SourceOption => ({
        usable: usableRemotePluginEngine(engine),
        key: optionKey({ providerId: engine.providerId, agentDeviceId: device.deviceId }),
        providerId: engine.providerId,
        agentDeviceId: device.deviceId,
        label: device.name ? `${engine.name} · ${device.name}` : engine.name,
        pluginEngine: engine,
      }))),
  ], [providers, poolViews, localPluginEngines, devices, catalogs, pluginDeviceList, remotePluginCatalogues, t]);
}

/** 还没并进任何路由的供应商里，有几个账号或几台电脑的：它们之间怎么分在这一行改。 */
export function ProviderAllocationRows({ config }: { config: ModelGroupsConfig }) {
  const { providers } = useProviders();
  const groups = useLocalProviderGroups();
  // 已隐藏的供应商路由或被取消参与(source.off)的成员恢复独立显示，其账号/电脑分配行一并恢复。
  const members = new Set((config.sourceRoutes ?? [])
    .filter((route) => !route.hidden)
    .flatMap((route) => route.sources.filter((source) => !source.off && !source.agentDeviceId).map((source) => source.providerId)));
  return (
    <>
      {providers.filter(usableProvider).flatMap((provider) => {
        if (members.has(provider.id)) return [];
        const group = groups[provider.id];
        // 账号数以已核实的登录身份为准；只有一个账号的供应商没有可分配的，不列。几台电脑合成了组、又有几个账号时两行都列。
        return [
          ...(group ? [<ComputersRouteRow key={`computers:${provider.id}`} provider={provider} initial={group} />] : []),
          ...((provider.subscriptionAccountKeys?.length ?? 0) >= 2 ? [<AccountsRouteRow key={`accounts:${provider.id}`} provider={provider} />] : []),
        ];
      })}
    </>
  );
}

/** 路由列表里的一行：合并了整个供应商的路由。 */
export function SourceRouteRow({ route, config, options, onOpen }: {
  route: ModelGroupSourceRoute; config: ModelGroupsConfig; options: readonly SourceOption[]; onOpen(): void;
}) {
  const { t } = useTranslation();
  const activeSources = route.sources.filter((source) => !source.off);
  const first = (activeSources.length > 0 ? activeSources : route.sources)
    .map((source) => options.find((option) => option.key === optionKey(source)))
    .find(Boolean);
  const models = config.routes.filter((item) => item.parent?.id === route.id).length;
  return (
    <SettingsRow
      media
      data-source-route={route.id}
      lead={first ? <ProviderLead provider={first.provider} pluginEngine={first.pluginEngine} /> : <SettingsRowIcon><Sparkles size={16} aria-hidden /></SettingsRowIcon>}
      title={route.name}
      tag={route.hidden ? t('modelGroups.auto.hiddenTag') : route.auto ? t('modelGroups.sources.autoTag') : undefined}
      hint={[
        t('modelGroups.sources.providers', { count: activeSources.length }),
        t('modelGroups.sources.models', { count: models }),
        t(`modelGroups.strategy.${route.strategy}.title`),
      ].join(' · ')}
      className={route.hidden ? '[&>span:nth-child(-n+2)]:opacity-60' : undefined}
      chevron
      onClick={onOpen}
    />
  );
}

const ADD_NONE = '__none__';

/** 「添加供应商路由」：本机的、其他电脑上的、分享来的都在这一个下拉里。 */
export function WholeProviderAddRow({ options, taken, onAdd }: {
  options: readonly SourceOption[]; taken: readonly ModelGroupSource[]; onAdd(source: ModelGroupSource): void;
}) {
  const { t } = useTranslation();
  const addable = options.filter((option) => option.usable && !option.fallbackOnly && !taken.some((source) => optionKey(source) === option.key));
  if (addable.length === 0) return null;
  return (
    <SettingsRow
      title={t('modelGroups.sources.addWhole')}
      wrap
      trailing={
        <Select data-settings-search-action="Adds a whole provider as a source of this route" label={t('modelGroups.sources.addWhole')} value={ADD_NONE} width="sm"
          options={[{ value: ADD_NONE, label: t('modelGroups.sources.chooseProvider') }, ...addable.map((option) => ({ value: option.key, label: option.label }))]}
          onValueChange={(key) => {
            const option = addable.find((item) => item.key === key);
            if (option) {
              onAdd({
                providerId: option.providerId,
                ...(option.agentDeviceId ? { agentDeviceId: option.agentDeviceId } : {}),
                ...(option.accountId ? { accountId: option.accountId } : {}),
              });
            }
          }} />
      }
    />
  );
}

/** 一条合并了整个供应商的路由的编辑页。自动合成的成员不能改，其余与用户自己建的一样。 */
export function SourceRouteDetail({ route, config, options, save, onBack, onSwitchToModel, switchingKind = false, focusType = false }: {
  route: ModelGroupSourceRoute;
  config: ModelGroupsConfig;
  options: readonly SourceOption[];
  save(change: (latest: ModelGroupsConfig) => ModelGroupsConfig): Promise<boolean>;
  onBack(): void;
  onSwitchToModel?: (fromKeyboard: boolean) => void;
  switchingKind?: boolean;
  focusType?: boolean;
}) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const patchOwn = (patch: (current: ModelGroupSourceRoute) => ModelGroupSourceRoute) => save((latest) => ({
    ...latest, sourceRoutes: (latest.sourceRoutes ?? []).map((item) => (item.id === route.id ? patch(item) : item)),
  }));
  const setStrategy = (strategy: RouteStrategy) => (route.auto
    ? void save((latest) => ({ ...latest, autoStrategy: { ...(latest.autoStrategy ?? {}), [route.id]: strategy } }))
    : patchOwn((current) => ({ ...current, strategy })));
  const setAutoSwitch = (on: boolean) => (route.auto
    ? void save((latest) => {
      const rest = (latest.autoSwitchOff ?? []).filter((id) => id !== route.id);
      return { ...latest, autoSwitchOff: on ? rest : [...rest, route.id] };
    })
    : patchOwn((current) => {
      const { autoSwitch: _was, ...rest } = current;
      void _was;
      return on ? rest : { ...rest, autoSwitch: false as const };
    }));
  const setHidden = (hidden: boolean) => void save((latest) => {
    const rest = (latest.hiddenAuto ?? []).filter((id) => id !== route.id);
    return { ...latest, hiddenAuto: hidden ? [...rest, route.id] : rest };
  });
  const remove = async () => {
    if (!await confirm({
      title: t('modelGroups.settings.deleteRouteConfirmTitle', { name: route.name }),
      description: t('modelGroups.settings.deleteMergedRouteConfirmDescription'),
      confirmText: t('modelGroups.settings.delete'),
      cancelText: t('modelGroups.settings.cancel'),
      confirmVariant: 'destructive',
    })) return;
    if (await save((latest) => ({ ...latest, sourceRoutes: (latest.sourceRoutes ?? []).filter((item) => item.id !== route.id) }))) onBack();
  };
  const expanded = useMemo(() => config.routes.filter((item) => item.parent?.id === route.id), [config, route.id]);
  const expandedCandidates = useMemo(() => expanded.flatMap((item) => item.candidates), [expanded]);
  const models = expanded.length;
  const setExceptions = (next: ModelGroupException[]) => save((latest) => (route.auto
    ? { ...latest, autoExceptions: { ...(latest.autoExceptions ?? {}), [route.id]: next } }
    : { ...latest, sourceRoutes: (latest.sourceRoutes ?? []).map((item) => (item.id === route.id ? { ...item, exceptions: next } : item)) }));
  // 成员的先后、权重、是否启用。自己建的路由直接改它的成员；自动合好的路由成员是谁仍跟着连接走，
  // 用户调的这三样单独存(autoSources)，下次合成时按它排。
  const setSources = (change: (sources: ModelGroupSource[]) => ModelGroupSource[]) => save((latest) => {
    const current = (latest.sourceRoutes ?? []).find((item) => item.id === route.id)?.sources ?? route.sources;
    if (!route.auto) {
      return { ...latest, sourceRoutes: (latest.sourceRoutes ?? []).map((item) => (item.id === route.id ? { ...item, sources: change(item.sources) } : item)) };
    }
    // 自动合成的路由：此刻没连上的成员(电脑离线、分享暂停)不在列表里，但用户给它排的位置、权重、暂停要留着，
    // 重新连上时回到原来的设置(model-groups.md §3.5)。
    const next = change(current);
    const shown = new Set(next.map(optionKey));
    const away = (latest.autoSources?.[route.id] ?? []).filter((item) => !shown.has(optionKey(item)));
    return { ...latest, autoSources: { ...(latest.autoSources ?? {}), [route.id]: [...next, ...away] } };
  });
  const patchSource = (key: string, patch: (source: ModelGroupSource) => ModelGroupSource) =>
    setSources((sources) => sources.map((item) => (optionKey(item) === key ? patch(item) : item)));
  const moveSource = (key: string, delta: number) => setSources((sources) => {
    const index = sources.findIndex((item) => optionKey(item) === key);
    const to = index + delta;
    if (index < 0 || to < 0 || to >= sources.length) return sources;
    const next = [...sources];
    const [item] = next.splice(index, 1);
    next.splice(to, 0, item!);
    return next;
  });
  return (
    <SettingsPageScope>
      <div data-testid="model-groups-source-route" data-source-route={route.id} className="flex min-w-0 flex-col">
        <SettingsPageHeader
          title={route.name}
          description={route.auto ? t('modelGroups.sources.note') : undefined}
          onBack={onBack}
          backLabel={t('modelGroups.settings.back')}
        />
        <div className="mt-6 flex min-w-0 flex-col gap-9">
          {!route.auto && onSwitchToModel && (
            <RouteTypeSection
              value="provider"
              disabled={switchingKind}
              focusSelected={focusType}
              onSelect={(next, fromKeyboard) => { if (next === 'model') onSwitchToModel(fromKeyboard); }}
            />
          )}
          <SettingsSection>
            <SettingsCard>
              {!route.auto && (
                <RouteNameRow key={route.id} value={route.name} label={t('modelGroups.settings.name')} hint={t('modelGroups.settings.nameHint')}
                  onCommit={(name) => patchOwn((current) => ({ ...current, name }))} />
              )}
              <SettingsRow
                title={t('modelGroups.settings.pick')}
                hint={t(`modelGroups.strategy.${route.strategy}.hint`)}
                wrap
                trailing={<StrategySelect label={t('modelGroups.settings.pick')} value={route.strategy}
                  strategies={MODEL_GROUP_STRATEGIES} onChange={setStrategy} />}
              />
              {/* 与其他路由同一个开关(model-groups.md §4.5)：正在用的成员出问题时自动换到下一个能用的成员。 */}
              <SettingsRow
                title={t('modelGroups.settings.autoSwitch.title')}
                hint={t('modelGroups.settings.autoSwitch.hint')}
                wrap
                trailing={<Switch data-settings-search-action="Turns automatic switching to the next source on or off for this route" checked={modelGroupAutoSwitchOn(route)} aria-label={t('modelGroups.settings.autoSwitch.title')} onCheckedChange={setAutoSwitch} />}
              />
              {route.auto && (
                <SettingsRow
                  title={t('modelGroups.auto.show')}
                  wrap
                  trailing={<Switch data-settings-search-action="Shows or hides an automatic route in the model picker" checked={!route.hidden} aria-label={t('modelGroups.auto.show')} onCheckedChange={(shown) => setHidden(!shown)} />}
                />
              )}
            </SettingsCard>
          </SettingsSection>
          <SettingsSection
            title={t('modelGroups.settings.sources')}
            description={route.strategy === 'weighted'
              ? `${t('modelGroups.sources.models', { count: models })} · ${t('modelGroups.settings.weightHint')}`
              : t('modelGroups.sources.models', { count: models })}
          >
            <SettingsCard>
              {route.sources.map((source, index) => {
                const key = optionKey(source);
                const option = options.find((item) => item.key === key)
                  ?? (source.accountId ? options.find((item) => item.key === optionKey({ providerId: source.providerId })) : undefined);
                const label = option?.label ?? source.providerId;
                // 与按模型排的路由里来源那一行同一套：序号、(按权重时)权重、上移下移、(自己建的)移出、启用开关。
                // 所有真实来源（本机单账号、本机多账号拆平后的每个账号、其他电脑、分享来源）一律平铺在这一张卡片里，
                // 逐个可控开关与先后，绝不嵌套第二层自动选路。
                return (
                  <SettingsRow
                    key={key}
                    media
                    data-source-route-member={index}
                    data-source-route-provider={!source.agentDeviceId ? source.providerId : undefined}
                    lead={
                      <span className="flex items-center gap-3">
                        <span className="w-4 text-center text-12 tabular-nums leading-[1.33] text-[var(--text-tertiary)]">{index + 1}</span>
                        {option ? <ProviderLead provider={option.provider} pluginEngine={option.pluginEngine} /> : <SettingsRowIcon><Sparkles size={16} aria-hidden /></SettingsRowIcon>}
                      </span>
                    }
                    title={label}
                    tag={!option?.usable ? t('modelGroups.settings.notConnected') : undefined}
                    className={cn(source.off && '[&>span:nth-child(-n+2)]:opacity-60')}
                    trailing={
                      <span className="flex shrink-0 items-center gap-1">
                        {route.strategy === 'weighted' && (
                          <span className="mr-2 flex items-center">
                            <WeightInput
                              key={`${key}:${modelGroupWeight(source.weight)}`}
                              value={modelGroupWeight(source.weight)}
                              label={t('modelGroups.settings.weightAria', { name: label })}
                              onCommit={(weight) => patchSource(key, (item) => {
                                const { weight: _weight, ...rest } = item;
                                void _weight;
                                return weight === 1 ? rest : { ...rest, weight };
                              })}
                            />
                          </span>
                        )}
                        <RowIconButton label={t('modelGroups.settings.moveUp')} disabled={index === 0} onClick={() => moveSource(key, -1)}
                          move={{ row: `source:${key}`, direction: 'up' }}><ArrowUp size={15} /></RowIconButton>
                        <RowIconButton label={t('modelGroups.settings.moveDown')} disabled={index === route.sources.length - 1} onClick={() => moveSource(key, 1)}
                          move={{ row: `source:${key}`, direction: 'down' }}><ArrowDown size={15} /></RowIconButton>
                        {!route.auto && (
                          <RowIconButton label={t('modelGroups.sources.removeAria', { name: label })}
                            onClick={() => void setSources((sources) => sources.filter((item) => optionKey(item) !== key))}><X size={15} /></RowIconButton>
                        )}
                        <Switch
                          data-settings-search-action="Turns one source of this route on or off"
                          className="ml-2"
                          checked={!source.off}
                          aria-label={t('modelGroups.settings.useSource', { name: label })}
                          onCheckedChange={(on) => void patchSource(key, (item) => {
                            const { off: _off, ...rest } = item;
                            void _off;
                            return on ? rest : { ...rest, off: true };
                          })}
                        />
                      </span>
                    }
                  />
                );
              })}
              {route.sources.length === 0 && (
                <SettingsBlock className="text-13 leading-[1.5] text-[var(--text-secondary)]">{t('modelGroups.settings.sourcesEmptyMerged')}</SettingsBlock>
              )}
              {!route.auto && route.sources.length < MODEL_GROUP_LIMITS.candidates && (
                <WholeProviderAddRow options={options} taken={route.sources}
                  onAdd={(source) => patchOwn((current) => ({ ...current, sources: [...current.sources, source] }))} />
              )}
            </SettingsCard>
          </SettingsSection>
          {/* 例外与「试一下」：与按模型排的路由同一块(2026-11-26 补上)。例外对展开出来的每个模型都生效；
              时段例外只能改走自己排的路由。 */}
          <ModelGroupRouteExceptions
            key={`exceptions:${route.id}`}
            route={{ id: route.id, name: route.name, strategy: route.strategy, candidates: [], ...(route.exceptions ? { exceptions: route.exceptions } : {}) }}
            routes={config.routes.filter((item) => !item.parent)}
            onChange={(next) => setExceptions(next)}
          />
          <ModelGroupRoutePreview key={`try:${route.id}`} resetKey={JSON.stringify(route)} routes={expanded} nameCandidates={expandedCandidates} />
          {!route.auto && (
            <SettingsSection>
              <SettingsCard>
                <SettingsRow danger title={t('modelGroups.settings.deleteRoute')} onClick={() => void remove()} />
              </SettingsCard>
            </SettingsSection>
          )}
        </div>
      </div>
    </SettingsPageScope>
  );
}

/**
 * 其他地方用的模型：Subagent、辅助模型与每位伙伴的模型都直接在这一页改(OtherModelSettings)，不再是跳去别处的入口。
 * 伙伴的模型编辑器带路由，需要在路由里渲染。
 */
export function ModelSettingsElsewhere({ onOpenBuddyDevice }: { onOpenBuddyDevice?(deviceId: string): void }) {
  const routed = useInRouterContext();
  return routed ? (
    <Suspense fallback={null}>
      <OtherModelSettings {...(onOpenBuddyDevice ? { onOpenBuddyDevice } : {})} />
    </Suspense>
  ) : null;
}
