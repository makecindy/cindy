import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { companionImportReasonKey, companionImportErrorCode, compactCompanionImportSelection, areCompanionImportEntriesSelected, toggleCompanionImportEntries, companionImportCategories, type CompanionImportCategory, type CompanionImportApi, type CompanionImportPreview, type CompanionImportResult, type CompanionImportSelection, type CompanionImportSource } from '@cindy/maker-shared/companion-import';
import { normalizeBotName } from '../../../shared/botCreation';
import { BOT_PORTRAIT_COUNT, BotPortraitPicker, galleryPortrait } from './BotPortraitPicker';
import { useBotProfiles } from './botStore';
import { extractIpcError } from '../../utils/ipcError';

/** Import only adds a selection step. Identity and all later settings use the normal teammate UI. */
export function BotImportForm({ api = window.electronAPI.companionImport, onBack, onCreated, onBusy }: {
  api?: CompanionImportApi; onBack(): void; onCreated(botId: string): void; onBusy(busy: boolean): void;
}) {
  const { t } = useTranslation();
  const tr = (key: string) => t(`bots.import.${key}`);
  const bots = useBotProfiles();
  const [sources, setSources] = useState<CompanionImportSource[]>();
  const [preview, setPreview] = useState<CompanionImportPreview>();
  const [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [portrait, setPortrait] = useState<string>();
  const [initialPortrait] = useState(() => Math.floor(Math.random() * BOT_PORTRAIT_COUNT));
  const [category, setCategory] = useState<CompanionImportCategory>();
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [takeover, setTakeover] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [details, setDetails] = useState(false);
  const [detailPage, setDetailPage] = useState(0);
  const [result, setResult] = useState<CompanionImportResult>();
  useEffect(() => setDetailPage(0), [result]);
  const intent = useRef<CompanionImportSelection | undefined>(undefined);
  const alive = useRef(true);
  const lock = useRef(false);
  const duplicate = bots.some(bot => bot.id !== result?.botId && bot.status !== 'archived' && normalizeBotName(bot.name) === normalizeBotName(name));
  useEffect(() => { alive.current = true; void api.sources().then(value => { if (alive.current) setSources(value); }).catch(cause => { if (alive.current) setError(companionImportErrorCode(cause) ?? 'IMPORT_ITEM_FAILED'); }); return () => { alive.current = false; }; }, [api]);
  const act = async (fn: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); onBusy(true); setError(undefined);
    try { await fn(); } catch (cause) {
      const code = extractIpcError(cause)?.code;
      // Only definitive creation/preflight rejections unlock editing. An ambiguous ACK
      // keeps the same request ID and is reconciled before any retry.
      if (code && ['INVALID_SELECTION', 'PROFILE_TEXT_TOO_LARGE', 'IMPORT_NAME_EXISTS', 'SOURCE_SNAPSHOT_TOO_LARGE', 'SOURCE_TOO_MANY_FILES', 'SOURCE_FILE_TOO_LARGE', 'SOURCE_ITEM_TOO_LARGE', 'SOURCE_LINK_OUTSIDE_FOLDER', 'SOURCE_LINK_CYCLE', 'SOURCE_NOT_REGULAR_FILE', 'SOURCE_CHANGED'].includes(code)) {
        intent.current = undefined;
        if (alive.current) setResult(undefined);
      }
      if (code === 'PREVIEW_EXPIRED' || code === 'SELECTION_CHANGED') {
        intent.current = undefined;
        if (alive.current) { setPreview(undefined); setResult(undefined); }
        // Host restarts invalidate source IDs too. Reuse the existing source step.
        try { const refreshed = await api.sources(); if (alive.current) setSources(refreshed); } catch { /* Existing source buttons allow another attempt. */ }
      }
      if (alive.current) setError(companionImportErrorCode(cause) ?? 'IMPORT_ITEM_FAILED');
    }
    finally { lock.current = false; if (alive.current) { setBusy(false); onBusy(false); } }
  };
  const choose = (source: CompanionImportSource) => act(async () => {
    const next = await api.preview(source.id);
    const avatar = next.avatarImageBase64 ? `data:image/png;base64,${next.avatarImageBase64}` : await galleryPortrait(initialPortrait);
    if (!alive.current) return;
    setPreview(next); setSelected(next.entries.filter(item => item.selected).map(item => item.id)); setName(next.name); setPortrait(avatar);
  });
  const submit = () => act(async () => {
    if (!preview || !portrait) return;
    intent.current ??= { requestId: crypto.randomUUID(), previewId: preview.id, name: name.trim(), avatarImageBase64: portrait.split(',')[1], ...compactCompanionImportSelection(preview, selected), takeover, deferSetup: true };
    // A lost acknowledgement is reconciled before retrying the same host operation.
    let next = await api.status(intent.current.requestId);
    if (!next || next.status === 'needs-attention') next = await api.start(intent.current);
    while (alive.current && next?.status === 'running') {
      setResult(next); onBusy(false);
      await new Promise(resolve => setTimeout(resolve, 1000));
      next = await api.status(intent.current.requestId);
      if (!next) throw new Error('IMPORT_RECEIPT_MISSING');
    }
    if (alive.current && next) setResult(next);
  });
  const toggle = (ids: string[], value: boolean) => setSelected(current => toggleCompanionImportEntries(preview?.entries ?? [], current, ids, value));
  const selectedSet = new Set(selected);
  const locked = busy || !!intent.current;
  const saved = !!result?.saved || result?.status === 'complete';
  const outstanding = result?.checks.filter(check => check.status === 'needs-attention') ?? [];
  const savedIds = new Set(result?.savedEntryIds);
  const incomplete = result?.savedEntryIds ? selected.some(id => !savedIds.has(id)) : outstanding.some(check => check.message === 'IMPORT_ITEM_FAILED');
  const finished = result && result.status !== 'running';
  const openedRequest = useRef<string | undefined>(undefined);
  const enterChat = !!finished && saved && !incomplete && !!result?.canonicalSessionId;
  useEffect(() => {
    if (!enterChat || !result || openedRequest.current === result.requestId) return;
    openedRequest.current = result.requestId;
    onCreated(result.botId);
  }, [enterChat, result, onCreated]);
  const categoryEntries = preview?.entries.filter(entry => entry.category === category) ?? [];
  const filtered = categoryEntries.filter(entry => `${entry.name} ${entry.description ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const openCategory = (next: CompanionImportCategory) => { setCategory(next); setQuery(''); setPage(0); };
  const checkbox = (ids: string[], checked: boolean, label: string, partial = false) => <input type="checkbox" aria-label={label}
    disabled={locked} checked={checked} ref={node => { if (node) node.indeterminate = partial; }} onChange={event => toggle(ids, event.target.checked)}
    className="h-4 w-4 shrink-0 accent-[var(--text-primary)]" />;
  if (enterChat) return null;
  return <div className="flex min-h-0 flex-col gap-5">
    <div className="min-h-0 space-y-5 overflow-y-auto">
    {finished && saved ? <div role="status" className="space-y-5">
      <p className="text-16 font-medium text-[var(--text-primary)]">{tr(incomplete ? 'partial' : 'complete')}</p>
      <div className="divide-y divide-[var(--border-default)]">
        {companionImportCategories.map(group => {
          const ids = new Set(preview?.entries.filter(entry => entry.category === group).map(entry => entry.id));
          const count = result.savedEntryIds ? result.savedEntryIds.filter(id => ids.has(id)).length : result.checks.filter(check => ids.has(check.entryId) && check.status !== 'needs-attention').length;
          if (!ids.size) return null;
          return <div key={group} className="flex items-center justify-between gap-3 py-3 text-14"><span>{tr(group)}</span><span className="text-[var(--text-secondary)]">{count} / {selected.filter(id => ids.has(id)).length}</span></div>;
        })}
      </div>
      {outstanding.length ? <>
        <Button variant="secondary" onClick={() => { setDetails(!details); setDetailPage(0); }}>{tr('details')} · {outstanding.length}</Button>
        {details ? <div className="space-y-3">
          {outstanding.slice(detailPage * 20, (detailPage + 1) * 20).map(check => <div key={check.entryId} className="break-words text-13">
            <p className="text-[var(--text-primary)]">{preview?.entries.find(entry => entry.id === check.entryId)?.name ?? tr('itemAttention')}</p>
            <p className="text-[var(--text-secondary)]">{tr(check.progress?.saved ? 'partlySaved' : savedIds.has(check.entryId) ? 'savedNeedsSetup' : 'notSaved')} · {tr(companionImportReasonKey(check.message))}</p>
            {check.progress ? <p className="text-[var(--text-secondary)]">{check.progress.saved} / {check.progress.total}</p> : null}
          </div>)}
          {outstanding.length > 20 ? <div className="flex justify-between gap-3"><Button variant="secondary" disabled={detailPage === 0} onClick={() => setDetailPage(detailPage - 1)}>{tr('previous')}</Button><span>{detailPage + 1} / {Math.ceil(outstanding.length / 20)}</span><Button variant="secondary" disabled={(detailPage + 1) * 20 >= outstanding.length} onClick={() => setDetailPage(detailPage + 1)}>{tr('next')}</Button></div> : null}
        </div> : null}
      </> : null}
    </div> : result?.status === 'running' ? <div role="status" className="space-y-3 py-5">
      <p className="text-16 font-medium">{tr('running')}</p>
      <p className="text-13 text-[var(--text-secondary)]">{result.checks.length} / {selected.length}</p>
    </div> : !preview ? <div className="space-y-2">
      {sources?.map(source => <Button key={source.id} variant="secondary" size="lg" className="w-full justify-between" disabled={busy} onClick={() => void choose(source)}>{source.name}<span>{source.kind === 'hermes' ? 'Hermes' : 'OpenClaw'}</span></Button>)}
      {error && !sources ? <Button variant="secondary" disabled={busy} onClick={() => void act(async () => { const value = await api.sources(); if (alive.current) setSources(value); })}>{tr('retry')}</Button> : null}
      {sources?.length === 0 ? <p className="text-13 text-[var(--text-secondary)]">{tr('empty')}</p> : null}
    </div> : category ? <section className="space-y-3">
      <div className="flex items-center justify-between gap-3"><h3 className="text-16 font-medium">{tr(category)}</h3>
        <label className="flex items-center gap-2 text-13">{checkbox(categoryEntries.map(entry => entry.id), areCompanionImportEntriesSelected(categoryEntries, selected), tr('selectAll'))}{tr('selectAll')}</label></div>
      <input type="search" aria-label={tr('search')} placeholder={tr('search')} value={query} onChange={event => { setQuery(event.target.value); setPage(0); }}
        className="h-9 w-full rounded-full border border-[var(--border-default)] bg-[var(--confirm-bg)] px-3 text-14 text-[var(--text-primary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]" />
      <div className="divide-y divide-[var(--border-default)]">
        {filtered.slice(page * 20, (page + 1) * 20).map(entry => <label key={entry.id} className="flex min-h-11 cursor-pointer items-start gap-3 py-3">
          <span className="flex h-5 shrink-0 items-center">{checkbox([entry.id], selectedSet.has(entry.id), entry.name)}</span>
          <span className="min-w-0 flex-1 break-words text-14">{entry.name}{entry.description ? <span className="mt-1 line-clamp-2 block text-13 text-[var(--text-secondary)]">{entry.description}</span> : null}</span>
          {entry.enabled === false ? <span className="shrink-0 text-12 text-[var(--text-secondary)]">{tr('paused')}</span> : null}
        </label>)}
      </div>
      {filtered.length > 20 ? <div className="flex items-center justify-between gap-3"><Button variant="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>{tr('previous')}</Button><span className="text-13 text-[var(--text-secondary)]">{page + 1} / {Math.ceil(filtered.length / 20)}</span><Button variant="secondary" disabled={(page + 1) * 20 >= filtered.length} onClick={() => setPage(page + 1)}>{tr('next')}</Button></div> : null}
    </section> : <>
      <div className="flex items-center gap-5">
        <BotPortraitPicker value={portrait} onChange={setPortrait} disabled={locked} />
        <label className="min-w-0 flex-1 text-13 text-[var(--text-secondary)]">{t('bots.creationName')}
          <input autoFocus maxLength={200} value={name} disabled={locked} onChange={event => setName(event.target.value)} className="mt-2 h-11 w-full rounded-full border border-[var(--border-default)] bg-[var(--confirm-bg)] px-3 text-16 text-[var(--text-primary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]" />
        </label>
      </div>
      <div className="divide-y divide-[var(--border-default)]">
        {companionImportCategories.map(group => {
          const entries = preview.entries.filter(item => item.category === group);
          if (!entries.length) return null;
          const count = entries.filter(item => selectedSet.has(item.id)).length;
          const allSelected = areCompanionImportEntriesSelected(entries, selected);
          return <div key={group} className="flex min-h-12 items-center gap-3 py-1">
            {checkbox(entries.map(item => item.id), allSelected, tr(group), count > 0 && !allSelected)}
            <button type="button" disabled={locked} className="flex min-h-11 min-w-0 flex-1 items-center justify-between gap-3 text-left text-14" onClick={() => openCategory(group)}>
              <span>{tr(group)}</span><span className="shrink-0 text-[var(--text-secondary)]">{count} / {entries.length} <span aria-hidden="true">›</span></span>
            </button>
          </div>;
        })}
      </div>
      {preview.entries.some(entry => entry.category === 'automations' && selectedSet.has(entry.id)) ? <label className="flex items-start gap-3 text-13"><input type="checkbox" checked={takeover} disabled={locked} onChange={event => setTakeover(event.target.checked)} className="mt-1 h-4 w-4 shrink-0 accent-[var(--text-primary)]" /><span>{tr('takeover')}</span></label> : null}
    </>}
    {(error || duplicate) ? <p role="alert" className="text-13 text-[var(--text-danger)]">{duplicate ? t('bots.guided.duplicateName') : tr(companionImportReasonKey(error))}</p> : null}
    </div>
    <div className="flex shrink-0 flex-wrap justify-between gap-3 py-3">
      {!saved ? <Button variant="secondary" size="lg" disabled={busy} onClick={() => category ? setCategory(undefined) : onBack()}>{tr('back')}</Button> : null}
      {finished ? <>{!saved || incomplete ? <Button variant="secondary" size="lg" disabled={busy} onClick={() => void submit()}>{tr('retry')}</Button> : null}<Button variant="cta" size="lg" className={saved ? 'ml-auto' : undefined} disabled={!result.canonicalSessionId} onClick={() => onCreated(result.botId)}>{tr('open')}</Button></> : preview && !category ? <Button variant="cta" size="lg" loading={busy} disabled={busy || !name.trim() || !portrait || duplicate} onClick={() => void submit()}>{tr('submit')}</Button> : null}
    </div>
  </div>;
}
