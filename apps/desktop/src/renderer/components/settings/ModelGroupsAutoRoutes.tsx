/**
 * 设置 → 智能路由里「整个供应商」这一类来源的界面部件。路由只有一种(一个名字、几个来源、一种选法)：
 * 来源可以是某个供应商的某个模型，也可以是一整个供应商——后者在选模型时像一个合并后的供应商，照常选模型，
 * 由路由决定这次用哪个成员(shared/modelGroups.ts 的 ModelGroupSourceRoute)。同一家的会自动合好。
 *
 * 一个供应商里的几个账号、几台电脑上同一个供应商合成的组，也是同一套选法、同一个选择函数，选法在这里改。
 * 成员可以是本机的供应商，也可以是其他电脑上的或别人分享来的。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Waypoints, X } from 'lucide-react';
import { useInRouterContext, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { ProviderMark } from '@/components/new-chat/ModelSelector';
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
import { Tip } from '@/components/ui/tooltip';
import { useLocalProviderGroups } from '@/features/provider-group/useLocalProviderGroups';
import { useProviderGroup } from '@/features/provider-group/useProviderGroup';
import { useDevicesProviders } from '@/hooks/useDevicesProviders';
import { useModelRouteDevices } from '@/hooks/useModelRouteDevices';
import { useProviders } from '@/hooks/useProviders';
import { isProviderShareAgentDeviceId } from '../../../shared/providerShare';
import { toast } from '@/lib/toast';

import {
  MODEL_GROUP_LIMITS,
  MODEL_GROUP_STRATEGIES,
  modelGroupAutoSwitchOn,
  type ModelGroupsConfig,
  type ModelGroupSource,
  type ModelGroupSourceRoute,
} from '../../../shared/modelGroups';
import { providerGroupDeviceCount, type ProviderGroupConfig } from '../../../shared/providerGroup';
import { SAME_SOURCE_ROUTE_STRATEGIES, type RouteStrategy } from '../../../shared/routeStrategy';
import type { SubscriptionPoolView } from '../../../shared/subscriptionAccounts';
import { SettingsTextInput } from './SettingsTextInput';

type Provider = ReturnType<typeof useProviders>['providers'][number];

const ICON_BUTTON = 'inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)] disabled:opacity-50';

function StrategySelect({ label, value, disabled, onChange, strategies = SAME_SOURCE_ROUTE_STRATEGIES }: {
  label: string; value: RouteStrategy; disabled?: boolean; onChange(next: RouteStrategy): void;
  /** 默认是同一个供应商的账号／电脑之间能选的那几种；几个供应商之间价格可能不同，再加上「最省钱」。 */
  strategies?: readonly RouteStrategy[];
}) {
  const { t } = useTranslation();
  const options = useMemo(
    () => strategies.map((item) => ({ value: item, label: t(`modelGroups.strategy.${item}.title`) })),
    [t, strategies],
  );
  return (
    <Select label={label} value={value} options={options} width="sm" disabled={disabled}
      onValueChange={(next) => { if (next !== value) onChange(next as RouteStrategy); }} />
  );
}

