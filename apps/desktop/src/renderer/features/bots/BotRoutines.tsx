import { useBotProfiles } from './botStore';
import type { BotModelRoute } from '../../../shared/botModelChain';
import { useNavigate } from 'react-router-dom';
import { standardSessionRoute } from '@/lib/orcaSessionIdentity';
import { BotTaskModelEditor } from './BotTaskModelEditor';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Clock3, Check, ChevronRight, CircleAlert, Pause, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cronToHuman } from '@/features/scheduler/lib/cronToHuman';
import { configToCron, cronToConfig } from '@/features/scheduler/lib/cronCodexPreset';
import type {
  Routine,
  RoutineInput,
  RoutineRun,
  RoutineSource,
  RoutineTrigger,
  RoutineDeliveryTarget,
} from '@cindy/maker-scheduler';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { PreRunPluginFields } from '@/features/scheduler/components/PreRunPluginFields';
import { GHOST_CONTROL_POINTS } from '../../../shared/ghost';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Spinner } from '@/components/ui/spinner';
import { useBotSettingsTarget } from './useBotSettingsTarget';
import { toast } from '@/lib/toast';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from '@/components/ui/dropdown-menu';
import type { NightlyLearningView } from '../../../shared/botNightlyLearning';
import { TODO_CHECK_ROUTINE_PREFIX } from '../../../shared/botAutonomy';
import { BotNightlyLearning, useNightlyLearningView } from './BotNightlyLearning';

const menuClass = 'p-2';
const fieldClass = 'block space-y-2';
const fieldLabelClass = 'block text-[var(--text-secondary)]';

