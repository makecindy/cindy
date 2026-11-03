import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { useTranslation } from 'react-i18next';
import { resolveRemoteText, type RemoteText } from '@cindy/device-link';
import type { RemoteInvoke } from '@/device-link/mobileMakerTransport';
import { invokeRemoteResourceAction } from '@/device-link/remoteResources';
import { loadCompanionProfile, type CompanionProfileData, type ProfilePanel } from './companionProfileData';

/** Mirrors the host store limits; the host service validates again before writing. */
export const COMPANION_MEMORY_TITLE_MAX = 100;
export const COMPANION_MEMORY_BODY_MAX_BYTES = 8192;
const SEARCH_DEBOUNCE_MS = 300;

export interface CompanionMemoryEntry { id: string; title: string; preview: string; timestamp?: number; resourceId: string }
export interface CompanionMemoryGroup { id: string; title: string; count: number; entries: CompanionMemoryEntry[] }
export interface CompanionMemoryDetail {
  resourceId: string; revision: string; title: string; body: string; kind: string; timestamp?: number;
  form?: ProfilePanel; remove?: ProfilePanel; data: CompanionProfileData;
}
export type CompanionMemoryView = 'list' | 'detail' | 'edit';
export type CompanionMemorySaveState = 'idle' | 'saving' | 'saved' | 'error' | 'conflict';
interface Content { title: string; body: string }

const utf8Bytes = (value: string) => {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
};
export const memoryBodyTooLong = (body: string) => utf8Bytes(body.trim()) > COMPANION_MEMORY_BODY_MAX_BYTES;
/** Same normalization the host applies on save, so whitespace alone never counts as an edit. */
const normalized = ({ title, body }: Content): Content => ({ title: title.replace(/\s+/g, ' ').trim(), body: body.trim() });
const sameContent = (left: Content, right: Content) => {
  const a = normalized(left); const b = normalized(right);
  return a.title === b.title && a.body === b.body;
};
/** Provider failures arrive as INTERNAL; only a stable NOT_FOUND says the memory is gone. */
const isNotFound = (error: unknown) => /(^|\[|\s)NOT_FOUND(\]|\s|:|$)/.test(error instanceof Error ? error.message : String(error));

function toDetail(data: CompanionProfileData, locale: string): CompanionMemoryDetail {
  const block = data.panels.find(panel => panel.id === 'entry');
  const form = block?.action ? block : undefined;
  const remove = data.panels.find(panel => panel.id === 'remove' && panel.action);
  return {
    resourceId: data.resource.ref.id, revision: data.resource.revision,
    title: typeof block?.values.title === 'string' ? block.values.title : resolveRemoteText(data.resource.display.title, locale),
    body: typeof block?.values.body === 'string' ? block.values.body : block?.text ?? '',
    kind: data.resource.display.subtitle ? resolveRemoteText(data.resource.display.subtitle, locale) : '',
    timestamp: data.resource.display.timestamp, form, remove, data,
  };
}
export function companionMemoryGroups(data: CompanionProfileData | null, locale: string): CompanionMemoryGroup[] {
  return (data?.panels ?? []).filter(panel => panel.primitive === 'list' && panel.entries?.length).map(panel => ({
    id: panel.id, title: panel.title ? resolveRemoteText(panel.title, locale) : '', count: panel.count ?? panel.entries!.length,
    entries: panel.entries!.map(entry => ({ id: entry.id, title: resolveRemoteText(entry.title, locale),
      preview: entry.subtitle ? resolveRemoteText(entry.subtitle, locale) : '', timestamp: entry.timestamp, resourceId: entry.resourceId })),
  }));
}

/** "Today" or a short date, optionally with the time, in the UI language. */
export function companionMemoryDate(timestamp: number | undefined, locale: string, today: string, withTime = false): string {
  if (timestamp === undefined) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  try {
    const day = date.toDateString() === new Date().toDateString() ? today
      : new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(date);
    return withTime ? `${day} ${new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(date)}` : day;
  } catch {
    return withTime ? date.toLocaleString() : date.toLocaleDateString();
  }
}
/** Host-owned form field copy for the editor, keyed by field id. */
export function companionMemoryFieldLabel(detail: CompanionMemoryDetail | null, id: 'title' | 'body', locale: string): string {
  const field = detail?.form?.action?.fields?.find(item => item.id === id);
  return field ? resolveRemoteText(field.label, locale) : '';
}

export interface CompanionMemoryOptions {
  invoke: RemoteInvoke;
  openLink(deviceId: string): Promise<unknown>;
  deviceId: string;
  deviceName: string;
  collectionId: string;
  resourceKind: string;
  /** Host-provided saved-memories page; absent on hosts that predate it. */
  listResourceId?: string;
  online: boolean;
  /** The page is shown; leaving it resets to the list. */
  active: boolean;
  /** Account / device / teammate / visibility identity. Late results from another binding are dropped. */
  binding: string;
}

