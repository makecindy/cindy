import { useCallback, useEffect, useRef, useState } from 'react';
import { Clock3, Check, CircleAlert, Pause, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cronToHuman } from '@/features/scheduler/lib/cronToHuman';
import { configToCron, cronToConfig } from '@/features/scheduler/lib/cronCodexPreset';
import type {
  Routine,
  RoutineInput,
  RoutineRun,
  RoutineSource,
  RoutineTrigger,
} from '@cindy/maker-scheduler';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Spinner } from '@/components/ui/spinner';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from '@/components/ui/dropdown-menu';

const menuClass = 'rounded-xl border-[var(--border-default)] bg-[var(--surface-elevated)] p-2';
const rowClass = 'rounded-lg text-13 text-[var(--text-primary)] focus:bg-[var(--surface-hover)]';
const fieldClass = 'block space-y-2';
const fieldLabelClass = 'block text-[var(--text-secondary)]';

/** A teammate's standing instructions and OR-combined triggers, shared by teammate settings and the task sidebar. */
export function BotRoutines({
  botId,
  beforeLeaveRef,
  backRef,
  embedded = false,
}: {
  embedded?: boolean;
  botId: string;
  beforeLeaveRef?: { current: (() => Promise<boolean>) | null };
  /** Host back button: steps from the editor to the list first (the inline back button is then omitted). */
  backRef?: { current: (() => Promise<boolean>) | null };
}) {
  const { confirm } = useConfirmDialog();
  const inFlight = useRef(false);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const { t, i18n } = useTranslation();
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [sources, setSources] = useState<RoutineSource[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<RoutineInput | null>(null);
  const [history, setHistory] = useState<RoutineRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const refresh = useCallback(async () => {
    const [items, available] = await Promise.all([
      window.electronAPI.routines.list(botId),
      window.electronAPI.routines.sources(),
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
        window.electronAPI.routines.list(botId),
        window.electronAPI.routines.sources(),
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
    const unsubscribe = window.electronAPI.routines.onChanged(load);
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
      void window.electronAPI.routines
        .history(botId, selected)
        .then((runs) => {
          if (alive) setHistory(runs);
        })
        .catch(() => {
          if (alive) setError(true);
        });
    };
    load();
    const unsubscribe = window.electronAPI.routines.onChanged(load);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [botId, selected, reload]);
  const editable = (value: RoutineInput) =>
    JSON.stringify({
      name: value.name,
      prompt: value.prompt,
      enabled: value.enabled,
      triggers: value.triggers,
      silentWhenIdle: value.silentWhenIdle ?? true,
      preRunHook: value.preRunHook ?? null,
    });
  const saved = routines.find((item) => item.id === selected);
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
      if (!draft) return false;
      if (!inFlight.current) await closeDraft();
      return true;
    };
    return () => {
      backRef.current = null;
    };
  }, [backRef, draft, closeDraft]);
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
    if (trigger.kind === 'interval')
      return t('routines.everyMinutes', { count: trigger.intervalMs / 60_000 });
    if (trigger.kind === 'cron')
      return `${trigger.expression === '0 * * * *' ? t('routines.hourly') : cronToHuman(trigger.expression, t, i18n.language)} · ${trigger.timezone}`;
    const source = sources.find((item) => item.id === trigger.sourceId);
    const event = source?.events.find((item) => item.type === trigger.eventType);
    return `${source?.name ?? trigger.sourceId} · ${event?.name ?? trigger.eventType}`;
  };
  const running = history.some((run) => run.status === 'running' || run.status === 'queued');
  return (
    <section
      className={
        embedded
          ? 'py-3 text-13 text-[var(--text-primary)]'
          : 'h-full overflow-y-auto bg-[var(--surface)] p-4 text-13 text-[var(--text-primary)]'
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
                setDraft({ name: '', prompt: '', enabled: true, triggers: [], silentWhenIdle: false });
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
      {!draft ? (
        <div className="space-y-2">
          {loading ? <Spinner size={18} /> : null}
          {!loading && !error && !routines.length && (
            <p className="text-[var(--text-secondary)]">{t('routines.empty')}</p>
          )}
          {routines.map((routine) => (
            <button
              key={routine.id}
              type="button"
              className="flex min-h-12 w-full items-start gap-3 rounded-lg px-3 py-3 text-left hover:bg-[var(--surface-hover)]"
              onClick={() => {
                setSelected(routine.id);
                setDraft(structuredClone(routine));
              }}
            >
              {routine.activity ? (
                <Spinner size={16} className="mt-1 shrink-0" />
              ) : routine.enabled ? (
                <Clock3 size={16} className="mt-1 shrink-0" />
              ) : (
                <Pause size={16} className="mt-1 shrink-0" />
              )}
              <span className="min-w-0">
                <span className="block truncate">{routine.name}</span>
                <span className="block truncate text-12 text-[var(--text-secondary)]">
                  {routine.triggers.map(triggerSummary).join(' · ')}
                </span>
              </span>
            </button>
          ))}
        </div>
      ) : (
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
                  !draft.name.trim() ||
                  !draft.prompt.trim() ||
                  !draft.triggers.length
                }
                onClick={() => {
                  if (revealInvalidField()) return;
                  void act(async () => {
                    const saved = await window.electronAPI.routines.save(botId, draft, selected!);
                    setDraft(structuredClone(saved));
                    await window.electronAPI.routines.runNow(botId, saved.id);
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
              autoFocus={selected === 'new'}
              value={draft.name}
              onChange={(name) => setDraft({ ...draft, name })}
            />
          </label>
          <label className="block space-y-2">
            <span className="text-[var(--text-secondary)]">{t('routines.instructions')}</span>
            <Textarea
              rows={8}
              value={draft.prompt}
              onChange={(prompt) => setDraft({ ...draft, prompt })}
            />
          </label>
          <details className="space-y-3">
            <summary className="min-h-8 cursor-pointer rounded-full py-2 focus-visible:outline focus-visible:outline-[var(--focus-ring)]">{t('routines.advancedSettings')}</summary>
            <label className="flex min-h-8 items-center gap-2">
              <Switch aria-label={t('routines.quiet')} checked={draft.silentWhenIdle ?? true} onCheckedChange={(silentWhenIdle) => setDraft({ ...draft, silentWhenIdle })} />
              {t('routines.quiet')}
            </label>
            <p className="text-12 text-[var(--text-secondary)]">{t('routines.quietHint')}</p>
            <label className="block space-y-2">
              <span className="text-[var(--text-secondary)]">{t('routines.checkCommand')}</span>
              <Textarea rows={3} value={draft.preRunHook?.command ?? ''} onChange={(command) => setDraft({ ...draft, preRunHook: command ? { ...draft.preRunHook, command } : null })} />
            </label>
            <p className="text-12 text-[var(--text-secondary)]">{t('routines.checkHint')}</p>
            {draft.preRunHook && <label className="block space-y-2">
              <span className="text-[var(--text-secondary)]">{t('routines.timeoutMs')}</span>
              <IntegerInput optional min={1} value={draft.preRunHook.timeoutMs} onChange={(timeoutMs) => setDraft({ ...draft, preRunHook: { ...draft.preRunHook!, timeoutMs } })} />
            </label>}
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
                <DropdownMenuContent
                  className={menuClass}
                  align="start"
                  style={{ boxShadow: 'none' }}
                >
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger className={rowClass}>
                      <Clock3 size={15} className="mr-2" />
                      {t('routines.schedule')}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className={menuClass} style={{ boxShadow: 'none' }}>
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
                          className={rowClass}
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
                      <DropdownMenuSubTrigger className={rowClass}>
                        {source.name}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className={menuClass} style={{ boxShadow: 'none' }}>
                        {source.events.map((event) => (
                          <DropdownMenuItem
                            key={event.type}
                            className={rowClass}
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
          <div className="flex flex-wrap justify-end gap-2">
            {selected !== 'new' && (
              <Button variant="secondary" disabled={busy} onClick={() => setDeletePending(true)}>
                {t('routines.delete')}
              </Button>
            )}
            <Button
              variant="cta"
              disabled={
                busy || !draft.name.trim() || !draft.prompt.trim() || !draft.triggers.length
              }
              onClick={() => {
                if (revealInvalidField()) return;
                void act(async () => {
                  const saved = await window.electronAPI.routines.save(
                    botId,
                    draft,
                    selected === 'new' ? undefined : selected!,
                  );
                  setSelected(saved.id);
                  setDraft(saved);
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
                      await window.electronAPI.routines.remove(botId, selected!);
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
                  <span aria-label={t(`routines.status.${run.status}`)}>
                    {run.status === 'running' || run.status === 'queued' ? (
                      <Spinner size={15} />
                    ) : run.status === 'success' || run.status === 'skipped' ? (
                      <Check size={15} />
                    ) : run.status === 'failed' || run.status === 'interrupted' ? (
                      <CircleAlert size={15} />
                    ) : (
                      <Pause size={15} />
                    )}
                  </span>
                </summary>
                <p className="mt-2 text-[var(--text-secondary)]">
                  {t(`routines.status.${run.status}`)}
                </p>
                {run.resultText && (
                  <p className="whitespace-pre-wrap break-words text-[var(--text-secondary)]">
                    {run.resultText}
                  </p>
                )}
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
      )}
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
