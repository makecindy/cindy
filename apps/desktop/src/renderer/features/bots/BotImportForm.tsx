import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { areCompanionImportEntriesSelected, toggleCompanionImportEntries, companionImportIssueKey, companionImportCategories, type CompanionImportApi, type CompanionImportPreview, type CompanionImportResult, type CompanionImportSelection, type CompanionImportSource } from '@cindy/maker-shared/companion-import';
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
  const [takeover, setTakeover] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [result, setResult] = useState<CompanionImportResult>();
  const intent = useRef<CompanionImportSelection | undefined>(undefined);
  const alive = useRef(true);
  const lock = useRef(false);
  const duplicate = bots.some(bot => bot.id !== result?.botId && bot.status !== 'archived' && normalizeBotName(bot.name) === normalizeBotName(name));
  useEffect(() => { alive.current = true; void api.sources().then(value => { if (alive.current) setSources(value); }).catch(() => { if (alive.current) setError(true); }); return () => { alive.current = false; }; }, [api]);
  const act = async (fn: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); onBusy(true); setError(false);
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
      if (alive.current) setError(true);
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
    intent.current ??= { requestId: crypto.randomUUID(), previewId: preview.id, name: name.trim(), avatarImageBase64: portrait.split(',')[1], entryIds: selected, takeover };
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
  const locked = busy || !!intent.current;
  return <div className="space-y-5">
    <p className="text-13 text-[var(--text-secondary)]">{tr('description')}</p>
    {!preview ? <div className="space-y-2">
      {sources?.map(source => <Button key={source.id} variant="secondary" size="lg" className="w-full justify-between" disabled={busy} onClick={() => void choose(source)}>{source.name}<span>{source.kind === 'hermes' ? 'Hermes' : 'OpenClaw'}</span></Button>)}
      {sources?.length === 0 ? <p className="text-13 text-[var(--text-secondary)]">{tr('empty')}</p> : null}
    </div> : <>
      <div className="flex items-center gap-5">
        <BotPortraitPicker value={portrait} onChange={setPortrait} disabled={locked} />
        <label className="min-w-0 flex-1 text-13 text-[var(--text-secondary)]">{t('bots.creationName')}
          <input autoFocus maxLength={200} value={name} disabled={locked} onChange={event => setName(event.target.value)} className="mt-2 h-11 w-full rounded-full border border-[var(--border-default)] bg-[var(--confirm-bg)] px-3 text-16 text-[var(--text-primary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]" />
        </label>
      </div>
      <fieldset disabled={locked} className="divide-y divide-[var(--border-default)] rounded-xl border border-[var(--border-default)]">
        {companionImportCategories.map(category => {
          const entries = preview.entries.filter(item => item.category === category);
          if (!entries.length) return null;
          const count = entries.filter(item => selected.includes(item.id)).length;
          const allSelected = areCompanionImportEntriesSelected(entries, selected);
          return <div key={category} className="px-4 py-3">
            <div className="flex min-h-9 items-center gap-3">
              <input type="checkbox" aria-label={tr(category)} checked={allSelected} ref={node => { if (node) node.indeterminate = count > 0 && !allSelected; }} onChange={event => toggle(entries.map(item => item.id), event.target.checked)} className="h-4 w-4 accent-[var(--text-primary)]" />
              <details className="min-w-0 flex-1" open={category === 'automations'}><summary className="cursor-pointer py-2 text-14 font-medium">{tr(category)} <span className="font-normal text-[var(--text-secondary)]">{count} / {entries.length}</span></summary>
                <div className="max-h-64 overflow-y-auto">
                  {entries.map(entry => <label key={entry.id} className="flex min-h-11 cursor-pointer items-start gap-3 py-2 text-13"><input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-[var(--text-primary)]" checked={selected.includes(entry.id)} onChange={event => toggle([entry.id], event.target.checked)} /><span className="min-w-0 break-words">{entry.name}{entry.description ? <span className="mt-1 block text-[var(--text-secondary)]">{entry.description}</span> : null}{entry.enabled === false ? <span className="block text-[var(--text-secondary)]">{tr('paused')}</span> : null}{entry.issues?.length ? <span className="block text-[var(--text-secondary)]">{tr(companionImportIssueKey(entry.issues[0]))}</span> : null}</span></label>)}
                </div>
              </details>
            </div>
          </div>;
        })}
      </fieldset>
      {preview.entries.some(entry => entry.category === 'automations' && selected.includes(entry.id)) ? <label className="flex gap-3 text-13"><input type="checkbox" checked={takeover} disabled={locked} onChange={event => setTakeover(event.target.checked)} className="mt-1 h-4 w-4 accent-[var(--text-primary)]" /><span>{tr('takeover')}<span className="mt-1 block text-[var(--text-secondary)]">{tr('takeoverNote')}</span></span></label> : null}
    </>}
    {error || duplicate ? <p role="alert" className="text-13 text-[var(--text-danger)]">{duplicate ? t('bots.guided.duplicateName') : tr('error')}</p> : null}
    {result ? <div role="status" className="space-y-2 text-13"><p>{tr(result.status === 'running' ? 'running' : result.status === 'complete' ? 'complete' : 'attention')}</p>{result.checks.filter(check => check.status === 'needs-attention').map(check => <p key={check.entryId} className="text-[var(--text-secondary)]">{preview?.entries.find(entry => entry.id === check.entryId)?.name ?? tr('title')} · {tr(companionImportIssueKey(check.message))}{preview?.entries.find(entry => entry.id === check.entryId)?.category === 'automations' ? ` · ${tr('keptAtSource')}` : ''}</p>)}</div> : null}
    <div className="flex flex-wrap justify-between gap-3">
      <Button variant="secondary" size="lg" disabled={busy} onClick={onBack}>{tr('back')}</Button>
      {result && result.status !== 'running' ? <>{result.status === 'needs-attention' ? <Button variant="secondary" size="lg" disabled={busy} onClick={() => void submit()}>{t('bots.import.retry')}</Button> : null}<Button variant="cta" size="lg" disabled={!result.canonicalSessionId} onClick={() => onCreated(result.botId)}>{tr('open')}</Button></> : preview ? <Button variant="cta" size="lg" loading={busy} disabled={busy || !name.trim() || !portrait || duplicate} onClick={() => void submit()}>{tr('submit')}</Button> : null}
    </div>
  </div>;
}
