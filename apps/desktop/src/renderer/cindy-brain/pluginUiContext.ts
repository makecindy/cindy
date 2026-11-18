import { flushDraft, getDraft, subscribeDraftContent } from '@/lib/composerDraftStore';
import type { Editor, JSONContent } from '@tiptap/core';
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

type Listener = () => void;
type Source = { listeners: Set<Listener>; stop(): void; stopSelection?(): void; revision: number;
  document?: { text: JSONContent | null; serialized: string } };
const sources = new Map<string, Source>();
const editors = new Map<string, { editor: Editor; locked(): boolean }>();
let revision = 0;
// Same-owner projection repairs do not remount the existing composer editor.
const key = (sessionId: string) => JSON.stringify([getDataOwnerGeneration().dataOwnerId, sessionId]);

function changed(source: Source) {
  source.revision = ++revision;
  for (const listener of source.listeners) listener();
}

function observeSelection(id: string, source: Source) {
  source.stopSelection?.();
  const editor = editors.get(id)?.editor;
  if (!editor || editor.isDestroyed) { source.stopSelection = undefined; return; }
  let previous = editor.state.selection;
  const listener = () => {
    const next = editor.state.selection;
    // Empty selections all project to null; moving a caret changes no public state.
    const same = previous.empty && next.empty || previous.eq(next);
    previous = next;
    if (!same) changed(source);
  };
  editor.on('selectionUpdate', listener);
  source.stopSelection = () => editor.off('selectionUpdate', listener);
}

/** Register the existing editor without observing it until a draft View is open. */
export function registerPluginUiDraftEditor(sessionId: string, editor: Editor, locked: () => boolean): () => void {
  const id = key(sessionId), entry = { editor, locked };
  editors.set(id, entry);
  const source = sources.get(id);
  if (source) { observeSelection(id, source); changed(source); }
  return () => {
    if (editors.get(id) !== entry) return;
    editors.delete(id);
    const source = sources.get(id);
    if (source) { observeSelection(id, source); changed(source); }
  };
}

export function replacePluginUiDraftSelection(sessionId: string, text: string): void {
  const entry = editors.get(key(sessionId));
  if (!entry || entry.editor.isDestroyed || !entry.editor.isEditable || entry.locked()) throw new Error('MCP_APP_DRAFT_UNAVAILABLE');
  const { from, to, empty } = entry.editor.state.selection;
  if (empty) throw new Error('MCP_APP_SELECTION_UNAVAILABLE');
  entry.editor.view.dispatch(entry.editor.state.tr.insertText(text, from, to));
}

/** No mounted editor means a stored draft; a live editor owns its existing lock. */
export function assertPluginUiDraftWritable(sessionId: string): void {
  const entry = editors.get(key(sessionId));
  if (entry && (entry.editor.isDestroyed || !entry.editor.isEditable || entry.locked())) throw new Error('MCP_APP_DRAFT_UNAVAILABLE');
}

/** The existing draft store is authoritative; only active Views connect to it. */
export function subscribePluginUiDraft(sessionId: string, listener: Listener): () => void {
  const id = key(sessionId);
  let source = sources.get(id);
  if (!source) {
    source = { listeners: new Set(), revision: ++revision, stop: () => {} };
    const current = source;
    sources.set(id, current);
    const stopContent = subscribeDraftContent(sessionId, () => { current.document = undefined; changed(current); });
    observeSelection(id, current);
    current.stop = () => { stopContent(); current.stopSelection?.(); };
  }
  source.listeners.add(listener);
  return () => {
    source.listeners.delete(listener);
    if (!source.listeners.size) { source.stop(); sources.delete(id); }
  };
}

export function pluginUiDraftSnapshot(sessionId: string) {
  flushDraft(sessionId);
  const editor = editors.get(key(sessionId))?.editor;
  const range = editor && !editor.isDestroyed ? editor.state.selection : undefined;
  return { revision: String(sources.get(key(sessionId))?.revision ?? ++revision),
    selection: range && !range.empty ? { from: range.from, to: range.to,
      text: editor!.state.doc.textBetween(range.from, range.to, '\n').slice(0, 128000) } : null };
}

/** Full fidelity JSON is read only on demand; each standard tool reply stays bounded. */
export function readPluginUiDraftDocument(sessionId: string, offset = 0, expectedRevision?: string) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 0 && !expectedRevision) throw new Error('MCP_APP_INVALID_REQUEST');
  const snapshot = pluginUiDraftSnapshot(sessionId);
  if (expectedRevision !== undefined && expectedRevision !== snapshot.revision) throw new Error('MCP_APP_DRAFT_CHANGED');
  const source = sources.get(key(sessionId)), text = getDraft(sessionId)?.text ?? null;
  const document = source?.document?.text === text ? source.document : { text, serialized: JSON.stringify(text) };
  if (source) source.document = document;
  if (offset > document.serialized.length) throw new Error('MCP_APP_INVALID_REQUEST');
  const end = Math.min(offset + 128000, document.serialized.length);
  return { revision: snapshot.revision, chunk: document.serialized.slice(offset, end),
    nextOffset: end < document.serialized.length ? end : null };
}

export function pluginUiSelection(sessionId: string): string {
  const selection = document.getSelection();
  const parent = selection?.anchorNode?.parentElement?.closest<HTMLElement>('[data-plugin-ui-task]');
  const end = selection?.focusNode?.parentElement?.closest<HTMLElement>('[data-plugin-ui-task]');
  return parent?.dataset.pluginUiTask === sessionId && end?.dataset.pluginUiTask === sessionId
    ? selection?.toString().slice(0, 128000) ?? '' : '';
}
