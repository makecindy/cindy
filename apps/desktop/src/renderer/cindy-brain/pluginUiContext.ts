import { flushDraft, getDraft, subscribeDraftContent } from '@/lib/composerDraftStore';
import type { Editor, JSONContent } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { Selection, type Transaction } from '@tiptap/pm/state';
import { Slice } from '@tiptap/pm/model';
import { normalizeComposerDocumentJSON } from '@/lib/composerListDocument';
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

type Listener = () => void;
type Source = { listeners: Set<Listener>; stop(): void; stopSelection?(): void; revision: number;
  document?: { text: JSONContent | null; serialized: string } };
const sources = new Map<string, Source>();
type DraftEditor = { editor: Editor; locked(): boolean };
const editors = new Map<string, DraftEditor>();
export type ComposerActionOutcome = { status: 'success' | 'error'; message?: string };
type ComposerAction = {
  sessionId: string;
  instanceId: string;
  contributionId: string;
  editor: DraftEditor;
  openId?: string;
  finish(outcome: ComposerActionOutcome): void;
};
const composerActions = new Map<string, ComposerAction>();
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

function dispatchComposerEdit(editor: Editor, transaction: Transaction, isolated: boolean) {
  if (isolated && transaction.doc.eq(transaction.before)) return;
  editor.view.dispatch(isolated ? closeHistory(transaction) : transaction);
  if (isolated) editor.view.dispatch(closeHistory(editor.state.tr));
}

export function replacePluginUiDraftSelection(sessionId: string, text: string, isolated = false): void {
  const entry = editors.get(key(sessionId));
  if (!entry || entry.editor.isDestroyed || !entry.editor.isEditable || entry.locked()) throw new Error('MCP_APP_DRAFT_UNAVAILABLE');
  const { from, to, empty } = entry.editor.state.selection;
  if (empty) throw new Error('MCP_APP_SELECTION_UNAVAILABLE');
  dispatchComposerEdit(entry.editor, entry.editor.state.tr.insertText(text, from, to), isolated);
}

/** A click belongs to this renderer and this exact mounted editor. */
export function registerPluginUiComposerAction(sessionId: string, editor: Editor,
  source: Pick<ComposerAction, 'instanceId' | 'contributionId'>, finish: ComposerAction['finish']) {
  const entry = editors.get(key(sessionId));
  if (!entry || entry.editor !== editor || editor.isDestroyed || !editor.isEditable || entry.locked()) return;
  const id = crypto.randomUUID();
  composerActions.set(id, { ...source, sessionId, editor: entry, finish });
  return { id, release: () => { composerActions.delete(id); } };
}

function resolveComposerAction(sessionId: string, binding: unknown) {
  if (!binding || typeof binding !== 'object') throw new Error('MCP_APP_ACTION_UNAVAILABLE');
  const { id, openId, instanceId, contributionId } = binding as Record<string, unknown>;
  const action = typeof id === 'string' ? composerActions.get(id) : undefined;
  if (typeof id !== 'string' || typeof openId !== 'string' || !action || action.sessionId !== sessionId ||
      action.instanceId !== instanceId || action.contributionId !== contributionId ||
      action.editor !== editors.get(key(sessionId)) || action.editor.editor.isDestroyed) {
    throw new Error('MCP_APP_ACTION_UNAVAILABLE');
  }
  return { id, openId, action };
}

export function startPluginUiComposerAction(sessionId: string, binding: unknown): void {
  const { openId, action } = resolveComposerAction(sessionId, binding);
  if (action.openId !== undefined) throw new Error('MCP_APP_ACTION_UNAVAILABLE');
  assertPluginUiDraftWritable(sessionId);
  action.openId = openId;
}

export function assertPluginUiComposerActionStarted(sessionId: string, binding: unknown): Editor {
  const { openId, action } = resolveComposerAction(sessionId, binding);
  if (action.openId !== openId) throw new Error('MCP_APP_ACTION_UNAVAILABLE');
  return action.editor.editor;
}

export function finishPluginUiComposerAction(sessionId: string, binding: unknown, outcome: ComposerActionOutcome): void {
  const { id, openId, action } = resolveComposerAction(sessionId, binding);
  if (action.openId !== openId) throw new Error('MCP_APP_ACTION_UNAVAILABLE');
  composerActions.delete(id);
  action.finish(outcome);
}

export type PluginUiDraftWriteMode = 'append' | 'replace' | 'replace-selection';
/** Write through the editor's own schema, save pipeline and undo history. */
export function editPluginUiDraft(editor: Editor, content: JSONContent, mode: PluginUiDraftWriteMode): void {
  let incoming;
  try {
    if (!content || content.type !== 'doc' || !Array.isArray(content.content)) throw new Error('invalid document');
    const document = editor.schema.nodeFromJSON(normalizeComposerDocumentJSON(content));
    if (document.type !== editor.schema.topNodeType) throw new Error('invalid document');
    document.check();
    incoming = document.content;
  } catch { throw new Error('MCP_APP_INVALID_REQUEST'); }
  const { tr, doc } = editor.state;
  if (mode === 'replace-selection') {
    if (editor.state.selection.empty) throw new Error('MCP_APP_SELECTION_UNAVAILABLE');
    tr.replaceSelection(new Slice(incoming, 0, 0));
  } else if (mode === 'append' && !editor.isEmpty) tr.insert(doc.content.size, incoming);
  else tr.replaceWith(0, doc.content.size, incoming);
  if (!editor.isFocused && mode !== 'replace-selection') tr.setSelection(Selection.atEnd(tr.doc));
  dispatchComposerEdit(editor, tr, true);
}

/** No mounted editor means a stored draft; a live editor owns its existing lock. */
export function assertPluginUiDraftWritable(sessionId: string): Editor | undefined {
  const entry = editors.get(key(sessionId));
  if (entry && (entry.editor.isDestroyed || !entry.editor.isEditable || entry.locked())) throw new Error('MCP_APP_DRAFT_UNAVAILABLE');
  return entry?.editor;
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
