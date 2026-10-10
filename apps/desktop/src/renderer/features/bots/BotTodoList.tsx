import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MoreHorizontal, Plus, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import {
  effectiveTodoDeadline,
  createTodoDueComparator,
  nextTodoDeferralAt,
  scheduleTodoDeferralRefresh,
  todoDateLabel,
  todoOverdue,
  todoLocalDate,
  todoVisible,
  type TeammateTodo,
  type TodoPatch,
} from '@cindy/maker-shared/teammate-todo';
import './botTodo.css';

export interface TodoTransport {
  list(): Promise<{ items: TeammateTodo[] }>;
  update(p: TodoPatch): Promise<TeammateTodo>;
  act(input: {
    id: string;
    revision: number;
    requestId: string;
    locale?: string;
  }): Promise<TeammateTodo | null>;
}
export function BotTodoList({ botId }: { botId: string }) {
  const transport = useRef<TodoTransport | null>(null);
  transport.current = {
    list: () => window.electronAPI.localDb.bots.todos.list(botId),
    update: (p) => window.electronAPI.localDb.bots.todos.update(botId, p),
    act: (p) => window.electronAPI.localDb.bots.todos.act(botId, p),
  };
  return (
    <TodoPanel
      key={
        getDataOwnerGeneration().dataOwnerId +
        ':' +
        getDataOwnerGeneration().generation +
        ':' +
        botId
      }
      transport={{
        list: () => transport.current!.list(),
        update: (p) => transport.current!.update(p),
        act: (p) => transport.current!.act(p),
      }}
      botId={botId}
    />
  );
}
/** The production panel also mounts in isolated component acceptance fixtures. No demo data. */
export function TodoPanel({ transport, botId }: { transport: TodoTransport; botId?: string }) {
  const { t, i18n } = useTranslation();
  const tr = (k: string, values?: Record<string, unknown>): string =>
    String(t('teammateTodo.' + k, values));
  const [items, setItems] = useState<TeammateTodo[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [query, setQuery] = useState(''),
    [view, setView] = useState<'open' | 'hidden'>('open'),
    [origin, setOrigin] = useState('all'),
    [order, setOrder] = useState('dueOrder'),
    [page, setPage] = useState(0),
    [doneOpen, setDoneOpen] = useState(false),
    [donePage, setDonePage] = useState(0);
  const [detail, setDetail] = useState<string | null>(null),
    [form, setForm] = useState<Partial<
      Record<
        'title' | 'outcome' | 'progress' | 'date' | 'time' | 'zone' | 'summary' | 'ref' | 'until',
        string
      >
    > | null>(null),
    [mode, setMode] = useState<'edit' | 'deadline' | 'complete' | 'later'>('edit');
  const pending = useRef(false);
  const formRevision = useRef<number | undefined>(undefined);
  const scope = useRef(getDataOwnerGeneration()),
    epoch = useRef(0),
    mounted = useRef(true),
    initialOrder = useRef(new Map<string, number>()),
    api = useRef(transport);
  api.current = transport;
  const current = () => mounted.current && isDataOwnerGenerationCurrent(scope.current);
  const sorted = (rows: TeammateTodo[], kind: string) => {
    const compareDue = createTodoDueComparator();
    return [...rows].sort((a, b) =>
      kind === 'dueOrder'
        ? compareDue(a, b) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
        : a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  };
  const refresh = useCallback(async () => {
    const request = ++epoch.current;
    try {
      const data = await api.current.list();
      if (!current() || request !== epoch.current) return;
      setItems(data.items);
      for (const x of sorted(data.items, 'dueOrder')) {
        if (!initialOrder.current.has(x.id))
          initialOrder.current.set(x.id, initialOrder.current.size);
      }
      setError('');
    } catch {
      if (current()) setError('error');
    } finally {
      if (current()) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const unsub = botId
      ? window.electronAPI.maker.onBotWorkbenchChanged((event) => {
          if (event.botId === botId) void refresh();
        })
      : undefined;
    return () => {
      mounted.current = false;
      epoch.current++;
      unsub?.();
    };
  }, [botId, refresh]);
  const nextDeferredAt = nextTodoDeferralAt(items);
  useEffect(() => {
    if (!nextDeferredAt) return;
    return scheduleTodoDeferralRefresh(nextDeferredAt, () => void refresh());
  }, [nextDeferredAt, refresh]);
  useEffect(() => {
    const foreground = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', foreground);
    window.addEventListener('focus', foreground);
    return () => {
      document.removeEventListener('visibilitychange', foreground);
      window.removeEventListener('focus', foreground);
    };
  }, [refresh]);
  const selected = items.find((x) => x.id === detail);
  const matches = (x: TeammateTodo) =>
    (origin === 'all' || x.origin === origin) &&
    (!query ||
      [x.title, x.progress, ...x.sources.map((s) => s.label)]
        .join(' ')
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()));
  const rows = items
    .filter((x) => (view === 'hidden' ? !todoVisible(x) : x.status === 'open' && todoVisible(x)))
    .filter(matches)
    .sort((a, b) => (initialOrder.current.get(a.id) ?? 0) - (initialOrder.current.get(b.id) ?? 0));
  const completed = items
    .filter((x) => x.status === 'done' && todoVisible(x))
    .filter(matches)
    .sort((a, b) => (initialOrder.current.get(a.id) ?? 0) - (initialOrder.current.get(b.id) ?? 0));
  const visibleDonePage = Math.min(donePage, Math.max(0, Math.ceil(completed.length / 25) - 1));
  const visiblePage = Math.min(page, Math.max(0, Math.ceil(rows.length / 25) - 1));
  const run = async (fn: () => Promise<unknown>, close = false) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await fn();
      if (current()) {
        if (close) {
          setForm(null);
          setDetail(null);
        }
        await refresh();
      }
    } catch (e) {
      if (current()) setError(String(e).includes('CONFLICT') ? 'conflict' : 'error');
    } finally {
      pending.current = false;
      if (current()) setBusy(false);
    }
  };
  const update = (x: TeammateTodo, patch: TodoPatch, close = false) =>
    run(() => api.current.update({ ...patch, id: x.id, expectedRevision: x.revision }), close);
  const edit = (x: TeammateTodo | undefined, m: typeof mode) => {
    formRevision.current = x?.revision;
    setDetail(x?.id ?? 'new');
    setMode(m);
    const d = x ? effectiveTodoDeadline(x) : null;
    setForm({
      title: x?.title ?? '',
      outcome: x?.outcome ?? '',
      progress: x?.progress ?? '',
      date: d?.at
        ? todoLocalDate(new Date(d.at), Intl.DateTimeFormat().resolvedOptions().timeZone)
        : (d?.date ?? ''),
      time: d?.at ?? '',
      zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      summary: '',
      ref: '',
      until: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
  };
  const act = (x: TeammateTodo, confirmed = false) => {
    if (
      x.status === 'done' ||
      !x.next ||
      x.next.kind === 'view' ||
      (x.next.kind === 'decide' && !confirmed) ||
      (x.action && x.action.state !== 'failed')
    ) {
      setDetail(x.id);
      setForm(null);
      return;
    }
    void run(() =>
      api.current.act({
        id: x.id,
        revision: x.revision,
        requestId: crypto.randomUUID(),
        locale: i18n.language,
      }),
    );
  };
  const label = (x: TeammateTodo) =>
    x.status === 'done'
      ? tr('evidence')
      : x.action
        ? tr(
            x.action.state === 'failed'
              ? 'failed'
              : x.action.state === 'accepted'
                ? 'accepted'
                : x.action.state === 'unknown'
                  ? 'unknown'
                  : 'received',
          )
        : x.legacyId && x.next?.label === 'Continue'
          ? tr('continue')
          : (x.next?.label ?? tr('view'));
  const list = (data: TeammateTodo[]) =>
    data.map((x) => (
      <li className="todo-row" key={x.id} data-todo-id={x.id}>
        <button
          className="todo-heading"
          onClick={() => {
            setDetail(x.id);
            setForm(null);
          }}
          title={x.title}
          aria-label={x.title}
        >
          <span className="todo-title">{x.title}</span>
          <span className="todo-progress">
            {!todoVisible(x) && x.decision
              ? tr(
                  x.decision.kind === 'deleted'
                    ? 'deleted'
                    : x.decision.kind === 'muted'
                      ? 'muted'
                      : 'deferred',
                ) + ' · '
              : ''}
            {x.origin === 'discovered' ? tr('discovered') + ' · ' : ''}
            {x.progress || x.next?.instruction || x.outcome}
          </span>
        </button>
        <div className="todo-rail">
          <button
            className={'todo-date' + (todoOverdue(x) && x.status !== 'done' ? ' todo-overdue' : '')}
            aria-label={tr('deadline')}
            onClick={() => edit(x, 'deadline')}
          >
            {!effectiveTodoDeadline(x) && x.deadlineCandidate
              ? tr('candidate') + ' '
              : !effectiveTodoDeadline(x) && x.suggestedDate
                ? tr('suggested') + ' '
                : ''}
            {todoDateLabel(x, i18n.language)}
            {todoOverdue(x) && x.status !== 'done' ? ' · ' + tr('overdue') : ''}
          </button>
          <Button
            className="todo-action"
            variant="secondary"
            title={label(x)}
            disabled={busy}
            onClick={() => act(x)}
          >
            <span>{label(x)}</span>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                className="todo-more"
                variant="secondary"
                tone="quiet"
                aria-label={tr('more')}
              >
                <MoreHorizontal size={16} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => edit(x, 'edit')}>{tr('edit')}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => edit(x, 'deadline')}>
                {tr('deadline')}
              </DropdownMenuItem>
              {x.status === 'done' ? (
                <DropdownMenuItem onSelect={() => void update(x, { operation: 'reopen' })}>
                  {tr('reopen')}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={() => edit(x, 'complete')}>
                  {tr('complete')}
                </DropdownMenuItem>
              )}
              {x.decision ? (
                <DropdownMenuItem onSelect={() => void update(x, { operation: 'restore' })}>
                  {tr('restore')}
                </DropdownMenuItem>
              ) : (
                <>
                  <DropdownMenuItem onSelect={() => edit(x, 'later')}>
                    {tr('later')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void update(x, { operation: 'delete' })}>
                    {tr('delete')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void update(x, { operation: 'mute' })}>
                    {tr('mute')}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </li>
    ));
  const localInput = (value: string | undefined) => {
    if (!value) return '';
    const d = new Date(value);
    return Number.isFinite(d.getTime())
      ? todoLocalDate(d, Intl.DateTimeFormat().resolvedOptions().timeZone) +
          'T' +
          [d.getHours(), d.getMinutes()].map((v) => String(v).padStart(2, '0')).join(':')
      : '';
  };
  const field = (key: keyof NonNullable<typeof form>, labelKey: string = key, type = 'text') => (
    <label className="todo-field">
      {tr(labelKey)}
      {['outcome', 'progress', 'summary'].includes(key) ? (
        <textarea
          value={form?.[key] ?? ''}
          rows={3}
          onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        />
      ) : (
        <input
          type={type}
          value={type === 'datetime-local' ? localInput(form?.[key]) : (form?.[key] ?? '')}
          onChange={(e) => {
            if (type !== 'datetime-local') {
              if (type === 'date' && form?.time) {
                const moved = new Date(form.time),
                  parts = e.target.value.split('-').map(Number);
                moved.setFullYear(parts[0], parts[1] - 1, parts[2]);
                setForm({
                  ...form,
                  date: e.target.value,
                  time: Number.isFinite(moved.getTime()) ? moved.toISOString() : '',
                });
              } else setForm({ ...form, [key]: e.target.value });
              return;
            }
            const date = new Date(e.target.value),
              value = Number.isFinite(date.getTime()) ? date.toISOString() : '';
            setForm({
              ...form,
              [key]: value,
              ...(key === 'time' && value ? { date: todoLocalDate(date, form!.zone!) } : {}),
            });
          }}
        />
      )}
    </label>
  );
  const save = () => {
    if (!form) return;
    let patch: TodoPatch =
      mode === 'edit'
        ? { title: form.title, outcome: form.outcome, progress: form.progress }
        : mode === 'deadline'
          ? {
              deadlineOverride: {
                value: form.date
                  ? {
                      kind: form.time ? 'instant' : 'date',
                      date: form.date,
                      timeZone: form.zone!,
                      ...(form.time ? { at: form.time } : {}),
                    }
                  : null,
              },
            }
          : mode === 'complete'
            ? {
                operation: 'complete',
                completion: { summary: form.summary!, ...(form.ref ? { ref: form.ref } : {}) },
              }
            : { operation: 'later', until: form.until };
    if (selected)
      void run(
        () =>
          api.current.update({ ...patch, id: selected.id, expectedRevision: formRevision.current }),
        true,
      );
    else
      void run(
        () =>
          api.current.update({
            ...patch,
            key: 'user:' + crypto.randomUUID(),
            origin: 'assigned',
            next: { kind: 'advance', label: tr('continue'), instruction: form.outcome! },
          }),
        true,
      );
  };
  const pagination = (
    count: number,
    currentPage: number,
    change: (page: number) => void,
    label: string,
  ) =>
    count > 25 && (
      <nav className="todo-pages" aria-label={label}>
        <Button
          variant="secondary"
          tone="quiet"
          disabled={!currentPage}
          onClick={() => change(currentPage - 1)}
        >
          {tr('previous')}
        </Button>
        <span>
          {tr('page', {
            start: currentPage * 25 + 1,
            end: Math.min(count, currentPage * 25 + 25),
            count,
          })}
        </span>
        <Button
          variant="secondary"
          tone="quiet"
          disabled={(currentPage + 1) * 25 >= count}
          onClick={() => change(currentPage + 1)}
        >
          {tr('following')}
        </Button>
      </nav>
    );
  return (
    <section className="todo-panel" aria-label={tr('title')}>
      <header className="todo-header">
        <h2>{tr('title')}</h2>
        <Button
          variant="secondary"
          tone="quiet"
          aria-label={tr('new')}
          onClick={() => edit(undefined, 'edit')}
        >
          <Plus size={16} />
        </Button>
      </header>
      <div className="todo-tools">
        <input
          aria-label={tr('search')}
          placeholder={tr('search')}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(0);
            setDonePage(0);
          }}
        />
        <select
          aria-label={tr('open')}
          value={view}
          onChange={(e) => {
            setView(e.target.value as typeof view);
            setPage(0);
            setDonePage(0);
          }}
        >
          <option value="open">{tr('open')}</option>
          <option value="hidden">{tr('hidden')}</option>
        </select>
      </div>
      <div className="todo-filters">
        <select
          aria-label={tr('origin')}
          value={origin}
          onChange={(e) => {
            setOrigin(e.target.value);
            setPage(0);
            setDonePage(0);
          }}
        >
          {['all', 'assigned', 'discovered'].map((k) => (
            <option key={k} value={k}>
              {tr(k)}
            </option>
          ))}
        </select>
        <select
          aria-label={tr('order')}
          value={order}
          onChange={(e) => {
            setOrder(e.target.value);
            initialOrder.current = new Map(
              sorted(items, e.target.value).map((x, rank) => [x.id, rank]),
            );
            setPage(0);
            setDonePage(0);
          }}
        >
          {['dueOrder', 'createdOrder'].map((k) => (
            <option key={k} value={k}>
              {tr(k)}
            </option>
          ))}
        </select>
      </div>
      {error && (
        <p role="alert" className="todo-error">
          {tr(error)}{' '}
          <Button variant="secondary" tone="quiet" onClick={() => void refresh()}>
            {tr('retry')}
          </Button>
        </p>
      )}
      {loading ? (
        <p role="status">{tr('loading')}</p>
      ) : rows.length ? (
        <ul className="todo-list">{list(rows.slice(visiblePage * 25, visiblePage * 25 + 25))}</ul>
      ) : (
        <p className="todo-empty">{tr(query ? 'noMatch' : 'empty')}</p>
      )}
      {pagination(rows.length, visiblePage, setPage, tr('title'))}
      <button
        className="todo-done-toggle"
        aria-expanded={doneOpen}
        onClick={() => setDoneOpen(!doneOpen)}
      >
        {doneOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {tr('done')} ·{' '}
        {completed.length}
      </button>
      {doneOpen && (
        <>
          <ul className="todo-list">
            {list(completed.slice(visibleDonePage * 25, visibleDonePage * 25 + 25))}
          </ul>
          {pagination(completed.length, visibleDonePage, setDonePage, tr('done'))}
        </>
      )}
      <ConfirmDialog
        open={detail !== null}
        onOpenChange={(open) => {
          if (!open && !pending.current) {
            setDetail(null);
            setForm(null);
          }
        }}
        title={selected?.title ?? tr('new')}
        presentation="standard"
        showCloseButton
        confirmText={form ? tr('save') : tr('close')}
        cancelText={tr('cancel')}
        onConfirm={form ? save : () => setDetail(null)}
        loading={busy}
        content={
          <div className="todo-detail">
            {error && (
              <p role="alert" className="todo-error">
                {tr(error)}
              </p>
            )}
            {form ? (
              <>
                {mode === 'edit' ? (
                  <>
                    {field('title', 'name')}
                    {field('outcome')}
                    {field('progress')}
                  </>
                ) : mode === 'deadline' ? (
                  <>
                    {field('date', 'date', 'date')}
                    {field('time', 'time', 'datetime-local')}
                    <p>
                      {tr('zone')} · {form.zone}
                    </p>
                    <Button
                      variant="secondary"
                      tone="quiet"
                      onClick={() => setForm({ ...form, date: '', time: '' })}
                    >
                      {tr('clearDate')}
                    </Button>
                    {selected?.deadlineCandidate && (
                      <>
                        <p>{selected.deadlineCandidate.reason}</p>
                        <Button
                          onClick={() =>
                            void update(selected, { operation: 'confirm-deadline' }, true)
                          }
                        >
                          {tr('confirmDate')}
                        </Button>
                      </>
                    )}
                  </>
                ) : mode === 'complete' ? (
                  <>
                    {field('summary')}
                    {field('ref', 'link')}
                  </>
                ) : (
                  <>
                    {field('until', 'until', 'datetime-local')}
                    <p>{tr('laterConflict')}</p>
                  </>
                )}
              </>
            ) : (
              selected && (
                <>
                  {selected.next &&
                    selected.next.kind !== 'view' &&
                    selected.status === 'open' &&
                    (!selected.action || selected.action.state === 'failed') && (
                      <Button onClick={() => act(selected, true)}>{selected.next.label}</Button>
                    )}
                  <p>{selected.progress}</p>
                  {[
                    ['outcome', selected.outcome],
                    ['value', selected.value],
                    ['next', selected.next?.instruction],
                  ]
                    .filter(([, v]) => v)
                    .map(([k, v]) => (
                      <div key={k}>
                        <h3>{tr(k!)}</h3>
                        <p>{v}</p>
                      </div>
                    ))}
                  {selected.action && (
                    <p role="status">
                      {tr(selected.action.state === 'failed' ? 'error' : selected.action.state)}
                      {selected.action.error ? ' · ' + tr('error') : ''}
                    </p>
                  )}
                  {selected.sourceDeadline && (
                    <div>
                      <h3>{tr('sourceDeadline')}</h3>
                      <p>
                        {selected.sourceDeadline.date} {selected.sourceDeadline.at} ·{' '}
                        {selected.sourceDeadline.timeZone}
                      </p>
                      <p>{selected.sourceDeadline.quote}</p>
                    </div>
                  )}
                  {selected.deadlineOverride && (
                    <p>
                      {tr('override')} ·{' '}
                      {effectiveTodoDeadline(selected)
                        ? [
                            effectiveTodoDeadline(selected)?.date,
                            effectiveTodoDeadline(selected)?.at,
                            effectiveTodoDeadline(selected)?.timeZone,
                          ]
                            .filter(Boolean)
                            .join(' · ')
                        : tr('clearDate')}
                    </p>
                  )}
                  {selected.deadlineCandidate && (
                    <div>
                      <h3>{tr('deadlineReason')}</h3>
                      <p>{selected.deadlineCandidate.reason}</p>
                      <Button
                        onClick={() => void update(selected, { operation: 'confirm-deadline' })}
                      >
                        {tr('confirmDate')}
                      </Button>
                    </div>
                  )}
                  {selected.decision?.until && (
                    <p>
                      {tr('reminder')} · {selected.decision.until}
                    </p>
                  )}
                  {!!selected.sources.length && (
                    <div>
                      <h3>{tr('sources')}</h3>
                      {selected.sources.map((s) => (
                        <p key={s.kind + ':' + s.id}>
                          {s.ref ? (
                            <a href={s.ref} target="_blank" rel="noreferrer">
                              {s.label}
                            </a>
                          ) : (
                            s.label
                          )}
                          {s.observedAt ? ' · ' + s.observedAt : ''}
                        </p>
                      ))}
                    </div>
                  )}
                  {!!selected.associations.length && (
                    <div>
                      <h3>{tr('associations')}</h3>
                      {selected.associations.map((a) => (
                        <p key={a.kind + ':' + a.id}>
                          {a.label} · {a.id}
                        </p>
                      ))}
                    </div>
                  )}
                  {!!selected.history.length && (
                    <div>
                      <h3>{tr('history')}</h3>
                      {selected.history.map((h, n) => (
                        <p key={n}>
                          {h.summary === 'Legacy completion evidence was not recorded'
                            ? tr('legacyEvidence')
                            : h.summary}{' '}
                          · {h.at}
                          {h.ref && /^https:\/\//.test(h.ref) && (
                            <a href={h.ref} target="_blank" rel="noreferrer">
                              {' '}
                              · {tr('evidence')}
                            </a>
                          )}
                        </p>
                      ))}
                    </div>
                  )}
                  <Button variant="secondary" onClick={() => edit(selected, 'edit')}>
                    {tr('edit')}
                  </Button>
                </>
              )
            )}
          </div>
        }
      />
    </section>
  );
}