/** A teammate's standing instructions and OR-combined triggers, shared by teammate settings and the task sidebar. */
export function BotRoutines({
  botId,
  beforeLeaveRef,
  backRef,
  embedded = false,
  header,
  inheritedRoute,
  systemSkillsOff = [],
}: {
  embedded?: boolean;
  inheritedRoute?: BotModelRoute;
  /** Settings shown above the list (not inside the editor), e.g. the teammate's follow-up switches. */
  header?: ReactNode;
  botId: string;
  beforeLeaveRef?: { current: (() => Promise<boolean>) | null };
  /** Host back button: steps from the editor to the list first (the inline back button is then omitted). */
  backRef?: { current: (() => Promise<boolean>) | null };
  /** System Skills the owner turned off: their built-in routines do not run and cannot be turned on here. */
  systemSkillsOff?: readonly string[];
}) {
  const { confirm } = useConfirmDialog();
  const settingsTarget = useBotSettingsTarget();
  const localBots = useBotProfiles();
  const primaryRoute = inheritedRoute ?? (settingsTarget.kind === 'local'
    ? localBots.find((bot) => bot.id === botId)?.capabilities.modelChain[0] : undefined);
  const routinesApi = settingsTarget.routines;
  // Follow-up and the daily todo check belong to system Skills; off, the host skips them.
  const skillOffFor = (routine: Routine): 'follow' | 'todo' | null =>
    routine.builtin === 'follow-up' && systemSkillsOff.includes('follow') ? 'follow'
      : routine.id.startsWith(TODO_CHECK_ROUTINE_PREFIX) && systemSkillsOff.includes('todo') ? 'todo' : null;
  const skillOffHint = (routine: Routine) => {
    const skill = skillOffFor(routine);
    return skill ? t('bots.systemSkills.offHint', { skill: t(`bots.capabilities.system.items.${skill}.name`) }) : undefined;
  };
  const navigate = useNavigate();
  const supportsModels = settingsTarget.kind === 'local' || settingsTarget.routineModels === true;
  const supportsDelivery = settingsTarget.kind === 'local' || settingsTarget.routineDelivery === true;
  const [deliveryTargets, setDeliveryTargets] = useState<RoutineDeliveryTarget[]>([]);
  const supportsSessionModes = settingsTarget.kind === 'local' || settingsTarget.routineSessionModes === true;
  const inFlight = useRef(false);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const { t, i18n } = useTranslation();
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [sources, setSources] = useState<RoutineSource[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<RoutineInput | null>(null);
  // 前置检查用脚本还是插件；插件只能在本机伙伴上选(插件装在各自的电脑上)。
  const [checkSource, setCheckSource] = useState<'script' | 'plugin'>('script');
  // 打开时脚本与插件都已配置(Agent 设的)：界面显示插件，保存时脚本原样保留。
  const [keepScript, setKeepScript] = useState(false);
  const [history, setHistory] = useState<RoutineRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [nightlyOpen, setNightlyOpen] = useState(false);
  // The nightly review is read and run on this computer; a remote teammate's lives on its own one.
  const nightlyLocal = settingsTarget.kind === 'local';
  const nightly = useNightlyLearningView(botId, nightlyLocal);
  useEffect(() => setNightlyOpen(false), [botId]);
  const refresh = useCallback(async () => {
    const [items, available] = await Promise.all([
      routinesApi.list(botId),
      routinesApi.sources(),
    ]);
    setRoutines(items);
    setSources(available);
  }, [botId]);
  useEffect(() => {
    let alive = true;
    let request = 0;
    const load = () => {
      const current = ++request;
      void Promise.all([
        routinesApi.list(botId),
        routinesApi.sources(),
      ])
        .then(([items, available]) => {
          if (alive && current === request) {
            setRoutines(items);
            setSources(available);
            setError(false);
            setLoading(false);
          }
        })
        .catch(() => {
          if (alive && current === request) {
            setError(true);
            setLoading(false);
          }
        });
    };
    setLoading(true);
    load();
    const unsubscribe = routinesApi.onChanged(load);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [botId, reload]);
  useEffect(() => {
    let alive = true;
    if (!selected || selected === 'new') {
      setHistory([]);
      return;
    }
    const load = () => {
      void routinesApi
        .history(botId, selected)
        .then((runs) => {
          if (alive) setHistory(runs);
        })
        .catch(() => {
          if (alive) setError(true);
        });
    };
    load();
    const unsubscribe = routinesApi.onChanged(load);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [botId, selected, reload]);
  useEffect(() => {
    let alive = true;
    if (!draft || !supportsDelivery) return;
    void routinesApi.deliveryTargets?.(botId).then(targets => {
      if (alive) setDeliveryTargets(targets);
    }).catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, [botId, selected, supportsDelivery, routinesApi]);
  const localTarget = settingsTarget.kind === 'local';
  useEffect(() => {
    setCheckSource(draft?.preRunPlugin ? 'plugin' : 'script');
    setKeepScript(!!draft?.preRunPlugin && !!draft?.preRunHook?.command);
    // 只在切换编辑对象时按已保存内容重置。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);
  const pluginCheck = localTarget && checkSource === 'plugin';
  const missingCheckPlugin = pluginCheck && !draft?.preRunPlugin?.pluginId;
  /** 保存时只保留选中的检查方式；远程伙伴不改插件设置(省略 = 保留)。 */
  const draftForSave = (value: RoutineInput): RoutineInput => {
    if (!localTarget) return value;
    if (pluginCheck) return keepScript ? value : { ...value, preRunHook: null };
    return { ...value, preRunPlugin: null };
  };
  const editable = (value: RoutineInput) =>
    JSON.stringify({
      name: value.name,
      prompt: value.prompt,
      enabled: value.enabled,
      triggers: value.triggers,
      silentWhenIdle: value.silentWhenIdle ?? true,
      preRunHook: value.preRunHook ?? null,
      preRunPlugin: value.preRunPlugin ?? null,
      modelOverride: value.modelOverride ?? null,
      sessionMode: value.sessionMode ?? 'persistent',
      delivery: value.delivery ?? { kind: 'companion', mode: 'direct' },
    });
  const saved = routines.find((item) => item.id === selected);
  const missingRecipient = draft?.delivery?.kind === 'im' && !draft.delivery.targetId;
  const dirty =
    draft !== null &&
    (saved
      ? editable(draft) !== editable(saved)
      : Boolean(draft.name || draft.prompt || draft.triggers.length));
  const canLeave = useCallback(async () => {
    if (inFlight.current) return false;
    if (!dirty) return true;
    return confirm({
      presentation: 'standard',
      title: t('routines.unsavedTitle'),
      description: t('routines.unsavedDescription'),
      confirmText: t('routines.discard'),
      cancelText: t('routines.continueEditing'),
    });
  }, [dirty, confirm, t]);
  useEffect(() => {
    if (!beforeLeaveRef) return;
    beforeLeaveRef.current = canLeave;
    return () => {
      beforeLeaveRef.current = null;
    };
  }, [beforeLeaveRef, canLeave]);
  const closeDraft = useCallback(async () => {
    if (!(await canLeave())) return;
    setDraft(null);
    setSelected(null);
    setDeletePending(false);
  }, [canLeave]);
  useEffect(() => {
    if (!backRef) return;
    backRef.current = async () => {
      if (nightlyOpen) {
        setNightlyOpen(false);
        return true;
      }
      if (!draft) return false;
      if (!inFlight.current) await closeDraft();
      return true;
    };
    return () => {
      backRef.current = null;
    };
  }, [backRef, draft, closeDraft, nightlyOpen]);
  const editorRef = useRef<HTMLFieldSetElement>(null);
  // A number field the user left invalid is not silently replaced by the old
  // value on save: point at it instead.
  const revealInvalidField = () => {
    const field = editorRef.current?.querySelector<HTMLInputElement>('input[aria-invalid="true"]');
    if (!field) return false;
    field.closest('details')?.setAttribute('open', '');
    field.focus();
    return true;
  };
  const act = async (action: () => Promise<unknown>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(false);
    try {
      await action();
      await refresh();
    } catch {
      setError(true);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const add = (trigger: RoutineTrigger) =>
    setDraft((value) =>
      value && !inFlight.current ? { ...value, triggers: [...value.triggers, trigger] } : value,
    );
  const triggerSummary = (trigger: RoutineTrigger) => {
    if (trigger.kind === 'once') return new Date(trigger.at).toLocaleString(i18n.language);
    if (trigger.kind === 'interval')
      return t('routines.everyMinutes', { count: trigger.intervalMs / 60_000 });
    if (trigger.kind === 'cron')
      return `${cronToHuman(trigger.expression, t, i18n.language)} · ${trigger.timezone}`;
    const source = sources.find((item) => item.id === trigger.sourceId);
    const event = source?.events.find((item) => item.type === trigger.eventType);
    return t('routines.onEvent', { source: source?.name ?? trigger.sourceId, event: event?.name ?? trigger.eventType });
  };
  const running = history.some((run) => run.status === 'running' || run.status === 'queued');
  if (nightlyOpen && !draft) {
    return (
      <section className={embedded ? 'py-3 text-13 text-[var(--text-primary)]' : 'app-wallpaper-surface h-full overflow-y-auto bg-[var(--surface)] p-4 text-13 text-[var(--text-primary)]'}>
        {!backRef ? (
          <div className="mb-5">
            <Button variant="secondary" onClick={() => setNightlyOpen(false)}>{t('routines.back')}</Button>
          </div>
        ) : null}
        <h3 className="mb-3 text-14 font-medium text-[var(--text-primary)]">{t('routines.builtinNightlyLearning.title')}</h3>
        <BotNightlyLearning botId={botId} />
      </section>
    );
  }
  return (
    <section
      className={
        embedded
          ? 'py-3 text-13 text-[var(--text-primary)]'
          : 'app-wallpaper-surface h-full overflow-y-auto bg-[var(--surface)] p-4 text-13 text-[var(--text-primary)]'
      }
    >
      {!draft || !backRef ? (
        <div className="mb-5 flex items-center justify-between gap-2">
          {draft ? (
            <Button variant="secondary" disabled={busy} onClick={() => void closeDraft()}>
              {t('routines.back')}
            </Button>
          ) : embedded ? (
            <span />
          ) : (
            <h2 className="font-medium">{t('routines.title')}</h2>
          )}
          {!draft && (
            <Button
              variant="secondary"
              onClick={() => {
                setSelected('new');
                setDraft({ name: '', prompt: '', enabled: true, triggers: [], silentWhenIdle: false, sessionMode: 'persistent' });
              }}
            >
              <Plus size={14} />
              {t('routines.add')}
            </Button>
          )}
        </div>
      ) : null}
      {error && (
        <div role="alert" className="mb-4 text-[var(--text-danger)]">
          <p>{t('routines.error')}</p>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              setError(false);
              setReload((n) => n + 1);
            }}
          >
            {t('bots.retry')}
          </Button>
        </div>
      )}
      {!draft && header ? <div className="mb-5">{header}</div> : null}
      {!draft ? (
        <div className="space-y-2">
          {loading ? <Spinner size={18} /> : null}
          {!loading && !error && !routines.length && (
            <p className="text-[var(--text-secondary)]">{t('routines.empty')}</p>
          )}
          {routines.map((routine) => routine.builtin ? (
            <BuiltinRoutineRow
              key={routine.id}
              routine={routine}
              disabled={busy || skillOffFor(routine) !== null}
              onOpen={supportsModels && routine.builtin !== 'nightly-learning' ? () => {
                setSelected(routine.id);
                setDraft(structuredClone(routine));
              } : undefined}
              hint={skillOffHint(routine)
                ?? (routine.builtin === 'nightly-learning' && nightly.view?.frequency === 'weekly'
                  ? t('routines.builtinNightlyLearning.hintWeekly') : undefined)}
              extra={routine.builtin === 'nightly-learning' && nightlyLocal
                ? <NightlyLearningStatus routine={routine} view={nightly.view} onOpen={() => setNightlyOpen(true)} />
                : null}
              onEnabledChange={(enabled) =>
                void act(() => routinesApi.save(botId, routineInput({ ...routine, enabled }), routine.id))
              }
            />
          ) : (
            <div key={routine.id} className="border-b border-[var(--border-default)] py-4 last:border-b-0">
              <div className="flex items-start gap-3">
                <button
                  type="button"
                  className="min-h-6 min-w-0 flex-1 rounded-lg text-left outline-none hover:text-[var(--text-secondary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                  onClick={() => {
                    setSelected(routine.id);
                    setDraft(structuredClone(routine));
                  }}
                >
                  <span className="flex items-start gap-2 text-13 font-medium leading-5">
                    <span className="min-w-0 break-words">{routine.name}</span>
                    <ChevronRight size={14} className="mt-1 shrink-0" aria-hidden="true" />
                  </span>
                </button>
                <Switch
                  aria-label={routine.name}
                  className="mt-0.5 shrink-0"
                  checked={routine.enabled}
                  disabled={busy || skillOffFor(routine) !== null}
                  onCheckedChange={(enabled) => void act(() =>
                    // 每天查待办与近况开关走同一个入口，切换后近况跟着刷新。
                    // 远程伙伴没有这个入口，按普通例行任务在伙伴所在的电脑上切换。
                    routine.id.startsWith(TODO_CHECK_ROUTINE_PREFIX) && settingsTarget.kind === 'local'
                      ? window.electronAPI.localDb.bots.todos.dailyCheck(botId, enabled)
                      : routinesApi.save(botId, routineInput({ ...routine, enabled }), routine.id),
                  )}
                />
              </div>
              <RoutineState routine={routine} />
              <RoutineSchedule summaries={routine.triggers.map(triggerSummary)} />
              {skillOffHint(routine) ? <p className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">{skillOffHint(routine)}</p> : null}
            </div>
          ))}
        </div>
      ) : null}
      {draft ? (
        <fieldset ref={editorRef} disabled={busy} className="min-w-0 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="flex items-center gap-2">
              <Switch
                aria-label={t('routines.enabled')} checked={draft.enabled}
                onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
              />
              {t(draft.enabled ? 'routines.enabled' : 'routines.paused')}
            </label>
            {selected !== 'new' && (
              <Button
                variant="secondary"
                disabled={
                  busy ||
                  running ||
                  missingRecipient ||
                  missingCheckPlugin ||
                  !draft.name.trim() ||
                  !draft.prompt.trim() ||
                  !draft.triggers.length
                }
                onClick={() => {
                  if (revealInvalidField()) return;
                  void act(async () => {
                    const saved = await routinesApi.save(botId, draftForSave(draft), selected!);
                    setDraft(structuredClone(saved));
                    await routinesApi.runNow(botId, saved.id);
                  });
                }}
              >
                {t(running ? 'routines.running' : 'routines.runNow')}
              </Button>
            )}
          </div>
          <label className="block space-y-2">
            <span className="text-[var(--text-secondary)]">{t('routines.name')}</span>
            <Input
              disabled={!!saved?.builtin}
              autoFocus={selected === 'new'}
              value={draft.name}
              onChange={(name) => setDraft({ ...draft, name })}
            />
          </label>
          <label className="block space-y-2">
            <span className="text-[var(--text-secondary)]">{t('routines.instructions')}</span>
            <Textarea
              disabled={!!saved?.builtin}
              rows={8}
              value={draft.prompt}
              onChange={(prompt) => setDraft({ ...draft, prompt })}
            />
          </label>
          {supportsModels && <BotTaskModelEditor inheritedRoute={primaryRoute} inheritanceHint={t('bots.model.inheritPrimary')}
            value={draft.modelOverride ? {
              harness: draft.modelOverride.agentKind === 'claude-code' ? 'claude' : draft.modelOverride.agentKind,
              model: draft.modelOverride.model, providerId: draft.modelOverride.providerId ?? null,
              effort: draft.modelOverride.effort ?? '', fastMode: draft.modelOverride.fastMode ?? false,
              agentDeviceId: draft.modelOverride.agentDeviceId ?? null,
            } : null}
            disabled={busy} deviceId={settingsTarget.deviceId}
            onChange={(route) => setDraft({ ...draft, modelOverride: route ? {
              agentKind: route.harness === 'claude' ? 'claude-code' : route.harness,
              model: route.model, providerId: route.providerId, effort: route.effort,
              fastMode: route.fastMode, agentDeviceId: route.agentDeviceId ?? null,
            } : null })}
          />}
          {supportsSessionModes && <div className="space-y-2">
            <span aria-hidden className={fieldLabelClass}>{t('routines.sessionMode')}</span>
            <Select
              label={t('routines.sessionMode')}
              className="w-full"
              disabled={busy || saved?.builtin === 'nightly-learning'}
              value={draft.sessionMode ?? 'persistent'}
              options={[
                { value: 'persistent', label: t('routines.sessionModePersistent') },
                { value: 'fresh', label: t('routines.sessionModeFresh') },
              ]}
              onValueChange={(value) => setDraft({ ...draft, sessionMode: value as 'persistent' | 'fresh' })}
              aria-describedby="routine-session-mode-hint"
            />
            <p id="routine-session-mode-hint" className="text-12 text-[var(--text-secondary)]">{t('routines.sessionModeHint')}</p>
          </div>}
          {supportsDelivery && !saved?.builtin && <div className="space-y-2">
            <span aria-hidden className={fieldLabelClass}>{t('routines.deliveryLabel')}</span>
            <Select label={t('routines.deliveryLabel')} className="w-full" disabled={busy}
              value={draft.delivery?.kind === 'im' ? 'im' : draft.delivery?.kind === 'none' ? 'none' : draft.delivery?.mode ?? 'direct'}
              options={[
                { value: 'direct', label: t('routines.deliveryDirect') },
                { value: 'process', label: t('routines.deliveryProcess') },
                { value: 'im', label: t('routines.deliveryIm') },
                { value: 'none', label: t('routines.deliveryNone') },
              ]}
              onValueChange={(value) => setDraft({ ...draft, delivery: value === 'im'
                ? { kind: 'im', targetId: deliveryTargets[0]?.id ?? '' }
                : value === 'none' ? { kind: 'none' } : { kind: 'companion', mode: value as 'direct' | 'process' } })}
            />
            <p className="text-12 text-[var(--text-secondary)]">{t('routines.deliveryHint')}</p>
            {draft.delivery?.kind === 'im' && <>
              <Select label={t('routines.deliveryRecipient')} className="w-full" disabled={busy}
                value={draft.delivery.targetId} options={[
                  ...(!deliveryTargets.some(target => target.id === (draft.delivery?.kind === 'im' ? draft.delivery.targetId : ''))
                    ? [{ value: draft.delivery.targetId, label: t('routines.deliveryUnavailable') }] : []),
                  ...deliveryTargets.map(target => ({ value: target.id, label: `${target.name} · ${target.recipient}` })),
                ]}
                onValueChange={(targetId) => setDraft({ ...draft, delivery: { kind: 'im', targetId } })}
              />
              {!deliveryTargets.length && <p className="text-12 text-[var(--text-secondary)]">{t('routines.deliveryNoRecipients')}</p>}
            </>}
          </div>}
          <fieldset disabled={!!saved?.builtin} className="min-w-0 space-y-5">
          <details className="space-y-3">
            <summary className="min-h-8 cursor-pointer rounded-full py-2 focus-visible:outline focus-visible:outline-[var(--focus-ring)]">{t('routines.advancedSettings')}</summary>
            <label className="flex min-h-8 items-center gap-2">
              <Switch aria-label={t('routines.quiet')} checked={draft.silentWhenIdle ?? true} onCheckedChange={(silentWhenIdle) => setDraft({ ...draft, silentWhenIdle })} />
              {t('routines.quiet')}
            </label>
            <p className="text-12 text-[var(--text-secondary)]">{t('routines.quietHint')}</p>
            {localTarget && (
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="text-[var(--text-secondary)]">{t('routines.checkSource')}</span>
                <SegmentedControl
                  aria-label={t('routines.checkSource')}
                  value={checkSource}
                  height={32}
                  options={(['script', 'plugin'] as const).map((source) => ({
                    value: source,
                    label: t(`scheduler.editor.preRunPlugin.source.${source}`),
                  }))}
                  onValueChange={setCheckSource}
                />
              </div>
            )}
            {pluginCheck ? (
              <PreRunPluginFields
                point="will-routine-run"
                pluginId={draft.preRunPlugin?.pluginId ?? ''}
                onFailure={draft.preRunPlugin?.onFailure ?? GHOST_CONTROL_POINTS['will-routine-run'].defaultOnFailure}
                onPluginChange={(pluginId) => setDraft((value) => value && ({ ...value, preRunPlugin: {
                  pluginId, onFailure: value.preRunPlugin?.onFailure ?? GHOST_CONTROL_POINTS['will-routine-run'].defaultOnFailure,
                } }))}
                onFailureChange={(onFailure) => setDraft((value) => value && ({ ...value, preRunPlugin: {
                  pluginId: value.preRunPlugin?.pluginId ?? '', onFailure,
                } }))}
              />
            ) : (
              <>
                <label className="block space-y-2">
                  <span className="text-[var(--text-secondary)]">{t('routines.checkCommand')}</span>
                  <Textarea rows={3} value={draft.preRunHook?.command ?? ''} onChange={(command) => setDraft({ ...draft, preRunHook: command ? { ...draft.preRunHook, command } : null })} />
                </label>
                <p className="text-12 text-[var(--text-secondary)]">{t('routines.checkHint')}</p>
                {draft.preRunHook && <label className="block space-y-2">
                  <span className="text-[var(--text-secondary)]">{t('routines.timeoutMs')}</span>
                  <IntegerInput optional min={1} value={draft.preRunHook.timeoutMs} onChange={(timeoutMs) => setDraft({ ...draft, preRunHook: { ...draft.preRunHook!, timeoutMs } })} />
                </label>}
              </>
            )}
          </details>
          <div className="space-y-2">
            <h3 className="text-[var(--text-secondary)]">{t('routines.when')}</h3>
            <div className="space-y-3 rounded-xl border border-[var(--border-default)] p-3">
              {draft.triggers.map((trigger, index) => (
                <details key={trigger.id} className="min-w-0">
                  <summary className="cursor-pointer break-words py-1">
                    {triggerSummary(trigger)}
                  </summary>
                  <TriggerFields
                    trigger={trigger}
                    sources={sources}
                    onChange={(updated) =>
                      setDraft({
                        ...draft,
                        triggers: draft.triggers.map((item, i) => (i === index ? updated : item)),
                      })
                    }
                  />
                  <Button
                    variant="secondary"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        triggers: draft.triggers.filter((item) => item.id !== trigger.id),
                      })
                    }
                  >
                    {t('routines.removeTrigger')}
                  </Button>
                </details>
              ))}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="secondary">
                    <Plus size={14} />
                    {t('routines.addTrigger')}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className={menuClass} align="start">
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <Clock3 size={15} className="mr-2" />
                      {t('routines.schedule')}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className={menuClass}>
                      {(
                        [
                          'hourly',
                          'daily',
                          'weekdays',
                          'weekly',
                          'monthly',
                          'interval',
                          'advanced',
                        ] as const
                      ).map((preset) => (
                        <DropdownMenuItem
                          key={preset}
                          onSelect={() => {
                            const id = crypto.randomUUID();
                            if (preset === 'interval')
                              add({ id, kind: 'interval', intervalMs: 3600_000 });
                            else
                              add({
                                id,
                                kind: 'cron',
                                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                                expression: {
                                  hourly: '0 * * * *',
                                  daily: '0 9 * * *',
                                  weekdays: '0 9 * * 1-5',
                                  weekly: '0 9 * * 1',
                                  monthly: '0 9 1 * *',
                                  advanced: '0 * * * *',
                                }[preset],
                              });
                          }}
                        >
                          {t(`routines.${preset}`)}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  {sources.map((source) => (
                    <DropdownMenuSub key={source.id}>
                      <DropdownMenuSubTrigger>
                        {source.name}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className={menuClass}>
                        {source.events.map((event) => (
                          <DropdownMenuItem
                            key={event.type}
                            onSelect={() =>
                              add({
                                id: crypto.randomUUID(),
                                kind: 'event',
                                sourceId: source.id,
                                eventType: event.type,
                                filters: [],
                              })
                            }
                          >
                            {event.name}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          </fieldset>
          <div className="flex flex-wrap justify-end gap-2">
            {selected !== 'new' && !saved?.builtin && (
              <Button variant="secondary" disabled={busy} onClick={() => setDeletePending(true)}>
                {t('routines.delete')}
              </Button>
            )}
            <Button
              variant="cta"
              disabled={
                busy || missingRecipient || missingCheckPlugin || !draft.name.trim() || !draft.prompt.trim() || !draft.triggers.length
              }
              onClick={() => {
                if (revealInvalidField()) return;
                void act(async () => {
                  const saved = await routinesApi.save(
                    botId,
                    draftForSave(draft),
                    selected === 'new' ? undefined : selected!,
                  );
                  setSelected(saved.id);
                  setDraft(saved);
                  toast.success(t('routines.saved'));
                });
              }}
            >
              {t('routines.save')}
            </Button>
          </div>
          {deletePending && (
            <div className="space-y-2 rounded-xl border border-[var(--border-default)] p-3">
              <p>{t('routines.deleteConfirm')}</p>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => setDeletePending(false)}>
                  {t('routines.keep')}
                </Button>
                <Button
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await routinesApi.remove(botId, selected!);
                      setDraft(null);
                      setSelected(null);
                      setDeletePending(false);
                    })
                  }
                >
                  {t('routines.delete')}
                </Button>
              </div>
            </div>
          )}
          <div>
            <h3 className="mb-3 text-[var(--text-secondary)]">{t('routines.history')}</h3>
            {!history.length && (
              <p className="text-[var(--text-tertiary)]">{t('routines.noRuns')}</p>
            )}
            {history.map((run) => (
              <details key={run.id} className="py-2">
                <summary className="flex cursor-pointer items-center justify-between gap-2">
                  <time dateTime={new Date(run.createdAt).toISOString()}>
                    {new Date(run.createdAt).toLocaleString(i18n.language)}
                  </time>
                  <span className={`inline-flex shrink-0 items-center gap-2 ${run.delivery?.status === 'failed' || run.status === 'failed' || run.status === 'interrupted' ? 'text-[var(--text-danger)]' : 'text-[var(--text-secondary)]'}`}>
                    {run.status === 'running' || run.status === 'queued' ? (
                      <Spinner size={15} />
                    ) : run.delivery?.status === 'failed' ? (
                      <CircleAlert size={15} />
                    ) : run.status === 'success' || run.status === 'skipped' ? (
                      <Check size={15} />
                    ) : run.status === 'failed' || run.status === 'interrupted' ? (
                      <CircleAlert size={15} />
                    ) : (
                      <Pause size={15} />
                    )}
                    {run.delivery?.status === 'failed' ? t('routines.deliveryFailed') : t(`routines.status.${run.status}`)}
                  </span>
                </summary>
                {run.sessionId && <Button variant="secondary" size="sm" onClick={() => navigate(standardSessionRoute(run.sessionId!, settingsTarget.deviceId))}>
                  {t('routines.openTask')}
                </Button>}
                {run.resultText && (
                  <p className="whitespace-pre-wrap break-words text-[var(--text-secondary)]">
                    {run.resultText}
                  </p>
                )}
                {run.delivery?.status === 'failed' && <p className="break-words text-[var(--text-danger)]">{t('routines.deliveryFailedHint')}</p>}
                {run.delivery?.status === 'delivered' && <p className="text-12 text-[var(--text-secondary)]">{t('routines.deliveryDelivered')}</p>}
                {run.error && <p className="break-words text-[var(--text-danger)]">{run.error}</p>}
                {run.events.map(({ sourceId, event }) => (
                  <p
                    key={`${sourceId}:${event.id}`}
                    className="break-words text-12 text-[var(--text-secondary)]"
                  >
                    {sourceId} · {event.type} · {event.subject ?? event.id}
                  </p>
                ))}
              </details>
            ))}
          </div>
        </fieldset>
      ) : null}
    </section>
  );
}

function TriggerFields({
  trigger,
  sources,
  onChange,
}: {
  trigger: RoutineTrigger;
  sources: RoutineSource[];
  onChange(trigger: RoutineTrigger): void;
}) {
  const { t } = useTranslation();
  if (trigger.kind === 'interval')
    return (
      <label className={`${fieldClass} py-2`}>
        <span className={fieldLabelClass}>{t('routines.minutes')}</span>
        <IntegerInput
          min={1}
          value={trigger.intervalMs / 60_000}
          onChange={(minutes) => {
            if (minutes !== undefined) onChange({ ...trigger, intervalMs: minutes * 60_000 });
          }}
        />
      </label>
    );
  if (trigger.kind === 'once') return <time dateTime={new Date(trigger.at).toISOString()}>{new Date(trigger.at).toLocaleString()}</time>;
  if (trigger.kind === 'cron') return <CronFields trigger={trigger} onChange={onChange} />;
  const source = sources.find((item) => item.id === trigger.sourceId);
  const fields = [
    'subject',
    ...(source?.events.find((item) => item.type === trigger.eventType)?.fields ?? []),
  ];
  const selectClass =
    'w-full rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-2 text-12';
  return (
    <div className="space-y-2 py-2">
      <p className="text-12 text-[var(--text-secondary)]">
        {t(`routines.sourceStatus.${source?.status ?? 'disconnected'}`)}
        {source?.lastEventAt ? ` · ${new Date(source.lastEventAt).toLocaleString()}` : ''}
      </p>
      {trigger.filters.map((filter, index) => (
        <div key={index} className="space-y-2 rounded-xl border border-[var(--border-default)] p-2">
          <select
            aria-label={t('routines.field')}
            className={selectClass}
            value={filter.field}
            onChange={(event) =>
              onChange({
                ...trigger,
                filters: trigger.filters.map((item, i) =>
                  i === index ? { ...item, field: event.target.value } : item,
                ),
              })
            }
          >
            {[...new Set([...fields, filter.field])].map((field) => (
              <option key={field}>{field}</option>
            ))}
          </select>
          <select
            aria-label={t('routines.operator')}
            className={selectClass}
            value={filter.operator}
            onChange={(event) =>
              onChange({
                ...trigger,
                filters: trigger.filters.map((item, i) =>
                  i === index
                    ? { ...item, operator: event.target.value as typeof filter.operator }
                    : item,
                ),
              })
            }
          >
            {['equals', 'contains', 'not-equals'].map((operator) => (
              <option key={operator} value={operator}>
                {t(`routines.operators.${operator}`)}
              </option>
            ))}
          </select>
          <Input
            aria-label={t('routines.value')}
            value={filter.value}
            onChange={(value) =>
              onChange({
                ...trigger,
                filters: trigger.filters.map((item, i) =>
                  i === index ? { ...item, value } : item,
                ),
              })
            }
          />
          <Button
            variant="secondary"
            onClick={() =>
              onChange({ ...trigger, filters: trigger.filters.filter((_, i) => i !== index) })
            }
          >
            {t('routines.removeFilter')}
          </Button>
        </div>
      ))}
      <Button
        variant="secondary"
        onClick={() =>
          onChange({
            ...trigger,
            filters: [...trigger.filters, { field: fields[0], operator: 'equals', value: '' }],
          })
        }
      >
        {t('routines.addFilter')}
      </Button>
    </div>
  );
}

function CronFields({
  trigger,
  onChange,
}: {
  trigger: Extract<RoutineTrigger, { kind: 'cron' }>;
  onChange(trigger: RoutineTrigger): void;
}) {
  const { t, i18n } = useTranslation();
  const config = cronToConfig(trigger.expression);
  const [advanced, setAdvanced] = useState(
    !['hourly', 'daily', 'weekdays', 'weekly', 'monthly'].includes(config.mode),
  );
  const patch = (values: Partial<typeof config>) =>
    onChange({ ...trigger, expression: configToCron({ ...config, ...values }) });
  return (
    <div className="space-y-3 py-2">
      <label className={fieldClass}>
        <span className={fieldLabelClass}>{t('routines.schedule')}</span>
        <select
          className="w-full rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-2"
          value={advanced ? 'custom' : config.mode}
          onChange={(event) => {
            const mode = event.target.value as typeof config.mode;
            setAdvanced(mode === 'custom');
            if (mode !== 'custom') patch({ mode });
          }}
        >
          {['hourly', 'daily', 'weekdays', 'weekly', 'monthly', 'custom'].map((mode) => (
            <option key={mode} value={mode}>
              {t(`routines.${mode === 'custom' ? 'advanced' : mode}`)}
            </option>
          ))}
        </select>
      </label>
      {advanced ? (
        <label className={fieldClass}>
          <span className={fieldLabelClass}>{t('routines.expression')}</span>
          <Input
            value={trigger.expression}
            onChange={(expression) => onChange({ ...trigger, expression })}
          />
        </label>
      ) : (
        <>
          {config.mode !== 'hourly' && (
            <label className={fieldClass}>
              <span className={fieldLabelClass}>{t('routines.time')}</span>
              <Input
                type="time"
                value={`${String(config.hour).padStart(2, '0')}:${String(config.minute).padStart(2, '0')}`}
                onChange={(value) => {
                  // A cleared segment reports ''; keep the last complete time.
                  const match = /^(\d{2}):(\d{2})/.exec(value);
                  if (match) patch({ hour: Number(match[1]), minute: Number(match[2]) });
                }}
              />
            </label>
          )}
          {config.mode === 'weekly' && (
            <label className={fieldClass}>
              <span className={fieldLabelClass}>{t('routines.weekday')}</span>
              <select
                className="w-full rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-2"
                value={config.weekday}
                onChange={(event) => patch({ weekday: Number(event.target.value) })}
              >
                {Array.from({ length: 7 }, (_, day) => (
                  <option value={day} key={day}>
                    {new Intl.DateTimeFormat(i18n.language, {
                      weekday: 'long',
                      timeZone: 'UTC',
                    }).format(new Date(Date.UTC(2024, 0, 7 + day)))}
                  </option>
                ))}
              </select>
            </label>
          )}
          {config.mode === 'monthly' && (
            <label className={fieldClass}>
              <span className={fieldLabelClass}>{t('routines.day')}</span>
              <IntegerInput
                min={1}
                max={31}
                value={config.monthDay}
                onChange={(monthDay) => {
                  if (monthDay !== undefined) patch({ monthDay });
                }}
              />
            </label>
          )}
        </>
      )}
      <label className={fieldClass}>
        <span className={fieldLabelClass}>{t('routines.timezone')}</span>
        <Input
          value={trigger.timezone}
          onChange={(timezone) => onChange({ ...trigger, timezone })}
        />
      </label>
    </div>
  );
}

/**
 * Whole-number field that keeps what the user is typing: an emptied or
 * out-of-range entry is not committed (optional fields commit `undefined` when
 * emptied) and stays marked invalid until corrected.
 */
function IntegerInput({
  value,
  min,
  max,
  optional = false,
  onChange,
}: {
  value: number | undefined;
  min: number;
  max?: number;
  optional?: boolean;
  onChange(value: number | undefined): void;
}) {
  const format = (next: number | undefined) => (next === undefined ? '' : String(next));
  const [text, setText] = useState(() => format(value));
  const [shown, setShown] = useState(value);
  if (!Object.is(shown, value)) {
    setShown(value);
    setText(format(value));
  }
  const parse = (raw: string): number | undefined | null => {
    const trimmed = raw.trim();
    if (!trimmed) return optional ? undefined : null;
    if (!/^\d+$/.test(trimmed)) return null;
    const next = Number(trimmed);
    return next >= min && (max === undefined || next <= max) ? next : null;
  };
  return (
    <Input
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      value={text}
      // The saved value itself is never flagged (routines written elsewhere may hold other values).
      error={text !== format(value) && parse(text) === null}
      onChange={(raw) => {
        setText(raw);
        const next = parse(raw);
        if (next !== null) onChange(next);
      }}
    />
  );
}

function routineInput(routine: Routine): RoutineInput {
  return {
    name: routine.name,
    prompt: routine.prompt,
    enabled: routine.enabled,
    triggers: routine.triggers,
    ...(routine.silentWhenIdle !== undefined ? { silentWhenIdle: routine.silentWhenIdle } : {}),
    ...(routine.preRunHook !== undefined ? { preRunHook: routine.preRunHook } : {}),
    ...(routine.preRunPlugin !== undefined ? { preRunPlugin: routine.preRunPlugin } : {}),
    ...(routine.modelOverride !== undefined ? { modelOverride: routine.modelOverride } : {}),
    ...(routine.delivery !== undefined ? { delivery: routine.delivery } : {}),
    ...(routine.sessionMode !== undefined ? { sessionMode: routine.sessionMode } : {}),
  };
}

/**
 * 宿主内置规则保留指令与触发条件；普通 Agent 规则允许暂停或单独配置模型。
 */
/** 内置例行任务（跟进、夜间学习）的文案键；名称与说明随界面语言，不用宿主存的名字。 */
const BUILTIN_COPY: Record<string, string | undefined> = {
  'follow-up': 'routines.builtinFollowUp',
  'nightly-learning': 'routines.builtinNightlyLearning',
};

/** 夜间学习行下方的两行状态（待整理、上次结果）与进入学习记录的入口。 */
function NightlyLearningStatus({
  routine,
  view,
  onOpen,
}: {
  routine: Routine;
  view: NightlyLearningView | null;
  onOpen: () => void;
}) {
  const { t, i18n } = useTranslation();
  const last = view?.lastRun ?? null;
  const when = (at: number) => new Intl.DateTimeFormat(i18n.language, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(at);
  const lastText = !last
    ? t('routines.nightly.lastNever')
    : `${when(last.at)} · ${last.outcome === 'failed'
      ? t('routines.nightly.lastFailed')
      : last.items.length
        ? t('routines.nightly.lastLearned', { count: last.items.length })
        : t('routines.nightly.nothing')}`;
  return (
    <>
      {view ? (
        <span className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-12 leading-[1.5] text-[var(--text-secondary)]">
          {!routine.enabled ? (
            <span className="col-span-2">{t('routines.nightly.paused')}</span>
          ) : view.running ? (
            <span className="col-span-2">{t('routines.nightly.running')}</span>
          ) : (
            <>
              {!view.memoryEnabled ? <span className="col-span-2">{t('routines.nightly.memoryOff')}</span> : null}
              <span className="text-[var(--text-tertiary)]">{t('routines.nightly.pending')}</span>
              <span className="tabular-nums">
                {view.pendingTurns > 0 ? t('routines.nightly.pendingTurns', { count: view.pendingTurns }) : t('routines.nightly.pendingNone')}
              </span>
              <span className="text-[var(--text-tertiary)]">{t('routines.nightly.last')}</span>
              <span className="tabular-nums">{lastText}</span>
            </>
          )}
        </span>
      ) : null}
      <button
        type="button"
        className="-ml-1.5 mt-1.5 inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-12 leading-[1.5] text-[var(--text-secondary)] outline-none transition-colors duration-[var(--motion-instant)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        onClick={onOpen}
      >
        {t('routines.nightly.viewHistory')}
        <ChevronRight size={14} aria-hidden="true" />
      </button>
    </>
  );
}

function BuiltinRoutineRow({
  routine,
  disabled,
  onEnabledChange,
  onOpen,
  hint,
  extra,
}: {
  routine: Routine;
  disabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onOpen?: () => void;
  hint?: string;
  extra?: ReactNode;
}) {
  const { t } = useTranslation();
  // 旧版电脑上的「每天查待办」仍是内置规则，远程查看时没有对应说明，只显示名称。
  const copy = BUILTIN_COPY[routine.builtin ?? 'follow-up'];
  const name = copy ? t(`${copy}.name`) : t('routines.todoCheck.name');
  return (
    <div className="flex w-full items-start gap-3 border-b border-[var(--border-default)] py-4 last:border-b-0">
      <div className="min-w-0 flex-1">
        {onOpen ? <button type="button" disabled={disabled} onClick={onOpen}
          className="flex min-h-6 items-start gap-2 rounded-lg text-left text-13 font-medium leading-5 outline-none hover:text-[var(--text-secondary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
          <span className="break-words">{name}</span><ChevronRight size={14} className="mt-1 shrink-0" aria-hidden="true" />
        </button> : <p className="break-words text-13 font-medium leading-5">{name}</p>}
        <RoutineState routine={routine} />
        {hint || copy ? <p className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">{hint ?? t(`${copy}.hint`)}</p> : null}
        {extra}
      </div>
      <Switch
        aria-label={name}
        className="mt-0.5 shrink-0"
        checked={routine.enabled}
        disabled={disabled}
        onCheckedChange={(enabled) => onEnabledChange(enabled === true)}
      />
    </div>
  );
}

/** Enabling a rule and a run being active are separate facts. */
function RoutineState({ routine }: { routine: Routine }) {
  const { t } = useTranslation();
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-2 text-12 leading-5 text-[var(--text-secondary)]">
      <span>{t(routine.enabled ? 'routines.enabled' : 'routines.paused')}</span>
      {routine.activity ? <span className="inline-flex items-center gap-1.5"><Spinner size={12} />{t(`routines.status.${routine.activity}`)}</span> : null}
    </p>
  );
}

function RoutineSchedule({ summaries }: { summaries: string[] }) {
  const { t } = useTranslation();
  if (!summaries.length) return <p className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">{t('routines.noTriggers')}</p>;
  if (summaries.length === 1 && summaries[0].length <= 90) {
    return <p className="mt-1 break-words text-12 leading-5 text-[var(--text-secondary)]">{summaries[0]}</p>;
  }
  return (
    <details className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">
      <summary className="min-h-6 cursor-pointer rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">{t('routines.triggerDetails', { count: summaries.length })}</summary>
      <ul className="mt-1 space-y-1">
        {summaries.map((text, index) => <li key={index} className="break-words">{text}</li>)}
      </ul>
    </details>
  );
}
