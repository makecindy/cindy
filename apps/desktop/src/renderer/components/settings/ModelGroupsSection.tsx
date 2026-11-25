/**
 * 设置 → 模型组：把模型供应商里已有的来源合成路线，可连同推理强度一起存。
 * 来源本身仍在「模型供应商」里连接和管理；这里只引用已连接的模型。每次改动立即保存。
 * 产品规则见 docs/product-rules/model-groups.md。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ArrowDown, ArrowUp, Check, CornerDownRight, Minus, Play, Plus, Waypoints, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ModelSelector, ProviderMark } from '@/components/new-chat/ModelSelector';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Select } from '@/components/ui/select';
import {
  SettingsBlock,
  SettingsCard,
  SettingsPageHeader,
  SettingsPageScope,
  SettingsRow,
  SettingsRowIcon,
  SettingsSection,
} from '@/components/ui/settings-rows';
import { Switch } from '@/components/ui/switch';
import { Tip } from '@/components/ui/tooltip';
import {
  modelGroupExceptionText,
  modelGroupWhyText,
  saveModelGroups,
  useModelGroupCandidateNames,
  useModelGroups,
} from '@/features/model-groups/modelGroupsClient';
import { useModelRouteDevices } from '@/hooks/useModelRouteDevices';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

import {
  MODEL_GROUP_LIMITS,
  MODEL_GROUP_STRATEGIES,
  modelGroupAutoSwitchOn,
  modelGroupCandidateKey,
  modelGroupWeight,
  type ModelGroupCandidate,
  type ModelGroupResolveResult,
  type ModelGroupRoute,
  type ModelGroupsConfig,
  type ModelGroupStrategy,
} from '../../../shared/modelGroups';
import { ModelGroupRouteExceptions } from './ModelGroupRouteExceptions';
import {
  ModelSettingsElsewhere,
  ProviderAllocationRows,
  SourceRouteDetail,
  SourceRouteRow,
  useSourceOptions,
  WholeProviderAddRow,
} from './ModelGroupsAutoRoutes';
import { modelGroupsSettings } from './ModelGroupsSection.settings-search';
import { ModelGroupsOverview } from './ModelGroupsOverview';
import { RowIconButton, WeightInput } from './ModelGroupRowControls';
import { SettingsTextInput } from './SettingsTextInput';
import { useSettingsSubpageBack } from './useSettingsEscape';
import { useSettingsSearchNavigation } from './SettingsSearchNavigation';
import { useSettingsSectionTarget } from './useSettingsSectionTarget';
import { useSettingsSubpageScroll } from './useSettingsSubpageScroll';

const log = createLogger('ModelGroupsSection');
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const UNSET_EFFORT = '__unset__';

type View = { kind: 'list' } | { kind: 'route'; id: string } | { kind: 'source'; id: string };

function NameRow({ value, label, hint, onCommit }: { value: string; label: string; hint: string; onCommit(next: string): void }) {
  const [draft, setDraft] = useState(value);
  const commit = () => {
    const next = draft.trim().slice(0, MODEL_GROUP_LIMITS.name);
    if (next && next !== value) onCommit(next);
    else setDraft(value);
  };
  return (
    <SettingsRow
      title={label}
      hint={hint}
      wrap
      trailing={
        <SettingsTextInput
          aria-label={label}
          data-settings-search-action="Renames one user-created route; the list is indexed by its section entry"
          value={draft}
          maxLength={MODEL_GROUP_LIMITS.name}
          onChange={setDraft}
          onBlur={commit}
          onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
          className="w-[240px] max-w-full"
        />
      }
    />
  );
}

/** 路由列表里两种路由各自的小标题：与模型供应商页左栏的分组标题同一档字。 */
const ROUTE_KIND_LABEL = 'px-1 text-12 font-medium leading-[1.33] text-[var(--text-tertiary)]';