function ProviderLead({ provider }: { provider: Provider }) {
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
function AccountsRouteRow({ provider, plain = null }: { provider: Provider; plain?: ReactNode }) {
  const { t } = useTranslation();
  const [view, setView] = useState<SubscriptionPoolView | null>(null);
  const [saving, setSaving] = useState(false);
  const read = useCallback(async () => {
    try {
      setView(await window.electronAPI.subscriptionAccounts.command({ action: 'read', providerId: provider.id }));
    } catch {
      // 读不到就不列这一行；供应商页里仍能看到账号和原因。
      setView(null);
    }
  }, [provider.id]);
  useEffect(() => {
    void read();
    return window.electronAPI.subscriptionAccounts.onChanged(() => { void read(); });
  }, [read]);
  if (!view || view.accounts.length < 2) return <>{plain}</>;
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
  return (
    <SettingsRow
      media
      wrap
      data-auto-route={`accounts:${provider.id}`}
      lead={<ProviderLead provider={provider} />}
      title={provider.name}
      hint={`${t('modelGroups.auto.accounts', { count: view.accounts.length })} · ${t(`modelGroups.strategy.${view.strategy}.hint`)}`}
      trailing={<StrategySelect label={t('modelGroups.auto.pickFor', { name: provider.name })} value={view.strategy} disabled={saving} onChange={(next) => void change(next)} />}
    />
  );
}

/** 把几台电脑上的同一个供应商合成的一组。 */
function ComputersRouteRow({ provider, initial }: { provider: Provider; initial: ProviderGroupConfig }) {
  const { t } = useTranslation();
  const group = useProviderGroup(provider.id, { initialConfig: initial });
  const [saving, setSaving] = useState(false);
  const config = group.view?.config ?? initial;
  const change = async (strategy: RouteStrategy) => {
    setSaving(true);
    try {
      await group.save({ ...config, strategy });
    } catch {
      toast.error(t('modelGroups.settings.saveFailed'));
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingsRow
      media
      wrap
      data-auto-route={`computers:${provider.id}`}
      lead={<ProviderLead provider={provider} />}
      title={provider.name}
      hint={`${t('modelGroups.auto.computers', { count: providerGroupDeviceCount(config.members) })} · ${t(`modelGroups.strategy.${config.strategy}.hint`)}`}
      trailing={<StrategySelect label={t('modelGroups.auto.pickFor', { name: provider.name })} value={config.strategy} disabled={saving} onChange={(next) => void change(next)} />}
    />
  );
}

/** 可以整个加进路由的供应商：本机已连接的，加上其他电脑上允许远程调用的、别人分享来的。 */
export interface SourceOption {
  key: string;
  providerId: string;
  agentDeviceId?: string;
  label: string;
  provider: Provider;
}

const optionKey = (source: Pick<ModelGroupSource, 'providerId' | 'agentDeviceId'>) => `${source.agentDeviceId ?? ''}\u0000${source.providerId}`;
const usableProvider = (provider: Provider) => provider.connected && !provider.suspended && !provider.removed;

export function useSourceOptions(): SourceOption[] {
  const { providers } = useProviders();
  const { devices } = useModelRouteDevices({ controlledDeviceId: null, leadAgentDeviceId: null });
  const deviceIds = useMemo(() => (devices ?? []).map((device) => device.deviceId), [devices]);
  const catalogs = useDevicesProviders(deviceIds, { retainDisplaySnapshot: true });
  return useMemo(() => [
    ...providers.filter(usableProvider).map((provider): SourceOption => ({
      key: optionKey({ providerId: provider.id }), providerId: provider.id, label: provider.name, provider,
    })),
    ...(devices ?? []).flatMap((device) => (catalogs.get(device.deviceId)?.providers ?? [])
      .filter((provider) => usableProvider(provider) && provider.remoteInvocationEnabled !== false)
      .map((provider): SourceOption => ({
        key: optionKey({ providerId: provider.id, agentDeviceId: device.deviceId }),
        providerId: provider.id, agentDeviceId: device.deviceId,
        // 分享的名字已经是「供应商 · 分享者」；其他电脑写「供应商 · 电脑名」。
        label: isProviderShareAgentDeviceId(device.deviceId) ? device.name : `${provider.name} · ${device.name}`,
        provider,
      }))),
  ], [providers, devices, catalogs]);
}

/** 还没并进任何路由的供应商里，有几个账号或几台电脑的：它们之间怎么分在这一行改。 */
export function ProviderAllocationRows({ config }: { config: ModelGroupsConfig }) {
  const { providers } = useProviders();
  const groups = useLocalProviderGroups();
  const members = new Set((config.sourceRoutes ?? []).flatMap((route) => route.sources.filter((source) => !source.agentDeviceId).map((source) => source.providerId)));
  return (
    <>
      {providers.filter(usableProvider).flatMap((provider) => {
        if (members.has(provider.id)) return [];
        const group = groups[provider.id];
        if (group) return [<ComputersRouteRow key={`computers:${provider.id}`} provider={provider} initial={group} />];
        // 账号数以已核实的登录身份为准；只有一个账号的供应商没有可分配的，不列。
        if ((provider.subscriptionAccountKeys?.length ?? 0) >= 2) return [<AccountsRouteRow key={`accounts:${provider.id}`} provider={provider} />];
        return [];
      })}
    </>
  );
}

/** 路由列表里的一行：合并了整个供应商的路由。 */
export function SourceRouteRow({ route, config, options, onOpen }: {
  route: ModelGroupSourceRoute; config: ModelGroupsConfig; options: readonly SourceOption[]; onOpen(): void;
}) {
  const { t } = useTranslation();
  const first = route.sources.map((source) => options.find((option) => option.key === optionKey(source))).find(Boolean);
  const models = config.routes.filter((item) => item.parent?.id === route.id).length;
  return (
    <SettingsRow
      media
      data-source-route={route.id}
      lead={first ? <ProviderLead provider={first.provider} /> : <SettingsRowIcon><Waypoints size={16} aria-hidden /></SettingsRowIcon>}
      title={route.name}
      tag={route.hidden ? t('modelGroups.auto.hiddenTag') : route.auto ? t('modelGroups.sources.autoTag') : undefined}
      hint={[
        t('modelGroups.sources.providers', { count: route.sources.length }),
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

/** 「添加整个供应商」：本机的、其他电脑上的、分享来的都在这一个下拉里。 */
export function WholeProviderAddRow({ options, taken, onAdd }: {
  options: readonly SourceOption[]; taken: readonly ModelGroupSource[]; onAdd(source: ModelGroupSource): void;
}) {
  const { t } = useTranslation();
  const addable = options.filter((option) => !taken.some((source) => optionKey(source) === option.key));
  if (addable.length === 0) return null;
  return (
    <SettingsRow
      title={t('modelGroups.sources.addWhole')}
      hint={t('modelGroups.sources.addWholeHint')}
      wrap
      trailing={
        <Select label={t('modelGroups.sources.addWhole')} value={ADD_NONE} width="sm"
          options={[{ value: ADD_NONE, label: t('modelGroups.sources.chooseProvider') }, ...addable.map((option) => ({ value: option.key, label: option.label }))]}
          onValueChange={(key) => {
            const option = addable.find((item) => item.key === key);
            if (option) onAdd({ providerId: option.providerId, ...(option.agentDeviceId ? { agentDeviceId: option.agentDeviceId } : {}) });
          }} />
      }
    />
  );
}

/** 一条合并了整个供应商的路由的编辑页。自动合成的成员不能改，其余与用户自己建的一样。 */
export function SourceRouteDetail({ route, config, options, save, onBack }: {
  route: ModelGroupSourceRoute;
  config: ModelGroupsConfig;
  options: readonly SourceOption[];
  save(change: (latest: ModelGroupsConfig) => ModelGroupsConfig): Promise<boolean>;
  onBack(): void;
}) {
  const { t } = useTranslation();
  const patchOwn = (patch: (current: ModelGroupSourceRoute) => ModelGroupSourceRoute) => void save((latest) => ({
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
    if (await save((latest) => ({ ...latest, sourceRoutes: (latest.sourceRoutes ?? []).filter((item) => item.id !== route.id) }))) onBack();
  };
  const models = config.routes.filter((item) => item.parent?.id === route.id).length;
  return (
    <SettingsPageScope>
      <div data-testid="model-groups-source-route" data-source-route={route.id} className="flex min-w-0 flex-col">
        <SettingsPageHeader
          title={route.name}
          description={t(route.auto ? 'modelGroups.sources.note' : 'modelGroups.sources.detailHint')}
          onBack={onBack}
          backLabel={t('modelGroups.settings.back')}
        />
        <div className="mt-6 flex min-w-0 flex-col gap-9">
          <SettingsSection>
            <SettingsCard>
              {!route.auto && <SourceRouteName route={route} onCommit={(name) => patchOwn((current) => ({ ...current, name }))} />}
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
                trailing={<Switch checked={modelGroupAutoSwitchOn(route)} aria-label={t('modelGroups.settings.autoSwitch.title')} onCheckedChange={setAutoSwitch} />}
              />
              {route.auto && (
                <SettingsRow
                  title={t('modelGroups.auto.show')}
                  wrap
                  trailing={<Switch checked={!route.hidden} aria-label={t('modelGroups.auto.show')} onCheckedChange={(shown) => setHidden(!shown)} />}
                />
              )}
            </SettingsCard>
          </SettingsSection>
          <SettingsSection title={t('modelGroups.settings.sources')} description={t('modelGroups.sources.models', { count: models })}>
            <SettingsCard>
              {route.sources.map((source) => {
                const option = options.find((item) => item.key === optionKey(source));
                const label = option?.label ?? source.providerId;
                const plain = (
                  <SettingsRow
                    key={optionKey(source)}
                    media
                    lead={option ? <ProviderLead provider={option.provider} /> : <SettingsRowIcon><Waypoints size={16} aria-hidden /></SettingsRowIcon>}
                    title={label}
                    tag={option ? undefined : t('modelGroups.settings.notConnected')}
                    trailing={route.auto ? undefined : (
                      <Tip text={t('modelGroups.settings.remove')}>
                        <button type="button" className={ICON_BUTTON} aria-label={t('modelGroups.sources.removeAria', { name: label })}
                          onClick={() => patchOwn((current) => ({ ...current, sources: current.sources.filter((item) => optionKey(item) !== optionKey(source)) }))}>
                          <X size={15} aria-hidden />
                        </button>
                      </Tip>
                    )}
                  />
                );
                // 自动合成的路由里，本机成员自己有几个账号时，账号之间怎么分就在这一行改。
                return route.auto && option && !source.agentDeviceId && (option.provider.subscriptionAccountKeys?.length ?? 0) >= 2
                  ? <AccountsRouteRow key={optionKey(source)} provider={option.provider} plain={plain} />
                  : plain;
              })}
              {route.sources.length === 0 && (
                <SettingsBlock className="text-13 leading-[1.5] text-[var(--text-secondary)]">{t('modelGroups.settings.sourcesEmpty')}</SettingsBlock>
              )}
              {!route.auto && route.sources.length < MODEL_GROUP_LIMITS.candidates && (
                <WholeProviderAddRow options={options} taken={route.sources}
                  onAdd={(source) => patchOwn((current) => ({ ...current, sources: [...current.sources, source] }))} />
              )}
            </SettingsCard>
          </SettingsSection>
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

function SourceRouteName({ route, onCommit }: { route: ModelGroupSourceRoute; onCommit(name: string): void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(route.name);
  const commit = () => {
    const next = draft.trim().slice(0, MODEL_GROUP_LIMITS.name);
    if (next && next !== route.name) onCommit(next);
    else setDraft(route.name);
  };
  return (
    <SettingsRow
      title={t('modelGroups.settings.name')}
      hint={t('modelGroups.settings.nameHint')}
      wrap
      trailing={
        <SettingsTextInput aria-label={t('modelGroups.settings.name')} value={draft} maxLength={MODEL_GROUP_LIMITS.name}
          onChange={setDraft} onBlur={commit}
          onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
          className="w-[240px] max-w-full" />
      }
    />
  );
}

/**
 * 别处的模型设置入口：辅助模型、Subagent、伙伴各在自己的页面里设置，这里给出入口，让「模型相关的设置」从这一页都找得到。
 */
export function ModelSettingsElsewhere() {
  const routed = useInRouterContext();
  return routed ? <ElsewhereRows /> : null;
}

function ElsewhereRows() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const rows = [
    { key: 'auxiliary', title: t('settings.sections.auxiliaryModels'), hint: t('modelGroups.elsewhere.auxiliaryHint'), to: '/settings?tab=personalization&section=personalization.auxiliaryModels' },
    { key: 'subagent', title: t('settings.sections.subagentModels'), hint: t('modelGroups.elsewhere.subagentHint'), to: '/settings?tab=personalization&section=personalization.subagents' },
    { key: 'bots', title: t('modelGroups.elsewhere.botsTitle'), hint: t('modelGroups.elsewhere.botsHint'), to: '/bots/list' },
  ];
  return (
    <SettingsSection title={t('modelGroups.elsewhere.title')} description={t('modelGroups.elsewhere.description')} testId="model-settings-elsewhere">
      <SettingsCard>
        {rows.map((row) => (
          <SettingsRow key={row.key} data-model-settings-elsewhere={row.key} title={row.title} hint={row.hint} chevron onClick={() => navigate(row.to)} />
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}
