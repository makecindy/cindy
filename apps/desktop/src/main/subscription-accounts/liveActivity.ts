import type { SubscriptionRootActivity } from './activity.js';

interface LiveRoot {
  id: string;
  agentKind: string;
  remoteHostId: string | null;
  agentDeviceId: string | null;
  requestSessionId: string;
  getStatus(): string;
  isTurnRunning(): boolean;
  listBackgroundTasks(): unknown[];
  hasLiveBackgroundWork?(): Promise<boolean>;
}

// Coalesce the official native RPC while a bounded read has already returned busy.
// No timer loop or follow-up request: only a later actual activity read can use the result.
const probeFlights = new WeakMap<LiveRoot, Promise<boolean>>();
async function readNativeBusy(root: LiveRoot, budgetMs: number): Promise<boolean> {
  if (!root.hasLiveBackgroundWork) return false;
  let flight = probeFlights.get(root);
  if (!flight) {
    flight = Promise.resolve().then(() => root.hasLiveBackgroundWork!()).catch(() => true);
    probeFlights.set(root, flight);
    const current = flight;
    void current.finally(() => { if (probeFlights.get(root) === current) probeFlights.delete(root); });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([flight, new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(true), budgetMs);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Resolve only live local subscription roots; the launcher owns routing and native storage facts. */
export async function readLiveSubscriptionActivity(deps: {
  roots(): readonly LiveRoot[];
  owner?(): string;
  usesOpenai(sessionId: string): boolean;
  accountForRoot(sessionId: string, nativeId: string, root: object): Promise<string | undefined>;
  probeBudgetMs?: number;
}): Promise<SubscriptionRootActivity[]> {
  const result: SubscriptionRootActivity[] = [];
  const owner = deps.owner?.();
  await Promise.all(deps.roots().map(async root => {
    if (root.agentKind !== 'codex' || root.remoteHostId || root.agentDeviceId
      || root.getStatus() === 'closed' || !deps.usesOpenai(root.id)) return;
    const nativeId = root.requestSessionId;
    if (!nativeId) return;
    let accountId: string | undefined;
    try { accountId = await deps.accountForRoot(root.id, nativeId, root); }
    catch (error) {
      if (deps.owner?.() !== owner) throw error;
      return; // Unknown history for one root is not failure of the other accounts.
    }
    let nativeBusy = false;
    if (!root.isTurnRunning() && root.listBackgroundTasks().length === 0) {
      nativeBusy = await readNativeBusy(root, deps.probeBudgetMs ?? 2_000);
    }
    if (deps.owner?.() !== owner) throw new Error('Subscription activity owner changed');
    // A read may outlive close/replacement or a model/source change. Never publish an old root.
    if (!accountId || !deps.roots().includes(root) || root.getStatus() === 'closed'
      || !deps.usesOpenai(root.id) || root.requestSessionId !== nativeId) return;
    result.push({ sessionId: root.id, nativeId, provider: 'openai', accountId,
      running: root.isTurnRunning() || nativeBusy || root.listBackgroundTasks().length > 0,
      isRunning: () => deps.roots().includes(root) && root.requestSessionId === nativeId && root.getStatus() !== 'closed'
        && (root.isTurnRunning() || nativeBusy || root.listBackgroundTasks().length > 0) });
  }));
  return result;
}

/** Native history ownership is immutable for a live root. Share concurrent lookups, not quota/load. */
export function createLiveSubscriptionAccountResolver(deps: {
  owner(): string;
  binding(sessionId: string, nativeId: string): string | undefined;
  historyHome(nativeId: string): Promise<string | undefined>;
  accountForHome(home: string): string | undefined;
  now?(): number;
}): (sessionId: string, nativeId: string, root: object) => Promise<string | undefined> {
  const homes = new WeakMap<object, { owner: string; nativeId: string; at: number; home: Promise<string | undefined>; known: boolean; pending: boolean }>();
  return async (sessionId, nativeId, root) => {
    const bound = deps.binding(sessionId, nativeId);
    if (bound) return bound;
    const owner = deps.owner();
    const now = deps.now?.() ?? Date.now();
    let entry = homes.get(root);
    if (!entry || entry.owner !== owner || entry.nativeId !== nativeId || (!entry.known && !entry.pending && now - entry.at >= 30_000)) {
      entry = { owner, nativeId, at: now, home: deps.historyHome(nativeId), known: false, pending: true };
      homes.set(root, entry);
      const current = entry;
      void current.home.then(home => { current.pending = false; if (home) current.known = true; }, () => { current.pending = false; });
    }
    const home = await entry.home;
    if (deps.owner() !== owner) throw new Error('Subscription activity owner changed');
    return home ? deps.accountForHome(home) : undefined;
  };
}

/** A missing saved provider is not proof of OAuth; use the live app-server's applied auth mode. */
export function confirmedLiveOpenaiProvider(providerId: string | null, hostKey: string | undefined,
  oauthHosts: readonly string[], kindOf: (id: string) => string | undefined): string | undefined {
  if (!hostKey || !oauthHosts.includes(hostKey)) return undefined;
  return providerId ? kindOf(providerId) === 'openai' ? providerId : undefined : 'openai';
}