export function ModelGroupsSection({ scrollRef }: { scrollRef?: RefObject<HTMLDivElement | null> }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const { confirm } = useConfirmDialog();
  // 设置页读全部：隐藏了的自动路由要能在这里找回。
  const { config, loaded } = useModelGroups(true, { includeHidden: true });
  // 这里能打开、能改的是用户按模型排的路由；供应商路由(及它们在每个模型上的展开)在下面单独一段(ModelGroupsAutoRoutes)。
  const userRoutes = useMemo(() => config.routes.filter((item) => !item.parent), [config]);
  // 路由只有一种，来源分两类：某个模型，或一整个供应商(含其他电脑上的、分享来的)。后一类存在 sourceRoutes 里。
  const sourceRoutes = config.sourceRoutes ?? [];
  const sourceOptions = useSourceOptions();
  // 时段例外可能改走别的路线：「试一下」里会出现别的路线的来源，名字一起备好。
  const allCandidates = useMemo(() => config.routes.flatMap((item) => item.candidates), [config]);
  const namesOf = useModelGroupCandidateNames(allCandidates);
  // 「添加来源」与其它设置页一样列出其他电脑与分享来的供应商；选中哪一行，来源就连同运行位置一起存。
  const routeDevices = useModelRouteDevices({ controlledDeviceId: null, leadAgentDeviceId: null });
  const [view, setView] = useState<View>({ kind: 'list' });
  const route = view.kind === 'route' ? userRoutes.find((item) => item.id === view.id) : undefined;
  const sourceRoute = view.kind === 'source' ? sourceRoutes.find((item) => item.id === view.id) : undefined;
  const subpageOpen = !!(route ?? sourceRoute);
  const { entry, activation } = useSettingsSearchNavigation();
  // 这一页并在模型供应商页里、自己滚动：从设置搜索或别处的「去设置」过来时，由这里把要找的那一项滚到眼前
  // (设置页外层那个滚动区不动)。
  const ownScrollRef = useRef<HTMLDivElement | null>(null);
  useSettingsSectionTarget(entry?.tab === 'model-groups' ? entry.targetId : null, scrollRef ?? ownScrollRef,
    `${entry?.id ?? ''}:${activation}`, entry?.fallbackTargetId);
  useEffect(() => {
    if (entry?.tab === 'model-groups') setView({ kind: 'list' });
  }, [entry, activation]);
  const captureScroll = useSettingsSubpageScroll(scrollRef, subpageOpen ? 1 : 0, activation);
  const [preview, setPreview] = useState<{ routeId: string; result: ModelGroupResolveResult } | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const save = useCallback(async (change: (latest: ModelGroupsConfig) => ModelGroupsConfig) => {
    try {
      await saveModelGroups(change);
      setPreview(null);
      return true;
    } catch (error) {
      log.warn('save failed', error);
      toast.error(t('modelGroups.settings.saveFailed'));
      return false;
    }
  }, [t]);
  const updateRoute = (id: string, patch: (route: ModelGroupRoute) => ModelGroupRoute) =>
    save((latest) => ({ ...latest, routes: latest.routes.map((route) => (route.id === id ? patch(route) : route)) }));

  const strategyOptions = useMemo(
    () => MODEL_GROUP_STRATEGIES.map((value) => ({ value, label: t(`modelGroups.strategy.${value}.title`) })),
    [t],
  );
  const effortOptions = useMemo(
    () => [
      { value: UNSET_EFFORT, label: t('modelGroups.settings.effortUnset') },
      ...EFFORTS.map((value) => ({ value, label: t(`effortLevels.${value}`) })),
    ],
    [t],
  );
  const routeSummary = (route: ModelGroupRoute) => [
    t('modelGroups.sourceCount', { count: route.candidates.length }),
    t(`modelGroups.strategy.${route.strategy}.title`),
    route.effort ? t(`effortLevels.${route.effort}`, { defaultValue: route.effort }) : '',
  ].filter(Boolean).join(' · ');

  const openRoute = (id: string) => {
    captureScroll();
    setView({ kind: 'route', id });
  };
  const addRoute = async () => {
    const route: ModelGroupRoute = { id: crypto.randomUUID(), name: t('modelGroups.settings.newRouteName'), strategy: 'expiring', candidates: [] };
    if (await save((latest) => ({ ...latest, routes: [...latest.routes, route] }))) openRoute(route.id);
  };
  const back = () => setView({ kind: 'list' });
  useSettingsSubpageBack(subpageOpen ? back : null);

  // ── 路线详情 ───────────────────────────────────────────────────────────────
  if (sourceRoute) {
    return <SourceRouteDetail route={sourceRoute} config={config} options={sourceOptions} save={save} onBack={back} />;
  }
  if (route) {
    const move = (index: number, delta: number) => updateRoute(route.id, (current) => {
      const candidates = [...current.candidates];
      const [item] = candidates.splice(index, 1);
      candidates.splice(index + delta, 0, item);
      return { ...current, candidates };
    });
    const runPreview = async () => {
      setPreviewing(true);
      try {
        setPreview({ routeId: route.id, result: await window.electronAPI.modelGroups.resolve({ selection: { type: 'route', id: route.id }, dryRun: true }) });
      } catch (error) {
        log.warn('preview failed', error);
        toast.error(t('modelGroups.settings.saveFailed'));
      } finally {
        setPreviewing(false);
      }
    };
    const removeRoute = async () => {
      if (!await confirm({
        title: t('modelGroups.settings.deleteRouteConfirmTitle', { name: route.name }),
        description: t('modelGroups.settings.deleteRouteConfirmDescription'),
        confirmText: t('modelGroups.settings.delete'),
        cancelText: t('modelGroups.settings.cancel'),
        confirmVariant: 'destructive',
      })) return;
      if (await save((latest) => ({ ...latest, routes: latest.routes.filter((item) => item.id !== route.id) }))) back();
    };
    const shown = preview?.routeId === route.id ? preview.result : null;
    const full = route.candidates.length >= MODEL_GROUP_LIMITS.candidates;
    return (
      <SettingsPageScope>
        <section className="flex min-w-0 flex-col" data-testid="model-group-route-detail">
          <SettingsPageHeader
            title={route.name}
            description={t('modelGroups.settings.routeShownAs')}
            onBack={back}
            backLabel={t('modelGroups.settings.back')}
            backProps={{ 'data-settings-search-action': 'Return from a route to the model groups list' }}
          />
          <div className="mt-6 flex min-w-0 flex-col gap-9">
            <SettingsSection>
              <SettingsCard>
                <NameRow key={route.id} value={route.name} label={t('modelGroups.settings.name')} hint={t('modelGroups.settings.nameHint')}
                  onCommit={(name) => void updateRoute(route.id, (current) => ({ ...current, name }))} />
                <SettingsRow
                  title={t('modelGroups.settings.pick')}
                  hint={t(`modelGroups.strategy.${route.strategy}.hint`)}
                  wrap
                  trailing={
                    <Select
                      data-setting-id={modelGroupsSettings.routes.id}
                      label={t('modelGroups.settings.pick')}
                      value={route.strategy}
                      options={strategyOptions}
                      width="sm"
                      onValueChange={(value) => void updateRoute(route.id, (current) => ({ ...current, strategy: value as ModelGroupStrategy }))}
                    />
                  }
                />
                <SettingsRow
                  title={t('modelGroups.settings.effort')}
                  hint={t('modelGroups.settings.effortHint')}
                  wrap
                  trailing={
                    <Select
                      data-setting-id={modelGroupsSettings.routes.id}
                      label={t('modelGroups.settings.effort')}
                      value={route.effort ?? UNSET_EFFORT}
                      options={effortOptions}
                      width="sm"
                      onValueChange={(value) => void updateRoute(route.id, (current) => {
                        const { effort: _previous, ...rest } = current;
                        void _previous;
                        return value === UNSET_EFFORT ? rest : { ...rest, effort: value };
                      })}
                    />
                  }
                />
                <SettingsRow
                  title={t('modelGroups.settings.autoSwitch.title')}
                  hint={t('modelGroups.settings.autoSwitch.hint')}
                  wrap
                  trailing={
                    <Switch
                      data-setting-id={modelGroupsSettings.routes.id}
                      data-model-group-auto-switch
                      checked={modelGroupAutoSwitchOn(route)}
                      aria-label={t('modelGroups.settings.autoSwitch.title')}
                      onCheckedChange={(on) => void updateRoute(route.id, (current) => {
                        // 默认开：开着时不存这一项，关掉才存 false(model-groups.md §4.5)。
                        const { autoSwitch: _was, ...rest } = current;
                        void _was;
                        return on ? rest : { ...rest, autoSwitch: false };
                      })}
                    />
                  }
                />
              </SettingsCard>
            </SettingsSection>

            <SettingsSection
              title={t('modelGroups.settings.sources')}
              description={route.strategy === 'weighted' ? t('modelGroups.settings.weightHint') : t('modelGroups.settings.sourcesHint')}
            >
              <SettingsCard>
                {route.candidates.map((candidate, index) => {
                  const names = namesOf(candidate);
                  const label = `${names.modelName} · ${names.sourceLabel}`;
                  return (
                    <SettingsRow
                      key={modelGroupCandidateKey(candidate)}
                      media
                      data-model-group-candidate={index}
                      lead={
                        <span className="flex items-center gap-3">
                          <span className="w-4 text-center text-12 tabular-nums leading-[1.33] text-[var(--text-tertiary)]">{index + 1}</span>
                          <SettingsRowIcon>
                            <ProviderMark providerId={candidate.providerId} name={names.provider?.name} routing={names.provider?.routing} logoKind={names.provider?.logoKind} customIcon={names.provider?.customIcon}
                              colorClass="text-[var(--text-primary)]" withMargin={false} />
                          </SettingsRowIcon>
                        </span>
                      }
                      title={names.modelName}
                      tag={names.connected ? undefined : t('modelGroups.settings.notConnected')}
                      hint={names.sourceLabel}
                      className={cn(candidate.off && '[&>span:nth-child(-n+2)]:opacity-60')}
                      trailing={
                        <span className="flex shrink-0 items-center gap-1">
                          {route.strategy === 'weighted' && (
                            <span className="mr-2 flex items-center">
                              <WeightInput
                                key={`${modelGroupCandidateKey(candidate)}:${modelGroupWeight(candidate.weight)}`}
                                value={modelGroupWeight(candidate.weight)}
                                label={t('modelGroups.settings.weightAria', { name: label })}
                                onCommit={(weight) => updateRoute(route.id, (current) => ({
                                  ...current,
                                  candidates: current.candidates.map((item, i) => {
                                    if (i !== index) return item;
                                    const { weight: _weight, ...rest } = item;
                                    void _weight;
                                    return weight === 1 ? rest : { ...rest, weight };
                                  }),
                                }))}
                              />
                            </span>
                          )}
                          <RowIconButton label={t('modelGroups.settings.moveUp')} disabled={index === 0} onClick={() => void move(index, -1)}><ArrowUp size={15} /></RowIconButton>
                          <RowIconButton label={t('modelGroups.settings.moveDown')} disabled={index === route.candidates.length - 1} onClick={() => void move(index, 1)}><ArrowDown size={15} /></RowIconButton>
                          <RowIconButton label={t('modelGroups.settings.remove')}
                            onClick={() => void updateRoute(route.id, (current) => ({ ...current, candidates: current.candidates.filter((_, i) => i !== index) }))}><X size={15} /></RowIconButton>
                          <Switch
                            data-setting-id={modelGroupsSettings.routes.id}
                            className="ml-2"
                            checked={!candidate.off}
                            aria-label={t('modelGroups.settings.useSource', { name: label })}
                            onCheckedChange={(on) => void updateRoute(route.id, (current) => ({
                              ...current,
                              candidates: current.candidates.map((item, i) => {
                                if (i !== index) return item;
                                const { off: _off, ...rest } = item;
                                void _off;
                                return on ? rest : { ...rest, off: true };
                              }),
                            }))}
                          />
                        </span>
                      }
                    />
                  );
                })}
                {route.candidates.length === 0 && (
                  <SettingsBlock className="text-13 leading-[1.5] text-[var(--text-secondary)]">{t('modelGroups.settings.sourcesEmpty')}</SettingsBlock>
                )}
                {/* 还没有来源时可以改成合并整个供应商：这条路由随之变成「像一个供应商，照常选模型」的那一类。 */}
                {route.candidates.length === 0 && (
                  <WholeProviderAddRow options={sourceOptions} taken={[]} onAdd={(source) => void save((latest) => ({
                    ...latest,
                    routes: latest.routes.filter((item) => item.id !== route.id),
                    sourceRoutes: [...(latest.sourceRoutes ?? []), {
                      id: route.id, name: route.name, strategy: route.strategy, sources: [source],
                      ...(route.effort ? { effort: route.effort } : {}),
                      ...(route.autoSwitch === false ? { autoSwitch: false as const } : {}),
                    }],
                  })).then((ok) => { if (ok) setView({ kind: 'source', id: route.id }); })} />
                )}
                <SettingsRow
                  title={t('modelGroups.settings.addSource')}
                  hint={full ? t('modelGroups.settings.sourcesFull', { count: MODEL_GROUP_LIMITS.candidates }) : route.candidates.length === 0 ? t('modelGroups.sources.addModelHint') : undefined}
                  wrap
                  trailing={
                    <div className="w-[280px] max-w-full">
                      <ModelSelector
                        data-setting-id={modelGroupsSettings.routes.id}
                        remoteAgent={routeDevices.devices && { devices: routeDevices.devices, selectedDeviceId: null }}
                        disabled={full}
                        modelId=""
                        effort=""
                        onModelChange={() => false}
                        onEffortChange={() => undefined}
                        configurationEnabled={false}
                        triggerVariant="field"
                        fieldPanelWidth="content"
                        popoverSide="bottom"
                        ariaContext={t('modelGroups.settings.addSource')}
                        fallbackOption={{ active: true, label: t('modelGroups.settings.chooseModel'), onSelect: () => undefined }}
                        onUnifiedSelect={({ engine, providerId, modelId, agentDevice }) => {
                          const added: ModelGroupCandidate = {
                            agentKind: engine, providerId, model: modelId,
                            ...(agentDevice ? { agentDeviceId: agentDevice.deviceId } : {}),
                          };
                          if (route.candidates.some((item) => modelGroupCandidateKey(item) === modelGroupCandidateKey(added))) return true;
                          return updateRoute(route.id, (current) => ({ ...current, candidates: [...current.candidates, added] }));
                        }}
                      />
                    </div>
                  }
                />
              </SettingsCard>
            </SettingsSection>

            <ModelGroupRouteExceptions
              key={route.id}
              route={route}
              routes={config.routes}
              onChange={(next) => updateRoute(route.id, (current) => ({ ...current, exceptions: next }))}
            />

            <SettingsSection
              title={t('modelGroups.settings.try.title')}
              description={t('modelGroups.settings.try.hint')}
              action={
                <Button variant="secondary" size="md" loading={previewing} disabled={route.candidates.length === 0} onClick={() => void runPreview()}
                  data-settings-search-action="Previews which source a route would pick; changes no setting">
                  <Play size={14} aria-hidden />
                  {t('modelGroups.settings.try.run')}
                </Button>
              }
            >
              {shown && (
                <SettingsCard data-testid="model-group-preview" className="animate-fade-in">
                  {shown.outcome === 'routed' && shown.exceptions && shown.exceptions.length > 0 && (
                    <SettingsBlock data-model-group-preview-exception className="text-13 leading-[1.5] text-[var(--text-secondary)]">
                      {modelGroupExceptionText(shown.exceptions, t)}
                    </SettingsBlock>
                  )}
                  {shown.outcome !== 'routed' && (
                    <SettingsBlock className="text-13 leading-[1.5] text-[var(--text-secondary)]">{t('modelGroups.settings.try.unavailable')}</SettingsBlock>
                  )}
                  {shown.trace.map((entry) => {
                    const Icon = entry.state === 'picked' ? Check : entry.state === 'standby' ? CornerDownRight : Minus;
                    // 同一个来源的几个模型共用一份额度：备用的那几行不再重复写「先留着」。
                    const picked = shown.trace.find((item) => item.state === 'picked');
                    const sameQuota = entry.state === 'standby' && !!picked?.quota && !!entry.quota
                      && picked.quota.resetAtMs === entry.quota.resetAtMs && picked.quota.usedPercent === entry.quota.usedPercent;
                    // 名字与路线里那一行相同(含运行位置)；设置页还没读到那边的目录时用这次选路读到的。
                    const names = namesOf(entry, entry);
                    const title = `${names.modelName} · ${names.sourceLabel}`;
                    return (
                      <SettingsRow
                        key={modelGroupCandidateKey(entry)}
                        data-model-group-trace={entry.state}
                        lead={<Icon size={15} aria-hidden className={entry.state === 'picked' ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]'} />}
                        title={title}
                        tag={t(`modelGroups.settings.try.${entry.state}`)}
                        hint={modelGroupWhyText(sameQuota ? { ...entry, quota: null } : entry, t, locale)}
                      />
                    );
                  })}
                </SettingsCard>
              )}
            </SettingsSection>

            <SettingsSection>
              <SettingsCard>
                <SettingsRow danger title={t('modelGroups.settings.deleteRoute')} onClick={() => void removeRoute()}
                  data-settings-search-action="Deletes this route after confirmation" />
              </SettingsCard>
            </SettingsSection>
          </div>
        </section>
      </SettingsPageScope>
    );
  }

  // ── 列表 ───────────────────────────────────────────────────────────────────
  return (
    <SettingsSection variant="page" title={t('modelGroups.title')} description={t('modelGroups.description')} testId="model-groups-settings">
      <ModelGroupsOverview config={config}
        onOpenRoute={(id) => { if (userRoutes.some((item) => item.id === id)) openRoute(id); }}
        onOpenSourceRoute={(id) => { captureScroll(); setView({ kind: 'source', id }); }} />
      <SettingsSection
        title={t('modelGroups.routes')}
        titleId={modelGroupsSettings.routes.targetId}
        description={t('modelGroups.routesDescription')}
        caption={t('modelGroups.settings.scopeNote')}
        action={
          <Button variant="secondary" size="md" onClick={() => void addRoute()} disabled={!loaded || userRoutes.length >= MODEL_GROUP_LIMITS.routes}
            data-settings-search-action="Creates a route and opens it">
            <Plus size={14} aria-hidden />
            {t('modelGroups.settings.newRoute')}
          </Button>
        }
      >
        {/* 两种路由各一张卡片、各带一个小标题(2026-11-25 用户反馈：混在一张卡片里分不清)；只有一种时不加小标题。 */}
        <div className="flex flex-col gap-4">
          {userRoutes.length > 0 && (
            <div role="group" aria-label={t('modelGroups.kinds.byModel')} data-model-group-kind="model" className="flex flex-col gap-1.5">
              {sourceRoutes.length > 0 && <div className={ROUTE_KIND_LABEL}>{t('modelGroups.kinds.byModel')}</div>}
              <SettingsCard>
                {userRoutes.map((item) => (
                  <SettingsRow
                    key={item.id}
                    media
                    data-model-group-route={item.id}
                    data-settings-search-action="Opens one route"
                    lead={<SettingsRowIcon><Waypoints size={16} aria-hidden /></SettingsRowIcon>}
                    title={item.name}
                    hint={routeSummary(item)}
                    chevron
                    onClick={() => openRoute(item.id)}
                  />
                ))}
              </SettingsCard>
            </div>
          )}
          {sourceRoutes.length > 0 && (
            <div role="group" aria-label={t('modelGroups.kinds.byProvider')} data-model-group-kind="provider" className="flex flex-col gap-1.5">
              {userRoutes.length > 0 && <div className={ROUTE_KIND_LABEL}>{t('modelGroups.kinds.byProvider')}</div>}
              <SettingsCard>
                {sourceRoutes.map((item) => (
                  <SourceRouteRow key={item.id} route={item} config={config} options={sourceOptions} onOpen={() => { captureScroll(); setView({ kind: 'source', id: item.id }); }} />
                ))}
                <ProviderAllocationRows config={config} />
              </SettingsCard>
            </div>
          )}
          {sourceRoutes.length === 0 && (
            // 没有合并整个供应商的路由时，供应商内的分配行(几个账号、几台电脑)仍要有地方列；一行都没有时这张卡片不占地方。
            <SettingsCard className="empty:hidden">
              <ProviderAllocationRows config={config} />
              {userRoutes.length === 0 && (
                <SettingsBlock className="text-13 leading-[1.5] text-[var(--text-secondary)]">{t('modelGroups.settings.routesEmpty')}</SettingsBlock>
              )}
            </SettingsCard>
          )}
        </div>
      </SettingsSection>
      <ModelSettingsElsewhere />
    </SettingsSection>
  );
}
