import { DL_HISTORY_QUERY_CHANNEL } from '@cindy/device-link';
import { currentDbRpcAdmissionClass, type DbRpcAdmissionClass } from '../localDb/client/rpcAdmission.js';

/**
 * - ordinary / visible:正常可见;hidden:伙伴隐藏,任何远端读写都按不存在处理;
 * - background:插件后台隐藏任务,只从列表类结果(任务列表、运行中列表)中排除,单任务读取
 *   与操作照常,手机插件页可深链打开(未结束提示只回 id,已在源查询排除);missing:不存在。
 */
export type RemoteBotSessionAccess = 'ordinary' | 'visible' | 'hidden' | 'background' | 'missing';

/** 列表类 channel:插件后台隐藏任务不出现在这些结果里(与本机任务列表同口径)。 */
const BACKGROUND_EXCLUDED_LIST_CHANNELS = new Set([
  'local-db:sessions:list',
  'maker:list-active',
]);
type Lookup = (sessionId: string, kind?: 'session' | 'bot') => Promise<RemoteBotSessionAccess>;
export type RemoteBotSessionBatchLookup = (ids: readonly string[], kind: 'session' | 'bot') => Promise<ReadonlyMap<string, RemoteBotSessionAccess>>;
let lookup: Lookup | null = null;
let batchLookup: RemoteBotSessionBatchLookup | null = null;

export function setRemoteBotSessionLookup(value: Lookup | null, batch: RemoteBotSessionBatchLookup | null = null): void {
  lookup = value;
  batchLookup = value ? batch : null;
  // Joined requests keep the lookup they were issued against; new ones use the new one.
  pendingPushAccess.clear();
}

/**
 * Push 授权的同轮合并读取(DataLoader 形状,不是缓存)。
 *
 * 同一次同步分发(多控制端扇出、一次批量 flush、一轮离线回放)里的 push 在调用时登记
 * 要查的任务 ID,本轮微任务结束时合并成一次批量读取;读取发出后的登记进入下一轮。
 * 因此每条 push 的授权读取都在它到达 wire 边界之后才发出,结果只交给已登记的请求,
 * 读取结算后不保留——隐藏/删除/换账号之后到达的 push 必然重新读库,与逐条读取同样新鲜。
 * 按 DB 准入等级分轮,后台读不会搭上交互读的轮次(反之亦然)。
 */
interface PushAccessRound {
  readonly ids: Set<string>;
  /** Settles per ID so an injected single lookup failure stays scoped to that ID. */
  readonly result: Promise<ReadonlyMap<string, Promise<RemoteBotSessionAccess>>>;
}
const pendingPushAccess = new Map<DbRpcAdmissionClass, PushAccessRound>();

function readSessionAccess(
  single: Lookup, batch: RemoteBotSessionBatchLookup | null, ids: readonly string[],
): ReadonlyMap<string, Promise<RemoteBotSessionAccess>> {
  const access = new Map<string, Promise<RemoteBotSessionAccess>>();
  if (batch) {
    const rows = batch(ids, 'session');
    for (const id of ids) access.set(id, rows.then((map) => map.get(id) ?? 'hidden'));
  } else {
    // Injected single-lookup consumers keep the previous one-at-a-time read shape.
    let previous: Promise<unknown> = Promise.resolve();
    for (const id of ids) {
      const current = previous.then(() => single(id, 'session'));
      access.set(id, current);
      previous = current.catch(() => undefined);
    }
  }
  for (const pending of access.values()) pending.catch(() => undefined);
  return access;
}

