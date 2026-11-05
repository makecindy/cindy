import { parsePluginUiEditorSnapshot, type PluginUiComposerEffect, type PluginUiEditorSnapshot, type PluginUiView } from './pluginUi.js';

export interface PluginUiComposerEndpoint {
  current(): boolean;
  snapshot(): PluginUiEditorSnapshot;
  apply(effect: PluginUiComposerEffect): boolean | void;
}
type ApplyResult = 'applied' | 'DRAFT_CHANGED' | 'EDITOR_UNAVAILABLE';
interface Entry { endpoint: PluginUiComposerEndpoint; applied: Map<string, ApplyResult> }
export interface PluginUiComposerTicket {
  key: string; entry: Entry; snapshot: PluginUiEditorSnapshot;
  operations: NonNullable<PluginUiView['editor']>['operations'];
}

/** Endpoint references only. The editor remains the sole draft owner; no copy
 * of its document or editing state is retained in this index. */
export function createPluginUiComposerAccess() {
  const endpoints = new Map<string, Entry>();
  const listeners = new Set<(key: string) => void>();
  const notify = (key: string) => { for (const listener of listeners) listener(key); };
  return {
    register(key: string, endpoint: PluginUiComposerEndpoint) {
      const entry: Entry = { endpoint, applied: new Map() }; endpoints.set(key, entry); notify(key);
      return () => { if (endpoints.get(key) === entry) { endpoints.delete(key); notify(key); } };
    },
    has(key: string) { return endpoints.get(key)?.endpoint.current() === true; },
    onChanged(listener: (key: string) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    capture(key: string, editor: NonNullable<PluginUiView['editor']>): PluginUiComposerTicket | null {
      const entry = endpoints.get(key);
      if (!entry?.endpoint.current()) return null;
      try {
        const raw = entry.endpoint.snapshot();
        const snapshot = parsePluginUiEditorSnapshot({ draftKey: raw.draftKey, revision: raw.revision, selection: raw.selection,
          ...(editor.readSelection && raw.selectedText !== undefined ? { selectedText: raw.selectedText } : {}) });
        return snapshot ? { key, entry, snapshot, operations: [...editor.operations] } : null;
      } catch { return null; }
    },
    apply(ticket: PluginUiComposerTicket, effect: PluginUiComposerEffect): ApplyResult {
      if (endpoints.get(ticket.key) !== ticket.entry || !ticket.entry.endpoint.current() || !ticket.operations.includes(effect.operation)) return 'EDITOR_UNAVAILABLE';
      const previous = ticket.entry.applied.get(effect.operationId);
      if (previous) return previous;
      const frozen = ticket.snapshot, current = ticket.entry.endpoint.snapshot();
      if (effect.draftKey !== frozen.draftKey || effect.expectedDraftRevision !== frozen.revision ||
          effect.selection.start !== frozen.selection.start || effect.selection.end !== frozen.selection.end ||
          current.draftKey !== frozen.draftKey || current.revision !== frozen.revision ||
          current.selection.start !== frozen.selection.start || current.selection.end !== frozen.selection.end) return 'DRAFT_CHANGED';
      let result: ApplyResult;
      try { result = ticket.entry.endpoint.apply(effect) === false ? 'DRAFT_CHANGED' : 'applied'; }
      catch { result = 'EDITOR_UNAVAILABLE'; }
      ticket.entry.applied.set(effect.operationId, result);
      if (ticket.entry.applied.size > 256) ticket.entry.applied.delete(ticket.entry.applied.keys().next().value!);
      return result;
    },
  };
}
