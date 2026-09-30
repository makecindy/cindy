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
  isDataOwnerPushCurrent,
} from '@/contexts/dataOwnerGeneration';
import { useCindyMakeState } from '@/lib/cindyMakeState';
import { formatCindyMakeTitle } from '@/lib/cindyMakeTitle';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import { cn } from '@/lib/utils';
import type {
  CindyMakeHistoryState,
  MakeHistoryAction,
  MakeHistoryBuildSelection,
} from '../../../shared/cindyMakeHistory';
import './cindyMakeTasks.css';
import { CindyMakeTestStep } from './CindyMakeTestStep';
import { CindyMakeBuildLog } from './CindyMakeBuildLog';
import { CindyMakeBuildProgress } from './CindyMakeBuildProgress';
import { CindyMakeBuildFailure } from './CindyMakeBuildFailure';
import { cindyMakeBuildStatusKey } from './cindyMakeBuildStatus';
import { useCindyMakeBuildStop } from './useCindyMakeBuildStop';

type Filter = 'all' | 'pending' | 'integrated' | 'ended';
/** Historical facts and allowed actions come from Main; an old button cannot authorize a write. */
export function CindyMakeHistoryPanel({
  active = true,
  hasPersonalVersion = false,
  onState,
}: {
  active?: boolean;
  hasPersonalVersion?: boolean;
  onState?: (state: CindyMakeHistoryState) => void;
}) {
  const { t, i18n } = useTranslation();
  const translateRef = useRef(t);
  translateRef.current = t;
  const navigate = useNavigate();
  const { confirm } = useConfirmDialog();
  const make = useCindyMakeState();
  const [snapshot, setSnapshot] = useState<{
    owner: ReturnType<typeof getDataOwnerGeneration>;
    value: CindyMakeHistoryState;
  }>();
  const snapshotRef = useRef(snapshot);
  const state =
    snapshot && isDataOwnerGenerationCurrent(snapshot.owner) ? snapshot.value : undefined;
  const [selectedId, select] = useState('');
  const [query, search] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [selecting, setSelecting] = useState(false);
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [pending, setPending] = useState<string>();
  const [failed, setFailed] = useState(false);
  // A failed build is persisted so it can still be retried, but an old failure
  // should not reappear as a fresh red banner every time this panel is opened.
  const [showBuildFailure, setShowBuildFailure] = useState(false);
  const request = useRef(0);
  const acting = useRef(false);
  const actionGeneration = useRef(0);
  const owner = getDataOwnerGeneration();
  const notifyBuildResult = useCallback(
    (previous: CindyMakeHistoryState['build'], next: CindyMakeHistoryState['build']) => {
      if (
        !previous ||
        !next ||
        (previous.status === next.status && previous.buildId === next.buildId)
      )
        return;
      if (next.status === 'ready') {
        toast.success(translateRef.current('cindyMake.personal.status.ready'));
      } else if (next.status === 'failed' && next.error !== 'cancelled') {
        toast.error(translateRef.current('cindyMake.personal.errors.' + (next.error ?? 'unavailable')));
      }
    },
    [],
  );
  const refresh = useCallback(async () => {
    if (!window.electronAPI.getCindyMakeHistory) {
      setFailed(true);
      return;
    }
    const generation = ++request.current;
    try {
      const next = await window.electronAPI.getCindyMakeHistory(selectedId || undefined);
      if (isDataOwnerGenerationCurrent(owner) && generation === request.current) {
        const previousBuild = snapshotRef.current?.value.build;
        const nextBuild = next.build;
        notifyBuildResult(previousBuild, nextBuild);
        if (nextBuild?.status !== 'failed') {
          setShowBuildFailure(false);
        } else if (
          previousBuild &&
          (previousBuild.status !== 'failed' || previousBuild.buildId !== nextBuild.buildId)
        ) {
          setShowBuildFailure(true);
        }
        setSnapshot({ owner, value: next });
        snapshotRef.current = { owner, value: next };
        setFailed(false);
      }
    } catch {
      if (isDataOwnerGenerationCurrent(owner) && generation === request.current) setFailed(true);
    }
  }, [notifyBuildResult, owner, selectedId]);
  useEffect(() => {
    setSnapshot(undefined);
    snapshotRef.current = undefined;
    setShowBuildFailure(false);
    setPending(undefined);
    setSelecting(false);
    setCheckedIds([]);
    acting.current = false;
    actionGeneration.current += 1;
    return () => {
      request.current += 1;
      actionGeneration.current += 1;
    };
  }, [owner]);
  useEffect(() => {
    if (!active) setShowBuildFailure(false);
  }, [active]);
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
  }, [make, active, refresh, pending]);
  useEffect(() => {
    if (!active) return;
    // Completion state uses the same owner-stamped message broadcast as the task card.
    return window.electronAPI.localDb?.messages?.onCreated?.(({ message }, stamp) => {
      if (
        isDataOwnerGenerationCurrent(owner) &&
        isDataOwnerPushCurrent(stamp) &&
        message.agentMeta?.cindyMakeCompletion &&
        !acting.current
      )
        void refresh();
    });
  }, [active, owner, refresh]);
  useEffect(() => {
    if (!active) return;
    return window.electronAPI.onCindyMakeHistoryChanged?.((stamp) => {
      if (isDataOwnerGenerationCurrent(owner) && isDataOwnerPushCurrent(stamp)) void refresh();
    });
  }, [active, owner, refresh]);
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
  const selectable = visible.filter((item) => item.canSelectForBuild);
  const checked = items
    .filter((item) => item.canSelectForBuild && checkedIds.includes(item.runId))
    .sort((a, b) => a.createdAt - b.createdAt || a.runId.localeCompare(b.runId));
  const allChecked =
    selectable.length > 0 && selectable.every((item) => checkedIds.includes(item.runId));
  const currentBuild = (item: CindyMakeHistoryState['items'][number]) =>
    state?.batch?.runId === item.runId &&
    state.build &&
    !['ready', 'failed'].includes(state.build.status)
      ? state.build
      : item.operation === 'build' ||
          (!item.operation && ['ready', 'ended'].includes(item.lifecycle) && !item.test)
        ? item.build
        : undefined;
  const statusKey = (item: CindyMakeHistoryState['items'][number]) => {
    const build = currentBuild(item);
    if (build && !['ready', 'failed'].includes(build.status)) return cindyMakeBuildStatusKey(build);
    if (item.conflict) return 'cindyMake.history.conflict';
    if (item.operationError) return 'cindyMake.history.actionFailed';
    if (item.operation && item.operation !== 'build') return 'cindyMake.history.working';
    if (build) return cindyMakeBuildStatusKey(build);
    return item.test
      ? 'cindyMake.test.status.' + item.test.status
      : 'cindyMake.history.lifecycle.' + item.lifecycle;
  };
  const selectedBuild = selected && currentBuild(selected);
  const selectedError =
    selected?.conflict || selected?.operationError
      ? undefined
      : !selectedBuild && selected?.test?.error
        ? 'cindyMake.test.errors.' + selected.test.error
        : undefined;
  const selectedIsGlobalFailure =
    state?.build?.status === 'failed' &&
    showBuildFailure &&
    !!state.build.buildId &&
    selectedBuild?.buildId === state.build.buildId;
  const building = !!state?.build && !['ready', 'failed'].includes(state.build.status);
  const selectedActions: MakeHistoryAction[] = selected
    ? (
        [
          'test',
          'continue',
          'open',
          'revert',
          'reapply',
          'resolve',
          'retry',
          'retry-prepare',
          'retry-cleanup',
        ] as const
      ).filter(
        (action) =>
          selected.actions.includes(action) &&
          !(action === 'open' && selected.actions.includes('continue')),
      )
    : [];
  if (selected?.canHide && !selectedActions.includes('retry-cleanup')) selectedActions.push('hide');
  useEffect(() => {
    const nextId = selected?.runId ?? '';
    if (nextId !== selectedId) select(nextId);
  }, [selected?.runId, selectedId]);
  const date = (value: number) =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(
      value,
    );
  const update = (next: CindyMakeHistoryState) => {
    request.current += 1;
    if (isDataOwnerGenerationCurrent(owner)) {
      const previousBuild = snapshotRef.current?.value.build;
      const nextBuild = next.build;
      notifyBuildResult(previousBuild, nextBuild);
      if (nextBuild?.status !== 'failed') {
        setShowBuildFailure(false);
      } else if (
        previousBuild &&
        (previousBuild.status !== 'failed' || previousBuild.buildId !== nextBuild.buildId)
      ) {
        setShowBuildFailure(true);
      }
      setSnapshot({ owner, value: next });
      snapshotRef.current = { owner, value: next };
      setFailed(false);
    }
  };
  const act = async (action: MakeHistoryAction) => {
    if (
      !selected ||
      acting.current ||
      (!selected.actions.includes(action) && !(action === 'hide' && selected.canHide)) ||
      !isDataOwnerGenerationCurrent(owner)
    )
      return;
    acting.current = true;
    // A read started before this action must not restore an obsolete history row.
    request.current += 1;
    const actionId = ++actionGeneration.current;
    setPending(action);
    try {
      if (action === 'open') {
        const [service, { sessionsStore }] = await Promise.all([
          import('@/lib/sessionService'),
          import('@/lib/sessionsStore'),
        ]);
        if (!isDataOwnerGenerationCurrent(owner)) return;
        let session = await service.get(selected.sessionId);
        if (!isDataOwnerGenerationCurrent(owner) || session.status === 'deleted')
          throw new Error('unavailable');
        if (session.status === 'archived') {
          const restored = await service.restoreIfArchived(session.id, session);
          if (!isDataOwnerGenerationCurrent(owner) || !restored) throw new Error('unavailable');
          session = restored;
        }
        if (!isDataOwnerGenerationCurrent(owner)) return;
        sessionsStore.prependCreated(session);
        navigate('/cc-agent/' + session.id);
        return;
      }
      if (
        action === 'end' ||
        action === 'retry-cleanup' ||
        action === 'revert' ||
        action === 'hide'
      ) {
        const accepted = await confirm({
          title: t(
            action === 'hide'
              ? 'cindyMake.history.cleanTitle'
              : 'cindyMake.history.actions.' + action,
          ),
          description:
            t(
              action === 'hide'
                ? 'cindyMake.history.cleanConfirm'
                : 'cindyMake.history.' + (action === 'revert' ? 'revertConfirm' : 'endConfirm'),
            ) +
            (action !== 'revert' && action !== 'hide' && selected.integration === 'unknown'
              ? '\n\n' + t('settings.cindyMake.tasks.endUnknown')
              : ''),
          confirmText: t(
            action === 'hide'
              ? 'cindyMake.history.cleanTask'
              : 'cindyMake.history.actions.' + action,
          ),
          cancelText: t('settings.cindyMake.create.cancel'),
          ...(action === 'hide'
            ? {
                content: (
                  <ul className="list-disc space-y-2 pl-5 text-[var(--confirm-desc)]">
                    <li>{t('cindyMake.history.cleanWorkspace')}</li>
                    <li>{t('cindyMake.history.cleanKeep')}</li>
                  </ul>
                ),
                describeContent: true,
              }
            : {}),
          confirmVariant: 'destructive',
        });
        if (!accepted || !isDataOwnerGenerationCurrent(owner)) return;
      }
      if (action === 'retry-prepare') {
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
        if (action === 'continue')
          navigate('/cc-agent/' + selected.sessionId, {
            state: {
              cindyMakeEditing: {
                sessionId: selected.sessionId,
                completionId: selected.completionId,
              },
            },
          });
        if (action === 'resolve') {
          const session = next.items.find(
            (item) => item.runId === selected.runId,
          )?.resolutionSessionId;
          if (session) navigate('/cc-agent/' + session);
        }
      }
    } catch (error) {
      if (isDataOwnerGenerationCurrent(owner)) {
        const rawReason = extractIpcError(error)?.message;
        // Electron may preserve the IpcError code on the Error object, in which
        // case the shared decoder intentionally leaves the `[CODE]` prefix in
        // the message.  Main's history handler only exposes the stable reason
        // after that prefix, so normalize both IPC shapes before translating.
        const reason = rawReason?.replace(/^\[PRECONDITION_FAILED\]\s*/, '');
        const knownReason = [
          'busy',
          'dirty',
          'conflict',
          'cleanupFailed',
          'directoryBusy',
          'unavailable',
        ].includes(reason ?? '')
          ? reason
          : undefined;
        toast.error(
          reason === 'stopFailed'
            ? t('cindyMake.test.errors.stopFailed')
            : knownReason
              ? t('settings.cindyMake.tasks.errors.' + knownReason)
              : t('cindyMake.history.actionFailed'),
        );
        await refresh();
      }
    } finally {
      if (actionId === actionGeneration.current) {
        acting.current = false;
        if (isDataOwnerGenerationCurrent(owner)) setPending(undefined);
      }
    }
  };
  const rebuildPersonal = async () => {
    if (
      acting.current ||
      !hasPersonalVersion ||
      !state?.canBuild ||
      building ||
      !isDataOwnerGenerationCurrent(owner)
    )
      return;
    acting.current = true;
    request.current += 1;
    const actionId = ++actionGeneration.current;
    setPending('rebuild-personal');
    try {
      const next = await window.electronAPI.generateCindyMakePersonal();
      if (!isDataOwnerGenerationCurrent(owner)) return;
      update(next);
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
  const buildSelected = async () => {
    if (acting.current || !checked.length || !isDataOwnerGenerationCurrent(owner)) return;
    const pins: MakeHistoryBuildSelection[] = checked.map((item) => ({
      runId: item.runId,
      completionId: item.completionId!,
      commit: item.completions.at(-1)!.commit!,
      tree: item.completions.at(-1)!.tree!,
    }));
    acting.current = true;
    request.current += 1;
    const actionId = ++actionGeneration.current;
    setPending('batch-build');
    try {
      const accepted = await confirm({
        title: t('cindyMake.history.batch.confirmTitle', { count: checked.length }),
        description: t('cindyMake.history.batch.confirmDescription'),
        content: (
          <ol className="list-decimal space-y-2 pl-5 text-[var(--confirm-desc)]">
            {checked.map((item) => (
              <li key={item.runId} className="break-words">
                {formatCindyMakeTitle(item.title, item.runId)}
                <span className="block text-12 text-[var(--text-secondary)]">
                  {date(item.createdAt)}
                </span>
              </li>
            ))}
          </ol>
        ),
        describeContent: true,
        confirmText: t('cindyMake.history.batch.start'),
        cancelText: t('settings.cindyMake.create.cancel'),
      });
      if (!accepted || !isDataOwnerGenerationCurrent(owner)) return;
      const next = await window.electronAPI.generateCindyMakePersonal(pins);
      if (!isDataOwnerGenerationCurrent(owner)) return;
      update(next);
      setSelecting(false);
      setCheckedIds([]);
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
  const showGlobalResult =
    state?.build &&
    !building &&
    ((state.build.status === 'failed' && showBuildFailure) ||
      (state.build.status === 'ready' &&
        !items.some((item) => state.build?.buildId && item.build?.buildId === state.build.buildId)));
  const { stop: confirmStopBuild, stopping: stoppingBuild } = useCindyMakeBuildStop(
    building ? state?.build?.buildId : undefined,
  );
  const stopping = building && (stoppingBuild || state?.build?.stopping === true);
  const stopBuild = async () => {
    const buildId = state?.build?.buildId;
    if (!building || !buildId || stopping || !isDataOwnerGenerationCurrent(owner)) return;
    await confirmStopBuild(
      () => isDataOwnerGenerationCurrent(owner),
      update,
      () => {
        toast.error(t('cindyMake.history.actionFailed'));
        void refresh();
      },
    );
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
      <div className="space-y-2 border-b border-[var(--border-default)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-medium">
            {t('cindyMake.history.title')} ·{' '}
            {t('cindyMake.history.taskCount', { count: items.length })}
          </h3>
          {hasPersonalVersion && (
            <Button
              variant="secondary"
              disabled={!!pending || failed || !state?.canBuild || building}
              loading={pending === 'rebuild-personal'}
              onClick={() => void rebuildPersonal()}
            >
              {t('cindyMake.history.regeneratePersonal')}
            </Button>
          )}
        </div>
        {!building && (
          <>
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
                onValueChange={(value) => {
                  setFilter(value as Filter);
                  setSelecting(false);
                  setCheckedIds([]);
                }}
                disabled={!!pending}
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
              {filter === 'pending' && !selecting && (
                <Button
                  variant="primary"
                  className="ml-auto"
                  disabled={!!pending || failed || !selectable.length}
                  onClick={() => {
                    setSelecting(true);
                    setCheckedIds([]);
                  }}
                >
                  {t('cindyMake.history.batch.make')}
                </Button>
              )}
              {selecting && (
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <Button
                    variant="secondary"
                    disabled={!!pending}
                    onClick={() => {
                      setSelecting(false);
                      setCheckedIds([]);
                    }}
                  >
                    {t('settings.cindyMake.create.cancel')}
                  </Button>
                  <Button
                    variant="primary"
                    disabled={!!pending || failed || !checked.length}
                    loading={pending === 'batch-build'}
                    onClick={() => void buildSelected()}
                  >
                    {t('cindyMake.history.batch.selected', { count: checked.length })}
                  </Button>
                </div>
              )}
            </div>
            {selecting && (
              <div className="flex flex-wrap items-center gap-3 text-12 text-[var(--text-secondary)]">
                <label className="flex min-h-8 cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={allChecked}
                    disabled={!!pending || !selectable.length}
                    ref={(node) => {
                      if (node)
                        node.indeterminate =
                          !allChecked && selectable.some((item) => checkedIds.includes(item.runId));
                    }}
                    className="size-4 accent-[var(--confirm-btn-primary-bg)]"
                    onChange={() =>
                      setCheckedIds((previous) =>
                        allChecked
                          ? previous.filter((id) => !selectable.some((item) => item.runId === id))
                          : [...new Set([...previous, ...selectable.map((item) => item.runId)])],
                      )
                    }
                  />
                  {t('cindyMake.history.batch.selectAll')}
                </label>
                <span>{t('cindyMake.history.batch.hint')}</span>
              </div>
            )}
          </>
        )}
        {building && state?.build && (
          <div
            role="status"
            aria-live="polite"
            className="space-y-3 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated-soft)] p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-2">
                <Spinner size={16} className="mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <p className="font-medium">{t(cindyMakeBuildStatusKey(state.build, stopping))}</p>
                  {state.batch && (
                    <p className="text-12 text-[var(--text-secondary)]">
                      {t('cindyMake.history.batch.progress', {
                        current: state.batch.current,
                        total: state.batch.total,
                        title: formatCindyMakeTitle(state.batch.title, state.batch.runId),
                      })}
                    </p>
                  )}
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
            <CindyMakeBuildProgress build={state.build} />
            <CindyMakeBuildLog build={state.build} />
          </div>
        )}
        {showGlobalResult && state?.build?.status === 'failed' && (
          <div className="space-y-3">
            <CindyMakeBuildFailure build={state.build} />
            <CindyMakeBuildProgress build={state.build} />
            <CindyMakeBuildLog build={state.build} />
          </div>
        )}
        {showGlobalResult && state?.build?.status === 'ready' && (
          <div className="space-y-2">
            <p role="status" className="text-12 text-[var(--text-secondary)]">
              {t(
                !state.build.versionId
                  ? 'cindyMake.history.buildStatus.installerReady'
                  : cindyMakeBuildStatusKey(state.build),
              )}
            </p>
            <CindyMakeBuildProgress build={state.build} />
          </div>
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
      <div className="cindy-make-history-layout grid min-w-0">
        <ul
          aria-label={t('cindyMake.history.title')}
          className="cindy-make-history-list min-h-0 space-y-1 overflow-y-auto overscroll-contain border-b border-[var(--border-default)] p-2"
        >
          {visible.map((item) => (
            <li key={item.runId} className="flex items-center gap-1">
              {selecting && (
                <label className="flex min-h-8 min-w-8 shrink-0 cursor-pointer items-center justify-center">
                  <input
                    type="checkbox"
                    checked={checked.some((entry) => entry.runId === item.runId)}
                    disabled={!!pending || !item.canSelectForBuild}
                    aria-label={t('cindyMake.history.batch.selectItem', {
                      title: formatCindyMakeTitle(item.title, item.runId),
                    })}
                    className="size-4 accent-[var(--confirm-btn-primary-bg)]"
                    onChange={(event) =>
                      setCheckedIds((previous) =>
                        event.target.checked
                          ? [...new Set([...previous, item.runId])]
                          : previous.filter((id) => id !== item.runId),
                      )
                    }
                  />
                </label>
              )}
              <button
                type="button"
                aria-pressed={selected?.runId === item.runId}
                onClick={() => select(item.runId)}
                className={cn(
                  'cindy-make-history-row flex w-full min-w-0 flex-col justify-center gap-0.5 rounded-lg border px-3 py-2 text-left',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]',
                  selected?.runId === item.runId
                    ? 'border-[var(--settings-menu-border-selected)] bg-[var(--settings-menu-bg-selected)] text-[var(--settings-menu-text-selected)]'
                    : 'border-transparent hover:bg-[var(--settings-menu-bg-hover)]',
                )}
              >
                <span className="w-full truncate font-medium">
                  {formatCindyMakeTitle(item.title, item.runId)}
                </span>
                <span className="w-full truncate text-12 text-[var(--text-secondary)]">
                  {t(statusKey(item))}
                </span>
                <span className="w-full truncate text-12 text-[var(--text-tertiary)]">
                  {date(item.createdAt)}
                </span>
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
          <div className="flex min-h-0 min-w-0 flex-col overflow-y-auto overscroll-contain">
            <div className="cindy-make-history-detail min-h-0 shrink-0 space-y-3 p-4">
              {!selected.completions.length && (
                <h4 className="break-words font-medium">
                  {formatCindyMakeTitle(selected.title, selected.runId)}
                </h4>
              )}
              <p className="text-12 text-[var(--text-tertiary)]">
                {t('cindyMake.history.updated', { time: date(selected.updatedAt) })}
              </p>
              <p
                role={selectedError ? 'alert' : 'status'}
                className={cn(
                  'text-12',
                  selectedError ? 'text-[var(--error-fg)]' : 'text-[var(--text-secondary)]',
                )}
              >
                {t(
                  selectedError ??
                    (selected.actionReason && !selectedBuild && !selected.test
                      ? 'cindyMake.history.noActions.' + selected.actionReason
                      : statusKey(selected)),
                )}
              </p>
              <CindyMakeTestStep test={selected.test} />
              {!selectedIsGlobalFailure && (
                <>
                  <CindyMakeBuildFailure build={selectedBuild} />
                  {selectedBuild && ['ready', 'failed'].includes(selectedBuild.status) && (
                    <CindyMakeBuildProgress build={selectedBuild} />
                  )}
                  <CindyMakeBuildLog build={selectedBuild} />
                </>
              )}
              {!selected.completions.length &&
                formatCindyMakeTitle(selected.request.trim(), selected.runId) !==
                  formatCindyMakeTitle(selected.title.trim(), selected.runId) && (
                  <p className="whitespace-pre-wrap break-words">{selected.request}</p>
                )}
              {!!selected.completions.length && (
                <details>
                  <summary className="min-h-8 cursor-pointer py-2 text-12 text-[var(--text-secondary)]">
                    {t('cindyMake.history.rounds', { count: selected.completions.length })}
                  </summary>
                  <ol className="mt-2 space-y-2">
                    {selected.completions.toReversed().map((completion, index) => (
                      <li key={completion.id} className="text-12 text-[var(--text-secondary)]">
                        <div>
                          {t('cindyMake.history.round', {
                            number: selected.completions.length - index,
                            time: date(completion.reportedAt),
                          })}
                          {completion.changedFiles !== undefined &&
                            ' · ' +
                              t('cindyMake.history.files', { count: completion.changedFiles })}
                        </div>
                        {typeof completion.prompt === 'string' && completion.prompt.trim() && (
                          <p className="mt-1 whitespace-pre-wrap break-words text-[var(--text-primary)]">
                            {completion.prompt}
                          </p>
                        )}
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap gap-2 border-t border-[var(--border-default)] p-4">
              {selectedActions.map((action) => (
                <Button
                  key={action}
                  variant={action === 'retry' ? 'primary' : 'secondary'}
                  disabled={!!pending || failed}
                  loading={pending === action}
                  onClick={() => void act(action)}
                >
                  {t(
                    action === 'hide'
                      ? 'cindyMake.history.cleanTask'
                      : action === 'test'
                        ? selected.test?.status === 'ready'
                          ? 'cindyMake.history.batch.restartTest'
                          : 'cindyMake.test.start'
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