function readPushSessionAccess(single: Lookup, ids: readonly string[]): Promise<RemoteBotSessionAccess[]> {
  const admission = currentDbRpcAdmissionClass();
  let round = pendingPushAccess.get(admission);
  if (!round) {
    const roundIds = new Set<string>();
    const activeBatch = batchLookup;
    let start!: () => void;
    const result = new Promise<void>((resolve) => { start = resolve; })
      .then(() => readSessionAccess(single, activeBatch, [...roundIds]));
    const created: PushAccessRound = { ids: roundIds, result };
    round = created;
    pendingPushAccess.set(admission, created);
    queueMicrotask(() => {
      if (pendingPushAccess.get(admission) === created) pendingPushAccess.delete(admission);
      start();
    });
  }
  for (const id of ids) round.ids.add(id);
  return round.result.then((access) => Promise.all(ids.map((id) => access.get(id) ?? 'hidden')));
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function sessionIds(value: unknown): string[] {
  const row = record(value);
  if (!row) return [];
  return [
    ...(Array.isArray(row.sessionIds) ? row.sessionIds : []),
    row.sessionId, row.parentSessionId, record(row.session)?.id, record(row.message)?.sessionId]
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/** Resolve channel-specific Bot IDs before checking generic Session references. */
export async function assertRemoteBotInvocationAllowed(args: unknown[], channel = ''): Promise<void> {
  if (channel === DL_HISTORY_QUERY_CHANNEL) {
    if (!lookup) throw new Error('[HOST_NOT_READY] History visibility is not ready');
    const ids = record(record(args[0])?.args)?.session_ids;
    if (ids !== undefined && (!Array.isArray(ids) || ids.length > 50 || ids.some((id) => typeof id !== 'string' || !id || id.length > 512))) {
      throw new Error('[INVALID_PARAMS] Invalid history session IDs');
    }
    // The source query applies visibility before ranking/pagination. Looking up
    // requested IDs here would distinguish hidden sessions from missing ones.
    return;
  }
  if (channel === 'maker:review:start') {
    const id = record(args[0])?.sourceSessionId;
    if (typeof id !== 'string' || !id.trim() || id.length > 512) {
      throw new Error('[INVALID_PARAMS] Invalid review source session ID');
    }
    if (lookup && await lookup(id.trim(), 'session') === 'hidden') {
      throw new Error('[NOT_FOUND] Session does not exist');
    }
    return;
  }
  // Review queries nest the target under payload; recheck it before execution
  // and on cached/queued replies just like top-level Session reads.
  if (channel === 'git-review:remote-op') {
    const id = record(record(args[0])?.payload)?.sessionId;
    if (typeof id !== 'string' || !id.trim() || id.length > 256) {
      throw new Error('[INVALID_PARAMS] Invalid review session ID');
    }
    if (lookup && await lookup(id, 'session') === 'hidden') {
      throw new Error('[NOT_FOUND] Session does not exist');
    }
    return;
  }
  if (channel === 'local-db:task-tags:execute') {
    const request = record(args[0]);
    const targets = request?.sessionIds;
    // Match taskTagsTx's ids(..., 100) / text(..., 128) before any DB lookup.
    // Only sessionIds is consumed by this channel; unrelated object fields must
    // not manufacture additional authorization queries.
    if (!request || args.length !== 1 || (
      targets !== undefined && (
        !Array.isArray(targets) || !targets.length || targets.length > 100 ||
        targets.some((id) => typeof id !== 'string' || !id.trim() || id.trim().length > 128)
      )
    ) || (['get', 'attach', 'detach'].includes(String(request.action)) && targets === undefined)) {
      throw new Error('[INVALID_PARAMS] Invalid task tag session IDs');
    }
    if (lookup && Array.isArray(targets)) {
      for (const id of new Set(targets.map((id: string) => id.trim()))) {
        if (await lookup(id, 'session') === 'hidden') throw new Error('[NOT_FOUND] Session does not exist');
      }
    }
    return;
  }
  if (!lookup) return;
  if (channel === 'maker:bot-direct-message-thread:get') {
    // The first argument is an opaque thread ID, not a Session. The local service
    // still checks membership; remote access additionally requires a visible viewer.
    // Dispatch calls this again for in-flight, cached and queued reply delivery.
    const viewerBotId = args[1];
    if (typeof viewerBotId !== 'string' || await lookup(viewerBotId, 'bot') !== 'visible') {
      throw new Error('[NOT_FOUND] Resource does not exist');
    }
    return;
  }
  const ids = new Set(args.flatMap((arg, index) => [
    ...(index === 0 && typeof arg === 'string' ? [arg] : []), ...sessionIds(arg),
  ]));
  for (const id of ids) {
    if (
      (await lookup(id, channel.startsWith('local-db:bots:') ? 'bot' : 'session')) === 'hidden') throw new Error('[NOT_FOUND] Session does not exist');
  }
  for (const arg of args) {
    const row = record(arg);
    const ref = record(row?.ref) ?? record(row?.resourceRef);
    if (ref?.kind === 'bot' && typeof ref.id === 'string' && await lookup(ref.id, 'bot') === 'hidden') {
      throw new Error('[NOT_FOUND] Resource does not exist');
    }
  }
}

export async function projectRemoteSessionResult(channel: string, value: unknown): Promise<unknown> {
  if (channel === 'local-db:conversations:search') {
    if (!lookup) throw new Error('[HOST_NOT_READY] History visibility is not ready');
    const row = record(value);
    if (!row || !Array.isArray(row.results)) return value;
    // Search pages can wait in the transport cache while a companion is hidden.
    // Re-check personal ownership before returning snippets or identity metadata.
    const ids = [...new Set(row.results.flatMap(item => {
      const id = record(record(record(item)?.session)?.companion)?.id;
      return typeof id === 'string' ? [id] : [];
    }))];
    const access = batchLookup
      ? await batchLookup(ids, 'bot')
      : new Map(await Promise.all(ids.map(async id => [id, await lookup!(id, 'bot')] as const)));
    const results = row.results.filter(item => {
      const id = record(record(record(item)?.session)?.companion)?.id;
      return typeof id !== 'string' || access.get(id) === 'visible';
    });
    return { ...row, results };
  }
  if (channel === DL_HISTORY_QUERY_CHANNEL) {
    if (!lookup) throw new Error('[HOST_NOT_READY] History visibility is not ready');
    // Rechecked on normal, cached and queued delivery by the existing dispatch path.
    const row = record(value);
    if (!row || row.ok !== true) return value;
    const listing = Array.isArray(row.sessions);
    if (!listing && !Array.isArray(row.hits)) throw new Error('[INVALID_PARAMS] Invalid history result');
    const entries = (listing ? row.sessions : row.hits) as unknown[];
    const ids = [...new Set(entries.flatMap((item) => {
      const entry = record(item);
      return [listing ? entry?.id : entry?.sessionId, ...(listing ? [entry?.parentSessionId] : [])]
        .filter((id): id is string => typeof id === 'string');
    }))];
    const access = new Map<string, RemoteBotSessionAccess>();
    if (batchLookup) {
      for (const [id, status] of await batchLookup(ids, 'session')) access.set(id, status);
    } else {
      for (const id of ids) access.set(id, await lookup(id, 'session'));
    }
    const visible = (id: unknown) => typeof id === 'string'
      && (access.get(id) === 'ordinary' || access.get(id) === 'visible' || access.get(id) === 'background');
    // The page and its foreign references share one fresh, source-owned lookup.
    // Missing or hidden page members invalidate pagination; optional parents
    // are simply omitted, including on cached/queued delivery after a hide.
    if (entries.some((item) => !visible(listing ? record(item)?.id : record(item)?.sessionId))) {
      throw new Error('[NOT_FOUND] History page is no longer available');
    }
    if (Array.isArray(row.sessions)) {
      const sessions = row.sessions.map((item) => {
        const { parentSessionId, ...session } = record(item)!;
        return visible(parentSessionId) ? { ...session, parentSessionId } : session;
      });
      return { ...row, sessions };
    }
    const allowed = new Set(entries.map((hit) => record(hit)?.sessionId));
    return { ...row,
      sessions: Object.fromEntries(Object.entries(record(row.sessions) ?? {}).filter(([id]) => allowed.has(id))),
      // Hidden results must not reveal their content, metadata or candidate count.
      pool_size: undefined,
    };
  }
  if (!lookup || ![
      'local-db:task-tags:execute',
      'local-db:sessions:get', 'local-db:sessions:get-many', 'local-db:sessions:list', 'maker:list-active', 'local-db:sessions:interrupted-pending', 'local-db:bots:get', 'local-db:bots:list', 'maker:remote-resources:get', 'maker:remote-resources:list'].includes(channel)) return value;
  if (channel === 'local-db:task-tags:execute') {
    const row = record(value);
    if (!row) return value;
    return {
      ...row,
      sessions: await projectRemoteSessionResult('local-db:sessions:list', row.sessions),
    };
  }
  const activeLookup = lookup;
  const activeBatchLookup = batchLookup;
  const excludeBackground = BACKGROUND_EXCLUDED_LIST_CHANNELS.has(channel);
  const excluded = (access: RemoteBotSessionAccess) =>
    access === 'hidden' || (excludeBackground && access === 'background');
  const identity = (item: unknown) => {
    const row = record(item);
    const ref = record(row?.ref);
    if (channel.startsWith('maker:remote-resources:') && ref?.kind !== 'bot') return null;
    const id = ref?.id ?? row?.id ?? row?.sessionId;
    if (!row || typeof id !== 'string') return null;
    return { id, kind: ref?.kind === 'bot' || channel.startsWith('local-db:bots:') ? 'bot' as const : 'session' as const };
  };
  const project = async (item: unknown) => {
    const key = identity(item);
    if (!key) return item;
    return excluded(await activeLookup(key.id, key.kind)) ? null : item;
  };
  if (Array.isArray(value)) {
    const identities = value.map(identity);
    const accessByKind = new Map<'session' | 'bot', ReadonlyMap<string, RemoteBotSessionAccess>>();
    for (const kind of ['session', 'bot'] as const) {
      const ids = [...new Set(identities.filter((key) => key?.kind === kind).map((key) => key!.id))];
      if (!ids.length) continue;
      if (activeBatchLookup) {
        accessByKind.set(kind, await activeBatchLookup(ids, kind));
      } else {
        // Injected single-lookup consumers must not recreate the per-row RPC burst.
        const access = new Map<string, RemoteBotSessionAccess>();
        for (const id of ids) access.set(id, await activeLookup(id, kind));
        accessByKind.set(kind, access);
      }
    }
    return value.filter((item, index) => {
      const key = identities[index];
      return item !== null && (!key || !excluded(accessByKind.get(key.kind)?.get(key.id) ?? 'hidden'));
    });
  }
  const row = record(value);
  if (row && !row.id && Array.isArray(row.sessions)) return { ...row, sessions: await projectRemoteSessionResult(channel, row.sessions) };
  if (row && Array.isArray(row.items)) {
    const items = await projectRemoteSessionResult(channel, row.items) as unknown[];
    return { ...row, items, ...(items.length !== row.items.length ? { revision: items.map((item) => record(item)?.revision ?? '').join('|') } : {}) };
  }
  const projected = await project(value);
  if (projected === null && channel.endsWith(':get')) throw new Error('[NOT_FOUND] Resource does not exist');
  return projected;
}

/**
 * Called at delivery, including buffered batches and offline replay. The read is
 * shared only with pushes reaching the wire boundary in the same pass (see
 * readPushSessionAccess); it is never reused once issued.
 */
export async function projectRemoteBotPush(value: unknown, channel = ''): Promise<unknown | null> {
  if (!lookup) return value;
  const ids = sessionIds(value);
  const row = record(value);
  if (channel === 'local-db:sessions:created' && typeof row?.id === 'string') ids.push(row.id);
  const unique = [...new Set(ids)];
  if (!unique.length) return value;
  for (const status of await readPushSessionAccess(lookup, unique)) {
    if (status === 'hidden' || (status === 'missing' && row?.source === 'bot')) return null;
  }
  return value;
}

export function hasRemoteBotSessionLookup(): boolean { return lookup !== null; }
