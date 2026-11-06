import { getDataOwnerGeneration, type DataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { extractIpcError } from '@/utils/ipcError';
import {
  botReadIdentityKey, effectiveBotReadAt,
  type BotReadIdentity, type BotReadPosition, type BotReadStateChanged,
  type BotReadStateResult,
} from '../../../shared/botReadStateStorage';

type Bridge = Pick<Window['electronAPI']['maker'], 'botReadState' | 'onBotReadStateChanged'>;
export interface BotReadSyncStatus {
  phase: 'idle' | 'loading' | 'ready' | 'error' | 'unavailable';
  /** Corrupt sources are preserved, not reported as successfully imported. */
  corruptSources: readonly string[];
}
interface Dependencies {
  currentOwner: () => DataOwnerGeneration;
  bridge: () => Bridge | undefined;
  storage: () => Storage;
}
const validId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200;
const validAt = (at: unknown): at is number => typeof at === 'number' && Number.isSafeInteger(at) && at >= 0;
export function localBotReadIdentity(key: string): BotReadIdentity {
  return key.startsWith('group:') ? { kind: 'group', id: key.slice(6) }
    : key.startsWith('thread:') ? { kind: 'thread', id: key.slice(7) } : { kind: 'bot', id: key };
}
const validIdentity = (id: BotReadIdentity) => id.kind === 'remote-bot'
  ? validId(id.deviceId) && validId(id.botId) : validId(id.id);
function mergePosition(previous: BotReadPosition | undefined, value: BotReadPosition): BotReadPosition {
  const next = { ...(previous ?? { identity: value.identity }) };
  if (value.initialAt !== undefined) next.initialAt = Math.min(next.initialAt ?? Infinity, value.initialAt);
  if (value.ackAt !== undefined) next.ackAt = Math.max(next.ackAt ?? 0, value.ackAt);
  if (value.legacyFloor !== undefined) next.legacyFloor = Math.max(next.legacyFloor ?? 0, value.legacyFloor);
  return next;
}

/** A renderer mirror, not another persistence writer. Factory also isolates real multi-window tests. */
export function createBotReadStateProjection(deps: Dependencies) {
  let owner = deps.currentOwner();
  let epoch = 0;
  let users = 0;
  let ready = false;
  let status: BotReadSyncStatus = { phase: 'idle', corruptSources: [] };
  let records = new Map<string, BotReadPosition>();
  const pending = new Map<string, BotReadPosition>();
  const seeds = new Map<string, BotReadPosition>();
  const listeners = new Set<() => void>();
  let off: (() => void) | undefined;
  let work: Promise<void> | undefined;
  let requested = false;
  let version: BotReadStateChanged | undefined;
  const retiredInstances = new Set<string>();
  const emit = () => listeners.forEach(fn => fn());
  const sameOwner = (a: DataOwnerGeneration, b: DataOwnerGeneration) => a.dataOwnerId === b.dataOwnerId && a.generation === b.generation;
  function current(token: number) { return token === epoch && sameOwner(owner, deps.currentOwner()); }
  function ensureOwner() {
    if (sameOwner(owner, deps.currentOwner())) return;
    const nextOwner = deps.currentOwner();
    const sameAccount = owner.dataOwnerId !== null && owner.dataOwnerId === nextOwner.dataOwnerId;
    epoch += 1;
    owner = nextOwner;
    off?.(); off = undefined;
    work = undefined; requested = false; ready = false; version = undefined;
    records = new Map();
    // A same-account runtime repair invalidates responses, not the user's still
    // uncommitted read intention. A real sign-out/account switch drops it.
    if (!sameAccount) { pending.clear(); seeds.clear(); }
    retiredInstances.clear();
    status = { phase: 'idle', corruptSources: [] };
    emit();
    if (users) connect();
  }
  function apply(rows: readonly BotReadPosition[]) {
    for (const row of rows) records.set(botReadIdentityKey(row.identity), mergePosition(records.get(botReadIdentityKey(row.identity)), row));
  }
  function accept(result: BotReadStateChanged): boolean {
    if (!sameOwner(result.owner, owner) || retiredInstances.has(result.instanceId)) return false;
    if (version?.instanceId === result.instanceId && result.revision < version.revision) return false;
    if (version && version.instanceId !== result.instanceId) retiredInstances.add(version.instanceId);
    version = result;
    return true;
  }
  /** Reads all current-owner legacy sources once per bootstrap, never in the delegation publish loop. */
  function legacy(): { positions: BotReadPosition[]; corruptSources: string[] } {
    const storage = deps.storage();
    const account = owner.dataOwnerId!;
    const positions = new Map<string, BotReadPosition>();
    const corruptSources: string[] = [];
    const add = (position: BotReadPosition) => {
      if (!validIdentity(position.identity)) return;
      const key = botReadIdentityKey(position.identity);
      positions.set(key, mergePosition(positions.get(key), position));
    };
    function parse(key: string): unknown {
      // getItem exceptions intentionally escape: inaccessible is not empty or corrupt.
      const raw = storage.getItem(key);
      if (raw === null) return null;
      try { return JSON.parse(raw); }
      catch { corruptSources.push(key); return null; }
    }
    const localKey = `cindy.bots.readState.v1.${account}`;
    const local = parse(localKey);
    if (local && typeof local === 'object' && !Array.isArray(local)) {
      for (const [key, at] of Object.entries(local)) if (validAt(at) && at > 0) add({ identity: localBotReadIdentity(key), legacyFloor: at });
    } else if (local !== null) corruptSources.push(localKey);
    for (const key of [`cindy.remoteBots.v1.${account}`, `cindy.remoteBotReads.v1.${account}`]) {
      const rows = parse(key);
      if (rows !== null && !Array.isArray(rows)) { corruptSources.push(key); continue; }
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        if (!row || !validId(row.deviceId) || !validId(row.id) || !validAt(row.readAt)) continue;
        add({ identity: { kind: 'remote-bot', deviceId: row.deviceId, botId: row.id },
          ...(row.readAtIsInitial === true ? { initialAt: row.readAt } : { legacyFloor: row.readAt }) });
      }
    }
    const localPrefix = `cindy.bots.readState.v1.mark.${JSON.stringify(account)}.`;
    const remotePrefix = `cindy.remoteBotReads.v1.entry.${JSON.stringify(account)}.`;
    // key()/length failures also block readiness rather than silently dropping a source.
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) { const key = storage.key(i); if (key) keys.push(key); }
    for (const key of keys) {
      const remote = key.startsWith(remotePrefix);
      if (!remote && !key.startsWith(localPrefix)) continue;
      if (storage.getItem(key) !== '1') continue;
      let row: unknown;
      try { row = JSON.parse(key.slice((remote ? remotePrefix : localPrefix).length)); }
      catch { corruptSources.push(key); continue; }
      if (!Array.isArray(row)) { corruptSources.push(key); continue; }
      const size = remote ? 3 : 2;
      if ((row.length !== size && !(row.length === size + 1 && row[size] === 'initial'))
        || !validId(row[0]) || (remote && !validId(row[1])) || !validAt(row[size - 1])) {
        corruptSources.push(key); continue;
      }
      add({ identity: remote ? { kind: 'remote-bot', deviceId: row[0], botId: row[1] } : localBotReadIdentity(row[0]),
        ...(row.length === size + 1 ? { initialAt: row[size - 1] } : { ackAt: row[size - 1] }) });
    }
    return { positions: [...positions.values()], corruptSources };
  }
  async function batches(api: Bridge, rows: BotReadPosition[], token: number): Promise<void> {
    // 128 bounded identities fit the Main 256 KiB transport budget, including UTF-8 ids.
    for (let i = 0; i < rows.length; i += 128) {
      if (!current(token)) return;
      const result = await api.botReadState({ owner: { ...owner, dataOwnerId: owner.dataOwnerId! }, action: 'merge', positions: rows.slice(i, i + 128) });
      if (!current(token)) return;
      // A merge contains only its own rows, so it must not advance the full-snapshot version.
      if (sameOwner(result.owner, owner) && !retiredInstances.has(result.instanceId)) apply(result.positions);
    }
  }
  async function snapshot(api: Bridge, token: number): Promise<void> {
    const rows: BotReadPosition[] = [];
    let cursor: string | undefined;
    let first: BotReadStateResult | undefined;
    do {
      if (!current(token)) return;
      const result = await api.botReadState({ owner: { ...owner, dataOwnerId: owner.dataOwnerId! }, action: 'snapshot', ...(cursor ? { cursor } : {}) });
      if (!current(token)) return;
      if (!sameOwner(result.owner, owner) || retiredInstances.has(result.instanceId)) throw new Error('Read snapshot owner changed');
      first ??= result;
      if (result.instanceId !== first.instanceId || result.revision !== first.revision) {
        requested = true;
        throw new Error('Read snapshot changed during pagination');
      }
      rows.push(...result.positions);
      cursor = result.nextCursor;
    } while (cursor);
    if (first && accept(first)) {
      records = new Map(rows.map(row => [botReadIdentityKey(row.identity), row]));
      emit();
    }
  }
  function request() {
    ensureOwner();
    requested = true;
    if (work || !users || !owner.dataOwnerId) return;
    const api = deps.bridge();
    if (!api?.botReadState || !api.onBotReadStateChanged) {
      status = { phase: 'unavailable', corruptSources: [] }; emit(); return;
    }
    const token = epoch;
    // The bridge may synchronously publish an invalidation while accepting a merge.
    work = Promise.resolve();
    const operation = (async () => {
      try {
        while (requested && current(token)) {
          requested = false;
          if (!ready) {
            status = { phase: 'loading', corruptSources: [] };
            const imported = legacy();
            status = { ...status, corruptSources: imported.corruptSources };
            await batches(api, imported.positions, token);
            if (!current(token)) return;
            await snapshot(api, token);
            if (!current(token)) return;
            ready = true;
            // Preserve the time of an independent discovery made before bootstrap.
            // Main merges its baseline by minimum, without promoting it over an ack.
            for (const [key, seed] of seeds) pending.set(key, mergePosition(pending.get(key), seed));
            seeds.clear();
            status = { ...status, phase: 'ready' }; emit();
          }
          const writes = [...pending.values()];
          await batches(api, writes, token);
          if (!current(token)) return;
          for (const row of writes) {
            const key = botReadIdentityKey(row.identity);
            if (pending.get(key) === row) pending.delete(key);
          }
          await snapshot(api, token);
          if (current(token)) { status = { ...status, phase: 'ready' }; emit(); }
        }
      } catch (error) {
        if (current(token)) {
          const ipc = extractIpcError(error);
          if (ipc?.code === 'PRECONDITION_FAILED' && ipc.message.endsWith('BOT_READ_SNAPSHOT_STALE')) requested = true;
          status = { ...status, phase: 'error' }; emit();
        }
        // Committed batches remain valid. Pending intentions retry on focus/push/reconnect.
      }
    })();
    work = operation;
    void operation.finally(() => {
      if (current(token)) {
        work = undefined;
        // A concurrent commit may invalidate a paginated cursor. Consume that
        // invalidation once; do not wait for a future push that may never arrive.
        if (requested) request();
      }
    });
  }
  function connect() {
    if (!owner.dataOwnerId || off) return;
    const api = deps.bridge();
    if (api?.onBotReadStateChanged) {
      const token = epoch;
      off = api.onBotReadStateChanged(event => {
        if (!current(token) || !sameOwner(event.owner, owner) || retiredInstances.has(event.instanceId)) return;
        if (version?.instanceId === event.instanceId && event.revision <= version.revision) return;
        request();
      });
    }
    request();
  }
  function read(identity: BotReadIdentity): number | undefined {
    ensureOwner();
    const key = botReadIdentityKey(identity);
    const row = mergePosition(records.get(key), pending.get(key) ?? { identity });
    return effectiveBotReadAt(row);
  }
  function write(identity: BotReadIdentity, at: number, initial: boolean): boolean {
    ensureOwner();
    if (!owner.dataOwnerId || !validIdentity(identity) || !validAt(at)) return false;
    const key = botReadIdentityKey(identity);
    if (initial && !ready) {
      seeds.set(key, mergePosition(seeds.get(key), { identity, initialAt: at }));
      return false;
    }
    const before = read(identity);
    if (initial && before !== undefined) return false;
    const existing = mergePosition(records.get(key), pending.get(key) ?? { identity });
    // An automatic baseline is not an acknowledgement: the first actual read
    // may be earlier (or equal) and must still be committed as an ack.
    if (!initial && (existing.ackAt !== undefined || existing.legacyFloor !== undefined)
      && at <= Math.max(existing.ackAt ?? 0, existing.legacyFloor ?? 0)) return false;
    pending.set(key, mergePosition(pending.get(key), { identity, ...(initial ? { initialAt: at } : { ackAt: at }) }));
    const changed = before !== read(identity);
    if (changed) emit();
    request();
    return changed;
  }
  const focus = () => { ensureOwner(); connect(); request(); };
  return {
    ensureOwner,
    read,
    ack: (identity: BotReadIdentity, at: number) => write(identity, at, false),
    seed: (identity: BotReadIdentity, at: number) => write(identity, at, true),
    localMap(): Record<string, number> {
      ensureOwner();
      const map: Record<string, number> = {};
      for (const row of [...records.values(), ...pending.values()]) {
        const id = row.identity;
        if (id.kind === 'remote-bot') continue;
        const key = id.kind === 'bot' ? id.id : `${id.kind}:${id.id}`;
        const at = read(id);
        if (at !== undefined) Object.defineProperty(map, key, { value: at, enumerable: true, configurable: true });
      }
      return map;
    },
    status: () => status,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    start(): () => void {
      ensureOwner(); users += 1;
      if (users === 1) { window.addEventListener('focus', focus); connect(); }
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true; users -= 1;
        if (!users) {
          window.removeEventListener('focus', focus); off?.(); off = undefined;
          epoch += 1; work = undefined; requested = false; ready = false; version = undefined; retiredInstances.clear();
          status = { ...status, phase: 'idle' };
        }
      };
    },
    /** Test-only mirror reset; committed facts belong to the bridge and survive. */
    reset() {
      off?.(); off = undefined; window.removeEventListener('focus', focus);
      epoch += 1; users = 0; work = undefined; ready = false; requested = false; version = undefined;
      records.clear(); pending.clear(); seeds.clear(); retiredInstances.clear(); listeners.clear();
      owner = deps.currentOwner(); status = { phase: 'idle', corruptSources: [] };
    },
  };
}

export const botReadStateProjection = createBotReadStateProjection({
  currentOwner: getDataOwnerGeneration,
  bridge: () => typeof window === 'undefined' ? undefined : window.electronAPI?.maker,
  storage: () => window.localStorage,
});
/** Mount in every complete app window, outside route lifetime; no notifications are emitted here. */
export const startBotReadStateSync = () => botReadStateProjection.start();
export const getBotReadStateSyncStatus = () => botReadStateProjection.status();
