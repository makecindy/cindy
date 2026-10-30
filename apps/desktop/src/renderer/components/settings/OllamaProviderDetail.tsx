import { Button } from '@/components/ui/button';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import type {
  CuratedOllamaModel,
  LocalInstalledModel,
  LocalModelPullPhase,
  LocalModelPullProgress,
  LocalRecommendReason,
  LocalRuntimeStatus,
} from '../../../shared/localModelRuntime';
import {
  canonicalOllamaModelRef,
  classifyOllamaPullError,
  filterCuratedOllamaModels,
  isHfMlxPullName,
  normalizeOllamaPullName,
  ollamaModelRefsEqual,
} from '../../../shared/localModelRuntime';
import { DownloadMeter } from './DownloadMeter';
import { LocalOllamaInstall, offersManagedOllamaInstall } from './LocalOllamaInstall';
import { LocalPackagingTag } from './LocalPackagingTag';
import {
  LocalDownloadActions,
  LocalModelCard,
  LocalModelDownloadButton,
  LocalModelBrowser,
  LocalModelManualDownload,
  localModelBrowserItems,
} from './LocalModelDownloadUI';

function formatModelSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

function PullMeter({ pull }: { pull: LocalModelPullProgress }) {
  const { t } = useTranslation();
  const pullPhase = (pull.phase ?? 'starting') as LocalModelPullPhase;
  const errorKind = pull.phase === 'error' ? classifyOllamaPullError(pull.error, pull.name) : null;
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

export function OllamaProviderDetail({ onChanged }: { onChanged: () => void }) {
  const { t, i18n } = useTranslation();
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

  const refreshGeneration = useRef(0);
  const progressRevision = useRef(0);
  const statusRevision = useRef(0);
  const updatedPulls = useRef(new Map<string, number>());
  const pendingPulls = useRef(new Set<string>());

  const replaceListedPulls = useCallback(
    (items: readonly LocalModelPullProgress[], since: number) => {
      setPulls((current) => {
        const next: Record<string, LocalModelPullProgress> = {};
        for (const item of items) {
          if (item.phase === 'cancelled' || item.phase === 'success') continue;
          next[canonicalOllamaModelRef(item.name)] = item;
        }
        for (const [name, item] of Object.entries(current)) {
          if (!next[name] && item.phase === 'error') next[name] = item;
        }
        // A slow list response must not undo progress, start, pause or completion
        // events received after that request began. Keep terminal deletions too.
        for (const [name, revision] of updatedPulls.current) {
          if (revision <= since && !pendingPulls.current.has(name)) continue;
          if (current[name]) next[name] = current[name];
          else delete next[name];
        }
        return next;
      });
    },
    [],
  );

  const upsertPull = useCallback((item: LocalModelPullProgress) => {
    const name = canonicalOllamaModelRef(item.name);
    updatedPulls.current.set(name, ++progressRevision.current);
    setPulls((current) => {
      if (item.phase === 'cancelled' || item.phase === 'success') {
        if (!(name in current)) return current;
        const next = { ...current };
        delete next[name];
        return next;
      }
      return { ...current, [name]: item };
    });
  }, []);

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    const since = progressRevision.current;
    const statusSince = statusRevision.current;
    const result = await window.electronAPI.maker.localModelList();
    if (generation !== refreshGeneration.current) return;
    if (statusSince === statusRevision.current) setStatus(result.status);
    setModels(result.models);
    setCatalog(result.catalog ?? []);
    setFeatured(result.featured ?? []);
    setMemoryGb(result.memoryGb ?? 0);
    setRecommendReason(result.recommendReason ?? 'unknown');
    setAppleSilicon(result.appleSilicon === true);
    replaceListedPulls(result.pulls ?? [], since);
    if (result.catalogDirty) onChanged();
  }, [onChanged, replaceListedPulls]);

  useEffect(() => {
    void refresh().catch(() => undefined);
    const offCatalog = window.electronAPI.maker.onProvidersChanged(() => {
      void refresh().catch(() => undefined);
    });
    const offStatus = window.electronAPI.maker.onLocalModelStatus((next) => {
      statusRevision.current += 1;
      setStatus(next as LocalRuntimeStatus);
    });
    const offPull = window.electronAPI.maker.onLocalModelPullProgress((next) => {
      upsertPull(next as LocalModelPullProgress);
    });
    return () => {
      refreshGeneration.current += 1;
      offCatalog();
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
    const key = canonicalOllamaModelRef(name);
    if (pendingPulls.current.has(key)) return;
    pendingPulls.current.add(key);
    upsertPull({ name, status: 'starting', phase: 'starting', done: false });
    try {
      let result;
      try {
        result = await window.electronAPI.maker.localModelPull(name);
      } finally {
        // Release only this IPC's guard, before awaiting a refresh that may
        // outlive a resumed download. Never clear another call's guard later.
        pendingPulls.current.delete(key);
      }
      if (result.stopped) {
        await refresh().catch(() => undefined);
        return;
      }
      upsertPull({ name, status: 'success', phase: 'success', percent: 100, done: true });
      await refresh().catch(() => undefined);
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
      const current = pulls[canonicalOllamaModelRef(name)];
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
  const browserItems = useMemo(() => {
    const extras = Object.values(pulls)
      .filter((item) => !item.done || item.phase === 'paused' || item.phase === 'error')
      .map((item) => catalog.find((entry) => ollamaModelRefsEqual(entry.libraryName, item.name)))
      .filter((entry): entry is CuratedOllamaModel => Boolean(entry));
    return localModelBrowserItems({
      catalog,
      featured: featured.map((entry) => catalog.find((item) => item.id === entry.id) ?? entry),
      active: extras,
      query,
      matches: (entry, text) => filterCuratedOllamaModels([entry], text).length > 0,
      isInstalled: (entry) =>
        models.some((model) => ollamaModelRefsEqual(model.name, entry.libraryName)),
    });
  }, [catalog, featured, pulls, query, models]);
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
    const pull = pulls[canonicalOllamaModelRef(entry.libraryName)];
    const pulling = Boolean(pull && (!pull.done || pull.phase === 'paused'));
    const failed = pull?.phase === 'error';
    if (!searching && installed && !pulling && !failed) return null;
    const lowMemory = memoryGb > 0 && memoryGb < entry.minUnifiedMemoryGb;
    const badge =
      !searching && featured[0]?.id === entry.id
        ? t('settings.providers.local.bestForYou')
        : !searching && featured[1]?.id === entry.id
          ? t('settings.providers.local.lighterAlternative')
          : null;
    return (
      <LocalModelCard
        key={entry.id}
        name={entry.name}
        packaging={<LocalPackagingTag libraryName={entry.libraryName} />}
        badge={badge}
        description={
          entry.descriptions?.[
            (i18n.resolvedLanguage ?? i18n.language) as keyof NonNullable<typeof entry.descriptions>
          ] ??
          entry.descriptions?.en ??
          ''
        }
        details={
          <>
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
          </>
        }
        actions={
          pulling && pull ? (
            <LocalDownloadActions
              active
              paused={pull.phase === 'paused'}
              onPause={() => void handleAbort('pause', entry.libraryName)}
              onCancel={() => void handleAbort('cancel', entry.libraryName)}
              onResume={() => void handlePull(entry.libraryName)}
            />
          ) : (
            <LocalModelDownloadButton
              installed={installed}
              failed={failed}
              disabled={!canDownload}
              onClick={() => void handlePull(entry.libraryName)}
            />
          )
        }
        progress={pulling && pull ? <PullMeter pull={pull} /> : undefined}
      />
    );
  };

  return (
    <div
      className="flex flex-col gap-6 border-t px-5 py-5"
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
        <Button
          variant="cta"
          size="lg"
          loading={busy}
          type="button"
          disabled={busy}
          onClick={() => void handleStart()}
          className="w-fit"
        >
          {t('settings.providers.local.start')}
        </Button>
      )}

      <LocalModelBrowser
        id="ollama-model-search"
        query={query}
        onQuery={setQuery}
        visible={browserItems.visible}
        more={browserItems.more}
        renderCard={renderCatalogCard}
        summary={
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
              {t(
                featured.length > 0
                  ? `settings.providers.local.recommendReason.${recommendReason}`
                  : 'settings.providers.local.noRecommendation',
              )}
            </span>
          </>
        }
      />
      <LocalModelManualDownload
        id="ollama-manual-download"
        value={libraryName}
        onChange={setLibraryName}
        placeholder={t('settings.providers.local.manualDownloadPlaceholder')}
        disabled={!canDownload || !normalizeOllamaPullName(libraryName)}
        onSubmit={() => void handlePull(libraryName)}
      />

      {customPulls.map((customPull) => (
        <LocalModelCard
          key={customPull.name}
          name={t('settings.providers.local.pullingTitle', { name: customPull.name })}
          actions={
            <LocalDownloadActions
              active={!customPull.done || customPull.phase === 'paused'}
              paused={customPull.phase === 'paused'}
              onPause={() => void handleAbort('pause', customPull.name)}
              onCancel={() => void handleAbort('cancel', customPull.name)}
              onResume={() => void handlePull(customPull.name)}
            />
          }
          progress={<PullMeter pull={customPull} />}
        />
      ))}
    </div>
  );
}
