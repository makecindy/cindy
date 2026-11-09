import { flushDraft, getDraft, subscribeDraftContent } from '@/lib/composerDraftStore';
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

type Listener = () => void;
type Source = { listeners: Set<Listener>; stop(): void; revision: number };
const sources = new Map<string, Source>();
let revision = 0;
const key = (sessionId: string) => JSON.stringify([getDataOwnerGeneration(), sessionId]);

/** The existing draft store is authoritative; only active Views connect to it. */
export function subscribePluginUiDraft(sessionId: string, listener: Listener): () => void {
  const id = key(sessionId);
  let source = sources.get(id);
  if (!source) {
    source = { listeners: new Set(), revision: ++revision, stop: () => {} };
    const current = source;
    sources.set(id, current);
    current.stop = subscribeDraftContent(sessionId, () => {
      current.revision = ++revision;
      for (const changed of current.listeners) changed();
    });
  }
  source.listeners.add(listener);
  return () => {
    source.listeners.delete(listener);
    if (!source.listeners.size) { source.stop(); sources.delete(id); }
  };
}

export function pluginUiDraftSnapshot(sessionId: string) {
  flushDraft(sessionId);
  return { revision: String(sources.get(key(sessionId))?.revision ?? ++revision), text: getDraft(sessionId)?.text ?? null };
}

export function pluginUiSelection(sessionId: string): string {
  const selection = document.getSelection();
  const parent = selection?.anchorNode?.parentElement?.closest<HTMLElement>('[data-plugin-ui-task]');
  const end = selection?.focusNode?.parentElement?.closest<HTMLElement>('[data-plugin-ui-task]');
  return parent?.dataset.pluginUiTask === sessionId && end?.dataset.pluginUiTask === sessionId
    ? selection?.toString().slice(0, 128000) ?? '' : '';
}
