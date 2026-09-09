import { useCallback, useEffect, useState } from 'react';
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

/** A teammate's standing instructions and OR-combined triggers, hosted in the standard sidebar. */
export function BotRoutines({ botId }: { botId: string }) {
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
    const load = () => {
      void Promise.all([
        window.electronAPI.routines.list(botId),
        window.electronAPI.routines.sources(),
      ])
        .then(([items, available]) => {
          if (alive) {
            setRoutines(items);
            setSources(available);
          }
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
  }, [botId]);
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
  }, [botId, selected]);
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(false);
    try {
      await action();
      await refresh();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  const add = (trigger: RoutineTrigger) =>
    setDraft((value) => (value ? { ...value, triggers: [...value.triggers, trigger] } : value));
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
    <section className="h-full overflow-y-auto bg-[var(--surface)] p-4 text-13 text-[var(--text-primary)]">
      <div className="mb-5 flex items-center justify-between gap-2">
        {draft ? (
          <Button
            variant="secondary"
            onClick={() => {
              setDraft(null);
              setSelected(null);
              setDeletePending(false);
            }}
          >
            {t('routines.back')}
          </Button>
        ) : (
          <h2 className="font-medium">{t('routines.title')}</h2>
        )}
        {!draft && (
          <Button
            variant="secondary"
            onClick={() => {
              setSelected('new');
              setDraft({ name: '', prompt: '', enabled: true, triggers: [] });
            }}
          >
            <Plus size={14} />
            {t('routines.add')}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="mb-4 text-[var(--text-danger)]">
          {t('routines.error')}
        </p>
      )}
      {!draft ? (
        <div className="space-y-2">
          {!routines.length && (
            <p className="text-[var(--text-secondary)]">{t('routines.empty')}</p>
          )}
          {routines.map((routine) => (
            <button
              key={routine.id}
              type="button"
              className="flex w-full items-start gap-3 rounded-full px-3 py-2 text-left hover:bg-[var(--surface-hover)]"
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
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="flex items-center gap-2">
              <Switch
                checked={draft.enabled}
                onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
              />
              {t(draft.enabled ? 'routines.enabled' : 'routines.paused')}
            </label>
            {selected !== 'new' && (
              <Button
                variant="secondary"
                disabled={busy || running}
                onClick={() =>
                  void act(async () => {
                    const saved = await window.electronAPI.routines.save(botId, draft, selected!);
                    setDraft(structuredClone(saved));
                    await window.electronAPI.routines.runNow(botId, saved.id);
                  })
                }
              >
                {t(running ? 'routines.running' : 'routines.runNow')}
              </Button>
            )}
          </div>
          <label className="block space-y-2">
            <span className="text-[var(--text-secondary)]">{t('routines.name')}</span>
            <Input value={draft.name} onChange={(name) => setDraft({ ...draft, name })} />
          </label>
          <label className="block space-y-2">
            <span className="text-[var(--text-secondary)]">{t('routines.instructions')}</span>
            <Textarea
              rows={8}
              value={draft.prompt}
              onChange={(prompt) => setDraft({ ...draft, prompt })}
            />
          </label>
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
              variant="primary"
              disabled={
                busy || !draft.name.trim() || !draft.prompt.trim() || !draft.triggers.length
              }
              onClick={() =>
                void act(async () => {
                  const saved = await window.electronAPI.routines.save(
                    botId,
                    draft,
                    selected === 'new' ? undefined : selected!,
                  );
                  setSelected(saved.id);
                  setDraft(saved);
                })
              }
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
                    ) : run.status === 'success' ? (
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
        </div>
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
      <label className="block py-2">
        {t('routines.minutes')}
        <Input
          type="number"
          min={1}
          value={String(trigger.intervalMs / 60_000)}
          onChange={(value) => onChange({ ...trigger, intervalMs: Number(value) * 60_000 })}
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
    <div className="space-y-2 py-2">
      <label className="block">
        {t('routines.schedule')}
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
        <label className="block">
          {t('routines.expression')}
          <Input
            value={trigger.expression}
            onChange={(expression) => onChange({ ...trigger, expression })}
          />
        </label>
      ) : (
        <>
          {config.mode !== 'hourly' && (
            <label className="block">
              {t('routines.time')}
              <Input
                type="time"
                value={`${String(config.hour).padStart(2, '0')}:${String(config.minute).padStart(2, '0')}`}
                onChange={(value) => {
                  const [hour, minute] = value.split(':').map(Number);
                  patch({ hour, minute });
                }}
              />
            </label>
          )}
          {config.mode === 'weekly' && (
            <label className="block">
              {t('routines.weekday')}
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
            <label className="block">
              {t('routines.day')}
              <Input
                type="number"
                min={1}
                max={31}
                value={String(config.monthDay)}
                onChange={(value) => patch({ monthDay: Number(value) })}
              />
            </label>
          )}
        </>
      )}
      <label className="block">
        {t('routines.timezone')}
        <Input
          value={trigger.timezone}
          onChange={(timezone) => onChange({ ...trigger, timezone })}
        />
      </label>
    </div>
  );
}
