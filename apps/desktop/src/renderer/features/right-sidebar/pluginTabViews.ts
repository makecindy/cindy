import { parsePluginUiValues, pluginUiRecord, pluginUiText } from '@cindy/maker-shared/plugin-ui-host';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, isDataOwnerPushStampCurrent } from '@/contexts/dataOwnerGeneration';
import { findGlobalTab } from './globalTabs';
import { getBucket } from './store';
import { openPluginTabView } from './lib/openPluginTabView';
import { pluginTabViewPositions as positions } from './pluginTabViewPositions';

const listeners = new Map<string, Set<() => void>>();
const newest = new Map<string, number>();
let newestFocusSequence = 0;
let owner = getDataOwnerGeneration();
let initialized = false;
function currentOwner() {
  const next = getDataOwnerGeneration();
  if (!isDataOwnerGenerationCurrent(owner)) { positions.clear(); newest.clear(); newestFocusSequence = 0; owner = next; }
  return next;
}
const publish = (id: string) => { for (const listener of listeners.get(id) ?? []) listener(); };

/** Transport endpoint in the existing native tab owner. No layout preferences. */
export function initPluginTabViewHost(): void {
  currentOwner();
  const api = window.electronAPI?.ghosts?.ui?.tabViews;
  if (!api) return;
  void api.ready().catch(() => {});
  if (initialized) return;
  initialized = true;
  api.onRequest(raw => {
    if (!pluginUiRecord(raw) || !isDataOwnerPushStampCurrent(raw.ownerStamp)) return;
    currentOwner();
    if (pluginUiText(raw.releaseTabId) && Number.isSafeInteger(raw.sequence)) {
      const position = positions.get(raw.releaseTabId);
      if (position && position.sequence <= (raw.sequence as number) &&
          (raw.generation === undefined || position.generation === raw.generation)) positions.delete(raw.releaseTabId);
      return;
    }
    if (!pluginUiText(raw.requestId) || !pluginUiText(raw.instanceId) || !pluginUiText(raw.id, 64) ||
        (raw.sessionId !== null && !pluginUiText(raw.sessionId)) || !Number.isSafeInteger(raw.sequence)) return;
    const params = parsePluginUiValues(raw.params);
    if (!params) return;
    const { requestId, instanceId, id } = raw;
    const sessionId = raw.sessionId as string | null, sequence = raw.sequence as number;
    const key = JSON.stringify([instanceId, id, sessionId]);
    if (sequence < (newest.get(key) ?? 0)) { void api.opened(requestId, null).catch(() => {}); return; }
    newest.set(key, sequence);
    newestFocusSequence = Math.max(newestFocusSequence, sequence);
    const expectedOwner = currentOwner();
    const current = () => isDataOwnerGenerationCurrent(expectedOwner) && newest.get(key) === sequence;
    void (async () => {
      let tabId: string | null = null;
      let positioned: string | null = null;
      try {
        tabId = await openPluginTabView(instanceId, id, sessionId, {
          beforeReveal: id => {
            if (!current()) return;
            positioned = id;
            positions.set(id, { ...positions.get(id), params, sequence }); publish(id);
          }, current, focus: () => newestFocusSequence === sequence,
        });
        if (!isDataOwnerGenerationCurrent(expectedOwner) || newest.get(key) !== sequence) { tabId = null; return; }
        // beforeReveal owns the position. A detached host may already have
        // taken it while tab creation was awaiting IPC; never recreate it here.
      } catch {
        if (positioned && !(sessionId === null ? findGlobalTab(positioned) : getBucket(sessionId).tabs.find(t => t.id === positioned))) positions.delete(positioned);
        tabId = null;
      }
      finally { await api.opened(requestId, tabId).catch(() => {}); }
    })();
  });
}

export async function mountPluginTabView(input: { tabId: string; instanceId: string; id: string; sessionId: string | null; visible: boolean }, signal?: AbortSignal) {
  initPluginTabViewHost();
  const api = window.electronAPI.ghosts.ui.tabViews;
  const expectedOwner = currentOwner();
  const position = positions.get(input.tabId) ?? { params: {}, sequence: 0 };
  const result = await api.mount({ ...input, params: position.params, sequence: position.sequence,
    visible: input.visible && document.visibilityState !== 'hidden' });
  if (signal?.aborted || !isDataOwnerGenerationCurrent(expectedOwner)) { await api.release(result.token, false); throw new Error('VIEW_UNAVAILABLE'); }
  // A native window transfer may have a newer snapshot than this renderer.
  const latest = positions.get(input.tabId);
  positions.set(input.tabId, { ...(latest && latest.sequence > result.sequence ? latest : {
    params: result.snapshot.params, sequence: result.sequence }), generation: result.token });
  let visible = input.visible, closed = false;
  const update = () => {
    const position = positions.get(input.tabId);
    if (closed || !isDataOwnerGenerationCurrent(expectedOwner) || !position || position.generation !== result.token) return;
    void api.update({ token: result.token, params: position.params, sequence: position.sequence,
      visible: visible && document.visibilityState !== 'hidden' }).catch(() => {});
  };
  const set = listeners.get(input.tabId) ?? new Set(); listeners.set(input.tabId, set); set.add(update);
  document.addEventListener('visibilitychange', update);
  const initial = positions.get(input.tabId)!;
  try {
    await api.update({ token: result.token, params: initial.params, sequence: initial.sequence,
      visible: visible && document.visibilityState !== 'hidden' });
    if (signal?.aborted || !isDataOwnerGenerationCurrent(expectedOwner)) throw new Error('VIEW_UNAVAILABLE');
  } catch (error) {
    closed = true; set.delete(update); if (!set.size) listeners.delete(input.tabId);
    document.removeEventListener('visibilitychange', update);
    void api.release(result.token, false).catch(() => {});
    throw error;
  }
  update();
  return { token: result.token,
    setVisible: (value: boolean) => { visible = value; update(); },
    dispose: () => {
      if (closed) return; closed = true;
      set.delete(update); if (!set.size) listeners.delete(input.tabId);
      document.removeEventListener('visibilitychange', update);
      // Unmount may be parking, a native window transfer, or optimistic close.
      // The tab store alone confirms a close; a rollback must keep its position.
      void api.release(result.token, true).catch(() => {});
    } };
}
