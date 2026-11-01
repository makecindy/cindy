import { randomUUID } from 'node:crypto';

export interface PluginPageProgress {
  progress: number;
  total?: number;
  message?: string;
}

export interface PluginPageCall {
  onProgress?: (progress: PluginPageProgress) => void;
  instance: string;
  revision: string;
  sessionId: string;
  clientId: string;
  tool: string;
  assertCurrent(): Promise<void>;
}

/** Queue create options deliberately omit the business id; cold page restores must add it back. */
export async function restorePluginPageSession<Session extends { id: string }, Meta, Options>(
  sessionId: string,
  deps: {
    getSession(id: string): Session | undefined;
    getMeta(id: string): Promise<Meta | null | undefined>;
    buildCreateOpts(id: string, meta: NonNullable<Meta>): Promise<Options>;
    bootstrap(opts: Options & { id: string }): Promise<Session>;
    assertCurrent(): Promise<void>;
  },
): Promise<Session> {
  await deps.assertCurrent();
  const live = deps.getSession(sessionId);
  if (live) return live;
  const meta = await deps.getMeta(sessionId);
  if (!meta) throw new Error('MCP_APP_SESSION_UNAVAILABLE');
  const opts = await deps.buildCreateOpts(sessionId, meta);
  await deps.assertCurrent();
  const session = await deps.bootstrap({ ...opts, id: sessionId });
  await deps.assertCurrent();
  if (session.id !== sessionId) throw new Error('MCP_APP_SESSION_UNAVAILABLE');
  return session;
}
const calls = new Map<string, PluginPageCall>();
/** Main-only, one-use capability, minted after View and tool authorization. Never sent to the iframe. */
export async function withPluginPageTicket<T>(
  grant: PluginPageCall,
  execute: (ticket: string) => Promise<T>,
): Promise<T> {
  await grant.assertCurrent();
  const ticket = randomUUID();
  calls.set(ticket, grant);
  try {
    return await execute(ticket);
  } finally {
    calls.delete(ticket);
  }
}
export async function consumePluginPageTicket<T>(
  ticket: unknown,
  instance: string,
  revision: string,
  tool: string,
  execute: (grant: PluginPageCall) => Promise<T>,
): Promise<T> {
  const grant = typeof ticket === 'string' ? calls.get(ticket) : undefined;
  if (!grant || grant.instance !== instance || grant.revision !== revision || grant.tool !== tool)
    throw new Error('MCP_APP_CALL_NOT_AUTHORIZED');
  calls.delete(ticket as string);
  await grant.assertCurrent();
  // Authority is an explicit argument, never ambient context: execute may cold-
  // bootstrap an Agent and create shared connections, listeners or async resources.
  const result = await execute(grant);
  await grant.assertCurrent();
  return result;
}

/** Latest-value coalescing, scoped to one View call. Completion never leaves a timer behind. */
export function createPageProgressRelay(
  send: (value: PluginPageProgress, signal: AbortSignal) => Promise<void>,
) {
  const lifetime = new AbortController();
  let pending: PluginPageProgress | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let highWater = -1;
  return {
    update(value: PluginPageProgress) {
      if (closed) return;
      if (value.progress <= highWater) return;
      highWater = value.progress;
      pending = value;
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        const next = pending;
        pending = undefined;
        if (!closed && next) void send(next, lifetime.signal).catch(() => {});
      }, 200);
      timer.unref?.();
    },
    close() {
      closed = true;
      lifetime.abort();
      if (timer) clearTimeout(timer);
      timer = undefined;
      pending = undefined;
    },
  };
}
