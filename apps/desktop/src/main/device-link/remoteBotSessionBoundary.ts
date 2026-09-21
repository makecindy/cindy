export type RemoteBotSessionAccess = 'ordinary' | 'visible' | 'hidden' | 'missing';
type Lookup = (sessionId: string, kind?: 'session' | 'bot') => Promise<RemoteBotSessionAccess>;
export type RemoteBotSessionBatchLookup = (ids: readonly string[], kind: 'session' | 'bot') => Promise<ReadonlyMap<string, RemoteBotSessionAccess>>;
let lookup: Lookup | null = null;
let batchLookup: RemoteBotSessionBatchLookup | null = null;

export function setRemoteBotSessionLookup(value: Lookup | null, batch: RemoteBotSessionBatchLookup | null = null): void {
  lookup = value;
  batchLookup = value ? batch : null;
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
    return await activeLookup(key.id, key.kind) === 'hidden' ? null : item;
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
      return item !== null && (!key || (accessByKind.get(key.kind)?.get(key.id) ?? 'hidden') !== 'hidden');
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

/** Called at delivery, including buffered batches and offline replay. */
export async function projectRemoteBotPush(value: unknown, channel = ''): Promise<unknown | null> {
  if (!lookup) return value;
  const ids = sessionIds(value);
  const row = record(value);
  if (channel === 'local-db:sessions:created' && typeof row?.id === 'string') ids.push(row.id);
  for (const id of new Set(ids)) {
    const access = await lookup(id);
    if (access === 'hidden' || (access === 'missing' && row?.source === 'bot')) return null;
  }
  return value;
}

export function hasRemoteBotSessionLookup(): boolean { return lookup !== null; }
