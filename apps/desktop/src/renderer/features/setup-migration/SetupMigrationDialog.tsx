/**
 * New-computer setup wizard (docs/product-rules/new-device-setup-migration.md).
 *
 * 1. Pick another computer on this account. 2. Review what will be copied; values this
 * computer already changed are kept. 3. Confirm plugin permissions once, then apply:
 * Main installs plugins/skills, writes settings files and, when chosen, asks the other computer
 * to copy keys and authorize this computer's new SSH key (a person there allows it); this window
 * applies what its settings pages already own. 4. Show the result and what must still be done
 * here once (sign-ins, OS permissions), which can be walked one by one.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import * as Dialog from '@radix-ui/react-dialog';
import { AlertCircle, Check, Laptop, Minus, Monitor, X } from 'lucide-react';

import { WINDOW_DRAG_STYLE, WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/ui/error-notice';
import { Spinner } from '@/components/ui/spinner';
import { GhostInstallConsentContent } from '@/cindy-brain/GhostInstallConsentHost';
import { useDialogExit } from '@/hooks/useDialogExit';
import { getDataOwnerGeneration, isDataOwnerIdCurrent } from '@/contexts/dataOwnerGeneration';
import { createCustomProvider } from '@/lib/customProviders';
import { cn } from '@/lib/utils';
import { extractIpcError } from '@/utils/ipcError';
import {
  type SetupMigrationChecklistItem,
  type SetupMigrationItemState,
  type SetupMigrationPlan,
  type SetupMigrationResult,
  type SetupMigrationSecretRef,
  type SetupMigrationSource,
} from '../../../shared/setupMigration';
import { applyRendererItems } from './applyRendererItems';
import { BUILTIN_KEY_NAMES, openChecklistRoute } from './checklistTargets';
import { applyPortableRendererPrefs } from './rendererPrefs';
import {
  SetupMigrationChecklist,
  checklistItemTitle,
  startChecklistWalkthrough,
} from './SetupMigrationChecklist';
import {
  closeSetupMigration,
  notifySetupMigrationStateChanged,
  useSetupMigrationDialog,
} from './setupMigrationStore';

type Phase = 'source' | 'reading' | 'review' | 'permissions' | 'running' | 'done';
type ItemPhase = 'pending' | 'running' | SetupMigrationResult['outcome'];

interface ReviewRow {
  key: string;
  title: string;
  meta?: string;
  state: SetupMigrationItemState;
}

interface ReviewGroup {
  id: string;
  title: string;
  description?: string;
  rows: ReviewRow[];
}

const READ_ERROR_CODES = new Set([
  'SETUP_SOURCE_OUTDATED',
  'SETUP_SOURCE_UNAVAILABLE',
  'SETUP_SNAPSHOT_INVALID',
  'SETUP_PLAN_EXPIRED',
]);

function SelectionCheckbox({
  checked,
  indeterminate = false,
  disabled = false,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(event) => onChange(event.target.checked)}
      className="size-3.5 shrink-0 cursor-pointer accent-[var(--confirm-btn-primary-bg)] disabled:cursor-default"
    />
  );
}

function PhaseIcon({ phase }: { phase: ItemPhase }) {
  if (phase === 'running') return <Spinner size={14} className="text-[var(--confirm-desc)]" />;
  if (phase === 'done') return <Check size={14} className="text-[var(--status-success)]" aria-hidden="true" />;
  if (phase === 'failed') return <X size={14} className="text-[var(--text-danger)]" aria-hidden="true" />;
  if (phase === 'skipped') return <Minus size={14} className="text-[var(--confirm-desc)]" aria-hidden="true" />;
  return <span className="inline-block size-3.5 shrink-0" aria-hidden="true" />;
}

export function SetupMigrationDialog() {
  const { open, deviceId, session } = useSetupMigrationDialog();
  if (!open) return null;
  return <SetupMigrationDialogBody key={session} initialDeviceId={deviceId} />;
}

function SetupMigrationDialogBody({ initialDeviceId }: { initialDeviceId: string | null }) {
  const { t } = useTranslation();
  const dialog = useDialogExit();
  // One bridge object for this dialog's lifetime; effects must not re-run when the
  // host hands back a fresh wrapper on each property read.
  const api = useMemo(() => window.electronAPI.setupMigration, []);
  const [phase, setPhase] = useState<Phase>(initialDeviceId ? 'reading' : 'source');
  const [sources, setSources] = useState<SetupMigrationSource[] | null>(null);
  const [sourcesFailed, setSourcesFailed] = useState(false);
  const [deviceId, setDeviceId] = useState<string | null>(initialDeviceId);
  const [plan, setPlan] = useState<SetupMigrationPlan | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [toolNames, setToolNames] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [itemPhases, setItemPhases] = useState<ReadonlyMap<string, ItemPhase>>(() => new Map());
  const [results, setResults] = useState<SetupMigrationResult[]>([]);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [checklist, setChecklist] = useState<SetupMigrationChecklistItem[]>([]);
  const [prefsChanged, setPrefsChanged] = useState(false);
  /** Code the other computer shows while it is asked to allow keys / SSH. */
  const [confirm, setConfirm] = useState<{ key: string; code: string } | null>(null);
  const busy = phase === 'reading' || phase === 'running';
  const busyRef = useRef(false);
  busyRef.current = busy;

  const close = useCallback(() => {
    if (busyRef.current) return;
    dialog.close(() => closeSetupMigration());
  }, [dialog]);

  const sourceName = useMemo(() => {
    if (plan) return plan.source.name;
    return sources?.find((source) => source.deviceId === deviceId)?.name ?? '';
  }, [deviceId, plan, sources]);

  const loadSources = useCallback(() => {
    setSources(null);
    setSourcesFailed(false);
    api
      .sources()
      .then((list) => {
        setSources(list);
        setDeviceId((current) => current ?? list.find((source) => !source.unavailable)?.deviceId ?? null);
      })
      .catch(() => setSourcesFailed(true));
  }, [api]);

  useEffect(() => {
    loadSources();
    window.electronAPI.maker.plugins
      .list(undefined, true)
      .then((items) => setToolNames(new Map(items.map((item) => [item.id, item.name]))))
      .catch(() => {});
  }, [loadSources]);

  const read = useCallback(
    (target: string) => {
      setPhase('reading');
      setReadError(null);
      api
        .preview(target)
        .then((next) => {
          setPlan(next);
          setSelected(new Set(defaultSelection(next)));
          setPhase('review');
        })
        .catch((error: unknown) => {
          const code = extractIpcError(error)?.code;
          setReadError(code && READ_ERROR_CODES.has(code) ? code : 'GENERIC');
          setPhase('source');
        });
    },
    [api],
  );

  useEffect(() => {
    if (initialDeviceId) read(initialDeviceId);
  }, [initialDeviceId, read]);

  const groups = useMemo(() => (plan ? buildReviewGroups(plan, t, toolNames) : []), [plan, t, toolNames]);
  const presentCount = useMemo(
    () => groups.reduce((sum, group) => sum + group.rows.filter((row) => row.state === 'present').length, 0),
    [groups],
  );
  const selectableKeys = useMemo(
    () => groups.flatMap((group) => group.rows.filter((row) => row.state === 'ready').map((row) => row.key)),
    [groups],
  );
  const selectedCount = selectableKeys.filter((key) => selected.has(key)).length;
  const consentPlugins = useMemo(
    () =>
      plan?.plugins.filter((item) => item.state === 'ready' && item.consent && selected.has(item.key)) ?? [],
    [plan, selected],
  );

  const toggle = (keys: string[], checked: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous);
      for (const key of keys) {
        if (checked) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  };

  const runApply = async (approvedPluginKeys: string[]) => {
    if (!plan || busyRef.current) return;
    busyRef.current = true;
    setPhase('running');
    const keys = selectableKeys.filter((key) => selected.has(key));
    const keySet = new Set(keys);
    setItemPhases(new Map(keys.map((key) => [key, 'pending' as ItemPhase])));
    const mark = (key: string, next: ItemPhase) =>
      setItemPhases((previous) => new Map(previous).set(key, next));
    const stop = api.onProgress((progress) => {
      if (progress.planId !== plan.planId) return;
      mark(progress.key, progress.phase);
      if (progress.confirmCode) setConfirm({ key: progress.key, code: progress.confirmCode });
      else if (progress.phase !== 'running') setConfirm((current) => (current?.key === progress.key ? null : current));
    });
    const collected: SetupMigrationResult[] = [];
    let nextChecklist = plan.checklist;
    let handledKeys: ReadonlySet<string> = new Set();
    // The dialog lives outside the owner-scoped routes, so the account it previewed for is
    // pinned here; Main re-checks the same plan (account, window, expiry, single use).
    const owner = getDataOwnerGeneration();
    let planRejected: string | null = null;
    try {
      // Always through Main, even for renderer-only items: it is the one check that this
      // plan is still valid for this account and window.
      const response = await api.apply({ planId: plan.planId, keys, approvedPluginKeys });
      collected.push(...response.results);
      nextChecklist = response.checklist;
      // Connections Main already created with their copied keys.
      handledKeys = new Set(response.handledKeys ?? []);
    } catch (error) {
      planRejected = extractIpcError(error)?.code ?? 'FAILED';
      setApplyError(planRejected);
    } finally {
      stop();
      setConfirm(null);
    }
    if (planRejected) {
      // Nothing else is written from a plan Main refused.
      for (const key of keys) collected.push({ key, outcome: 'failed', code: planRejected });
      setResults(collected);
      setPrefsChanged(false);
      setChecklist(nextChecklist);
      busyRef.current = false;
      setPhase('done');
      notifySetupMigrationStateChanged();
      return;
    }
    const renderer = await applyRendererItems(
      plan,
      new Set([...keySet].filter((key) => !handledKeys.has(key))),
      {
        isCurrent: () => isDataOwnerIdCurrent(owner),
        createProvider: (config) => createCustomProvider(config, {}),
        createMcpServer: (config) => window.electronAPI.maker.createCustomMcpServer(config),
        setBuiltinTool: (id, enabled) => window.electronAPI.maker.plugins.setEnabled(id, enabled),
        setRemoteControl: (enabled) => window.electronAPI.deviceLink.setEnabled(enabled),
        setKeepAwake: (enabled) => window.electronAPI.deviceLink.setKeepAwake(enabled),
        applyPrefs: (values) => applyPortableRendererPrefs(values),
      },
      (progress) => mark(progress.key, progress.phase),
      { completed: collected.length, total: keys.length },
    );
    collected.push(...renderer.results);
    setResults(collected);
    setPrefsChanged(renderer.prefsChanged);
    setChecklist(nextChecklist);
    busyRef.current = false;
    setPhase('done');
    notifySetupMigrationStateChanged();
  };

  const startApply = () => {
    if (consentPlugins.length > 0) setPhase('permissions');
    else void runApply([]);
  };

  const finish = () => {
    if (prefsChanged) {
      // Interface preferences are read when the window starts.
      window.location.reload();
      return;
    }
    close();
  };

  const openChecklistItem = (item: SetupMigrationChecklistItem) => {
    dialog.close(() => {
      closeSetupMigration();
      openChecklistRoute(item);
    });
  };

  const walkChecklist = () => {
    dialog.close(() => {
      closeSetupMigration();
      startChecklistWalkthrough(checklist, openChecklistRoute);
    });
  };

  const steps = [
    t('setupMigration.steps.source'),
    t('setupMigration.steps.review'),
    t('setupMigration.steps.apply'),
  ];
  const stepIndex = phase === 'source' || phase === 'reading' ? 1 : phase === 'review' || phase === 'permissions' ? 2 : 3;
  const doneCount = results.filter((result) => result.outcome === 'done').length;
  const failed = results.filter((result) => result.outcome === 'failed');
  const settingsApplied = results.some((result) => result.key.startsWith('settings:') && result.outcome === 'done');
  const labelOf = (key: string) =>
    groups.flatMap((group) => group.rows).find((row) => row.key === key)?.title ?? key;

  let body: ReactNode = null;
  if (phase === 'source') {
    body = (
      <div className="flex flex-col gap-3">
        <p className="text-13 leading-[1.5] text-[var(--confirm-desc)]">{t('setupMigration.source.description')}</p>
        {readError ? (
          <ErrorNotice
            message={t(`setupMigration.errors.${readError}`, { name: sourceName })}
            actions={
              deviceId ? (
                <Button variant="secondary" size="sm" compact onClick={() => read(deviceId)}>
                  {t('setupMigration.source.readAgain')}
                </Button>
              ) : undefined
            }
          />
        ) : null}
        {sourcesFailed ? (
          <ErrorNotice
            message={t('setupMigration.source.loadFailed')}
            actions={
              <Button variant="secondary" size="sm" compact onClick={loadSources}>
                {t('setupMigration.source.reload')}
              </Button>
            }
          />
        ) : sources === null ? (
          <div className="flex items-center gap-2 py-6 text-13 text-[var(--confirm-desc)]">
            <Spinner size={14} />
            {t('setupMigration.source.loading')}
          </div>
        ) : sources.length === 0 ? (
          <p className="py-6 text-13 text-[var(--confirm-desc)]">{t('setupMigration.source.empty')}</p>
        ) : (
          <ul role="radiogroup" aria-label={t('setupMigration.steps.source')} className="flex flex-col gap-1">
            {sources.map((source) => {
              const Icon = source.platform === 'darwin' ? Laptop : Monitor;
              const checked = deviceId === source.deviceId;
              return (
                <li key={source.deviceId}>
                  <label
                    className={cn(
                      'flex items-center gap-3 rounded-lg p-2',
                      source.unavailable ? 'cursor-default' : 'cursor-pointer hover:bg-[var(--surface-hover)]',
                    )}
                  >
                    <input
                      type="radio"
                      name="setup-migration-source"
                      checked={checked}
                      disabled={Boolean(source.unavailable)}
                      onChange={() => setDeviceId(source.deviceId)}
                      className="size-3.5 shrink-0 cursor-pointer accent-[var(--confirm-btn-primary-bg)] disabled:cursor-default"
                    />
                    <Icon size={16} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-[var(--confirm-desc)]" />
                    <span className={cn('flex min-w-0 flex-1 flex-col', source.unavailable && 'opacity-60')}>
                      <span className="truncate text-13 font-medium text-[var(--confirm-title)]">{source.name}</span>
                      <span className="text-12 text-[var(--confirm-desc)]">
                        {source.unavailable
                          ? t(`setupMigration.source.unavailable.${source.unavailable}`)
                          : t('setupMigration.source.ready')}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  } else if (phase === 'reading') {
    body = (
      <div className="flex min-h-[200px] items-center justify-center gap-2 text-13 text-[var(--confirm-desc)]">
        <Spinner size={14} />
        {t('setupMigration.reading', { name: sourceName })}
      </div>
    );
  } else if (phase === 'review' && plan) {
    body = (
      <div className="flex flex-col gap-4">
        <p className="text-13 leading-[1.5] text-[var(--confirm-desc)]">
          {t('setupMigration.review.description', { name: plan.source.name })}
        </p>
        {plan.unavailable.length > 0 ? (
          <p className="text-12 leading-[1.5] text-[var(--confirm-desc)]">{t('setupMigration.review.partial')}</p>
        ) : null}
        {groups.map((group) => {
          const visible = group.rows.filter((row) => row.state !== 'present');
          if (visible.length === 0) return null;
          const ready = visible.filter((row) => row.state === 'ready').map((row) => row.key);
          const checkedCount = ready.filter((key) => selected.has(key)).length;
          return (
            <section key={group.id} aria-label={group.title}>
              <div className="flex items-center justify-between px-2 pb-1">
                <label className="flex cursor-pointer items-center gap-2.5 text-13 font-medium text-[var(--confirm-title)]">
                  {ready.length > 0 ? (
                    <SelectionCheckbox
                      checked={checkedCount === ready.length}
                      indeterminate={checkedCount > 0 && checkedCount < ready.length}
                      onChange={(checked) => toggle(ready, checked)}
                    />
                  ) : null}
                  {group.title}
                </label>
                <span className="text-12 text-[var(--confirm-desc)]">
                  {t('setupMigration.review.groupCount', { selected: checkedCount, total: ready.length })}
                </span>
              </div>
              {group.description ? (
                <p className="px-2 pb-1.5 text-12 leading-[1.5] text-[var(--confirm-desc)]">{group.description}</p>
              ) : null}
              <ul className="border-y border-[var(--border-default)] py-1">
                {visible.map((row) => {
                  const selectable = row.state === 'ready';
                  return (
                    <li key={row.key}>
                      <label
                        className={cn(
                          'flex items-center gap-2.5 rounded-lg p-2',
                          selectable ? 'cursor-pointer hover:bg-[var(--surface-hover)]' : 'cursor-default',
                        )}
                      >
                        <SelectionCheckbox
                          checked={selectable && selected.has(row.key)}
                          disabled={!selectable}
                          ariaLabel={row.title}
                          onChange={(checked) => toggle([row.key], checked)}
                        />
                        <span className={cn('min-w-0 flex-1', !selectable && 'opacity-60')}>
                          <span className="block break-words text-13 text-[var(--confirm-title)]">{row.title}</span>
                          {row.meta ? (
                            <span className="mt-0.5 block break-words text-12 text-[var(--confirm-desc)]">{row.meta}</span>
                          ) : null}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
        {presentCount > 0 ? (
          <p className="px-2 text-12 text-[var(--confirm-desc)]">
            {t('setupMigration.review.present', { count: presentCount })}
          </p>
        ) : null}
        {plan.checklist.length > 0 ? (
          <section aria-label={t('setupMigration.review.checklistTitle')}>
            <h3 className="px-2 pb-1 text-13 font-medium text-[var(--confirm-title)]">
              {t('setupMigration.review.checklistTitle')}
            </h3>
            <p className="px-2 pb-1 text-12 leading-[1.5] text-[var(--confirm-desc)]">
              {plan.secrets
                ? t('setupMigration.review.checklistDescriptionWithKeys', { name: plan.source.name })
                : t('setupMigration.review.checklistDescription')}
            </p>
            <ul className="border-y border-[var(--border-default)] px-2 py-1">
              {plan.checklist.map((item) => (
                <li key={item.id} className="py-1.5 text-13 text-[var(--confirm-title)]">
                  {checklistItemTitle(t, item)}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    );
  } else if (phase === 'permissions') {
    body = (
      <div className="flex flex-col gap-4">
        <p className="text-13 leading-[1.5] text-[var(--confirm-desc)]">
          {t('setupMigration.permissions.description', { count: consentPlugins.length })}
        </p>
        {consentPlugins.map((item) => (
          <section key={item.key} className="rounded-xl border border-[var(--border-default)] p-3">
            <h3 className="pb-2 text-13 font-medium text-[var(--confirm-title)]">
              {t('setupMigration.permissions.pluginTitle', { name: item.name, version: item.version })}
            </h3>
            {item.consent ? <GhostInstallConsentContent facts={item.consent} /> : null}
          </section>
        ))}
      </div>
    );
  } else if (phase === 'running') {
    const total = itemPhases.size;
    const completed = [...itemPhases.values()].filter((value) => value !== 'pending' && value !== 'running').length;
    body = (
      <div className="flex flex-col gap-3">
        <p className="text-13 text-[var(--confirm-desc)]" aria-live="polite">
          {t('setupMigration.running.progress', { completed, total })}
        </p>
        {confirm ? (
          <div role="status" className="rounded-xl border border-[var(--border-default)] p-3">
            <p className="text-13 leading-[1.5] text-[var(--confirm-title)]">
              {t('setupMigration.running.confirm', { name: sourceName })}
            </p>
            <p className="pt-1 text-12 text-[var(--confirm-desc)]">
              {t('setupMigration.running.confirmCode')}{' '}
              <span className="select-text font-mono text-16 font-medium tracking-[0.2em] text-[var(--confirm-title)]">
                {confirm.code}
              </span>
            </p>
          </div>
        ) : null}
        <ul className="flex flex-col">
          {[...itemPhases.entries()].map(([key, value]) => (
            <li key={key} className="flex items-center gap-2.5 py-1.5 text-13 text-[var(--confirm-title)]">
              <PhaseIcon phase={value} />
              <span className="min-w-0 flex-1 truncate">{labelOf(key)}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  } else if (phase === 'done') {
    body = (
      <div className="flex flex-col gap-4">
        <p className="text-13 leading-[1.5] text-[var(--confirm-title)]" role="status">
          {t('setupMigration.done.summary', { count: doneCount, name: sourceName })}
        </p>
        {applyError ? (
          <ErrorNotice message={t('setupMigration.done.applyFailed')} details={applyError} />
        ) : null}
        {failed.length > 0 ? (
          <section aria-label={t('setupMigration.done.failedTitle', { count: failed.length })}>
            <h3 className="pb-1 text-13 font-medium text-[var(--confirm-title)]">
              {t('setupMigration.done.failedTitle', { count: failed.length })}
            </h3>
            <ul className="flex flex-col">
              {failed.map((result) => (
                <li key={result.key} className="flex items-start gap-2.5 py-1.5">
                  <AlertCircle size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--text-danger)]" />
                  <span className="min-w-0 flex-1 select-text">
                    <span className="block break-words text-13 text-[var(--confirm-title)]">{labelOf(result.key)}</span>
                    <span className="block break-words text-12 text-[var(--confirm-desc)]">
                      {t(`setupMigration.failure.${result.code ?? 'FAILED'}`, {
                        defaultValue: t('setupMigration.failure.generic', { code: result.code ?? 'FAILED' }),
                      })}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <section aria-label={t('setupMigration.done.checklistTitle')}>
          <h3 className="pb-1 text-13 font-medium text-[var(--confirm-title)]">
            {t('setupMigration.done.checklistTitle')}
          </h3>
          {checklist.length === 0 ? (
            <p className="text-13 text-[var(--confirm-desc)]">{t('setupMigration.done.checklistEmpty')}</p>
          ) : (
            <>
              <p className="pb-1 text-12 leading-[1.5] text-[var(--confirm-desc)]">
                {t('setupMigration.done.checklistDescription')}
              </p>
              <SetupMigrationChecklist
                items={checklist}
                variant="dialog"
                onOpen={openChecklistItem}
                onStartAll={walkChecklist}
              />
            </>
          )}
        </section>
        {settingsApplied ? (
          <p className="text-12 leading-[1.5] text-[var(--confirm-desc)]">{t('setupMigration.done.restartHint')}</p>
        ) : null}
      </div>
    );
  }

  const back =
    phase === 'review'
      ? () => {
          setPlan(null);
          setPhase('source');
        }
      : phase === 'permissions'
        ? () => setPhase('review')
        : null;

  return (
    <Dialog.Root open={dialog.open} onOpenChange={(next) => { if (!next) close(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-[10000]" style={WINDOW_DRAG_STYLE} />
        <Dialog.Content
          aria-describedby={undefined}
          onPointerDownOutside={(event) => event.preventDefault()}
          onOpenAutoFocus={dialog.onOpenAutoFocus}
          onCloseAutoFocus={dialog.onCloseAutoFocus}
          onEscapeKeyDown={(event) => {
            if (busyRef.current || event.isComposing) event.preventDefault();
          }}
          style={WINDOW_NO_DRAG_STYLE}
          className="modal-panel fixed inset-0 z-[10000] m-auto flex h-fit max-h-[min(640px,85vh)] w-[min(600px,calc(100vw-32px))] flex-col overflow-hidden outline-none"
        >
          <div className="flex items-center justify-between gap-4 px-4 pb-3 pt-4">
            <Dialog.Title asChild>
              <h2 className="min-w-0 truncate text-16 font-medium text-[var(--confirm-title)]">
                {phase === 'permissions' ? t('setupMigration.permissions.title') : t('setupMigration.title')}
              </h2>
            </Dialog.Title>
            <ol className="flex shrink-0 items-center gap-4" aria-label={t('setupMigration.steps.label')}>
              {steps.map((label, index) => {
                const n = index + 1;
                const current = n === stepIndex;
                const done = n < stepIndex || (phase === 'done' && n === stepIndex);
                return (
                  <li
                    key={label}
                    aria-current={current ? 'step' : undefined}
                    className={cn(
                      'flex items-center gap-1.5 text-12',
                      current ? 'text-[var(--confirm-title)]' : 'text-[var(--confirm-desc)]',
                    )}
                  >
                    <span
                      className={cn(
                        'flex h-[18px] w-[18px] items-center justify-center rounded-full border text-10 font-medium',
                        current && !done
                          ? 'border-[var(--accent-cta-bg)] bg-[var(--accent-cta-bg)] text-[var(--surface-on-card)]'
                          : done
                            ? 'border-[var(--surface-chip)] bg-[var(--surface-chip)] text-[var(--text-secondary)]'
                            : 'border-[var(--border-default)]',
                      )}
                    >
                      {done ? <Check size={10} aria-hidden="true" /> : n}
                    </span>
                    <span className={cn('hidden sm:inline', current && 'font-medium')}>{label}</span>
                  </li>
                );
              })}
            </ol>
          </div>

          <div className="min-h-[240px] flex-1 overflow-y-auto border-y border-[var(--border-default)] px-4 py-4">
            {body}
          </div>

          <div className="flex items-center justify-between px-4 pb-4 pt-3">
            <button
              type="button"
              onClick={back ?? undefined}
              className={cn(
                'text-13 font-medium text-[var(--text-secondary)] transition-opacity hover:opacity-80',
                !back && 'invisible',
              )}
            >
              {t('setupMigration.back')}
            </button>
            <div className="flex items-center gap-2.5">
              {phase !== 'done' ? (
                <Button variant="secondary" size="lg" type="button" onClick={close} disabled={busy}>
                  {t('setupMigration.cancel')}
                </Button>
              ) : null}
              {phase === 'source' || phase === 'reading' ? (
                <Button
                  variant="cta"
                  size="lg"
                  type="button"
                  loading={phase === 'reading'}
                  disabled={!deviceId || phase === 'reading' || Boolean(sources?.find((s) => s.deviceId === deviceId)?.unavailable)}
                  onClick={() => deviceId && read(deviceId)}
                >
                  {t('setupMigration.source.next')}
                </Button>
              ) : null}
              {phase === 'review' ? (
                <Button
                  variant="cta"
                  size="lg"
                  type="button"
                  // A checklist alone still continues, so it reaches the done page and Settings.
                  disabled={selectedCount === 0 && plan?.checklist.length === 0}
                  onClick={startApply}
                >
                  {selectedCount === 0
                    ? t('setupMigration.review.continue')
                    : t('setupMigration.review.start', { count: selectedCount })}
                </Button>
              ) : null}
              {phase === 'permissions' ? (
                <Button
                  variant="cta"
                  size="lg"
                  type="button"
                  onClick={() => void runApply(consentPlugins.map((item) => item.key))}
                >
                  {t('setupMigration.permissions.confirm', { count: consentPlugins.length })}
                </Button>
              ) : null}
              {phase === 'running' ? (
                <Button variant="cta" size="lg" type="button" loading disabled>
                  {t('setupMigration.running.label')}
                </Button>
              ) : null}
              {phase === 'done' ? (
                <Button variant="cta" size="lg" type="button" onClick={finish}>
                  {prefsChanged ? t('setupMigration.done.finishReload') : t('setupMigration.done.finish')}
                </Button>
              ) : null}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function defaultSelection(plan: SetupMigrationPlan): string[] {
  return [
    ...plan.plugins,
    ...plan.skills,
    ...plan.settings,
    ...(plan.rendererPrefs ? [plan.rendererPrefs] : []),
    ...plan.providers,
    ...plan.mcpServers,
    ...plan.builtinTools,
    ...plan.access,
    ...(plan.secrets ? [plan.secrets] : []),
    ...(plan.sshHosts ?? []),
  ]
    .filter((item) => item.state === 'ready')
    .map((item) => item.key);
}

function secretName(item: SetupMigrationSecretRef): string {
  return item.kind === 'builtin' ? (BUILTIN_KEY_NAMES[item.ref] ?? item.name) : item.name;
}

export function buildReviewGroups(
  plan: SetupMigrationPlan,
  t: ReturnType<typeof useTranslation>['t'],
  toolNames: ReadonlyMap<string, string>,
): ReviewGroup[] {
  const reasonMeta = (reason?: string) =>
    reason ? t(`setupMigration.review.reason.${reason}`) : t('setupMigration.review.kept');
  const plugins: ReviewRow[] = plan.plugins.map((item) => ({
    key: item.key,
    title: item.name,
    state: item.state,
    meta:
      item.state === 'unavailable'
        ? reasonMeta(item.reason)
        : item.consent === null && item.state === 'ready' && item.source === 'custom-market'
          ? t('setupMigration.review.pluginConsentLater', { market: item.marketName ?? '' })
          : !item.enabledOnSource
            ? t('setupMigration.review.pluginDisabled')
            : item.version
              ? t('setupMigration.review.version', { version: item.version })
              : undefined,
  }));
  const skills: ReviewRow[] = plan.skills.map((item) => ({
    key: item.key,
    title: item.name,
    state: item.state,
    meta:
      item.state === 'unavailable'
        ? reasonMeta(item.reason)
        : item.catalogScope === 'team'
          ? t('setupMigration.review.skillTeam')
          : undefined,
  }));
  const settings: ReviewRow[] = [
    ...plan.settings.map((item) => ({
      key: item.key,
      title: t(`setupMigration.settingsGroups.${item.id}`, { defaultValue: item.id }),
      state: item.state,
      meta:
        item.state === 'kept'
          ? t('setupMigration.review.settingsKept', { count: item.keptCount })
          : item.keptCount > 0
            ? t('setupMigration.review.settingsChangesKept', { count: item.changeCount, kept: item.keptCount })
            : t('setupMigration.review.settingsChanges', { count: item.changeCount }),
    })),
    ...(plan.rendererPrefs
      ? [
          {
            key: plan.rendererPrefs.key,
            title: t('setupMigration.review.rendererPrefs'),
            state: plan.rendererPrefs.state,
            meta: t('setupMigration.review.rendererPrefsHint'),
          },
        ]
      : []),
    ...plan.builtinTools.map((item) => ({
      key: item.key,
      title: t(item.enabled ? 'setupMigration.review.toolOn' : 'setupMigration.review.toolOff', {
        name: toolNames.get(item.id) ?? item.id,
      }),
      state: item.state,
      meta: item.state === 'kept' ? t('setupMigration.review.kept') : undefined,
    })),
  ];
  const copyable = new Set(
    (plan.secrets?.items ?? [])
      .filter((item) => item.kind === 'provider' || item.kind === 'mcp')
      .map((item) => `${item.kind}:${item.ref}`),
  );
  const connections: ReviewRow[] = [
    ...plan.providers.map((item) => ({
      key: item.key,
      title: item.provider.name,
      state: item.state,
      meta:
        item.state === 'unavailable'
          ? reasonMeta(item.reason)
          : copyable.has(`provider:${item.provider.id}`)
            ? t('setupMigration.review.providerAuth.apiKeyCopy')
            : t(`setupMigration.review.providerAuth.${item.provider.auth}`),
    })),
    ...plan.mcpServers.map((item) => ({
      key: item.key,
      title: item.server.name,
      state: item.state,
      meta: copyable.has(`mcp:${item.server.id}`)
        ? t('setupMigration.review.mcpTokenCopy', { url: safeHost(item.server.url) })
        : item.server.hasToken
          ? t('setupMigration.review.mcpToken', { url: safeHost(item.server.url) })
          : t('setupMigration.review.mcp', { url: safeHost(item.server.url) }),
    })),
  ];
  const secrets: ReviewRow[] = plan.secrets
    ? [
        {
          key: plan.secrets.key,
          title: t('setupMigration.review.secrets.title', { count: plan.secrets.items.length }),
          state: plan.secrets.state,
          meta: plan.secrets.items.map(secretName).join(t('setupMigration.listSeparator')),
        },
      ]
    : [];
  const ssh: ReviewRow[] = (plan.sshHosts ?? []).map((item) => ({
    key: item.key,
    title: item.displayName,
    state: item.state,
    meta: t('setupMigration.review.sshHost', { user: item.user, host: item.hostname, port: item.port }),
  }));
  const access: ReviewRow[] = plan.access.map((item) => ({
    key: item.key,
    title: t(`setupMigration.review.access.${item.id}`),
    state: item.state,
    meta: t(`setupMigration.review.access.${item.id}Hint`, { name: plan.source.name }),
  }));
  return [
    { id: 'plugins', title: t('setupMigration.review.groups.plugins'), rows: plugins },
    { id: 'skills', title: t('setupMigration.review.groups.skills'), rows: skills },
    { id: 'settings', title: t('setupMigration.review.groups.settings'), rows: settings },
    { id: 'connections', title: t('setupMigration.review.groups.connections'), rows: connections },
    {
      id: 'secrets',
      title: t('setupMigration.review.groups.secrets'),
      description: t('setupMigration.review.secrets.description', { name: plan.source.name }),
      rows: secrets,
    },
    {
      id: 'ssh',
      title: t('setupMigration.review.groups.ssh'),
      description: t('setupMigration.review.sshDescription', { name: plan.source.name }),
      rows: ssh,
    },
    { id: 'access', title: t('setupMigration.review.groups.access'), rows: access },
  ];
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
