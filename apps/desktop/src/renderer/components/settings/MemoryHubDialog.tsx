import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  Eye,
  History,
  Loader2,
  Pencil,
  Search,
  Sparkles,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { createLogger } from '@/lib/logger';
import {
  CURATED_MEMORY_HUB_TYPES,
  formatMemoryHubSize,
  formatMemoryHubTimestamp,
  scopeDisplayName,
  scopeIsOpenable,
  splitCuratedAndDigestEntries,
  type MemoryHubEntrySummary,
  type MemoryHubScope,
} from '@/lib/memoryHub';
import type {
  MemoryHubAiAnalysis,
  MemoryHubInsightsResult,
  MemoryHubRecommendation,
} from '../../../shared/memoryHubAnalysis';

const log = createLogger('MemoryHubDialog');

type MemoryHubEntryType = 'user' | 'feedback' | 'project' | 'reference' | 'digest';
type HubTab = 'entries' | 'insights' | 'trash';

interface MemoryHubSearchHit {
  filename: string;
  type: string;
  title: string;
  snippet: string;
  score: number;
}

interface MemoryHubEntryDetail {
  filename: string;
  slug: string;
  frontmatter: {
    title: string;
    description: string;
    type: MemoryHubEntryType;
    updatedAt: string;
  };
  body: string;
  sizeBytes: number;
}

interface MemoryHubEvent {
  id: number;
  ts: string;
  op: string;
  actor: string;
  filename: string;
  type: string;
  title: string;
  description: string;
}

