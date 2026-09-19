import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { useCindyMakeState } from '@/lib/cindyMakeState';
import { formatCindyMakeTitle } from '@/lib/cindyMakeTitle';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import type { CindyMakeHistoryState, MakeHistoryAction } from '../../../shared/cindyMakeHistory';
import './cindyMakeTasks.css';

type Filter = 'all' | 'pending' | 'integrated' | 'ended';
/** Historical facts and allowed actions come from Main; an old button cannot authorize a write. */
export function CindyMakeHistoryPanel({
  active = true,
  onState,
}: {
  active?: boolean;
  onState?: (state: CindyMakeHistoryState) => void;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { confirm } = useConfirmDialog();
  const make = useCindyMakeState();
  const [snapshot, setSnapshot] = useState<{
    owner: ReturnType<typeof getDataOwnerGeneration>;
    value: CindyMakeHistoryState;
  }>();
  const state =
    snapshot && isDataOwnerGenerationCurrent(snapshot.owner) ? snapshot.value : undefined;
  const [selectedId, select] = useState('');
  const [query, search] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [pending, setPending] = useState<string>();
  const [failed, setFailed] = useState(false);
  const request = useRef(0);
  const acting = useRef(false);
  const actionGeneration = useRef(0);
  const owner = getDataOwnerGeneration();
  const refresh = useCallback(async () => {
    if (!window.electronAPI.getCindyMakeHistory) {
      setFailed(true);
      return;
    }
    const generation = ++request.current;
    try {
      const next = await window.electronAPI.getCindyMakeHistory(selectedId || undefined);
      if (isDataOwnerGenerationCurrent(owner) && generation === request.current) {
        setSnapshot({ owner, value: next });
        setFailed(false);
      }
    } catch {
      if (isDataOwnerGenerationCurrent(owner) && generation === request.current) setFailed(true);
    }
  }, [owner, selectedId]);
  useEffect(() => {
    setSnapshot(undefined);
    setPending(undefined);
    acting.current = false;
    actionGeneration.current += 1;
    return () => {
      request.current += 1;
      actionGeneration.current += 1;
    };
  }, [owner]);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden' && !acting.current) void refresh();
    }, 5000);
    const focus = () => {
      if (!acting.current) void refresh();
    };
    window.addEventListener('focus', focus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', focus);
      request.current += 1;
    };
  }, [active, refresh]);
  useEffect(() => {
    if (active && !acting.current) void refresh();
  }, [make, active, refresh]);
  useEffect(() => {
    if (state) onState?.(state);
  }, [state, onState]);
  const items = state?.items ?? [];
  const visible = items.filter(
    (item) =>
      (!query.trim() ||
        (item.title + ' ' + item.request)
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase())) &&
      (filter === 'all' || filter === 'ended'
        ? filter === 'all' || item.lifecycle === 'ended'
        : filter === 'integrated'
          ? item.integration === 'integrated'
          : ['unintegrated', 'changed', 'reverted'].includes(item.integration) &&
            item.lifecycle !== 'ended'),
  );
  const selected = visible.find((item) => item.runId === selectedId) ?? visible[0];
  useEffect(() => {
    if (selected && selected.runId !== selectedId) select(selected.runId);
  }, [selected?.runId, selectedId]);
  const date = (value: number) =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(
      value,
    );
  const update = (next: CindyMakeHistoryState) => {
    request.current += 1;
    if (isDataOwnerGenerationCurrent(owner)) {
      setSnapshot({ owner, value: next });
      setFailed(false);
    }
  };
  const act = async (action: MakeHistoryAction) => {
    if (
      !selected ||
      acting.current ||
      !selected.actions.includes(action) ||
      !isDataOwnerGenerationCurrent(owner)
    )
      return;
    acting.current = true;
    const actionId = ++actionGeneration.current;
    setPending(action);
    try {
      if (action === 'open') {
        navigate('/cc-agent/' + selected.sessionId);
        return;
      }
      if (action === 'end' || action === 'retry-cleanup' || action === 'revert') {
        const accepted = await confirm({
          title: t('cindyMake.history.actions.' + action),
          description:
            t('cindyMake.history.' + (action === 'revert' ? 'revertConfirm' : 'endConfirm')) +
            (action !== 'revert' && selected.integration === 'unknown'
              ? '\n\n' + t('settings.cindyMake.tasks.endUnknown')
              : ''),
          confirmText: t('cindyMake.history.actions.' + action),
          cancelText: t('settings.cindyMake.create.cancel'),
          confirmVariant: 'destructive',
        });
        if (!accepted || !isDataOwnerGenerationCurrent(owner)) return;
      }
      if (action === 'build') {
        update(await window.electronAPI.generateCindyMakePersonal());
      } else if (action === 'retry-prepare') {
        await window.electronAPI.startCindyMakeTask({
          runId: selected.runId,
          request: selected.request,
          title: selected.title.slice(0, 200),
        });
        await refresh();
      } else {
        const next = await window.electronAPI.actCindyMakeHistory(selected.runId, action);
        if (!isDataOwnerGenerationCurrent(owner)) return;
        update(next);
        if (action === 'continue') navigate('/cc-agent/' + selected.sessionId);
        if (action === 'resolve') {
          const session = next.items.find(
            (item) => item.runId === selected.runId,
          )?.resolutionSessionId;
          if (session) navigate('/cc-agent/' + session);
        }
      }
    } catch {
      if (isDataOwnerGenerationCurrent(owner)) {
        toast.error(t('cindyMake.history.actionFailed'));
        await refresh();
      }
    } finally {
      if (actionId === actionGeneration.current) {
        acting.current = false;
        if (isDataOwnerGenerationCurrent(owner)) setPending(undefined);
      }
    }
  };
  const build = async () => {
    if (!state?.canBuild || acting.current) return;
    acting.current = true;
    const actionId = ++actionGeneration.current;
    setPending('build');
    try {
      update(await window.electronAPI.generateCindyMakePersonal());
    } catch {
      if (isDataOwnerGenerationCurrent(owner)) toast.error(t('cindyMake.history.actionFailed'));
    } finally {
      if (actionId === actionGeneration.current) {
        acting.current = false;
        if (isDataOwnerGenerationCurrent(owner)) setPending(undefined);
      }
    }
  };
  const building = !!state?.build && !['ready', 'failed'].includes(state.build.status);
  const stopping = building && state?.build?.stopping === true;
  const buildStep = (value: NonNullable<CindyMakeHistoryState['build']>) => {
    if (value.status === 'waiting') return 1;
    if (value.status === 'merging') return 2;
    if (value.status === 'checking') return 3;
    if (value.status === 'packaging') return 4;
    if (value.status === 'publishing') return 5;
    return 1;
  };
  const stopBuild = async () => {
    const buildId = state?.build?.buildId;
    if (!building || !buildId || stopping || !isDataOwnerGenerationCurrent(owner)) return;
    try {
      update(await window.electronAPI.cancelCindyMakePersonal(buildId));
    } catch {
      if (isDataOwnerGenerationCurrent(owner)) {
        toast.error(t('cindyMake.history.actionFailed'));
        await refresh();
      }
    }
  };
  const openInstaller = async () => {
    if (acting.current || !isDataOwnerGenerationCurrent(owner)) return;
    acting.current = true;
    const actionId = ++actionGeneration.current;
    setPending('open-build');
    try {
      await window.electronAPI.openCindyMakeHistoryBuild();
    } catch {
      if (isDataOwnerGenerationCurrent(owner)) {
        toast.error(t('cindyMake.history.actionFailed'));
        await refresh();
      }
    } finally {
      if (actionId === actionGeneration.current) {
        acting.current = false;
        if (isDataOwnerGenerationCurrent(owner)) setPending(undefined);
      }
    }
  };
  return (
    <section
      aria-label={t('cindyMake.history.title')}
      className="cindy-make-tasks rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] text-13 text-[var(--text-primary)]"
    >
      <div className="space-y-3 border-b border-[var(--border-default)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-medium">
            {t('cindyMake.history.title')} · {items.length}
          </h3>
          {!building && (
            <Button
              variant="secondary"
              className="gap-2"
              disabled={!state?.canBuild || !!pending || failed}
              onClick={() => void build()}
            >
              {pending === 'build' && <Spinner size={14} />}
              {t(pending === 'build' ? 'cindyMake.history.building' : 'cindyMake.history.build')}
            </Button>
          )}
        </div>
        {!building && (
          <>
            <p className="text-12 text-[var(--text-secondary)]">
              {t('cindyMake.history.buildDescription')}
            </p>
            <p className="text-12 text-[var(--text-secondary)]">
              {t('cindyMake.history.counts', {
                total: items.length,
                pending: items.filter(
                  (item) =>
                    ['unintegrated', 'changed', 'reverted'].includes(item.integration) &&
                    item.lifecycle !== 'ended',
                ).length,
                integrated: items.filter((item) => item.integration === 'integrated').length,
              })}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                label={t('cindyMake.history.filterLabel')}
                value={filter}
                options={(['all', 'pending', 'integrated', 'ended'] as const).map((value) => ({
                  value,
                  label: t('cindyMake.history.filters.' + value),
                }))}
                onValueChange={(value) => setFilter(value as Filter)}
                className="h-8 w-[168px]"
              />
              <Input
                size="sm"
                value={query}
                onChange={search}
                aria-label={t('settings.cindyMake.tasks.search')}
                placeholder={t('settings.cindyMake.tasks.search')}
                className="cindy-make-tasks-search"
              />
            </div>
          </>
        )}
        {building && state?.build && (
          <div
            role="status"
            aria-live="polite"
            className="space-y-3 rounded-xl border border-[var(--border-default)] bg-[var(--surface-card)] p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-2">
                <Spinner size={16} className="mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <p className="font-medium">
                    {t(
                      stopping
                        ? 'cindyMake.history.stopping'
                        : 'cindyMake.history.buildStatus.' + state.build.status,
                    )}
                  </p>
                  <p className="text-12 text-[var(--text-secondary)]">
                    {t(
                      state.build.status === 'checking' && state.build.checkStep
                        ? 'cindyMake.personal.checkStep.' + state.build.checkStep
                        : 'cindyMake.history.buildStatus.' + state.build.status,
                    )}
                  </p>
                </div>
              </div>
              <Button
                variant="secondary"
                disabled={stopping || !state.build.buildId}
                onClick={() => void stopBuild()}
              >
                {stopping && <Spinner size={14} />}
                {t(stopping ? 'cindyMake.history.stopping' : 'cindyMake.history.stop')}
              </Button>
            </div>
            <ol className="grid gap-1 text-12 text-[var(--text-secondary)] sm:grid-cols-2">
              {(['waiting', 'merging', 'checking', 'packaging', 'publishing'] as const).map(
                (step, index) => {
                  const current = buildStep(state.build!);
                  const active = current === index + 1;
                  const done = current > index + 1;
                  return (
                    <li
                      key={step}
                      className={cn(
                        'flex items-center gap-2',
                        active && 'font-medium text-[var(--text-primary)]',
                        done && 'text-[var(--status-success)]',
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className="inline-block h-1.5 w-1.5 rounded-full bg-current"
                      />
                      {t('cindyMake.history.progress.' + step)}
                    </li>
                  );
                },
              )}
            </ol>
          </div>
        )}
        {state?.build && !building && (
          <p role="status" className="text-12 text-[var(--text-secondary)]">
            {t(
              state.build.status === 'checking' && state.build.checkStep
                ? 'cindyMake.personal.checkStep.' + state.build.checkStep
                : 'cindyMake.history.buildStatus.' +
                    (state.build.status === 'ready' && !state.build.versionId
                      ? 'installerReady'
                      : state.build.status),
            )}
          </p>
        )}
        {state?.build?.status === 'failed' && state.build.error && (
          <p role="alert" className="text-12 text-[var(--status-danger)]">
            {t('cindyMake.personal.errors.' + state.build.error)}
          </p>
        )}
        {state?.build?.status === 'ready' &&
          !state.build.versionId &&
          state.build.buildId &&
          state.build.artifactName && (
            <Button
              variant="secondary"
              disabled={!!pending || state.busy || failed}
              loading={pending === 'open-build'}
              onClick={() => void openInstaller()}
            >
              {t('cindyMake.history.openInstaller')}
            </Button>
          )}
        {failed && (
          <div role="alert" className="flex items-center gap-2 text-[var(--error-fg)]">
            {t('cindyMake.history.loadFailed')}
            <Button size="md" variant="secondary" onClick={() => void refresh()}>
              {t('cindyMake.prepare.retry')}
            </Button>
          </div>
        )}
      </div>
      {!state && !failed && (
        <p role="status" className="p-4 text-[var(--text-secondary)]">
          {t('cindyMake.history.loading')}
        </p>
      )}
      <div className="cindy-make-tasks-layout grid min-w-0">
        <ul
          aria-label={t('cindyMake.history.title')}
          className="cindy-make-tasks-list max-h-80 space-y-1 overflow-y-auto overscroll-contain border-b border-[var(--border-default)] p-2"
        >
          {visible.map((item) => (
            <li key={item.runId}>
              <button
                type="button"
                aria-pressed={selected?.runId === item.runId}
                onClick={() => select(item.runId)}
                className={cn(
                  'flex w-full min-w-0 flex-col gap-1 rounded-lg border px-3 py-3 text-left',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]',
                  selected?.runId === item.runId
                    ? 'border-[var(--settings-menu-border-selected)] bg-[var(--settings-menu-bg-selected)] text-[var(--settings-menu-text-selected)]'
                    : 'border-transparent hover:bg-[var(--settings-menu-bg-hover)]',
                )}
              >
                <span className="line-clamp-2 break-words font-medium">
                  {formatCindyMakeTitle(item.title, item.runId)}
                </span>
                <span className="text-12 text-[var(--text-secondary)]">
                  {t(
                    item.operation === 'build'
                      ? 'cindyMake.history.building'
                      : 'cindyMake.history.lifecycle.' + item.lifecycle,
                  )}{' '}
                  · {t('cindyMake.history.integration.' + item.integration)}
                </span>
                <span className="text-12 text-[var(--text-tertiary)]">{date(item.createdAt)}</span>
              </button>
            </li>
          ))}
          {state && !visible.length && (
            <li className="p-3 text-[var(--text-secondary)]">
              {t('settings.cindyMake.tasks.noResults')}
            </li>
          )}
        </ul>
        {selected && (
          <div className="flex max-h-[480px] min-w-0 flex-col">
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-4">
              <h4 className="break-words font-medium">
                {formatCindyMakeTitle(selected.title, selected.runId)}
              </h4>
              <p className="text-12 text-[var(--text-secondary)]">
                {t('cindyMake.history.lifecycle.' + selected.lifecycle)} ·{' '}
                {t('cindyMake.history.integration.' + selected.integration)}
              </p>
              <p className="whitespace-pre-wrap break-words">{selected.request}</p>
              <p className="text-12 text-[var(--text-secondary)]">
                {t('cindyMake.history.updated', { time: date(selected.updatedAt) })}
              </p>
              {selected.needsBuild && (
                <p className="text-12 text-[var(--text-secondary)]">
                  {t('cindyMake.history.needsBuild')}
                </p>
              )}
              {selected.build && selected.build.status !== 'ready' && (
                <p role="status" className="text-12 text-[var(--text-secondary)]">
                  {t(
                    selected.build.status === 'checking' && selected.build.checkStep
                      ? 'cindyMake.personal.checkStep.' + selected.build.checkStep
                      : 'cindyMake.history.buildStatus.' + selected.build.status,
                  )}
                </p>
              )}
              {selected.build?.status === 'failed' && selected.build.error && (
                <p role="alert" className="text-12 text-[var(--status-danger)]">
                  {t('cindyMake.personal.errors.' + selected.build.error)}
                </p>
              )}
              {!!selected.versions.length && (
                <p className="text-12 text-[var(--text-secondary)]">
                  {selected.versions.at(-1)!.at === undefined
                    ? t('cindyMake.history.builtKnown')
                    : t('cindyMake.history.built', { time: date(selected.versions.at(-1)!.at!) })}
                </p>
              )}
              {(selected.conflict || selected.operationError) && (
                <p role="status" className="text-12 text-[var(--status-warning)]">
                  {t(
                    selected.conflict
                      ? 'cindyMake.history.conflict'
                      : 'cindyMake.history.actionFailed',
                  )}
                </p>
              )}
              {!selected.actions.length && selected.actionReason && (
                <p role="status" className="text-12 text-[var(--text-secondary)]">
                  {t('cindyMake.history.noActions.' + selected.actionReason)}
                </p>
              )}
              {!!selected.completions.length && (
                <details>
                  <summary className="min-h-8 cursor-pointer py-2 text-12 text-[var(--text-secondary)]">
                    {t('cindyMake.history.rounds', { count: selected.completions.length })}
                  </summary>
                  <ol className="mt-2 space-y-2">
                    {selected.completions.map((completion, index) => (
                      <li key={completion.id} className="text-12 text-[var(--text-secondary)]">
                        {t('cindyMake.history.round', {
                          number: index + 1,
                          time: date(completion.reportedAt),
                        })}
                        {completion.changedFiles !== undefined &&
                          ' · ' + t('cindyMake.history.files', { count: completion.changedFiles })}
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap gap-2 border-t border-[var(--border-default)] p-4">
              {selected.operation && (
                <span role="status" className="self-center text-12 text-[var(--text-secondary)]">
                  {t('cindyMake.history.working')}
                </span>
              )}
              {selected.actions.map((action) => (
                <Button
                  key={action}
                  variant="secondary"
                  disabled={!!pending || failed}
                  loading={pending === action}
                  onClick={() => void act(action)}
                >
                  {t(
                    action === 'build' && selected.build?.status === 'failed'
                      ? 'cindyMake.history.actions.retryBuild'
                      : action === 'end' &&
                          selected.integration === 'integrated' &&
                          !selected.needsBuild &&
                          selected.versions.length
                        ? 'cindyMake.history.endAndClean'
                        : 'cindyMake.history.actions.' + action,
                  )}
                </Button>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
