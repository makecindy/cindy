/**
 * Subagent tab discovery — "does this Pi task own a durable Subagent tab?".
 *
 * Registration is a one-shot goal, not a subscription: once the tab exists the
 * panel itself owns every later read (local change pushes / its own 1s remote
 * poll). So this watcher stops as soon as it registers.
 *
 * `onPresenceChange` is the exception. The tab's *visibility* cannot be one-shot
 * the way its registration is: a task that started durable children under Pi and
 * then switched to Claude Code / Codex still owns them, so the entry has to stay
 * — and once the records are gone (`/clear`, a rewind past their start, parent
 * deletion) it has to go away again. Falling edges therefore keep watching past
 * registration: the local path keeps its change subscription, and the remote
 * path — which has no change push at all — drops to a much slower poll rather
 * than stopping. Without a presence consumer both stop at registration, exactly
 * as before.
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

/**
 * Remote cadence *after* the tab exists, when a presence consumer is listening.
 *
 * Four times slower than discovery, because the two answer different questions.
 * Discovery decides whether a tab appears at all, and a user waiting on their
 * first Subagent notices five seconds. This one only decides when an entry for
 * records that no longer exist goes away — nobody is waiting on that, and the
 * cost is one device-link round per visible, already-registered remote task. It
 * is also the only thing that carries a remote `/clear` or rewind across: that
 * boundary emits a local change push the controller never receives.
 */
export const REMOTE_SUBAGENT_PRESENCE_POLL_MS = 20_000;

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
  /**
   * Called after every completed read with "this task has durable Pi runs".
   *
   * Supplying it keeps the local subscription running past registration, so the
   * caller sees the falling edge too. Omit it and this behaves exactly as it
   * did: register once, then stop watching entirely.
   */
  readonly onPresenceChange?: (present: boolean) => void;
  /** Guard the response against an auth/data-owner boundary crossed mid-flight. */
  readonly isRequestOwnerCurrent: () => boolean;
  readonly pollMs?: number;
  /** Overrides the post-registration remote cadence; tests use it. */
  readonly presencePollMs?: number;
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
    onPresenceChange,
    pollMs = REMOTE_SUBAGENT_DISCOVERY_POLL_MS,
    presencePollMs = REMOTE_SUBAGENT_PRESENCE_POLL_MS,
  } = options;
  const remote = typeof deviceId === 'string' && deviceId.length > 0;

  let disposed = false;
  let registered = false;
  let poll: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe: (() => void) | null = null;

  const stopPolling = (): void => {
    if (poll === null) return;
    clearTimeout(poll);
    poll = null;
  };

  const discover = async (): Promise<void> => {
    // `registered` no longer ends the work when a presence consumer is
    // listening: the tab exists, but whether it should still be *offered* is a
    // live question until the records are gone.
    if (disposed || !sessionId || (registered && !onPresenceChange)) return;
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
    const present = response.supported && response.runs.some((run) => run.provider === 'pi');
    onPresenceChange?.(present);
    if (!present || registered) return;
    await registerTab();
    if (disposed) return;
    registered = true;
    // Registration reached its one-shot goal; the panel owns reads from here.
    // A presence consumer keeps both watchers, because "should this entry still
    // be offered" stays a live question — the remote one only drops to
    // `presencePollMs`, since the panel's own faster poll never reports back
    // here and a remote clear has no push to announce itself.
    if (onPresenceChange) return;
    stopPolling();
    unsubscribe?.();
    unsubscribe = null;
  };

  const runDiscovery = (): void => {
    void discover().catch(() => undefined);
  };

  /**
   * Chained, not `setInterval`: the next remote round is only armed once this
   * one settled. A device-link invoke defaults to a 30s timeout, so a fixed 5s
   * interval stacks ~6 in-flight reads against an unreachable device and
   * starves the reliable-transport queue the user's controls share. A rejected
   * round still re-arms — the link coming back is exactly what this poll is
   * waiting for.
   */
  const runRemoteDiscovery = (): void => {
    poll = null;
    void discover().catch(() => undefined).finally(() => {
      if (disposed) return;
      if (registered && !onPresenceChange) return;
      poll = setTimeout(runRemoteDiscovery, registered ? presencePollMs : pollMs);
    });
  };

  if (remote) {
    runRemoteDiscovery();
  } else {
    runDiscovery();
    unsubscribe = subscribeLocalChanges(runDiscovery);
  }

  return () => {
    disposed = true;
    stopPolling();
    unsubscribe?.();
    unsubscribe = null;
  };
}
