/**
 * Subagent tab discovery — "does this Pi task own a durable Subagent tab?".
 *
 * Registration is a one-shot goal, not a subscription: once the tab exists the
 * panel itself owns every later read (local change pushes / its own 1s remote
 * poll). So this watcher stops as soon as it registers.
 *
 * Two data paths, one contract:
 *  - local task  → local DB read + `subagentRuns.onChanged` push.
 *  - remote task → the durable truth lives on the data-owning device, so the
 *    read goes through device-link. There is no remote change push for this
 *    channel, so a low-frequency poll fills in. It is deliberately 5s-scale:
 *    the only thing it can discover is "a tab should exist", and the panel's
 *    own faster poll takes over the moment it does.
 */

import type { SubagentRunsListResponse } from '@cindy/maker-shared/subagent-workspace';

/** Remote discovery cadence. Coarse on purpose — see the file docblock. */
export const REMOTE_SUBAGENT_DISCOVERY_POLL_MS = 5_000;

export interface SubagentTabDiscoveryOptions {
  readonly sessionId: string;
  /** Data-owning device for a device-link task; null/undefined = this machine. */
  readonly deviceId?: string | null;
  /** Local read (this machine's DB). */
  readonly listLocal: () => Promise<SubagentRunsListResponse>;
  /** Remote read through device-link, already bound to `deviceId`. */
  readonly listRemote: (deviceId: string) => Promise<SubagentRunsListResponse>;
  /** Local-only change push. Returns its unsubscribe. */
  readonly subscribeLocalChanges: (onChanged: () => void) => () => void;
  /** Idempotent tab registration. */
  readonly registerTab: () => Promise<void>;
  /** Guard the response against an auth/data-owner boundary crossed mid-flight. */
  readonly isRequestOwnerCurrent: () => boolean;
  readonly pollMs?: number;
}

/**
 * Start watching. Returns a disposer; safe to call more than once.
 */
export function startSubagentTabDiscovery(options: SubagentTabDiscoveryOptions): () => void {
  const {
    sessionId,
    deviceId,
    listLocal,
    listRemote,
    subscribeLocalChanges,
    registerTab,
    isRequestOwnerCurrent,
    pollMs = REMOTE_SUBAGENT_DISCOVERY_POLL_MS,
  } = options;
  const remote = typeof deviceId === 'string' && deviceId.length > 0;

  let disposed = false;
  let registered = false;
  let poll: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;

  const stopPolling = (): void => {
    if (poll === null) return;
    clearInterval(poll);
    poll = null;
  };

  const discover = async (): Promise<void> => {
    if (disposed || registered || !sessionId) return;
    const response = remote ? await listRemote(deviceId as string) : await listLocal();
    if (disposed || !isRequestOwnerCurrent()) return;
    // `unsupported` is the honest answer from a device that has no durable
    // Subagent store; an empty list means this task simply has no children yet.
    //
    // The tab itself is Pi-only, and `SubagentsBody` drops every non-Pi row, so
    // registering on "any run" opens a permanently empty tab for a task that
    // switched to Pi but only has Claude Code / Codex history in the store. The
    // remote read is already narrowed to Pi on the Main side; this is the local
    // path catching up, filtered here so the IPC contract stays unchanged.
    if (!response.supported || !response.runs.some((run) => run.provider === 'pi')) return;
    await registerTab();
    if (disposed) return;
    registered = true;
    // Registration reached its one-shot goal; the panel owns reads from here.
    stopPolling();
    unsubscribe?.();
    unsubscribe = null;
  };

  const runDiscovery = (): void => {
    void discover().catch(() => undefined);
  };

  runDiscovery();

  if (remote) {
    poll = setInterval(runDiscovery, pollMs);
  } else {
    unsubscribe = subscribeLocalChanges(runDiscovery);
  }

  return () => {
    disposed = true;
    stopPolling();
    unsubscribe?.();
    unsubscribe = null;
  };
}