/**
 * Saved-memories page state shared by the SwiftUI and React Native views: list (grouped,
 * host search) → detail → edit. Every write first re-reads the entry: a changed revision
 * means the teammate wrote meanwhile, so nothing is overwritten and the user chooses.
 */
export function useCompanionMemory(o: CompanionMemoryOptions) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const [view, setViewState] = useState<CompanionMemoryView>('list');
  const [list, setList] = useState<CompanionProfileData | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listFailed, setListFailed] = useState(false);
  const [query, setQueryState] = useState('');
  const [detailId, setDetailId] = useState('');
  const [detail, setDetail] = useState<CompanionMemoryDetail | null>(null);
  const [detailFailed, setDetailFailed] = useState(false);
  const [missing, setMissing] = useState(false);
  const [changed, setChanged] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);
  const [draft, setDraftState] = useState<Content>({ title: '', body: '' });
  const [draftGeneration, setDraftGeneration] = useState(0);
  const [saveState, setSaveStateValue] = useState<CompanionMemorySaveState>('idle');
  const [latest, setLatest] = useState<CompanionMemoryDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<RemoteText | null>(null);
  const viewRef = useRef<CompanionMemoryView>('list');
  const draftRef = useRef<Content>(draft);
  const saveStateRef = useRef<CompanionMemorySaveState>('idle');
  /** Host version the draft is based on; every write is checked against it. */
  const base = useRef<CompanionMemoryDetail | null>(null);
  /** Content accepted by the host whose post-save read did not arrive yet. */
  const accepted = useRef<Content | null>(null);
  const queryRef = useRef('');
  const listStale = useRef(false);
  const inFlight = useRef(false);
  const generation = useRef(0);
  const listSequence = useRef(0);
  const detailSequence = useRef(0);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setView = (next: CompanionMemoryView) => { viewRef.current = next; setViewState(next); };
  const setSaveState = (next: CompanionMemorySaveState) => { saveStateRef.current = next; setSaveStateValue(next); };
  const setDraft = (next: Content) => { draftRef.current = next; setDraftState(next); };
  const label = (value: RemoteText) => resolveRemoteText(value, locale);
  const ref = (id: string) => ({ collectionId: o.collectionId, kind: o.resourceKind, id });

  const loadList = useCallback(async (nextQuery: string) => {
    if (!o.listResourceId || !o.online) return;
    const sequence = ++listSequence.current; const started = generation.current;
    const current = () => sequence === listSequence.current && started === generation.current;
    setListLoading(true); setListFailed(false);
    try {
      await o.openLink(o.deviceId);
      const next = await loadCompanionProfile(o.invoke, o.deviceId, ref(o.listResourceId), locale, { query: nextQuery });
      if (!current()) return;
      listStale.current = false; setList(next);
    } catch { if (current()) setListFailed(true); }
    finally { if (current()) setListLoading(false); }
  }, [o.listResourceId, o.online, o.openLink, o.deviceId, o.invoke, o.collectionId, o.resourceKind, locale]);

  // A new account, teammate or sheet opening, or leaving the page starts from a fresh list.
  useEffect(() => {
    generation.current++; inFlight.current = false; base.current = null; accepted.current = null; queryRef.current = '';
    if (searchTimer.current) clearTimeout(searchTimer.current);
    setView('list'); setList(null); setListFailed(false); setListLoading(false); setQueryState(''); setDetail(null); setDetailId('');
    setDetailFailed(false); setMissing(false); setChanged(false); setDeleteFailed(false); setLatest(null); setSaveState('idle'); setBusy(false); setReceipt(null);
    if (o.active && o.online) void loadList('');
    return () => { generation.current++; if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [o.binding, o.active, o.listResourceId]);
  // Reconnecting shows what the list page could not read while offline; drafts are untouched.
  useEffect(() => { if (o.active && o.online && viewRef.current === 'list') void loadList(queryRef.current); }, [o.online]);

  const setQuery = (value: string) => {
    queryRef.current = value; setQueryState(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => { searchTimer.current = null; void loadList(value); }, SEARCH_DEBOUNCE_MS);
  };
  const readDetail = async (resourceId: string) => {
    await o.openLink(o.deviceId);
    return toDetail(await loadCompanionProfile(o.invoke, o.deviceId, ref(resourceId), locale), locale);
  };
  const loadDetail = async (resourceId: string) => {
    const sequence = ++detailSequence.current; const started = generation.current;
    const current = () => sequence === detailSequence.current && started === generation.current;
    setDetailFailed(false);
    try {
      const next = await readDetail(resourceId);
      if (!current()) return;
      base.current = next; accepted.current = null; setDetail(next);
    } catch (error) {
      if (!current()) return;
      if (isNotFound(error)) setMissing(true); else setDetailFailed(true);
    }
  };
  const open = (resourceId: string) => {
    if (inFlight.current) return;
    setDetailId(resourceId); setDetail(null); setMissing(false); setChanged(false); setDeleteFailed(false); setLatest(null); setSaveState('idle'); setReceipt(null);
    setView('detail'); void loadDetail(resourceId);
  };
  const edit = () => {
    if (!detail?.form?.action || inFlight.current) return;
    base.current = detail; setDraft({ title: detail.title, body: detail.body }); setDraftGeneration(value => value + 1);
    setLatest(null); setSaveState('idle'); setReceipt(null); setView('edit');
  };
  const change = (patch: Partial<Content>) => {
    if (inFlight.current) return;
    setDraft({ ...draftRef.current, ...patch });
    if (saveStateRef.current === 'saved' || saveStateRef.current === 'error') setSaveState('idle');
  };
  const isDirty = () => viewRef.current === 'edit' && !!base.current && !sameContent(draftRef.current, base.current);
  const isValid = () => {
    const { title, body } = normalized(draftRef.current);
    return !!title && Array.from(title).length <= COMPANION_MEMORY_TITLE_MAX && !!body && !memoryBodyTooLong(body);
  };
  const adopt = (next: CompanionMemoryDetail) => { base.current = next; accepted.current = null; setDetail(next); };
  const conflict = (next: CompanionMemoryDetail) => { setLatest(next); setSaveState('conflict'); };
  const markMissing = () => { setMissing(true); setSaveState('idle'); };

  const save = async (): Promise<boolean> => {
    const current = base.current;
    if (!isDirty() || !current) return true;
    if (inFlight.current || saveStateRef.current === 'conflict' || !isValid() || !o.online) return false;
    inFlight.current = true; setBusy(true); setSaveState('saving'); setReceipt(null);
    const started = generation.current; const stale = () => started !== generation.current;
    const submitted = normalized(draftRef.current);
    let expected = current.revision;
    try {
      // Renew the one-use host action only against the version this draft started from.
      const fresh = await readDetail(current.resourceId);
      if (stale()) return false;
      if (fresh.revision !== current.revision && !(accepted.current && sameContent(fresh, accepted.current))) { conflict(fresh); return false; }
      adopt(fresh); expected = fresh.revision;
      const action = fresh.form?.action;
      if (!action || action.disabled) { setSaveState('error'); return false; }
      const input: Record<string, string> = {};
      if (submitted.title !== normalized(fresh).title) input.title = submitted.title;
      if (submitted.body !== normalized(fresh).body) input.body = submitted.body;
      if (Object.keys(input).length) {
        const response = await invokeRemoteResourceAction(o.invoke, { deviceId: o.deviceId, deviceName: o.deviceName },
          { collectionId: o.collectionId, resourceRef: fresh.data.resource.ref, actionId: action.id, input }, locale);
        if (stale()) return false;
        const toast = response.effects.find(effect => effect.kind === 'toast');
        if (toast?.kind === 'toast') setReceipt(toast.message);
        accepted.current = submitted; listStale.current = true;
        // The receipt is authoritative; a failed follow-up read only delays the new base version.
        try { const next = await readDetail(current.resourceId); if (!stale()) adopt(next); } catch { /* keep `accepted` */ }
        if (stale()) return false;
      }
      setSaveState('saved');
      return true;
    } catch (error) {
      if (stale()) return false;
      if (isNotFound(error)) { markMissing(); return false; }
      // An ambiguous failure (e.g. lost acknowledgement) is reconciled by reading, never by replaying.
      try {
        const next = await readDetail(current.resourceId);
        if (stale()) return false;
        if (sameContent(next, submitted)) { adopt(next); listStale.current = true; setSaveState('saved'); return true; }
        if (next.revision !== expected) { conflict(next); return false; }
      } catch (readError) {
        if (stale()) return false;
        if (isNotFound(readError)) { markMissing(); return false; }
      }
      setSaveState('error');
      return false;
    } finally {
      inFlight.current = false;
      if (!stale()) setBusy(false);
    }
  };
  const useLatest = () => {
    if (!latest || inFlight.current) return;
    adopt(latest); setDraft({ title: latest.title, body: latest.body }); setDraftGeneration(value => value + 1);
    setLatest(null); setSaveState('idle');
  };
  const keepMine = async () => {
    if (!latest || inFlight.current) return;
    // The user has seen the newer version and still chooses theirs: save against that version.
    adopt(latest); setLatest(null); setSaveState('idle');
    await save();
  };
  const confirmDiscard = () => new Promise<boolean>(resolve => {
    Alert.alert(t('devices.companions.automation.unsavedTitle'), t('devices.companions.automation.unsavedBody'), [
      { text: t('devices.common.cancel'), style: 'cancel', onPress: () => resolve(false) },
      { text: t('devices.companions.automation.discard'), style: 'destructive', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
  /** Before leaving the editor: save when possible, otherwise the user decides to discard or stay. */
  const settle = async (): Promise<boolean> => {
    if (viewRef.current !== 'edit') return !inFlight.current;
    if (await save()) return true;
    if (inFlight.current) return false;
    return confirmDiscard();
  };
  const done = async () => {
    if (isDirty() && !isValid()) return;
    if (await save()) { setLatest(null); setSaveState('idle'); setView('detail'); }
  };
  const finishDeleted = () => {
    base.current = null; setDetail(null); listStale.current = true; setView('list');
    void loadList(queryRef.current);
  };
  const performRemove = async (current: CompanionMemoryDetail) => {
    if (inFlight.current || !o.online) return;
    inFlight.current = true; setBusy(true); setDeleteFailed(false); setChanged(false); setReceipt(null);
    const started = generation.current; const stale = () => started !== generation.current;
    const changedMeanwhile = (next: CompanionMemoryDetail) => { adopt(next); setChanged(true); };
    try {
      const fresh = await readDetail(current.resourceId);
      if (stale()) return;
      if (fresh.revision !== current.revision) { changedMeanwhile(fresh); return; }
      const action = fresh.remove?.action;
      if (!action || action.disabled) { setDeleteFailed(true); return; }
      const response = await invokeRemoteResourceAction(o.invoke, { deviceId: o.deviceId, deviceName: o.deviceName },
        { collectionId: o.collectionId, resourceRef: fresh.data.resource.ref, actionId: action.id, input: {} }, locale);
      if (stale()) return;
      const toast = response.effects.find(effect => effect.kind === 'toast');
      if (toast?.kind === 'toast') setReceipt(toast.message);
      finishDeleted();
    } catch (error) {
      if (stale()) return;
      if (isNotFound(error)) { finishDeleted(); return; }
      try {
        const next = await readDetail(current.resourceId);
        if (stale()) return;
        if (next.revision !== current.revision) { changedMeanwhile(next); return; }
      } catch (readError) {
        if (stale()) return;
        if (isNotFound(readError)) { finishDeleted(); return; }
      }
      setDeleteFailed(true);
    } finally {
      inFlight.current = false;
      if (!stale()) setBusy(false);
    }
  };
  const remove = () => {
    const current = detail; const action = current?.remove?.action;
    if (!current || !action || inFlight.current) return;
    const confirmation = action.confirmation;
    Alert.alert(label(confirmation?.title ?? action.label), confirmation?.body ? label(confirmation.body) : undefined, [
      { text: t('devices.common.cancel'), style: 'cancel' },
      { text: label(confirmation?.confirmLabel ?? action.label), style: 'destructive', onPress: () => { void performRemove(current); } },
    ]);
  };
  /** Sheet back: step out of edit, then detail; `false` means the list should leave the page. */
  const back = async (): Promise<boolean> => {
    if (inFlight.current) return true;
    if (viewRef.current === 'edit') {
      if (!(await settle())) return true;
      if (base.current) setDraft({ title: base.current.title, body: base.current.body });
      setLatest(null); setSaveState('idle'); setView('detail');
      return true;
    }
    if (viewRef.current === 'detail') {
      setView('list'); setDetail(null); setMissing(false); setChanged(false); setDeleteFailed(false);
      if (listStale.current || !list) void loadList(queryRef.current);
      return true;
    }
    return false;
  };
  const retry = () => {
    if (inFlight.current) return;
    if (viewRef.current === 'list') void loadList(queryRef.current);
    else if (detailId) void loadDetail(detailId);
  };

  const dirty = view === 'edit' && !!base.current && !sameContent(draft, base.current);
  const content = normalized(draft);
  return {
    view, query, setQuery, busy, dirty, receipt: receipt ? label(receipt) : null,
    groups: companionMemoryGroups(list, locale),
    searchPanel: list?.panels.find(panel => panel.primitive === 'search'),
    listLoaded: !!list, listLoading, listFailed,
    detail, detailFailed, missing, changed, deleteFailed,
    draft, draftGeneration, saveState, latest,
    titleMissing: !content.title, bodyMissing: !content.body, tooLong: memoryBodyTooLong(draft.body),
    open, edit, change, done, useLatest, keepMine: () => { void keepMine(); }, remove, back, flush: settle, retry,
  };
}
export type CompanionMemoryState = ReturnType<typeof useCompanionMemory>;
