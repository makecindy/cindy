export type RemoteBotSessionAccess = 'ordinary' | 'visible' | 'hidden' | 'missing';
type Lookup = (sessionId: string, kind?: 'session' | 'bot') => Promise<RemoteBotSessionAccess>;
let lookup: Lookup | null = null;

export function setRemoteBotSessionLookup(value: Lookup | null): void { lookup = value; }

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function sessionIds(value: unknown): string[] {
  const row = record(value);
  if (!row) return [];
  return [row.sessionId, row.parentSessionId, record(row.session)?.id, record(row.message)?.sessionId]
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/** Resolve channel-specific Bot IDs before checking generic Session references. */
export async function assertRemoteBotInvocationAllowed(args: unknown[], channel = ''): Promise<void> {
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
    if (await lookup(id, channel.startsWith('local-db:bots:') ? 'bot' : 'session') === 'hidden') throw new Error('[NOT_FOUND] Session does not exist');
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
  if (!lookup || !['local-db:sessions:get', 'local-db:sessions:list', 'maker:list-active', 'local-db:sessions:interrupted-pending', 'local-db:bots:get', 'local-db:bots:list', 'maker:remote-resources:get', 'maker:remote-resources:list'].includes(channel)) return value;
  const project = async (item: unknown) => {
    const row = record(item);
    const ref = record(row?.ref);
    if (channel.startsWith('maker:remote-resources:') && ref?.kind !== 'bot') return item;
    const id = ref?.id ?? row?.id ?? row?.sessionId;
    if (!row || typeof id !== 'string') return item;
    const access = await lookup!(id, ref?.kind === 'bot' || channel.startsWith('local-db:bots:') ? 'bot' : 'session');
    return access === 'hidden' ? null : item;
  };
  if (Array.isArray(value)) return (await Promise.all(value.map(project))).filter((item) => item !== null);
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
