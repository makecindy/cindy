import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pause, Play, X } from 'lucide-react';

import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import { Spinner } from '@/components/ui/spinner';
import type {
  CuratedOllamaModel,
  LocalInstalledModel,
  LocalModelPullPhase,
  LocalModelPullProgress,
  LocalRecommendReason,
  LocalRuntimeStatus,
} from '../../../shared/localModelRuntime';
import {
  classifyOllamaPullError,
  filterCuratedOllamaModels,
  isHfMlxPullName,
  normalizeOllamaPullName,
  ollamaModelRefsEqual,
} from '../../../shared/localModelRuntime';
import { DownloadMeter } from './DownloadMeter';
import { LocalOllamaInstall, offersManagedOllamaInstall } from './LocalOllamaInstall';
import { LocalPackagingTag } from './LocalPackagingTag';

function formatModelSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

function IconAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full outline-none transition-colors hover:opacity-80 focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
      style={{ backgroundColor: 'var(--surface-chip)', color: 'var(--text-secondary)' }}
    >
      {children}
    </button>
  );
}

function PullMeter({
  pull,
}: {
  pull: LocalModelPullProgress;
}) {
  const { t } = useTranslation();
  const pullPhase = (pull.phase ?? 'starting') as LocalModelPullPhase;
  const errorKind =
    pull.phase === 'error' ? classifyOllamaPullError(pull.error, pull.name) : null;
  return (
    <DownloadMeter
      progress={{
        label: errorKind
          ? t(`settings.providers.local.pullError.${errorKind}`)
          : t(`settings.providers.local.pullPhase.${pullPhase}`),
        percent: pull.percent,
        completed: pull.completed,
        total: pull.total,
        bytesPerSecond: pull.bytesPerSecond,
        error: pull.phase === 'error',
        paused: pull.phase === 'paused',
      }}
    />
  );
}

function PullActions({
  pull,
  onPause,
  onCancel,
  onResume,
}: {
  pull: LocalModelPullProgress;
  onPause?: () => void;
  onCancel?: () => void;
  onResume?: () => void;
}) {
  const { t } = useTranslation();
  const showControls =
    (onPause || onCancel || onResume) &&
    (pull.phase === 'paused' || !pull.done) &&
    pull.phase !== 'success' &&
    pull.phase !== 'error' &&
    pull.phase !== 'cancelled';
  if (!showControls) return null;
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {pull.phase === 'paused' ? (
        <IconAction label={t('settings.providers.local.resumeDownload')} onClick={onResume}>
          <Play size={13} fill="currentColor" />
        </IconAction>
      ) : (
        <IconAction label={t('settings.providers.local.pauseDownload')} onClick={onPause}>
          <Pause size={13} fill="currentColor" />
        </IconAction>
      )}
      <IconAction label={t('settings.providers.local.cancelDownload')} onClick={onCancel}>
        <X size={14} />
      </IconAction>
    </div>
  );
}

