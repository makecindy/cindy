/**
 * 设置 → 模型组：把模型供应商里已有的来源合成路线，可连同推理强度一起存。
 * 来源本身仍在「模型供应商」里连接和管理；这里只引用已连接的模型。每次改动立即保存。
 * 产品规则见 docs/product-rules/model-groups.md。
 */
import { Activity, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, Plus, Sparkles, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { PluginEngineIcon } from '@/components/icons/PluginEngineIcon';
import {
  ModelSelector, ModelSelectorContent, ModelSelectorPopover, ProviderMark, type ModelSelectorProps,
} from '@/components/new-chat/ModelSelector';
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
import {
  saveModelGroups,
  useModelGroupCandidateNames,
  useModelGroups,
} from '@/features/model-groups/modelGroupsClient';
import { routeStrategySelectGroups } from '@/features/model-groups/routeStrategyOptions';
import { useModelRouteDevices } from '@/hooks/useModelRouteDevices';
import { usePickerPluginEngines } from '@/hooks/usePickerPluginEngines';
import { createLogger } from '@/lib/logger';
import { PLUGIN_ENGINE_DEFAULT_MODEL, type PluginEngineSelection } from '@/lib/pluginEngineSelection';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

import {
  MODEL_GROUP_LIMITS,
  MODEL_GROUP_STRATEGIES,
  modelGroupAutoSwitchOn,
  modelGroupCandidateKey,
  modelGroupWeight,
  type ModelGroupCandidate,
  type ModelGroupException,
  type ModelGroupRoute,
  type ModelGroupsConfig,
  type ModelGroupStrategy,
} from '../../../shared/modelGroups';
import { modelGroupHarnessLabel } from '../../../shared/modelGroupRouteNoteText';
import { ModelGroupRouteExceptions } from './ModelGroupRouteExceptions';
import { ModelGroupRoutePreview } from './ModelGroupRoutePreview';
import {
  ModelSettingsElsewhere,
  ProviderAllocationRows,
  SourceRouteDetail,
  SourceRouteRow,
  useSourceOptions,
} from './ModelGroupsAutoRoutes';
import { modelGroupsSettings } from './ModelGroupsSection.settings-search';
import { ModelGroupsOverview } from './ModelGroupsOverview';
import { RouteNameRow, RouteTypeSection, RowIconButton, WeightInput, type RouteKind } from './ModelGroupRowControls';
import { useSettingsSubpageBack } from './useSettingsEscape';
import { useSettingsSearchNavigation } from './SettingsSearchNavigation';
import { useSettingsSectionTarget } from './useSettingsSectionTarget';
import { useSettingsSubpageScroll } from './useSettingsSubpageScroll';

const log = createLogger('ModelGroupsSection');
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const UNSET_EFFORT = '__unset__';

type View = { kind: 'list' } | { kind: 'route' | 'source'; id: string; focusType?: boolean }
  /** 另一台电脑上的伙伴用哪个模型(id 是那台电脑)。 */
  | { kind: 'buddies'; id: string };

/** 另一台电脑上的伙伴模型页：只在点进去时取(带着伙伴设置的远程读写)。 */
const RemoteBuddyModelsPage = lazy(() => import('./RemoteBuddyModelsPage').then((module) => ({ default: module.RemoteBuddyModelsPage })));

/** 路由列表里两种路由各自的小标题：与模型供应商页左栏的分组标题同一档字。 */
const ROUTE_KIND_LABEL = 'px-1 text-12 font-medium leading-[1.33] text-[var(--text-tertiary)]';

function CandidateModelEditor({ candidate, names, devices, onSelect }: {
  candidate: ModelGroupCandidate & { agentKind: NonNullable<ModelSelectorProps['vendorKey']> };
  names: ReturnType<ReturnType<typeof useModelGroupCandidateNames>>;
  devices: NonNullable<ModelSelectorProps['remoteAgent']>['devices'] | undefined;
  onSelect: NonNullable<ModelSelectorProps['onUnifiedSelect']>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <ModelSelectorPopover
      open={open}
      onOpenChange={setOpen}
      side="bottom"
      trigger={(
        <Button
          variant="secondary"
          size="md"
          tone="quiet"
          className="max-w-full justify-start"
          aria-label={`${t('modelGroups.settings.editSource')}: ${names.modelName}`}
          title={names.modelName}
          data-setting-id={modelGroupsSettings.routes.id}
        >
          <ProviderMark providerId={candidate.providerId} name={names.provider?.name}
            routing={names.provider?.routing} logoKind={names.provider?.logoKind} customIcon={names.provider?.customIcon}
            colorClass="text-[var(--text-primary)]" withMargin={false} />
          <span className="min-w-0 truncate">{names.modelName}</span>
          <ChevronDown size={12} aria-hidden className="shrink-0" />
        </Button>
      )}
    >
      {open && (
        <ModelSelectorContent
          remoteAgent={(devices || candidate.agentDeviceId)
            ? { devices: devices ?? [], selectedDeviceId: candidate.agentDeviceId ?? null }
            : undefined}
          vendorKey={candidate.agentKind}
          modelId={candidate.model}
          currentProviderId={candidate.providerId}
          effort=""
          onModelChange={() => false}
          onEffortChange={() => undefined}
          configurationEnabled="harness"
          unifiedSelectionPolicy="official"
          onDismiss={() => setOpen(false)}
          onUnifiedSelect={onSelect}
        />
      )}
    </ModelSelectorPopover>
  );
}

/** Time exceptions can only target a model route. Include the stored overrides of auto routes,
 * even if the supplier is currently disconnected and the route is not shown. */
function routeTypeRedirects(config: ModelGroupsConfig, id: string) {
  const entries: [string, ModelGroupException[] | undefined][] = [
    ...config.routes.filter((route) => !route.parent && route.id !== id).map((route): [string, ModelGroupException[] | undefined] => [route.id, route.exceptions]),
    ...(config.sourceRoutes ?? []).filter((route) => !route.auto).map((route): [string, ModelGroupException[] | undefined] => [route.id, route.exceptions]),
    ...Object.entries(config.autoExceptions ?? {}),
  ];
  return entries.flatMap(([routeId, exceptions]) =>
    (exceptions ?? []).filter((exception) => exception.use !== 'vision' && exception.use.routeId === id)
      .map((exception) => ({ routeId, exception })),
  );
}

export function ModelGroupsSection({ scrollRef, focusProvider }: {
  scrollRef?: RefObject<HTMLDivElement | null>;
  /** 从某个供应商的「调整」过来：落到它的账号或电脑那一行；它在某条合并路由里时先打开那条路由。 */
  focusProvider?: { providerId: string; at: number } | null;
}) {
  const { t } = useTranslation();
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
  const pickerPluginEngines = usePickerPluginEngines({ enabled: true });
  const [view, setView] = useState<View>({ kind: 'list' });
  const route = view.kind === 'route' ? userRoutes.find((item) => item.id === view.id) : undefined;
  const sourceRoute = view.kind === 'source' ? sourceRoutes.find((item) => item.id === view.id) : undefined;
  const subpageOpen = !!(route ?? sourceRoute) || view.kind === 'buddies';
  // 打开着的路由在别处被删掉、或自动合成的那条因为断开不见了：回到列表，免得它之后重新出现时又突然跳进去。
  // 只认已经显示过的那一条——刚新建、刚转换的路由要等配置推过来才有，不能当成不见了(2026-11-26 排查)。
  const shownView = useRef<string | null>(null);
  const viewKey = view.kind === 'list' ? null : `${view.kind}:${view.id}`;
  useEffect(() => {
    if (subpageOpen) {
      shownView.current = viewKey;
    } else if (viewKey && shownView.current === viewKey) {
      shownView.current = null;
      setView({ kind: 'list' });
    }
  }, [subpageOpen, viewKey]);
  const { entry, activation } = useSettingsSearchNavigation();
  // 这一页并在模型供应商页里、自己滚动：从设置搜索或别处的「去设置」过来时，由这里把要找的那一项滚到眼前
  // (设置页外层那个滚动区不动)。
  const ownScrollRef = useRef<HTMLDivElement | null>(null);
  useSettingsSectionTarget(entry?.tab === 'model-groups' ? entry.targetId : null, scrollRef ?? ownScrollRef,
    `${entry?.id ?? ''}:${activation}`, entry?.fallbackTargetId);
  useEffect(() => {
    if (entry?.tab === 'model-groups') setView({ kind: 'list' });
  }, [entry, activation]);
  // 从某个供应商的「调整」过来：它在某条合并路由里(本机成员)时打开那条路由，否则回到列表；再把它的账号或电脑那一行
  // 滚到眼前并把焦点放上去(2026-11-26 排查：原来落在页面最上面，还要自己找)。
  const focusAt = focusProvider?.at;
  useEffect(() => {
    if (!focusProvider) return;
    const owner = (config.sourceRoutes ?? []).find((item) =>
      !item.hidden && item.sources.some((source) => !source.off && !source.agentDeviceId && source.providerId === focusProvider.providerId));
    setView(owner ? { kind: 'source', id: owner.id } : { kind: 'list' });
    const selector = `[data-auto-route="accounts:${CSS.escape(focusProvider.providerId)}"],[data-auto-route="computers:${CSS.escape(focusProvider.providerId)}"],[data-source-route-provider="${CSS.escape(focusProvider.providerId)}"]`;
    let tries = 0;
    let frame = 0;
    const find = () => {
      const row = (scrollRef?.current ?? document).querySelector<HTMLElement>(selector);
      if (row) {
        row.scrollIntoView({ block: 'center' });
        row.querySelector<HTMLElement>('button,[role="combobox"],select')?.focus({ preventScroll: true });
        return;
      }
      // 账号要读一次才列得出来：最多等一秒半。
      if (++tries < 90) frame = requestAnimationFrame(find);
    };
    frame = requestAnimationFrame(find);
    return () => cancelAnimationFrame(frame);
    // 只在又一次点「调整」时执行(依赖只写 focusAt)；配置之后的变化不再把视图拉回来。
  }, [focusAt]);
  const captureScroll = useSettingsSubpageScroll(scrollRef, subpageOpen ? 1 : 0, activation);

  const save = useCallback(async (change: (latest: ModelGroupsConfig) => ModelGroupsConfig) => {
    try {
      await saveModelGroups(change);
      return true;
    } catch (error) {
      log.warn('save failed', error);
      toast.error(t('modelGroups.settings.saveFailed'));
      return false;
    }
  }, [t]);
  const updateRoute = (id: string, patch: (route: ModelGroupRoute) => ModelGroupRoute) =>
    save((latest) => ({ ...latest, routes: latest.routes.map((route) => (route.id === id ? patch(route) : route)) }));

  const strategyGroups = useMemo(() => routeStrategySelectGroups(MODEL_GROUP_STRATEGIES, t), [t]);
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
  const switchingKindRef = useRef(false);
  const [switchingKind, setSwitchingKind] = useState(false);
  const switchRouteKind = useCallback(async (id: string, fromKind: RouteKind, toKind: RouteKind, fromKeyboard: boolean) => {
    if (fromKind === toKind || switchingKindRef.current) return;
    switchingKindRef.current = true;
    setSwitchingKind(true);
    try {
      let approved: string | undefined;
      const fromView = fromKind === 'model' ? 'route' : 'source';
      const prevViewKey = `${fromView}:${id}`;
      for (;;) {
        const result: {
          status: 'converted' | 'missing' | 'full' | 'confirm';
          impact?: { snapshot: string; redirects: boolean };
        } = { status: 'missing' };
        const ok = await save((latest) => {
          const model = fromKind === 'model' ? latest.routes.find((item) => item.id === id && !item.parent) : undefined;
          const provider = fromKind === 'provider' ? latest.sourceRoutes?.find((item) => item.id === id && !item.auto) : undefined;
          const current = model ?? provider;
          if (!current) return latest;

          const userSourceRoutes = (latest.sourceRoutes ?? []).filter((item) => !item.auto);
          if (
            (toKind === 'provider' && userSourceRoutes.length >= MODEL_GROUP_LIMITS.routes * 2)
            || (toKind === 'model' && latest.routes.filter((item) => !item.parent).length >= MODEL_GROUP_LIMITS.routes)
          ) {
            result.status = 'full';
            return latest;
          }

          // Decide in the save queue, after any in-flight add. A confirmation only covers
          // the sources and redirects observed in that attempt, not a later edit.
          const sources = model?.candidates ?? provider?.sources ?? [];
          const redirects = model ? routeTypeRedirects(latest, id) : [];
          if (sources.length || redirects.length) {
            const snapshot = JSON.stringify([sources, redirects]);
            if (approved !== snapshot) {
              result.status = 'confirm';
              result.impact = { snapshot, redirects: redirects.length > 0 };
              return latest;
            }
          }

          result.status = 'converted';
          if (shownView.current === prevViewKey) shownView.current = null;
          const common = {
            id: current.id,
            name: current.name,
            strategy: current.strategy,
            ...(current.autoSwitch === false ? { autoSwitch: false as const } : {}),
            ...(current.exceptions?.length ? { exceptions: current.exceptions } : {}),
          };
          if (model) {
            return {
              ...latest,
              routes: latest.routes.filter((item) => item.id !== id),
              // The IPC normalizer caps the submitted array before the store strips automatic routes.
              sourceRoutes: [...userSourceRoutes, { ...common, sources: [] }],
            };
          }
          return {
            ...latest,
            routes: [...latest.routes, {
              ...common,
              candidates: [],
              ...(provider?.effort ? { effort: provider.effort } : {}),
            }],
            sourceRoutes: (latest.sourceRoutes ?? []).filter((item) => item.id !== id),
          };
        });
        if (!ok) {
          if (result.status === 'converted' && !shownView.current) shownView.current = prevViewKey;
          return;
        }
        if (result.status === 'confirm' && result.impact) {
          const description = t('modelGroups.settings.switchTypeConfirmDescription');
          if (!await confirm({
            title: t('modelGroups.settings.switchTypeConfirmTitle'),
            description: result.impact.redirects
              ? `${description} ${t('modelGroups.settings.switchTypeConfirmTargetWarning')}`
              : description,
            confirmText: t('modelGroups.settings.switchTypeConfirmAction'),
            cancelText: t('modelGroups.settings.cancel'),
          })) return;
          approved = result.impact.snapshot;
          continue;
        }
        if (result.status === 'full') {
          toast.error(t('modelGroups.settings.saveFailed'));
        } else {
          setView((current) => {
            if (current.kind !== fromView || current.id !== id) return current;
            return result.status === 'converted'
              ? { kind: toKind === 'model' ? 'route' : 'source', id, focusType: fromKeyboard }
              : { kind: 'list' };
          });
        }
        return;
      }
    } finally {
      switchingKindRef.current = false;
      setSwitchingKind(false);
    }
  }, [confirm, save, t]);
  const back = () => setView({ kind: 'list' });
  useSettingsSubpageBack(subpageOpen ? back : null);

  // ── 路线详情 ───────────────────────────────────────────────────────────────
  // 打开某条路由的详情时列表不卸载，只是隐藏：返回时关系图不重放进场动画、展开的「最近的选择」还开着、下面几块不再一块块冒出来
  // (2026-11-26 排查)。
  let detail: ReactNode = null;
  if (view.kind === 'buddies') {
    detail = (
      <Suspense fallback={null}>
        <RemoteBuddyModelsPage deviceId={view.id} onBack={back} />
      </Suspense>
    );
  } else if (sourceRoute) {
    detail = (
      <SourceRouteDetail
        route={sourceRoute}
        config={config}
        options={sourceOptions}
        save={save}
        onBack={back}
        switchingKind={switchingKind}
        focusType={view.kind === 'source' && view.focusType}
        onSwitchToModel={sourceRoute.auto ? undefined : (fromKeyboard) => void switchRouteKind(sourceRoute.id, 'provider', 'model', fromKeyboard)}
      />
    );
  } else if (route) {
    // 按来源本身找、不按界面上的序号：连点或另一处刚改过时，改的仍是点的那一行(2026-11-26 排查)。
    const move = (key: string, delta: number) => updateRoute(route.id, (current) => {
      const index = current.candidates.findIndex((item) => modelGroupCandidateKey(item) === key);
      const to = index + delta;
      if (index < 0 || to < 0 || to >= current.candidates.length) return current;
      const candidates = [...current.candidates];
      const [item] = candidates.splice(index, 1);
      candidates.splice(to, 0, item!);
      return { ...current, candidates };
    });
    const patchCandidate = (key: string, patch: (candidate: ModelGroupCandidate) => ModelGroupCandidate | null) => updateRoute(route.id, (current) => ({
      ...current,
      candidates: current.candidates.flatMap((item) => {
        if (modelGroupCandidateKey(item) !== key) return [item];
        const next = patch(item);
        return next ? [next] : [];
      }),
    }));
    const selectCandidate = (key?: string): NonNullable<ModelSelectorProps['onUnifiedSelect']> =>
      async ({ engine, providerId, modelId, agentDevice }) => {
        const selected: ModelGroupCandidate = {
          agentKind: engine, providerId, model: modelId,
          ...(agentDevice ? { agentDeviceId: agentDevice.deviceId } : {}),
        };
        const selectedKey = modelGroupCandidateKey(selected);
        const outcome: { value: 'applied' | 'duplicate' | 'unavailable' } = { value: 'unavailable' };
        const ok = await save((latest) => {
          const index = latest.routes.findIndex((item) => item.id === route.id);
          const current = latest.routes[index];
          if (!current) return latest;
          const previous = key === undefined ? undefined
            : current.candidates.find((candidate) => modelGroupCandidateKey(candidate) === key);
          if (key !== undefined && !previous) return latest;
          if (key === selectedKey) {
            outcome.value = 'applied';
            return latest;
          }
          if (current.candidates.some((item) => modelGroupCandidateKey(item) === selectedKey)) {
            outcome.value = 'duplicate';
            return latest;
          }
          if (key === undefined && current.candidates.length >= MODEL_GROUP_LIMITS.candidates) return latest;
          const candidates = previous
            ? current.candidates.map((item) => item === previous
              ? { ...selected, ...(item.off ? { off: item.off } : {}), ...(item.weight !== undefined ? { weight: item.weight } : {}) }
              : item)
            : [...current.candidates, selected];
          outcome.value = 'applied';
          return { ...latest, routes: latest.routes.map((item, i) => i === index ? { ...item, candidates } : item) };
        });
        if (ok && outcome.value === 'duplicate') toast.error(t('modelGroups.settings.duplicateSource'));
        return ok && outcome.value === 'applied';
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
    const full = route.candidates.length >= MODEL_GROUP_LIMITS.candidates;
    detail = (
      <SettingsPageScope>
        <section className="flex min-w-0 flex-col" data-testid="model-group-route-detail">
          <SettingsPageHeader
            title={route.name}
            onBack={back}
            backLabel={t('modelGroups.settings.back')}
            backProps={{ 'data-settings-search-action': 'Return from a route to the model groups list' }}
          />
          <div className="mt-6 flex min-w-0 flex-col gap-9">
            <RouteTypeSection
              value="model"
              disabled={switchingKind}
              focusSelected={view.kind === 'route' && view.focusType}
              onSelect={(next, fromKeyboard) => { if (next === 'provider') void switchRouteKind(route.id, 'model', 'provider', fromKeyboard); }}
            />
            <SettingsSection>
              <SettingsCard>
                <RouteNameRow key={route.id} value={route.name} label={t('modelGroups.settings.name')} hint={t('modelGroups.settings.nameHint')}
                  onCommit={(name) => updateRoute(route.id, (current) => ({ ...current, name }))} />
                <SettingsRow
                  title={t('modelGroups.settings.pick')}
                  hint={t(`modelGroups.strategy.${route.strategy}.hint`)}
                  wrap
                  trailing={
                    <Select
                      data-setting-id={modelGroupsSettings.routes.id}
                      label={t('modelGroups.settings.pick')}
                      value={route.strategy}
                      groups={strategyGroups}
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
              description={route.strategy === 'weighted' ? t('modelGroups.settings.weightHint') : undefined}
            >
              <SettingsCard>
                {route.candidates.map((candidate, index) => {
                  const names = namesOf(candidate);
                  const sourceLabel = [names.sourceLabel, modelGroupHarnessLabel(candidate.agentKind)].filter(Boolean).join(' · ');
                  const label = `${names.modelName} · ${sourceLabel}`;
                  const key = modelGroupCandidateKey(candidate);
                  return (
                    <SettingsRow
                      key={key}
                      media
                      data-model-group-candidate={index}
                      lead={
                        <span className="flex items-center gap-3">
                          <span className="w-4 text-center text-12 tabular-nums leading-[1.33] text-[var(--text-tertiary)]">{index + 1}</span>
                          {candidate.agentKind === 'acp' && (
                            <SettingsRowIcon><PluginEngineIcon iconDataUrl={names.pluginEngine?.iconDataUrl} size={16} /></SettingsRowIcon>
                          )}
                        </span>
                      }
                      title={candidate.agentKind === 'acp' ? names.modelName : <CandidateModelEditor
                        candidate={{ ...candidate, agentKind: candidate.agentKind }}
                        names={names}
                        devices={routeDevices.devices}
                        onSelect={selectCandidate(key)}
                      />}
                      tag={names.connected ? undefined : t('modelGroups.settings.notConnected')}
                      hint={sourceLabel}
                      className={cn(candidate.off && '[&>span:nth-child(-n+2)]:opacity-60')}
                      trailing={
                        <span className="flex shrink-0 items-center gap-1">
                          {route.strategy === 'weighted' && (
                            <span className="mr-2 flex items-center">
                              <WeightInput
                                key={`${key}:${modelGroupWeight(candidate.weight)}`}
                                value={modelGroupWeight(candidate.weight)}
                                label={t('modelGroups.settings.weightAria', { name: label })}
                                onCommit={(weight) => patchCandidate(key, (item) => {
                                  const { weight: _weight, ...rest } = item;
                                  void _weight;
                                  return weight === 1 ? rest : { ...rest, weight };
                                })}
                              />
                            </span>
                          )}
                          <RowIconButton label={t('modelGroups.settings.moveUp')} disabled={index === 0} onClick={() => move(key, -1)}
                            move={{ row: key, direction: 'up' }}><ArrowUp size={15} /></RowIconButton>
                          <RowIconButton label={t('modelGroups.settings.moveDown')} disabled={index === route.candidates.length - 1} onClick={() => move(key, 1)}
                            move={{ row: key, direction: 'down' }}><ArrowDown size={15} /></RowIconButton>
                          <RowIconButton label={t('modelGroups.settings.remove')}
                            onClick={() => void patchCandidate(key, () => null)}><X size={15} /></RowIconButton>
                          <Switch
                            data-setting-id={modelGroupsSettings.routes.id}
                            className="ml-2"
                            checked={!candidate.off}
                            aria-label={t('modelGroups.settings.useSource', { name: label })}
                            onCheckedChange={(on) => void patchCandidate(key, (item) => {
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
                {route.candidates.length === 0 && (
                  <SettingsBlock className="text-13 leading-[1.5] text-[var(--text-secondary)]">{t('modelGroups.settings.sourcesEmpty')}</SettingsBlock>
                )}
                <SettingsRow
                  title={t('modelGroups.settings.addSource')}
                  hint={full ? t('modelGroups.settings.sourcesFull', { count: MODEL_GROUP_LIMITS.candidates }) : undefined}
                  wrap
                  trailing={
                    <div className="w-[280px] max-w-full">
                      <ModelSelector
                        data-setting-id={modelGroupsSettings.routes.id}
                        remoteAgent={routeDevices.devices && { devices: routeDevices.devices, selectedDeviceId: null }}
                        pluginEngines={
                          pickerPluginEngines.hasSources
                            ? {
                                engines: pickerPluginEngines.engines,
                                active: null,
                                readCatalogue: pickerPluginEngines.readCatalogue,
                                onSelect: (selection: PluginEngineSelection) => {
                                  const added: ModelGroupCandidate = {
                                    agentKind: 'acp',
                                    providerId: selection.providerId,
                                    model: selection.modelId || PLUGIN_ENGINE_DEFAULT_MODEL,
                                    ...(selection.deviceId ? { agentDeviceId: selection.deviceId } : {}),
                                  };
                                  if (route.candidates.some((item) => modelGroupCandidateKey(item) === modelGroupCandidateKey(added))) return true;
                                  return updateRoute(route.id, (current) => ({ ...current, candidates: [...current.candidates, added] }));
                                },
                              }
                            : undefined
                        }
                        disabled={full}
                        modelId=""
                        effort=""
                        onModelChange={() => false}
                        onEffortChange={() => undefined}
                        configurationEnabled="harness"
                        unifiedSelectionPolicy="official"
                        triggerVariant="field"
                        fieldPanelWidth="content"
                        popoverSide="bottom"
                        ariaContext={t('modelGroups.settings.addSource')}
                        fallbackOption={{ active: true, label: t('modelGroups.settings.chooseModel'), onSelect: () => undefined }}
                        onUnifiedSelect={selectCandidate()}
                      />
                    </div>
                  }
                />
              </SettingsCard>
            </SettingsSection>

            <ModelGroupRouteExceptions
              key={route.id}
              route={route}
              // 时段例外只能改走自己排的路由：展开出来的那些不存盘，存的时候会被当成不存在的目标去掉。
              routes={userRoutes}
              onChange={(next) => updateRoute(route.id, (current) => ({ ...current, exceptions: next }))}
            />

            {/* 配置一改，旧的试用结果作废(resetKey)。 */}
            <ModelGroupRoutePreview key={`try:${route.id}`} resetKey={JSON.stringify(route)} routes={[route]} nameCandidates={allCandidates} />

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
  const list = (
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
                    lead={<SettingsRowIcon><Sparkles size={16} aria-hidden /></SettingsRowIcon>}
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
      <ModelSettingsElsewhere onOpenBuddyDevice={(deviceId) => { captureScroll(); setView({ kind: 'buddies', id: deviceId }); }} />
    </SettingsSection>
  );
  return (
    <>
      {detail}
      <Activity mode={detail ? 'hidden' : 'visible'}>{list}</Activity>
    </>
  );
}
