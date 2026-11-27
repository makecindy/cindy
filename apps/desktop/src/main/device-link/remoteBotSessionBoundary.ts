import { PROJECT_ARCHIVE_CHANNEL } from '../../shared/projectArchive.js';
import { isPluginObserveTaskStatus, parseSessionStatusIds, SESSION_STATUS_PROJECTION } from '../../shared/pluginObserve.js';
import { DL_HISTORY_QUERY_CHANNEL, TASK_ACTIVITY_SNAPSHOT } from '@cindy/device-link';
import { currentDbRpcAdmissionClass, type DbRpcAdmissionClass } from '../localDb/client/rpcAdmission.js';

/**
 * ordinary / visible: listed tasks; background: owner-readable tasks omitted from
 * default lists (including hidden companion and plugin tasks). hidden: denied by
 * the current owner scope; missing: no record. Account/device authorization is upstream.
 */
export type RemoteBotSessionAccess = 'ordinary' | 'visible' | 'hidden' | 'background' | 'missing';

/** 列表类 channel:插件后台隐藏任务不出现在这些结果里(与本机任务列表同口径)。 */
const BACKGROUND_EXCLUDED_LIST_CHANNELS = new Set([
  PROJECT_ARCHIVE_CHANNEL,
  'local-db:sessions:list',
  'maker:list-active',
]);
export type RemoteSessionLookupKind = 'session' | 'bot' | typeof SESSION_STATUS_PROJECTION;
type Lookup = (sessionId: string, kind?: RemoteSessionLookupKind) => Promise<RemoteBotSessionAccess>;
export type RemoteBotSessionBatchLookup = (ids: readonly string[], kind: RemoteSessionLookupKind) => Promise<ReadonlyMap<string, RemoteBotSessionAccess>>;
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
  single: Lookup, batch: RemoteBotSessionBatchLookup | null, ids: readonly string[], kind: RemoteSessionLookupKind = 'session',
): ReadonlyMap<string, Promise<RemoteBotSessionAccess>> {
  const access = new Map<string, Promise<RemoteBotSessionAccess>>();
  if (batch) {
    const rows = batch(ids, kind);
    for (const id of ids) access.set(id, rows.then((map) => map.get(id) ?? 'hidden'));
  } else {
    // Injected single-lookup consumers keep the previous one-at-a-time read shape.
    let previous: Promise<unknown> = Promise.resolve();
    for (const id of ids) {
      const current = previous.then(() => single(id, kind));
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

function localOriginRefs(item: unknown): { sessionId: string; botId: string | null } | null {
  const origin = record(record(item)?.createdBySession);
  const sessionId = typeof origin?.sessionId === 'string' && origin.sessionId && !origin.sessionId.includes('::')
    ? origin.sessionId : null;
  if (!sessionId) return null;
  const botId = typeof origin?.botId === 'string' && origin.botId ? origin.botId : null;
  return { sessionId, botId };
}

function omitCreatedBySession(item: unknown): unknown {
  const row = record(item);
  if (!row || !('createdBySession' in row)) return item;
  const { createdBySession: _omitted, ...rest } = row;
  return rest;
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
  if (channel === 'local-db:bots:dm-thread:list' || channel === 'local-db:bots:dm-thread:ensure') {
    const body = record(args[0]);
    const botId = body?.botId;
    const rootSessionId = body?.rootSessionId;
    const rootClientId = body?.rootClientId;
    if (args.length !== 1 || typeof botId !== 'string' || !/^\S{1,128}$/.test(botId)
      || typeof rootSessionId !== 'string' || !/^[^:\s]{1,128}$/.test(rootSessionId)
      || (channel.endsWith(':ensure') && (typeof rootClientId !== 'string' || !/^\S{1,256}$/.test(rootClientId)))) {
      throw new Error('[INVALID_PARAMS] Invalid private topic root');
    }
    if (!lookup) throw new Error('[HOST_NOT_READY] Topic visibility is not ready');
    if (await lookup(botId, 'bot') !== 'visible' || await lookup(rootSessionId, 'session') === 'hidden') {
      throw new Error('[NOT_FOUND] Topic does not exist');
    }
    return;
  }
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
  if (channel === TASK_ACTIVITY_SNAPSHOT) return projectRemoteBotPush(value, channel);
  if (channel === 'local-db:conversations:search') {
    if (!lookup) throw new Error('[HOST_NOT_READY] History visibility is not ready');
    const row = record(value);
    if (!row || !Array.isArray(row.results)) return value;
    // Recheck exact records at delivery; a companion's sidebar visibility is not
    // permission to read this owner's task. The device/account boundary is upstream.
    const ids = [...new Set(row.results.flatMap(item => {
      const id = record(record(item)?.session)?.id;
      return typeof id === 'string' ? [id] : [];
    }))];
    const access = batchLookup
      ? await batchLookup(ids, 'session')
      : new Map(await Promise.all(ids.map(async id => [id, await lookup!(id, 'session')] as const)));
    const results = row.results.filter(item => {
      const id = record(record(item)?.session)?.id;
      const status = typeof id === 'string' ? access.get(id) : undefined;
      return status === 'ordinary' || status === 'visible' || status === 'background';
    });
    return { ...row, results };
  }
  if (channel === DL_HISTORY_QUERY_CHANNEL) {
    if (!lookup) throw new Error('[HOST_NOT_READY] History visibility is not ready');
    // Rechecked on normal, cached and queued delivery by the existing dispatch path.
    const row = record(value);
    if (!row || row.ok !== true) return value;
    if (Array.isArray(row.teammates)) {
      await assertHistoryReferences(row.teammates.map(item => record(item)?.id), 'bot');
      return value;
    }
    if (Array.isArray(row.relationships)) {
      await assertHistoryReferences([row.teammateId], 'bot');
      await assertHistoryReferences(row.relationships.map(item => record(item)?.sessionId), 'session');
      return value;
    }
    const listing = Array.isArray(row.sessions);
    if (!listing && !Array.isArray(row.hits)) throw new Error('[INVALID_PARAMS] Invalid history result');
    const entries = (listing ? row.sessions : row.hits) as unknown[];
    const ids = [...new Set(entries.flatMap((item) => {
      const entry = record(item);
      const origin = record(entry?.createdBySession);
      const originSessionId = typeof origin?.sessionId === 'string' && !origin.sessionId.includes('::')
        ? origin.sessionId : undefined;
      return [listing ? entry?.id : entry?.sessionId, ...(listing ? [entry?.parentSessionId, originSessionId] : [])]
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
    // and originating task references are simply omitted, including on cached/queued delivery after a hide.
    if (entries.some((item) => !visible(listing ? record(item)?.id : record(item)?.sessionId))) {
      throw new Error('[NOT_FOUND] History page is no longer available');
    }
    if (Array.isArray(row.sessions)) {
      const sessions = row.sessions.map((item) => {
        const { parentSessionId, createdBySession, ...session } = record(item)!;
        const origin = record(createdBySession);
        const originId = typeof origin?.sessionId === 'string' ? origin.sessionId : null;
        const keepOrigin = originId !== null && (originId.includes('::') || visible(originId));
        return {
          ...session,
          ...(visible(parentSessionId) ? { parentSessionId } : {}),
          ...(keepOrigin ? { createdBySession } : {}),
        };
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
  // Status replies contain only the requested tasks. Recheck them on each delivery before
  // the full-row projection, which also reads and authorizes originating sessions and bots.
  const statusRows = channel === 'local-db:sessions:get-many' ? record(value)?.sessions : undefined;
  if (Array.isArray(statusRows)) {
    if (!lookup) throw new Error('[HOST_NOT_READY] Task visibility is not ready');
    if (!statusRows.length) return { sessions: [] };
    const rows = statusRows.map(row => ({ id: row?.id, status: row?.status }));
    const ids = parseSessionStatusIds(rows.map(row => row.id));
    if (!ids || rows.some(row => !isPluginObserveTaskStatus(row.status))) {
      throw new Error('[INVALID_PARAMS] Invalid session status result');
    }
    const access = readSessionAccess(lookup, batchLookup, ids, SESSION_STATUS_PROJECTION);
    const visibility = await Promise.all(rows.map(row => access.get(row.id)));
    return { sessions: rows.filter((_, index) => visibility[index] === 'ordinary') };
  }
  if (!lookup || ![
      PROJECT_ARCHIVE_CHANNEL, 'local-db:task-tags:execute',
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
  const redactHiddenOrigin = (
    item: unknown,
    sessionAccess: ReadonlyMap<string, RemoteBotSessionAccess>,
    botAccess: ReadonlyMap<string, RemoteBotSessionAccess>,
  ): unknown => {
    const refs = localOriginRefs(item);
    if (!refs) return item;
    const originSessionStatus = sessionAccess.get(refs.sessionId) ?? 'hidden';
    if (excluded(originSessionStatus)) return omitCreatedBySession(item);
    if (excludeBackground && refs.botId && (botAccess.get(refs.botId) ?? 'hidden') === 'hidden') {
      return omitCreatedBySession(item);
    }
    return item;
  };
  const project = async (item: unknown) => {
    const key = identity(item);
    if (!key) return item;
    if (excluded(await activeLookup(key.id, key.kind))) return null;
    const refs = key.kind === 'session' ? localOriginRefs(item) : null;
    if (!refs) return item;
    if (excluded(await activeLookup(refs.sessionId, 'session'))) return omitCreatedBySession(item);
    if (excludeBackground && refs.botId && await activeLookup(refs.botId, 'bot') === 'hidden') {
      return omitCreatedBySession(item);
    }
    return item;
  };
  if (Array.isArray(value)) {
    const identities = value.map(identity);
    const accessByKind = new Map<'session' | 'bot', ReadonlyMap<string, RemoteBotSessionAccess>>();
    for (const kind of ['session', 'bot'] as const) {
      const originIds = kind === 'session'
        ? value.map(localOriginRefs).map((refs) => refs?.sessionId ?? null).filter((id): id is string => id !== null)
        : excludeBackground
          ? value.map(localOriginRefs).map((refs) => refs?.botId ?? null).filter((id): id is string => id !== null)
          : [];
      const ids = [...new Set([
        ...identities.filter((key) => key?.kind === kind).map((key) => key!.id),
        ...originIds,
      ])];
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
    const sessionAccess = accessByKind.get('session') ?? new Map<string, RemoteBotSessionAccess>();
    const botAccess = accessByKind.get('bot') ?? new Map<string, RemoteBotSessionAccess>();
    return value
      .filter((item, index) => {
        const key = identities[index];
        return item !== null && (!key || !excluded(accessByKind.get(key.kind)?.get(key.id) ?? 'hidden'));
      })
      .map((item) => redactHiddenOrigin(item, sessionAccess, botAccess));
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

/** New history shapes keep the existing source-owned access rules on every delivery. */
async function assertHistoryReferences(ids: unknown[], kind: 'session' | 'bot'): Promise<void> {
  if (!lookup) throw new Error('[HOST_NOT_READY] History visibility is not ready');
  if (ids.length > 1000 || ids.some(id => typeof id !== 'string' || !id || id.length > 512))
    throw new Error('[INVALID_PARAMS] Invalid history result');
  const unique = [...new Set(ids as string[])];
  const access = batchLookup ? await batchLookup(unique, kind)
    : new Map(await Promise.all(unique.map(async id => [id, await lookup!(id, kind)] as const)));
  if (unique.some(id => kind === 'bot' ? access.get(id) !== 'visible'
    : !['ordinary', 'visible', 'background'].includes(access.get(id) ?? 'hidden')))
    throw new Error('[NOT_FOUND] History page is no longer available');
}

/**
 * Called at delivery, including buffered batches and offline replay. The read is
 * shared only with pushes reaching the wire boundary in the same pass (see
 * readPushSessionAccess); it is never reused once issued.
 */
export async function projectRemoteBotPush(value: unknown, channel = ''): Promise<unknown | null> {
  if (channel === TASK_ACTIVITY_SNAPSHOT) {
    const selected = record(record(value)?.selected);
    if (!selected) return value;
    if (!lookup || typeof selected.sessionId !== 'string') return { unavailable: true };
    const [access] = await readPushSessionAccess(lookup, [selected.sessionId]);
    return access === 'ordinary' || access === 'visible' || access === 'background' ? value : { unavailable: true };
  }
  const activeLookup = lookup;
  if (!activeLookup) return value;
  const ids = sessionIds(value);
  const row = record(value);
  if (channel === 'local-db:sessions:created' && typeof row?.id === 'string') ids.push(row.id);
  const pushOriginTarget =
    channel === 'local-db:sessions:created'
      ? (record(row?.session) ? 'session' as const : 'root' as const)
      : channel === 'local-db:sessions:patched' && record(row?.patch)
        ? 'patch' as const
        : null;
  const pushOriginHolder =
    pushOriginTarget === 'session' ? record(row?.session)
      : pushOriginTarget === 'patch' ? record(row?.patch)
        : pushOriginTarget === 'root' ? row
          : null;
  const pushOrigin = pushOriginHolder ? localOriginRefs(pushOriginHolder) : null;
  const primaryIds = [...new Set(ids)];
  const lookupIds = pushOrigin && !primaryIds.includes(pushOrigin.sessionId)
    ? [...primaryIds, pushOrigin.sessionId]
    : primaryIds;
  if (!lookupIds.length) return value;
  const statuses = await readPushSessionAccess(activeLookup, lookupIds);
  const statusById = new Map(lookupIds.map((id, index) => [id, statuses[index] ?? 'hidden'] as const));
  for (const id of primaryIds) {
    const status = statusById.get(id) ?? 'hidden';
    if (status === 'hidden' || (status === 'missing' && row?.source === 'bot')) return null;
  }
  if (pushOrigin) {
    const originStatus = statusById.get(pushOrigin.sessionId) ?? 'hidden';
    let omitOrigin = originStatus === 'hidden' || originStatus === 'background';
    if (!omitOrigin && pushOrigin.botId) {
      omitOrigin = (await activeLookup(pushOrigin.botId, 'bot')) === 'hidden';
    }
    if (omitOrigin) {
      if (pushOriginTarget === 'session' && row) {
        return { ...row, session: omitCreatedBySession(row.session) };
      }
      if (pushOriginTarget === 'patch' && row) {
        return { ...row, patch: omitCreatedBySession(row.patch) };
      }
      return omitCreatedBySession(value);
    }
  }
  return value;
}

export function hasRemoteBotSessionLookup(): boolean { return lookup !== null; }
