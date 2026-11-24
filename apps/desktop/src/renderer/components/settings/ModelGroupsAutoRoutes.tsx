/**
 * 设置 → 智能路由 → 供应商路由：把几个来源合成一条，用起来像一个合并后的供应商——照常选模型，由路由决定这次用哪个。
 *
 * 三种，用的是同一套选法(shared/routeStrategy.ts)和同一个选择函数，选法都只在这里改：
 *   - 一个供应商里有几个账号；
 *   - 把几台电脑上的同一个供应商合成了一组；
 *   - 几个供应商合成一条(ModelGroupSourceRoute)：同一家的会自动合好(成员跟着连接增减，可以改选法或隐藏)，
 *     也可以自己挑几个供应商合。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Eye, EyeOff, Plus, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ProviderMark } from '@/components/new-chat/ModelSelector';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { SettingsBlock, SettingsCard, SettingsRow, SettingsRowIcon, SettingsSection } from '@/components/ui/settings-rows';
import { Tip } from '@/components/ui/tooltip';
import { useLocalProviderGroups } from '@/features/provider-group/useLocalProviderGroups';
import { useProviderGroup } from '@/features/provider-group/useProviderGroup';
import { useProviders } from '@/hooks/useProviders';
import { toast } from '@/lib/toast';

import {
  MODEL_GROUP_LIMITS,
  MODEL_GROUP_STRATEGIES,
  modelGroupAutoSwitchOn,
  type ModelGroupsConfig,
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

export function ModelGroupsAutoRoutes({ config, save }: {
  config: ModelGroupsConfig;
  save(change: (latest: ModelGroupsConfig) => ModelGroupsConfig): Promise<boolean>;
}) {
  const { t } = useTranslation();
  const { providers } = useProviders();
  const groups = useLocalProviderGroups();
  const connected = providers.filter((provider) => provider.connected && !provider.suspended && !provider.removed);
  const sourceRoutes = config.sourceRoutes ?? [];
  const own = sourceRoutes.filter((route) => !route.auto);
  // 已经是某条供应商路由成员的供应商，它的账号／电脑怎么分就写在那条路由的成员行上，不在上面再列一遍。
  const memberIds = new Set(sourceRoutes.flatMap((route) => route.sources.map((source) => source.providerId)));
  const sourceRows = connected.flatMap((provider) => {
    if (memberIds.has(provider.id)) return [];
    const group = groups[provider.id];
    if (group) return [<ComputersRouteRow key={`computers:${provider.id}`} provider={provider} initial={group} />];
    // 账号数以已核实的登录身份为准；只有一个账号的供应商没有可分配的，不列。
    if ((provider.subscriptionAccountKeys?.length ?? 0) >= 2) return [<AccountsRouteRow key={`accounts:${provider.id}`} provider={provider} />];
    return [];
  });
  const patchOwn = (id: string, patch: (route: ModelGroupSourceRoute) => ModelGroupSourceRoute) => void save((latest) => ({
    ...latest, sourceRoutes: (latest.sourceRoutes ?? []).map((route) => (route.id === id ? patch(route) : route)),
  }));
  const setStrategy = (route: ModelGroupSourceRoute, strategy: RouteStrategy) => (route.auto
    ? void save((latest) => ({ ...latest, autoStrategy: { ...(latest.autoStrategy ?? {}), [route.id]: strategy } }))
    : patchOwn(route.id, (current) => ({ ...current, strategy })));
  const setAutoSwitch = (route: ModelGroupSourceRoute, on: boolean) => (route.auto
    ? void save((latest) => {
      const rest = (latest.autoSwitchOff ?? []).filter((id) => id !== route.id);
      return { ...latest, autoSwitchOff: on ? rest : [...rest, route.id] };
    })
    : patchOwn(route.id, (current) => {
      const { autoSwitch: _was, ...rest } = current;
      void _was;
      return on ? rest : { ...rest, autoSwitch: false as const };
    }));
  const setHidden = (route: ModelGroupSourceRoute, hidden: boolean) => void save((latest) => {
    const rest = (latest.hiddenAuto ?? []).filter((id) => id !== route.id);
    return { ...latest, hiddenAuto: hidden ? [...rest, route.id] : rest };
  });
  const add = () => void save((latest) => ({
    ...latest,
    sourceRoutes: [...(latest.sourceRoutes ?? []), {
      id: crypto.randomUUID(), name: t('modelGroups.sources.newName'), strategy: 'expiring', sources: [],
    }],
  }));
  const modelCount = (route: ModelGroupSourceRoute) => config.routes.filter((item) => item.parent?.id === route.id).length;
  return (
    <SettingsSection
      title={t('modelGroups.sources.title')}
      description={t('modelGroups.sources.description')}
      testId="model-groups-source-routes"
      action={
        <Button variant="secondary" size="md" onClick={add} disabled={own.length >= MODEL_GROUP_LIMITS.routes}>
          <Plus size={14} aria-hidden />
          {t('modelGroups.sources.new')}
        </Button>
      }
    >
      {(sourceRows.length > 0 || sourceRoutes.length === 0) && (
        <SettingsCard>
          {sourceRows}
          {sourceRows.length === 0 && (
            <SettingsBlock className="text-13 leading-[1.5] text-[var(--text-secondary)]">{t('modelGroups.sources.empty')}</SettingsBlock>
          )}
        </SettingsCard>
      )}
      {sourceRoutes.map((route) => {
        const members = route.sources.map((source) => ({ source, provider: providers.find((item) => item.id === source.providerId) }));
        const addable = connected.filter((provider) => !route.sources.some((source) => source.providerId === provider.id));
        const first = members.find((member) => member.provider)?.provider;
        return (
          <SettingsCard key={route.id} data-source-route={route.id}>
            {route.auto ? (
              <SettingsRow
                media
                wrap
                lead={first ? <ProviderLead provider={first} /> : undefined}
                title={route.name}
                tag={route.hidden ? t('modelGroups.auto.hiddenTag') : t('modelGroups.sources.autoTag')}
                hint={`${t('modelGroups.sources.models', { count: modelCount(route) })} · ${t(`modelGroups.strategy.${route.strategy}.hint`)}`}
                trailing={
                  <span className="flex shrink-0 items-center gap-1">
                    <StrategySelect label={t('modelGroups.auto.pickFor', { name: route.name })} value={route.strategy}
                      strategies={MODEL_GROUP_STRATEGIES} onChange={(next) => setStrategy(route, next)} />
                    <Tip text={route.hidden ? t('modelGroups.auto.show') : t('modelGroups.auto.hide')}>
                      <button type="button" className={ICON_BUTTON}
                        aria-label={t(route.hidden ? 'modelGroups.auto.showAria' : 'modelGroups.auto.hideAria', { name: route.name })}
                        aria-pressed={route.hidden === true} onClick={() => setHidden(route, !route.hidden)}>
                        {route.hidden ? <EyeOff size={15} aria-hidden /> : <Eye size={15} aria-hidden />}
                      </button>
                    </Tip>
                  </span>
                }
              />
            ) : (
              <>
                <SourceRouteName route={route} onCommit={(name) => patchOwn(route.id, (current) => ({ ...current, name }))}
                  onDelete={() => void save((latest) => ({ ...latest, sourceRoutes: (latest.sourceRoutes ?? []).filter((item) => item.id !== route.id) }))} />
                <SettingsRow
                  title={t('modelGroups.settings.pick')}
                  hint={`${t('modelGroups.sources.models', { count: modelCount(route) })} · ${t(`modelGroups.strategy.${route.strategy}.hint`)}`}
                  wrap
                  trailing={<StrategySelect label={t('modelGroups.auto.pickFor', { name: route.name })} value={route.strategy}
                    strategies={MODEL_GROUP_STRATEGIES} onChange={(next) => setStrategy(route, next)} />}
                />
              </>
            )}
            {/* 与普通路由同一个开关(model-groups.md §4.5)：正在用的成员出问题时自动换到下一个能用的成员。 */}
            <SettingsRow
              title={t('modelGroups.settings.autoSwitch.title')}
              hint={t('modelGroups.settings.autoSwitch.hint')}
              wrap
              trailing={
                <Switch checked={modelGroupAutoSwitchOn(route)} aria-label={t('modelGroups.settings.autoSwitch.title')}
                  onCheckedChange={(on) => setAutoSwitch(route, on)} />
              }
            />
            {members.map(({ source, provider }) => {
              const plain = (
                <SettingsRow
                  key={source.providerId}
                  media
                  lead={provider ? <ProviderLead provider={provider} /> : undefined}
                  title={provider?.name ?? source.providerId}
                  tag={provider?.connected ? undefined : t('modelGroups.settings.notConnected')}
                  trailing={route.auto ? undefined : (
                    <Tip text={t('modelGroups.settings.remove')}>
                      <button type="button" className={ICON_BUTTON}
                        aria-label={t('modelGroups.sources.removeAria', { name: provider?.name ?? source.providerId })}
                        onClick={() => patchOwn(route.id, (current) => ({ ...current, sources: current.sources.filter((item) => item.providerId !== source.providerId) }))}>
                        <X size={15} aria-hidden />
                      </button>
                    </Tip>
                  )}
                />
              );
              // 自动合成的路由里，成员自己有几个账号时，账号之间怎么分就在这一行改。
              return route.auto && provider && (provider.subscriptionAccountKeys?.length ?? 0) >= 2
                ? <AccountsRouteRow key={source.providerId} provider={provider} plain={plain} />
                : plain;
            })}
            {!route.auto && route.sources.length < MODEL_GROUP_LIMITS.candidates && addable.length > 0 && (
              <SettingsRow
                title={t('modelGroups.sources.addProvider')}
                wrap
                trailing={
                  <Select label={t('modelGroups.sources.addProvider')} value={ADD_NONE} width="sm"
                    options={[{ value: ADD_NONE, label: t('modelGroups.sources.chooseProvider') }, ...addable.map((provider) => ({ value: provider.id, label: provider.name }))]}
                    onValueChange={(providerId) => {
                      if (providerId !== ADD_NONE) patchOwn(route.id, (current) => ({ ...current, sources: [...current.sources, { providerId }] }));
                    }} />
                }
              />
            )}
          </SettingsCard>
        );
      })}
      {(sourceRows.length > 0 || sourceRoutes.some((route) => route.auto)) && (
        <SettingsBlock className="flex flex-col gap-1 px-0 text-12 leading-[1.5] text-[var(--text-tertiary)]">
          {sourceRows.length > 0 && <span>{t('modelGroups.auto.quotaFirst')}</span>}
          {sourceRoutes.some((route) => route.auto) && <span>{t('modelGroups.sources.note')}</span>}
        </SettingsBlock>
      )}
    </SettingsSection>
  );
}

const ADD_NONE = '__none__';

function SourceRouteName({ route, onCommit, onDelete }: { route: ModelGroupSourceRoute; onCommit(name: string): void; onDelete(): void }) {
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
      wrap
      trailing={
        <span className="flex shrink-0 items-center gap-1">
          <SettingsTextInput aria-label={t('modelGroups.settings.name')} value={draft} maxLength={MODEL_GROUP_LIMITS.name}
            onChange={setDraft} onBlur={commit}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
            className="w-[240px] max-w-full" />
          <Tip text={t('modelGroups.settings.delete')}>
            <button type="button" className={ICON_BUTTON} aria-label={t('modelGroups.sources.deleteAria', { name: route.name })} onClick={onDelete}>
              <Trash2 size={15} aria-hidden />
            </button>
          </Tip>
        </span>
      }
    />
  );
}