export function OllamaProviderDetail({ onChanged }: { onChanged: () => void }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<LocalRuntimeStatus | null>(null);
  const [models, setModels] = useState<LocalInstalledModel[]>([]);
  const [catalog, setCatalog] = useState<CuratedOllamaModel[]>([]);
  const [featured, setFeatured] = useState<CuratedOllamaModel[]>([]);
  const [memoryGb, setMemoryGb] = useState(0);
  const [recommendReason, setRecommendReason] = useState<LocalRecommendReason>('unknown');
  const [appleSilicon, setAppleSilicon] = useState(false);
  const [query, setQuery] = useState('');
  const [libraryName, setLibraryName] = useState('');
  const [busy, setBusy] = useState(false);
  const [pulls, setPulls] = useState<Record<string, LocalModelPullProgress>>({});

  const replaceListedPulls = useCallback((items: readonly LocalModelPullProgress[]) => {
    setPulls((current) => {
      const next: Record<string, LocalModelPullProgress> = {};
      for (const item of items) {
        if (item.phase === 'cancelled' || item.phase === 'success') continue;
        next[item.name] = item;
      }
      for (const [name, item] of Object.entries(current)) {
        if (!next[name] && item.phase === 'error') next[name] = item;
      }
      return next;
    });
  }, []);

  const upsertPull = useCallback((item: LocalModelPullProgress) => {
    setPulls((current) => {
      if (item.phase === 'cancelled' || item.phase === 'success') {
        if (!(item.name in current)) return current;
        const next = { ...current };
        delete next[item.name];
        return next;
      }
      return { ...current, [item.name]: item };
    });
  }, []);

  const refresh = useCallback(async () => {
    const result = await window.electronAPI.maker.localModelList();
    setStatus(result.status);
    setModels(result.models);
    setCatalog(result.catalog ?? []);
    setFeatured(result.featured ?? []);
    setMemoryGb(result.memoryGb ?? 0);
    setRecommendReason(result.recommendReason ?? 'unknown');
    setAppleSilicon(result.appleSilicon === true);
    replaceListedPulls(result.pulls ?? []);
    if (result.catalogDirty) onChanged();
  }, [onChanged, replaceListedPulls]);

  useEffect(() => {
    void refresh().catch(() => undefined);
    const offStatus = window.electronAPI.maker.onLocalModelStatus((next) => {
      setStatus(next as LocalRuntimeStatus);
    });
    const offPull = window.electronAPI.maker.onLocalModelPullProgress((next) => {
      upsertPull(next as LocalModelPullProgress);
    });
    return () => {
      offStatus();
      offPull();
    };
  }, [refresh, upsertPull]);

  const handleStart = async () => {
    setBusy(true);
    try {
      const next = await window.electronAPI.maker.localModelStart();
      setStatus(next);
      await refresh();
    } catch {
      toast.error(t('settings.providers.local.connectFailed'));
    } finally {
      setBusy(false);
    }
  };

  const handlePull = async (rawName: string) => {
    const name = normalizeOllamaPullName(rawName);
    if (!name) {
      toast.error(t('settings.providers.local.invalidLibraryName'));
      return;
    }
    if (isHfMlxPullName(name)) {
      upsertPull({ name, status: 'error', phase: 'error', done: true, error: 'not-gguf' });
      toast.error(t('settings.providers.local.pullError.not-gguf'));
      return;
    }
    upsertPull({ name, status: 'starting', phase: 'starting', done: false });
    try {
      const result = await window.electronAPI.maker.localModelPull(name);
      if (result.stopped) {
        await refresh();
        return;
      }
      upsertPull({ name, status: 'success', phase: 'success', percent: 100, done: true });
      await refresh();
      onChanged();
      toast.success(t('settings.providers.local.added'));
    } catch (error) {
      const code = extractIpcError(error)?.code;
      const kind =
        code === 'PRECONDITION_FAILED'
          ? null
          : classifyOllamaPullError(extractIpcError(error)?.message ?? error, name);
      upsertPull({
        name,
        status: 'error',
        phase: 'error',
        done: true,
        ...(kind ? { error: kind } : {}),
      });
      toast.error(
        code === 'PRECONDITION_FAILED'
          ? t('settings.providers.local.conflict')
          : t(`settings.providers.local.pullError.${kind ?? 'generic'}`),
      );
    }
  };

  const handleAbort = async (reason: 'pause' | 'cancel', name: string) => {
    try {
      const current = pulls[name];
      if (reason === 'cancel' && current?.phase === 'paused') {
        await window.electronAPI.maker.localModelDiscardPaused(name);
      } else {
        await window.electronAPI.maker.localModelAbort(reason, name);
      }
      if (reason === 'cancel') {
        upsertPull({ name, status: 'cancelled', phase: 'cancelled', done: true });
      }
      await refresh();
    } catch {
      toast.error(t('settings.providers.local.pullFailed'));
    }
  };

  const statusKind = status?.kind ?? 'absent';
  const canDownload = statusKind === 'ready' || statusKind === 'pulling';
  const searching = query.trim().length > 0;
  const featuredIds = useMemo(() => new Set(featured.map((entry) => entry.id)), [featured]);
  const moreModels = useMemo(
    () => catalog.filter((entry) => !featuredIds.has(entry.id)),
    [catalog, featuredIds],
  );
  const visibleCatalog = useMemo(() => {
    const base = searching ? filterCuratedOllamaModels(catalog, query) : featured;
    const extras = Object.values(pulls)
      .filter((item) => !item.done || item.phase === 'paused' || item.phase === 'error')
      .map((item) => catalog.find((entry) => ollamaModelRefsEqual(entry.libraryName, item.name)))
      .filter((entry): entry is CuratedOllamaModel => Boolean(entry))
      .filter((entry) => !base.some((item) => item.id === entry.id));
    return extras.length > 0 ? [...extras, ...base] : base;
  }, [catalog, featured, pulls, query, searching]);
  const catalogLibraryNames = useMemo(
    () => new Set(catalog.map((model) => model.libraryName)),
    [catalog],
  );
  const customPulls = Object.values(pulls).filter(
    (item) =>
      item.phase !== 'cancelled' &&
      ![...catalogLibraryNames].some((libraryName) => ollamaModelRefsEqual(libraryName, item.name)),
  );

  const renderCatalogCard = (entry: CuratedOllamaModel) => {
    const installed = models.some((model) => ollamaModelRefsEqual(model.name, entry.libraryName));
    const pull = pulls[entry.libraryName];
    const pulling = Boolean(pull && (!pull.done || pull.phase === 'paused'));
    const failed = pull?.phase === 'error';
    if (!searching && installed && !pulling && !failed) return null;
    const lowMemory = memoryGb > 0 && memoryGb < entry.minUnifiedMemoryGb;
    const badge =
      !searching && featured[0]?.id === entry.id
        ? t('settings.providers.local.bestForYou')
        : !searching && featured[1]?.id === entry.id
          ? t('settings.providers.local.alsoCoding')
          : null;
    return (
      <article
        key={entry.id}
        className="flex flex-col gap-3 rounded-[12px] border px-4 py-3.5"
        style={{
          borderColor: 'var(--border-default)',
          backgroundColor: 'var(--surface-elevated)',
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className="text-14 font-medium leading-tight"
                style={{ color: 'var(--settings-section-title)' }}
              >
                {entry.name}
              </span>
              <LocalPackagingTag libraryName={entry.libraryName} />
              {badge && (
                <span
                  className="rounded-full px-2 py-0.5 text-11 font-medium"
                  style={{
                    backgroundColor: 'var(--surface-chip)',
                    color: 'var(--text-secondary)',
                  }}
                >
                  {badge}
                </span>
              )}
            </div>
            <span className="text-12 leading-snug" style={{ color: 'var(--text-secondary)' }}>
              {t(`settings.providers.local.models.${entry.id}.blurb`)}
            </span>
            <span className="text-11" style={{ color: 'var(--text-tertiary)' }}>
              {t(
                appleSilicon
                  ? 'settings.providers.local.sizeHintApple'
                  : 'settings.providers.local.sizeHintGeneric',
                {
                  size: formatModelSize(entry.sizeBytes),
                  memory: entry.minUnifiedMemoryGb,
                },
              )}
            </span>
            {lowMemory && (
              <span className="text-11" style={{ color: 'var(--error-flat)' }}>
                {t('settings.providers.local.memoryWarning', {
                  need: entry.minUnifiedMemoryGb,
                  have: memoryGb,
                })}
              </span>
            )}
          </div>
          {installed && !pulling ? (
            <span className="shrink-0 pt-0.5 text-12" style={{ color: 'var(--text-tertiary)' }}>
              {t('settings.providers.local.alreadyInstalled')}
            </span>
          ) : pulling && pull ? (
            <PullActions
              pull={pull}
              onPause={() => void handleAbort('pause', entry.libraryName)}
              onCancel={() => void handleAbort('cancel', entry.libraryName)}
              onResume={() => void handlePull(entry.libraryName)}
            />
          ) : (
            <button
              type="button"
              disabled={!canDownload}
              onClick={() => void handlePull(entry.libraryName)}
              className="flex h-8 shrink-0 items-center rounded-full px-3.5 text-12 font-medium disabled:opacity-50"
              style={{
                backgroundColor: 'var(--surface-chip)',
                color: 'var(--text-primary)',
              }}
            >
              {failed
                ? t('settings.providers.local.retryDownload')
                : t('settings.providers.local.downloadAdd')}
            </button>
          )}
        </div>
        {pulling && pull && <PullMeter pull={pull} />}
      </article>
    );
  };

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto border-t px-5 py-5"
      style={{ borderColor: 'var(--settings-theme-card-border)' }}
    >
      {statusKind !== 'ready' && statusKind !== 'pulling' && statusKind !== 'absent' && (
        <p className="text-12" style={{ color: 'var(--text-secondary)' }}>
          {t(`settings.providers.local.status.${statusKind}`)}
        </p>
      )}
      {statusKind === 'absent' && (
        <LocalOllamaInstall
          canInstall={offersManagedOllamaInstall(
            window.electronAPI.platform,
            status?.canInstallRuntime,
          )}
          onReady={() => refresh()}
        />
      )}
      {statusKind === 'stopped' && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void handleStart()}
          className="flex h-9 w-fit items-center gap-2 rounded-full px-4 text-13 font-medium"
          style={{ backgroundColor: 'var(--accent-cta-bg)', color: 'var(--surface-on-card)' }}
        >
          {busy && <Spinner size={13} />}
          {t('settings.providers.local.start')}
        </button>
      )}

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-12 font-medium" style={{ color: 'var(--text-secondary)' }}>
            {searching
              ? t('settings.providers.local.searchResults')
              : t('settings.providers.local.recommendedForThisDevice')}
          </span>
          {!searching && (
            <>
              <span className="text-12" style={{ color: 'var(--text-tertiary)' }}>
                {memoryGb > 0
                  ? t(
                      appleSilicon
                        ? 'settings.providers.local.hostProfileApple'
                        : 'settings.providers.local.hostProfileGeneric',
                      { memory: memoryGb },
                    )
                  : t('settings.providers.local.hostProfileUnknown')}
              </span>
              <span className="text-12 leading-snug" style={{ color: 'var(--text-secondary)' }}>
                {t(`settings.providers.local.recommendReason.${recommendReason}`)}
              </span>
            </>
          )}
        </div>
        <input
          id="ollama-model-search"
          aria-label={t('settings.providers.local.searchPlaceholder')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('settings.providers.local.searchPlaceholder')}
          className="h-9 rounded-full border px-4 text-13 outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
          style={{
            borderColor: 'var(--border-default)',
            backgroundColor: 'var(--surface-elevated)',
            color: 'var(--settings-section-title)',
          }}
        />
        {visibleCatalog.length === 0 && (
          <span className="text-12" style={{ color: 'var(--text-tertiary)' }}>
            {t('settings.providers.local.noSearchResults')}
          </span>
        )}
        {visibleCatalog.map((entry) => renderCatalogCard(entry))}
      </section>

      {!searching && moreModels.length > 0 && (
        <section className="flex flex-col gap-3">
          <span className="text-12 font-medium" style={{ color: 'var(--text-secondary)' }}>
            {t('settings.providers.local.moreModels')}
          </span>
          {moreModels.map((entry) => renderCatalogCard(entry))}
        </section>
      )}

      <section className="flex flex-col gap-3">
        <span className="text-12 font-medium" style={{ color: 'var(--text-secondary)' }}>
          {t('settings.providers.local.manualDownload')}
        </span>
        <div className="flex gap-2">
          <input
            id="ollama-manual-download"
            aria-label={t('settings.providers.local.manualDownload')}
            value={libraryName}
            onChange={(event) => setLibraryName(event.target.value)}
            placeholder={t('settings.providers.local.manualDownloadPlaceholder')}
            className="h-9 min-w-0 flex-1 rounded-full border px-4 font-mono text-12 outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
            style={{
              borderColor: 'var(--border-default)',
              backgroundColor: 'var(--surface-elevated)',
              color: 'var(--settings-section-title)',
            }}
          />
          <button
            type="button"
            disabled={!canDownload || !normalizeOllamaPullName(libraryName)}
            onClick={() => void handlePull(libraryName)}
            className="flex h-9 items-center rounded-full px-4 text-12 font-medium disabled:opacity-50"
            style={{
              backgroundColor: 'var(--surface-chip)',
              color: 'var(--text-primary)',
            }}
          >
            {t('settings.providers.local.downloadAdd')}
          </button>
        </div>
      </section>

      {customPulls.map((customPull) => (
        <article
          key={customPull.name}
          className="flex flex-col gap-3 rounded-[12px] border px-4 py-3.5"
          style={{
            borderColor: 'var(--border-default)',
            backgroundColor: 'var(--surface-elevated)',
          }}
        >
          <div className="flex items-start justify-between gap-3">
            <span className="min-w-0 truncate text-14 font-medium" style={{ color: 'var(--settings-section-title)' }}>
              {t('settings.providers.local.pullingTitle', { name: customPull.name })}
            </span>
            <PullActions
              pull={customPull}
              onPause={() => void handleAbort('pause', customPull.name)}
              onCancel={() => void handleAbort('cancel', customPull.name)}
              onResume={() => void handlePull(customPull.name)}
            />
          </div>
          <PullMeter pull={customPull} />
        </article>
      ))}
    </div>
  );
}