interface MemoryHubTrashEntry {
  filename: string;
  type: string;
  title: string;
  description: string;
  deletedAt: string;
  sizeBytes: number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function SnippetText({ snippet }: { snippet: string }) {
  const segments: Array<{ text: string; mark: boolean }> = [];
  let mark = snippet.startsWith('<mark>');
  let rest = snippet;
  while (rest !== '') {
    const marker = mark ? '</mark>' : '<mark>';
    const index = rest.indexOf(marker);
    if (index === -1) {
      segments.push({ text: rest, mark });
      break;
    }
    segments.push({ text: rest.slice(0, index), mark });
    rest = rest.slice(index + marker.length);
    mark = !mark;
  }
  return (
    <p className="mt-0.5 line-clamp-2 text-12 text-[var(--settings-section-desc)]">
      {segments.map((segment, index) =>
        segment.mark ? (
          <mark key={index} className="rounded-sm bg-yellow-400/40 text-inherit">
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </p>
  );
}

export function MemoryHubDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [scopes, setScopes] = useState<MemoryHubScope[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedDirName, setSelectedDirName] = useState<string | null>(null);
  const [tab, setTab] = useState<HubTab>('entries');
  const [entries, setEntries] = useState<MemoryHubEntrySummary[] | null>(null);
  const [detail, setDetail] = useState<MemoryHubEntryDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<MemoryHubSearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [indexPreview, setIndexPreview] = useState<string | null>(null);
  const [digestOpen, setDigestOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editBody, setEditBody] = useState('');
  const [savingEntry, setSavingEntry] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [historyEvents, setHistoryEvents] = useState<MemoryHubEvent[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [trashEntries, setTrashEntries] = useState<MemoryHubTrashEntry[] | null>(null);
  const [trashLoading, setTrashLoading] = useState(false);
  const [restoringFilename, setRestoringFilename] = useState<string | null>(null);
  const [insights, setInsights] = useState<MemoryHubInsightsResult | null>(null);
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [recConfirmingId, setRecConfirmingId] = useState<string | null>(null);
  const [aiAnalysis, setAiAnalysis] = useState<MemoryHubAiAnalysis | null>(null);
  const [aiLoaded, setAiLoaded] = useState(false);
  const [aiRunning, setAiRunning] = useState(false);

  const resetScopeState = useCallback(() => {
    setEntries(null);
    setDetail(null);
    setDetailLoading(false);
    setQuery('');
    setHits(null);
    setSearching(false);
    setIndexPreview(null);
    setDigestOpen(false);
    setEditing(false);
    setConfirmingDelete(false);
    setHistoryEvents(null);
    setHistoryLoading(false);
    setTrashEntries(null);
    setTrashLoading(false);
    setRestoringFilename(null);
    setInsights(null);
    setInsightsLoading(false);
    setRecConfirmingId(null);
    setAiAnalysis(null);
    setAiLoaded(false);
    setAiRunning(false);
  }, []);

  const refreshEntries = useCallback(async (scopeKey: string) => {
    try {
      const res = await window.electronAPI.maker.memoryHubListEntries(scopeKey);
      setEntries(res.entries);
    } catch (err) {
      log.warn('memoryHubListEntries refresh failed', err);
    }
  }, []);

  const loadScopes = useCallback(async () => {
    setScopes(null);
    setLoadError(null);
    setSelectedDirName(null);
    setTab('entries');
    resetScopeState();
    try {
      const res = await window.electronAPI.maker.memoryHubListScopes();
      setScopes(res.scopes);
      const openable =
        res.scopes.find((scope) => scope.kind === 'local' && scopeIsOpenable(scope)) ??
        res.scopes.find((scope) => scopeIsOpenable(scope));
      if (openable) setSelectedDirName(openable.dirName);
    } catch (err) {
      log.warn('memoryHubListScopes failed', err);
      setScopes([]);
      setLoadError(errorMessage(err));
    }
  }, [resetScopeState]);

  useEffect(() => {
    if (open) void loadScopes();
  }, [open, loadScopes]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const selectedScope = scopes?.find((scope) => scope.dirName === selectedDirName) ?? null;
  const openScopeKey = selectedScope && scopeIsOpenable(selectedScope) ? selectedScope.scopeKey : null;

  useEffect(() => {
    if (!openScopeKey) {
      setEntries(null);
      return;
    }
    let cancelled = false;
    resetScopeState();
    void (async () => {
      try {
        const res = await window.electronAPI.maker.memoryHubListEntries(openScopeKey);
        if (!cancelled) setEntries(res.entries);
      } catch (err) {
        log.warn('memoryHubListEntries failed', err);
        if (!cancelled) setLoadError(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [openScopeKey, resetScopeState]);

  const openDetail = useCallback(
    async (filename: string) => {
      if (!openScopeKey) return;
      setDetailLoading(true);
      setHits(null);
      setEditing(false);
      setConfirmingDelete(false);
      setHistoryEvents(null);
      try {
        const res = await window.electronAPI.maker.memoryHubReadEntry(openScopeKey, filename);
        setDetail(res.entry);
      } catch (err) {
        log.warn('memoryHubReadEntry failed', err);
        setLoadError(errorMessage(err));
      } finally {
        setDetailLoading(false);
      }
    },
    [openScopeKey],
  );

  const startEdit = useCallback(() => {
    if (!detail) return;
    setEditTitle(detail.frontmatter.title);
    setEditDescription(detail.frontmatter.description);
    setEditBody(detail.body);
    setEditing(true);
    setConfirmingDelete(false);
    setHistoryEvents(null);
  }, [detail]);

  const saveEdit = useCallback(async () => {
    if (!openScopeKey || !detail) return;
    setSavingEntry(true);
    try {
      await window.electronAPI.maker.memoryHubEntryWrite(openScopeKey, {
        type: detail.frontmatter.type,
        name: detail.slug,
        title: editTitle.trim(),
        description: editDescription.trim(),
        body: editBody,
        mode: 'update',
      });
      setEditing(false);
      setDetail(null);
      await refreshEntries(openScopeKey);
    } catch (err) {
      log.warn('memoryHubEntryWrite failed', err);
      setLoadError(errorMessage(err));
    } finally {
      setSavingEntry(false);
    }
  }, [openScopeKey, detail, editTitle, editDescription, editBody, refreshEntries]);

  const toggleHistory = useCallback(async () => {
    if (!openScopeKey || !detail) return;
    if (historyEvents !== null) {
      setHistoryEvents(null);
      return;
    }
    setHistoryLoading(true);
    try {
      const res = await window.electronAPI.maker.memoryHubHistory(openScopeKey, detail.filename);
      setHistoryEvents(res.events);
    } catch (err) {
      log.warn('memoryHubHistory failed', err);
      setLoadError(errorMessage(err));
    } finally {
      setHistoryLoading(false);
    }
  }, [openScopeKey, detail, historyEvents]);

  const deleteEntry = useCallback(async () => {
    if (!openScopeKey || !detail) return;
    try {
      await window.electronAPI.maker.memoryHubEntryDelete(openScopeKey, detail.filename);
      setDetail(null);
      setConfirmingDelete(false);
      await refreshEntries(openScopeKey);
    } catch (err) {
      log.warn('memoryHubEntryDelete failed', err);
      setLoadError(errorMessage(err));
    }
  }, [openScopeKey, detail, refreshEntries]);

  const runSearch = useCallback(async () => {
    if (!openScopeKey || query.trim() === '') return;
    setSearching(true);
    setDetail(null);
    try {
      const res = await window.electronAPI.maker.memoryHubSearch(openScopeKey, query.trim());
      setHits(res.hits);
    } catch (err) {
      log.warn('memoryHubSearch failed', err);
      setLoadError(errorMessage(err));
    } finally {
      setSearching(false);
    }
  }, [openScopeKey, query]);

  const toggleIndexPreview = useCallback(async () => {
    if (indexPreview !== null) {
      setIndexPreview(null);
      return;
    }
    if (!openScopeKey) return;
    try {
      const res = await window.electronAPI.maker.memoryHubIndexPreview(openScopeKey);
      setIndexPreview(res.index);
    } catch (err) {
      log.warn('memoryHubIndexPreview failed', err);
      setLoadError(errorMessage(err));
    }
  }, [indexPreview, openScopeKey]);

  const loadTrash = useCallback(async () => {
    if (!openScopeKey) return;
    setTrashLoading(true);
    try {
      const res = await window.electronAPI.maker.memoryHubTrashList(openScopeKey);
      setTrashEntries(res.entries);
    } catch (err) {
      log.warn('memoryHubTrashList failed', err);
      setLoadError(errorMessage(err));
    } finally {
      setTrashLoading(false);
    }
  }, [openScopeKey]);

  useEffect(() => {
    if (tab === 'trash' && openScopeKey && trashEntries === null && !trashLoading) {
      void loadTrash();
    }
  }, [tab, openScopeKey, trashEntries, trashLoading, loadTrash]);

  const restoreEntry = useCallback(
    async (filename: string) => {
      if (!openScopeKey) return;
      setRestoringFilename(filename);
      try {
        await window.electronAPI.maker.memoryHubRestore(openScopeKey, filename);
        setTrashEntries(null);
        await loadTrash();
        await refreshEntries(openScopeKey);
      } catch (err) {
        log.warn('memoryHubRestore failed', err);
        setLoadError(errorMessage(err));
      } finally {
        setRestoringFilename(null);
      }
    },
    [openScopeKey, loadTrash, refreshEntries],
  );

  const loadInsights = useCallback(async () => {
    if (!openScopeKey) return;
    setInsightsLoading(true);
    try {
      const res = await window.electronAPI.maker.memoryHubInsights(openScopeKey);
      setInsights(res as unknown as MemoryHubInsightsResult);
    } catch (err) {
      log.warn('memoryHubInsights failed', err);
      setLoadError(errorMessage(err));
    } finally {
      setInsightsLoading(false);
    }
  }, [openScopeKey]);

  useEffect(() => {
    if (tab === 'insights' && openScopeKey && insights === null && !insightsLoading) {
      void loadInsights();
    }
    if (tab === 'insights' && openScopeKey && !aiLoaded && !aiRunning) {
      setAiLoaded(true);
      void (async () => {
        try {
          const res = await window.electronAPI.maker.memoryHubAiAnalysis(openScopeKey);
          setAiAnalysis((res.analysis as MemoryHubAiAnalysis | null) ?? null);
        } catch (err) {
          log.warn('memoryHubAiAnalysis failed', err);
        }
      })();
    }
  }, [tab, openScopeKey, insights, insightsLoading, aiLoaded, aiRunning, loadInsights]);

  const runAiAnalysis = useCallback(async () => {
    if (!openScopeKey || aiRunning) return;
    setAiRunning(true);
    try {
      const res = await window.electronAPI.maker.memoryHubRunAiAnalysis(openScopeKey);
      setAiAnalysis((res.analysis as MemoryHubAiAnalysis | null) ?? null);
    } catch (err) {
      log.warn('memoryHubRunAiAnalysis failed', err);
      setLoadError(errorMessage(err));
    } finally {
      setAiRunning(false);
    }
  }, [openScopeKey, aiRunning]);

  const executeRecommendation = useCallback(
    async (rec: MemoryHubRecommendation) => {
      if (!openScopeKey) return;
      if (rec.suggestedAction !== 'deprecate') return;
      setRecConfirmingId(rec.id);
    },
    [openScopeKey],
  );

  const confirmRecommendation = useCallback(
    async (rec: MemoryHubRecommendation) => {
      if (!openScopeKey) return;
      try {
        await window.electronAPI.maker.memoryHubEntryDelete(openScopeKey, rec.filename);
        setRecConfirmingId(null);
        setInsights(null);
        await refreshEntries(openScopeKey);
        await loadInsights();
      } catch (err) {
        log.warn('recommendation execute failed', err);
        setLoadError(errorMessage(err));
        setRecConfirmingId(null);
      }
    },
    [openScopeKey, refreshEntries, loadInsights],
  );

  if (!open) return null;

  const grouped = entries ? splitCuratedAndDigestEntries(entries) : null;
  const tabs: Array<{ id: HubTab; label: string }> = [
    { id: 'entries', label: t('settings.memory.hub.tabEntries') },
    { id: 'insights', label: t('settings.memory.hub.tabInsights') },
    { id: 'trash', label: t('settings.memory.hub.tabTrash') },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={cn(
          'flex h-[80vh] w-[760px] max-w-[92vw] flex-col overflow-hidden rounded-xl',
          'bg-[var(--settings-theme-card-bg)] border border-[var(--settings-theme-card-border)]',
        )}
      >
        <div className="flex items-center justify-between border-b border-[var(--settings-theme-card-border)] px-5 py-4">
          <h2 className="text-16 font-medium text-[var(--settings-section-title)]">
            {t('settings.memory.hub.title')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-[var(--settings-section-desc)] hover:bg-[var(--settings-input-bg)]"
            aria-label={t('settings.memory.hub.close')}
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex flex-col gap-3 px-5 py-4">
          <label className="flex items-center gap-2 text-13 text-[var(--settings-section-desc)]">
            <span className="shrink-0">{t('settings.memory.hub.scopeLabel')}</span>
            {scopes === null ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <select
                value={selectedDirName ?? ''}
                onChange={(event) => setSelectedDirName(event.target.value || null)}
                className={cn(
                  'min-w-0 flex-1 rounded-lg border border-[var(--settings-theme-card-border)]',
                  'bg-[var(--settings-input-bg)] px-2 py-1.5 text-13 text-[var(--settings-section-title)]',
                )}
              >
                {scopes.length === 0 && <option value="">—</option>}
                {scopes.map((scope) => (
                  <option key={scope.dirName} value={scope.dirName} disabled={!scopeIsOpenable(scope)}>
                    {scopeDisplayName(scope, t('settings.memory.hub.scopeLabel'))}
                    {scope.kind === 'remote' ? ' · ' + t('settings.memory.hub.scopeRemoteTag') : ''}
                    {!scopeIsOpenable(scope) ? ' · ' + t('settings.memory.hub.scopeViewOnly') : ''}
                  </option>
                ))}
              </select>
            )}
          </label>

          {loadError && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-13 text-red-500">
              {t('settings.memory.hub.loadFailed', { message: loadError })}
            </div>
          )}
        </div>

        {openScopeKey && (
          <div className="flex items-center gap-1 border-b border-[var(--settings-theme-card-border)] px-5">
            {tabs.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={cn(
                  'rounded-t-lg px-3 py-2 text-13 transition-colors',
                  tab === item.id
                    ? 'border-b-2 border-[var(--settings-section-title)] font-medium text-[var(--settings-section-title)]'
                    : 'text-[var(--settings-section-desc)] hover:text-[var(--settings-section-title)]',
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}

        {openScopeKey && tab === 'entries' && (
          <div className="flex items-center gap-2 px-5 py-3">
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-[var(--settings-theme-card-border)] bg-[var(--settings-input-bg)] px-3 py-1.5">
              <Search size={14} className="shrink-0 text-[var(--settings-section-desc)]" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void runSearch();
                }}
                placeholder={t('settings.memory.hub.searchPlaceholder')}
                className="min-w-0 flex-1 bg-transparent text-13 text-[var(--settings-section-title)] outline-none placeholder:text-[var(--settings-section-desc)]"
              />
            </div>
            <button
              type="button"
              onClick={() => void runSearch()}
              disabled={searching || query.trim() === ''}
              className="rounded-lg bg-[var(--settings-input-bg)] px-3 py-1.5 text-13 text-[var(--settings-section-title)] disabled:opacity-50"
            >
              {searching ? <Loader2 size={14} className="animate-spin" /> : t('settings.memory.hub.searchAction')}
            </button>
            <button
              type="button"
              onClick={() => void toggleIndexPreview()}
              className={cn(
                'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-13',
                indexPreview !== null
                  ? 'bg-[var(--settings-section-title)] text-[var(--settings-theme-card-bg)]'
                  : 'bg-[var(--settings-input-bg)] text-[var(--settings-section-title)]',
              )}
            >
              <Eye size={14} />
              {t('settings.memory.hub.preview')}
            </button>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
          {openScopeKey && tab === 'entries' && (
            <>
              {indexPreview !== null && (
                <div className="mb-4 flex flex-col gap-2">
                  <p className="text-12 leading-[1.5] text-[var(--settings-section-desc)]">
                    {t('settings.memory.hub.previewHint')}
                  </p>
                  <pre className="whitespace-pre-wrap rounded-lg bg-[var(--settings-input-bg)] p-3 text-12 leading-[1.6] text-[var(--settings-section-title)]">
                    {indexPreview}
                  </pre>
                </div>
              )}

              {detailLoading && (
                <div className="flex items-center justify-center py-10 text-[var(--settings-section-desc)]">
                  <Loader2 size={18} className="animate-spin" />
                </div>
              )}

              {detail && !detailLoading && (
                <div className="flex flex-col gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setDetail(null);
                      setEditing(false);
                      setConfirmingDelete(false);
                      setHistoryEvents(null);
                    }}
                    className="flex w-fit items-center gap-1.5 text-13 text-[var(--settings-section-desc)] hover:text-[var(--settings-section-title)]"
                  >
                    <ArrowLeft size={14} />
                    {t('settings.memory.hub.back')}
                  </button>

                  {editing ? (
                    <div className="flex flex-col gap-3">
                      <label className="flex flex-col gap-1">
                        <span className="text-12 text-[var(--settings-section-desc)]">
                          {t('settings.memory.hub.editTitle')}
                        </span>
                        <input
                          value={editTitle}
                          onChange={(event) => setEditTitle(event.target.value)}
                          className="rounded-lg border border-[var(--settings-theme-card-border)] bg-[var(--settings-input-bg)] px-3 py-1.5 text-13 text-[var(--settings-section-title)]"
                        />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-12 text-[var(--settings-section-desc)]">
                          {t('settings.memory.hub.editDescription')}
                        </span>
                        <input
                          value={editDescription}
                          onChange={(event) => setEditDescription(event.target.value)}
                          className="rounded-lg border border-[var(--settings-theme-card-border)] bg-[var(--settings-input-bg)] px-3 py-1.5 text-13 text-[var(--settings-section-title)]"
                        />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-12 text-[var(--settings-section-desc)]">
                          {t('settings.memory.hub.editBody')}
                        </span>
                        <textarea
                          value={editBody}
                          onChange={(event) => setEditBody(event.target.value)}
                          rows={12}
                          className="rounded-lg border border-[var(--settings-theme-card-border)] bg-[var(--settings-input-bg)] px-3 py-2 text-13 leading-[1.6] text-[var(--settings-section-title)]"
                        />
                      </label>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void saveEdit()}
                          disabled={savingEntry || editTitle.trim() === '' || editDescription.trim() === ''}
                          className="rounded-lg bg-[var(--settings-section-title)] px-4 py-1.5 text-13 text-[var(--settings-theme-card-bg)] disabled:opacity-50"
                        >
                          {savingEntry ? <Loader2 size={14} className="animate-spin" /> : t('settings.memory.hub.save')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditing(false)}
                          className="rounded-lg bg-[var(--settings-input-bg)] px-4 py-1.5 text-13 text-[var(--settings-section-title)]"
                        >
                          {t('settings.memory.hub.cancel')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <h3 className="text-15 font-medium text-[var(--settings-section-title)]">
                            {detail.frontmatter.title}
                          </h3>
                          <p className="mt-0.5 text-13 text-[var(--settings-section-desc)]">
                            {detail.frontmatter.description}
                          </p>
                          <p className="mt-1 text-12 text-[var(--settings-section-desc)]">
                            {detail.filename} ·{' '}
                            {t('settings.memory.hub.entryMeta', {
                              size: formatMemoryHubSize(detail.sizeBytes),
                              time: formatMemoryHubTimestamp(detail.frontmatter.updatedAt),
                            })}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            onClick={startEdit}
                            className="flex items-center gap-1 rounded-lg bg-[var(--settings-input-bg)] px-2.5 py-1.5 text-12 text-[var(--settings-section-title)]"
                          >
                            <Pencil size={12} />
                            {t('settings.memory.hub.edit')}
                          </button>
                          <button
                            type="button"
                            onClick={() => void toggleHistory()}
                            className="flex items-center gap-1 rounded-lg bg-[var(--settings-input-bg)] px-2.5 py-1.5 text-12 text-[var(--settings-section-title)]"
                          >
                            <History size={12} />
                            {t('settings.memory.hub.history')}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmingDelete(true)}
                            className="flex items-center gap-1 rounded-lg bg-[var(--settings-input-bg)] px-2.5 py-1.5 text-12 text-red-500"
                          >
                            <Trash2 size={12} />
                            {t('settings.memory.hub.delete')}
                          </button>
                        </div>
                      </div>

                      {confirmingDelete && (
                        <div className="flex items-center justify-between gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2">
                          <span className="text-12 text-[var(--settings-section-title)]">
                            {t('settings.memory.hub.confirmDelete')}
                          </span>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => void deleteEntry()}
                              className="rounded-lg bg-red-500 px-3 py-1 text-12 text-white"
                            >
                              {t('settings.memory.hub.delete')}
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmingDelete(false)}
                              className="rounded-lg bg-[var(--settings-input-bg)] px-3 py-1 text-12 text-[var(--settings-section-title)]"
                            >
                              {t('settings.memory.hub.cancel')}
                            </button>
                          </div>
                        </div>
                      )}

                      {historyLoading && (
                        <div className="flex items-center gap-2 text-12 text-[var(--settings-section-desc)]">
                          <Loader2 size={12} className="animate-spin" />
                        </div>
                      )}

                      {historyEvents !== null && (
                        <div className="flex flex-col gap-1.5 rounded-lg bg-[var(--settings-input-bg)] p-3">
                          <p className="text-12 font-medium text-[var(--settings-section-title)]">
                            {t('settings.memory.hub.history')}
                          </p>
                          {historyEvents.length === 0 && (
                            <p className="text-12 text-[var(--settings-section-desc)]">
                              {t('settings.memory.hub.historyEmpty')}
                            </p>
                          )}
                          {historyEvents.map((event) => (
                            <div key={event.id} className="flex items-baseline gap-2 text-12">
                              <span className="shrink-0 text-[var(--settings-section-desc)]">
                                {formatMemoryHubTimestamp(event.ts)}
                              </span>
                              <span className="font-medium text-[var(--settings-section-title)]">
                                {t(`settings.memory.hub.op_${event.op}`)}
                              </span>
                              <span className="truncate text-[var(--settings-section-desc)]">
                                {event.title}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}

                      <pre className="whitespace-pre-wrap rounded-lg bg-[var(--settings-input-bg)] p-3 text-13 leading-[1.6] text-[var(--settings-section-title)]">
                        {detail.body}
                      </pre>
                    </div>
                  )}
                </div>
              )}

              {!detail && !detailLoading && grouped && (
                <div className="flex flex-col gap-4">
                  {entries !== null && (
                    <p className="text-12 text-[var(--settings-section-desc)]">
                      {t('settings.memory.hub.count', { count: entries.length })}
                    </p>
                  )}
                  {hits !== null && (
                    <div className="flex flex-col gap-2">
                      {hits.length === 0 && (
                        <p className="text-13 text-[var(--settings-section-desc)]">
                          {t('settings.memory.hub.searchEmpty')}
                        </p>
                      )}
                      {hits.map((hit) => (
                        <button
                          key={hit.filename}
                          type="button"
                          onClick={() => void openDetail(hit.filename)}
                          className="rounded-lg border border-[var(--settings-theme-card-border)] px-3 py-2 text-left hover:bg-[var(--settings-input-bg)]"
                        >
                          <p className="text-13 font-medium text-[var(--settings-section-title)]">{hit.title}</p>
                          <SnippetText snippet={hit.snippet} />
                        </button>
                      ))}
                    </div>
                  )}
                  {entries !== null && entries.length === 0 && (
                    <p className="py-6 text-center text-13 text-[var(--settings-section-desc)]">
                      {t('settings.memory.hub.empty')}
                    </p>
                  )}
                  {entries !== null &&
                    entries.length > 0 &&
                    CURATED_MEMORY_HUB_TYPES.map((type) => {
                      const typeEntries = grouped.curated.filter(
                        (entry) => entry.frontmatter.type === type,
                      );
                      if (typeEntries.length === 0) return null;
                      return (
                        <div key={type} className="flex flex-col gap-2">
                          <p className="text-12 font-medium uppercase tracking-wide text-[var(--settings-section-desc)]">
                            {t(`settings.memory.hub.type_${type}`)}
                          </p>
                          {typeEntries.map((entry) => (
                            <EntryRow
                              key={entry.filename}
                              entry={entry}
                              meta={t('settings.memory.hub.entryMeta', {
                                size: formatMemoryHubSize(entry.sizeBytes),
                                time: formatMemoryHubTimestamp(entry.frontmatter.updatedAt),
                              })}
                              onOpen={() => void openDetail(entry.filename)}
                            />
                          ))}
                        </div>
                      );
                    })}
                  {entries !== null && entries.length > 0 && grouped.digest.length > 0 && (
                    <div className="flex flex-col gap-2">
                      <button
                        type="button"
                        onClick={() => setDigestOpen((prev) => !prev)}
                        className="text-left text-12 font-medium uppercase tracking-wide text-[var(--settings-section-desc)]"
                      >
                        {digestOpen ? '▾ ' : '▸ '}
                        {t('settings.memory.hub.digest')} ({grouped.digest.length})
                      </button>
                      {digestOpen && (
                        <>
                          <p className="text-12 text-[var(--settings-section-desc)]">
                            {t('settings.memory.hub.digestHint')}
                          </p>
                          {grouped.digest.map((entry) => (
                            <EntryRow
                              key={entry.filename}
                              entry={entry}
                              meta={t('settings.memory.hub.entryMeta', {
                                size: formatMemoryHubSize(entry.sizeBytes),
                                time: formatMemoryHubTimestamp(entry.frontmatter.updatedAt),
                              })}
                              onOpen={() => void openDetail(entry.filename)}
                            />
                          ))}
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {openScopeKey && tab === 'insights' && (
            <div className="flex flex-col gap-4">
              <p className="text-12 text-[var(--settings-section-desc)]">
                {t('settings.memory.hub.insightsHint')}
              </p>

              {insightsLoading && insights === null && (
                <div className="flex items-center justify-center py-10 text-[var(--settings-section-desc)]">
                  <Loader2 size={18} className="animate-spin" />
                </div>
              )}

              {insights !== null && (
                <>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="rounded-lg bg-[var(--settings-input-bg)] px-3 py-2">
                      <p className="text-18 font-medium text-[var(--settings-section-title)]">
                        {insights.totalEntries}
                      </p>
                      <p className="text-11 text-[var(--settings-section-desc)]">
                        {t('settings.memory.hub.statTotal')}
                      </p>
                    </div>
                    <div className="rounded-lg bg-[var(--settings-input-bg)] px-3 py-2">
                      <p className="text-18 font-medium text-[var(--settings-section-title)]">
                        {insights.staleCount}
                      </p>
                      <p className="text-11 text-[var(--settings-section-desc)]">
                        {t('settings.memory.hub.statStale')}
                      </p>
                    </div>
                    <div className="rounded-lg bg-[var(--settings-input-bg)] px-3 py-2">
                      <p className="text-18 font-medium text-[var(--settings-section-title)]">
                        {insights.lastActivityAt ? formatMemoryHubTimestamp(insights.lastActivityAt) : '—'}
                      </p>
                      <p className="text-11 text-[var(--settings-section-desc)]">
                        {t('settings.memory.hub.statLastActivity')}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-col gap-2">
                    <p className="text-12 font-medium uppercase tracking-wide text-[var(--settings-section-desc)]">
                      {t('settings.memory.hub.recommendations')}
                    </p>
                    {insights.recommendations.length === 0 && (
                      <p className="text-13 text-[var(--settings-section-desc)]">
                        {t('settings.memory.hub.noRecommendations')}
                      </p>
                    )}
                    {insights.recommendations.map((rec) => (
                      <div
                        key={rec.id}
                        className="flex flex-col gap-1.5 rounded-lg border border-[var(--settings-theme-card-border)] px-3 py-2"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-13 font-medium text-[var(--settings-section-title)]">
                            {t(`settings.memory.hub.rec_${rec.kind}`)} · {rec.title}
                          </p>
                          {rec.suggestedAction === 'deprecate' && recConfirmingId !== rec.id && (
                            <button
                              type="button"
                              onClick={() => void executeRecommendation(rec)}
                              className="shrink-0 rounded-lg bg-[var(--settings-input-bg)] px-2.5 py-1 text-12 text-red-500"
                            >
                              {t('settings.memory.hub.execute')}
                            </button>
                          )}
                        </div>
                        <p className="text-12 text-[var(--settings-section-desc)]">{rec.reason}</p>
                        {recConfirmingId === rec.id && (
                          <div className="flex items-center justify-between gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2">
                            <span className="text-12 text-[var(--settings-section-title)]">
                              {t('settings.memory.hub.confirmDelete')}
                            </span>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => void confirmRecommendation(rec)}
                                className="rounded-lg bg-red-500 px-3 py-1 text-12 text-white"
                              >
                                {t('settings.memory.hub.delete')}
                              </button>
                              <button
                                type="button"
                                onClick={() => setRecConfirmingId(null)}
                                className="rounded-lg bg-[var(--settings-input-bg)] px-3 py-1 text-12 text-[var(--settings-section-title)]"
                              >
                                {t('settings.memory.hub.cancel')}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}

              <div className="flex flex-col gap-2 rounded-lg border border-[var(--settings-theme-card-border)] px-3 py-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="flex items-center gap-1.5 text-13 font-medium text-[var(--settings-section-title)]">
                    <Sparkles size={14} />
                    {t('settings.memory.hub.aiAnalysis')}
                  </p>
                  <button
                    type="button"
                    onClick={() => void runAiAnalysis()}
                    disabled={aiRunning}
                    className="flex items-center gap-1.5 rounded-lg bg-[var(--settings-input-bg)] px-3 py-1.5 text-12 text-[var(--settings-section-title)] disabled:opacity-50"
                  >
                    {aiRunning ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Sparkles size={12} />
                    )}
                    {aiAnalysis ? t('settings.memory.hub.aiRefresh') : t('settings.memory.hub.aiRun')}
                  </button>
                </div>
                <p className="text-11 text-[var(--settings-section-desc)]">
                  {t('settings.memory.hub.aiCostHint')}
                </p>
                {aiAnalysis && !aiRunning && (
                  <div className="flex flex-col gap-1.5">
                    <p className="whitespace-pre-wrap text-13 leading-[1.6] text-[var(--settings-section-title)]">
                      {aiAnalysis.text}
                    </p>
                    <p className="text-11 text-[var(--settings-section-desc)]">
                      {t('settings.memory.hub.aiGeneratedAt', {
                        time: formatMemoryHubTimestamp(aiAnalysis.generatedAt),
                        source:
                          aiAnalysis.source === 'background'
                            ? t('settings.memory.hub.aiSourceBackground')
                            : t('settings.memory.hub.aiSourceManual'),
                      })}
                    </p>
                    {aiAnalysis.recommendations.length > 0 && (
                      <div className="flex flex-col gap-1.5 border-t border-[var(--settings-theme-card-border)] pt-2">
                        {aiAnalysis.recommendations.map((rec) => (
                          <div key={rec.id} className="text-12">
                            <span className="font-medium text-[var(--settings-section-title)]">
                              {t(`settings.memory.hub.rec_${rec.kind}`)} · {rec.title}
                            </span>
                            {rec.reason && (
                              <span className="text-[var(--settings-section-desc)]"> — {rec.reason}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {openScopeKey && tab === 'trash' && (
            <div className="flex flex-col gap-3">
              {trashLoading && trashEntries === null && (
                <div className="flex items-center justify-center py-10 text-[var(--settings-section-desc)]">
                  <Loader2 size={18} className="animate-spin" />
                </div>
              )}
              {trashEntries !== null && trashEntries.length === 0 && (
                <p className="py-6 text-center text-13 text-[var(--settings-section-desc)]">
                  {t('settings.memory.hub.trashEmpty')}
                </p>
              )}
              {trashEntries !== null &&
                trashEntries.map((entry) => (
                  <div
                    key={entry.filename}
                    className="flex items-center justify-between gap-2 rounded-lg border border-[var(--settings-theme-card-border)] px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="text-13 font-medium text-[var(--settings-section-title)]">{entry.title}</p>
                      <p className="mt-0.5 text-12 text-[var(--settings-section-desc)]">
                        {entry.filename} · {t('settings.memory.hub.trashDeletedAt', {
                          time: formatMemoryHubTimestamp(entry.deletedAt),
                        })}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void restoreEntry(entry.filename)}
                      disabled={restoringFilename === entry.filename}
                      className="flex shrink-0 items-center gap-1 rounded-lg bg-[var(--settings-input-bg)] px-2.5 py-1.5 text-12 text-[var(--settings-section-title)] disabled:opacity-50"
                    >
                      {restoringFilename === entry.filename ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Undo2 size={12} />
                      )}
                      {t('settings.memory.hub.restore')}
                    </button>
                  </div>
                ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function EntryRow({
  entry,
  meta,
  onOpen,
}: {
  entry: MemoryHubEntrySummary;
  meta: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="rounded-lg border border-[var(--settings-theme-card-border)] px-3 py-2 text-left hover:bg-[var(--settings-input-bg)]"
    >
      <p className="text-13 font-medium text-[var(--settings-section-title)]">{entry.frontmatter.title}</p>
      <p className="mt-0.5 text-12 text-[var(--settings-section-desc)]">{entry.frontmatter.description}</p>
      <p className="mt-1 text-12 text-[var(--settings-section-desc)]">{meta}</p>
    </button>
  );
}
