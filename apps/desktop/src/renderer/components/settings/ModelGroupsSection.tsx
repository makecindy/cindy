/**
 * 设置 → 模型组：把模型供应商里已有的来源合成路线，可连同推理强度一起存。
 * 来源本身仍在「模型供应商」里连接和管理；这里只引用已连接的模型。每次改动立即保存。
 * 产品规则见 docs/product-rules/model-groups.md。
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
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
  modelGroupCandidateKey,
  type ModelGroupCandidate,
  type ModelGroupResolveResult,
  type ModelGroupRoute,
  type ModelGroupsConfig,
  type ModelGroupStrategy,
} from '../../../shared/modelGroups';
import { ModelGroupRouteExceptions } from './ModelGroupRouteExceptions';
import { modelGroupsSettings } from './ModelGroupsSection.settings-search';
import { ModelGroupsOverview } from './ModelGroupsOverview';
import { SettingsTextInput } from './SettingsTextInput';

const log = createLogger('ModelGroupsSection');
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const UNSET_EFFORT = '__unset__';

type View = { kind: 'list' } | { kind: 'route'; id: string };

/** 行尾的小图标按钮：32px 热区，带可见提示。 */
function RowIconButton({ label, onClick, disabled, children }: { label: string; onClick(): void; disabled?: boolean; children: ReactNode }) {
  return (
    <Tip text={label} disabled={disabled}>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        data-settings-search-action="Reorders or removes one source inside a route"
        className="flex size-8 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] outline-none transition-colors duration-[var(--motion-fast)] ease-[var(--motion-ease-out)] enabled:hover:bg-[var(--surface-chip)] enabled:hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)] disabled:opacity-40"
      >
        {children}
      </button>
    </Tip>
  );
}

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

export function ModelGroupsSection() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const { confirm } = useConfirmDialog();
  const { config, loaded } = useModelGroups();
  // 时段例外可能改走别的路线：「试一下」里会出现别的路线的来源，名字一起备好。
  const allCandidates = useMemo(() => config.routes.flatMap((item) => item.candidates), [config]);
  const namesOf = useModelGroupCandidateNames(allCandidates);
  // 「添加来源」与其它设置页一样列出其他电脑与分享来的供应商；选中哪一行，来源就连同运行位置一起存。
  const routeDevices = useModelRouteDevices({ controlledDeviceId: null, leadAgentDeviceId: null });
  const [view, setView] = useState<View>({ kind: 'list' });
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

  const addRoute = async () => {
    const route: ModelGroupRoute = { id: crypto.randomUUID(), name: t('modelGroups.settings.newRouteName'), strategy: 'expiring', candidates: [] };
    if (await save((latest) => ({ ...latest, routes: [...latest.routes, route] }))) setView({ kind: 'route', id: route.id });
  };
  const back = () => setView({ kind: 'list' });

  // ── 路线详情 ───────────────────────────────────────────────────────────────
  const route = view.kind === 'route' ? config.routes.find((item) => item.id === view.id) : undefined;
  if (view.kind === 'route' && route) {
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
              </SettingsCard>
            </SettingsSection>

            <SettingsSection title={t('modelGroups.settings.sources')} description={t('modelGroups.settings.sourcesHint')}>
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
                            <ProviderMark providerId={candidate.providerId} name={names.provider?.name} routing={names.provider?.routing} logoKind={names.provider?.logoKind}
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
                <SettingsRow
                  title={t('modelGroups.settings.addSource')}
                  hint={full ? t('modelGroups.settings.sourcesFull', { count: MODEL_GROUP_LIMITS.candidates }) : undefined}
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
      <ModelGroupsOverview config={config} onOpenRoute={(id) => setView({ kind: 'route', id })} />
      <SettingsSection
        title={t('modelGroups.routes')}
        titleId={modelGroupsSettings.routes.targetId}
        description={t('modelGroups.routesDescription')}
        caption={t('modelGroups.settings.scopeNote')}
        action={
          <Button variant="secondary" size="md" onClick={() => void addRoute()} disabled={!loaded || config.routes.length >= MODEL_GROUP_LIMITS.routes}
            data-settings-search-action="Creates a route and opens it">
            <Plus size={14} aria-hidden />
            {t('modelGroups.settings.newRoute')}
          </Button>
        }
      >
        <SettingsCard>
          {config.routes.map((item) => (
            <SettingsRow
              key={item.id}
              media
              data-model-group-route={item.id}
              data-settings-search-action="Opens one route"
              lead={<SettingsRowIcon><Waypoints size={16} aria-hidden /></SettingsRowIcon>}
              title={item.name}
              hint={routeSummary(item)}
              chevron
              onClick={() => setView({ kind: 'route', id: item.id })}
            />
          ))}
          {config.routes.length === 0 && (
            <SettingsBlock className="text-13 leading-[1.5] text-[var(--text-secondary)]">{t('modelGroups.settings.routesEmpty')}</SettingsBlock>
          )}
        </SettingsCard>
      </SettingsSection>
    </SettingsSection>
  );
}
