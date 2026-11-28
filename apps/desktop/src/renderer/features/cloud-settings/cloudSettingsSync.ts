import type { CloudSettingsDomain, CloudSettingsState } from '../../../shared/cloudSettings';
import type { CloudSettingsClient } from './client';
import { CLOUD_RETRY_DELAYS_MS } from './blockRetry';

/** One group's unsent change: keys to set and keys to restore to the instance default. */
export type CloudSettingsPatch = { set: Record<string, unknown>; clear: string[] };
/**
 * Explicit failures revert at once. An unknown outcome is read back: notSaved when the instance
 * does not hold the change, unreachable when it could not be read. The page says what is known, or
 * what it will do, never that the outcome is unknown.
 */
export type CloudSyncFailureReason =
  'conflict' | 'rejected' | 'unavailable' | 'notSaved' | 'unreachable';
export interface CloudSyncFailure {
  domain: CloudSettingsDomain;
  reason: CloudSyncFailureReason;
  /** Rereads the group, then submits the same change as a new write on the fresh revision. */
  retry(): void;
}
/** Steppers and number fields wait this long so consecutive edits become one write. */
export const CLOUD_SYNC_DEBOUNCE_MS = 400;

const merge = (
  base: CloudSettingsPatch | undefined,
  set: Record<string, unknown>,
  clear: readonly string[] = [],
): CloudSettingsPatch => {
  const next = { set: { ...base?.set }, clear: [...(base?.clear ?? [])] };
  for (const key of clear) {
    delete next.set[key];
    if (!next.clear.includes(key)) next.clear.push(key);
  }
  for (const [key, value] of Object.entries(set)) {
    next.set[key] = value;
    next.clear = next.clear.filter((cleared) => cleared !== key);
  }
  return next;
};

/** The state the instance will report once the patch is saved, as the trial instance computes it. */
export function projectCloudSettings(
  state: CloudSettingsState,
  patch: CloudSettingsPatch | undefined,
): CloudSettingsState {
  if (!patch || state.status !== 'ready') return state;
  const value = { ...state.value };
  for (const key of patch.clear)
    if (state.defaults && Object.hasOwn(state.defaults, key)) value[key] = state.defaults[key];
  Object.assign(value, patch.set);
  const customizedKeys = state.customizedKeys && [
    ...new Set([
      ...state.customizedKeys.filter((key) => !patch.clear.includes(key)),
      ...Object.keys(patch.set),
    ]),
  ];
  return {
    ...state,
    value: value as CloudSettingsState['value'],
    ...(customizedKeys ? { customizedKeys, isCustomized: customizedKeys.length > 0 } : {}),
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/**
 * What is left to write once the patch is compared with the instance's confirmed state: a value it
 * already holds, or a clear of a key it does not store, is no change, so on → off → on merged into
 * a write of the original value leaves no explicit override.
 */
const effective = (
  state: CloudSettingsState,
  patch: CloudSettingsPatch,
  /** Keys the instance did not store when this page last read the group. */
  unset: ReadonlySet<string>,
): CloudSettingsPatch | undefined => {
  const customized = (key: string) => state.customizedKeys?.includes(key) !== false;
  const set: Record<string, unknown> = {};
  const clear = patch.clear.filter(customized);
  for (const [key, value] of Object.entries(patch.set)) {
    const isDefault =
      !!state.defaults &&
      Object.hasOwn(state.defaults, key) &&
      same(state.defaults[key], value);
    // Back to the default on a key this page's own writes made explicit: clear it instead.
    if (isDefault && unset.has(key)) {
      if (customized(key) && !clear.includes(key)) clear.push(key);
      continue;
    }
    if (state.value && Object.hasOwn(state.value, key) && same(state.value[key], value))
      continue;
    set[key] = value;
  }
  return Object.keys(set).length || clear.length ? { set, clear } : undefined;
};
const landed = (state: CloudSettingsState, patch: CloudSettingsPatch) =>
  state.status === 'ready' &&
  Object.entries(patch.set).every(([key, value]) => same(state.value?.[key], value)) &&
  patch.clear.every((key) => !state.customizedKeys?.includes(key));

function classify(error: unknown): CloudSyncFailureReason | 'unconfirmed' | 'scope' {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('SCOPE_CHANGED')) return 'scope';
  if (message.includes('CONFLICT')) return 'conflict';
  if (message === 'CLOUD_SETTINGS_REJECTED' || message === 'CLOUD_SETTINGS_UNSUPPORTED')
    return 'rejected';
  // Refused before anything was sent.
  if (message === 'CLOUD_SETTINGS_NOT_READY' || message === 'CLOUD_SETTINGS_BUSY')
    return 'unavailable';
  return 'unconfirmed';
}

/**
 * Optimistic writes for one settings client. The page shows confirmed state with unsent and
 * in-flight changes applied. Writes run one at a time; changes to a group that is waiting or
 * in flight merge into one patch and go out on the revision the previous write returned.
 * An unconfirmed outcome is never resubmitted: the group is reread and the instance wins.
 */
export function createCloudSettingsSync(options: {
  client: Pick<CloudSettingsClient, 'save' | 'read'>;
  onChange(): void;
  onSaved?(domain: CloudSettingsDomain, application: string): void;
  onFailure(failure: CloudSyncFailure): void;
  debounceMs?: number;
  /** Waits before each read that checks an unknown outcome. */
  checkDelaysMs?: readonly number[];
}) {
  const { client, debounceMs = CLOUD_SYNC_DEBOUNCE_MS, checkDelaysMs = CLOUD_RETRY_DELAYS_MS } =
    options;
  const confirmed = new Map<CloudSettingsDomain, CloudSettingsState>();
  const pending = new Map<CloudSettingsDomain, CloudSettingsPatch>();
  const timers = new Map<CloudSettingsDomain, ReturnType<typeof setTimeout>>();
  const queued = new Set<CloudSettingsDomain>();
  // A change whose outcome is being read back stays on screen, as if it were still saving.
  const checking = new Map<CloudSettingsDomain, CloudSettingsPatch>();
  // Waits between those reads; leaving the page ends them at once.
  const waits = new Set<() => void>();
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        waits.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      waits.add(done);
    });
  // Logical time of the latest local change or confirmed write per group; older reads lose.
  const touched = new Map<CloudSettingsDomain, number>();
  // Per group, the keys the instance did not store at the last read (not this page's own writes).
  const unset = new Map<CloudSettingsDomain, Set<string>>();
  /**
   * Groups whose latest read failed after an earlier one succeeded: they keep the last value read
   * and are not editable until a read succeeds: the values stay in place and the failure shows on
   * them, as the local IM workspace preferences do.
   */
  const stale = new Set<CloudSettingsDomain>();
  const noteRead = (state: CloudSettingsState) => {
    if (state.status === 'ready' && state.value && state.customizedKeys)
      unset.set(
        state.domain,
        new Set(Object.keys(state.value).filter((key) => !state.customizedKeys!.includes(key))),
      );
  };
  let inflight: { domain: CloudSettingsDomain; patch: CloudSettingsPatch } | undefined;
  let chain = Promise.resolve();
  let running = 0,
    clock = 0,
    disposed = false;
  const notify = () => {
    if (!disposed) options.onChange();
  };
  const touch = (domain: CloudSettingsDomain) => touched.set(domain, ++clock);
  const busy = (domain: CloudSettingsDomain) =>
    pending.has(domain) || timers.has(domain) || inflight?.domain === domain || checking.has(domain);
  const enqueue = (job: () => Promise<void>) => {
    running++;
    chain = chain
      .then(job)
      .catch(() => {})
      .then(() => {
        running--;
        notify();
      });
  };
  const report = (
    domain: CloudSettingsDomain,
    reason: CloudSyncFailureReason,
    patch: CloudSettingsPatch,
  ) => {
    if (!disposed) options.onFailure({ domain, reason, retry: () => retry(domain, patch) });
  };
  // Runs inside the queue, so it is always newer than any write of the same group.
  const refresh = async (domain: CloudSettingsDomain) => {
    try {
      const [latest] = await client.read([domain]);
      if (disposed || latest?.status !== 'ready') return undefined;
      stale.delete(domain);
      confirmed.set(domain, latest);
      noteRead(latest);
      touch(domain);
      notify();
      return latest;
    } catch {
      return undefined;
    }
  };
  const fail = async (domain: CloudSettingsDomain, sent: CloudSettingsPatch, error: unknown) => {
    const reason = classify(error);
    if (reason === 'scope') return;
    const later = pending.get(domain);
    const intended = later ? merge(sent, later.set, later.clear) : sent;
    pending.delete(domain);
    clearTimeout(timers.get(domain));
    timers.delete(domain);
    touch(domain);
    if (reason !== 'unconfirmed') {
      // The instance refused: show the last confirmed value now, then pick up its latest revision.
      notify();
      report(domain, reason, intended);
      await refresh(domain);
      return;
    }
    // Read back, never resent: at once, after 2 s and after 5 s, until a read answers.
    checking.set(domain, intended);
    let latest: CloudSettingsState | undefined;
    for (const delay of checkDelaysMs) {
      if (delay) {
        await pause(delay);
      }
      if (disposed) break;
      latest = await refresh(domain);
      if (latest) break;
    }
    checking.delete(domain);
    if (disposed) return;
    // The page now shows the instance's value, or the last confirmed one if it could not be read.
    notify();
    if (!latest) report(domain, 'unreachable', intended);
    else if (!landed(latest, intended)) report(domain, 'notSaved', intended);
  };
  // Also runs after the page has left (see dispose): the write goes out, nothing on screen changes.
  const send = async (domain: CloudSettingsDomain) => {
    queued.delete(domain);
    const waiting = pending.get(domain),
      base = confirmed.get(domain);
    if (!waiting || !base) return;
    pending.delete(domain);
    // Compared now, after any earlier write of the group has confirmed its new state.
    const patch = effective(base, waiting, unset.get(domain) ?? new Set());
    if (!patch) {
      notify();
      return;
    }
    inflight = { domain, patch };
    try {
      const saved = await client.save(
        base,
        patch.set,
        patch.clear.length ? patch.clear : undefined,
      );
      inflight = undefined;
      // Kept after leaving too, so a later flushed write of the group uses the new revision.
      confirmed.set(domain, saved.state);
      touch(domain);
      if (!disposed) options.onSaved?.(domain, saved.application);
    } catch (error) {
      inflight = undefined;
      // After leaving, a refused or unconfirmed write is left alone: never resent, nothing shown.
      if (!disposed) await fail(domain, patch, error);
    } finally {
      if (!disposed) {
        notify();
        if (pending.has(domain) && !timers.has(domain)) schedule(domain);
      }
    }
  };
  const schedule = (domain: CloudSettingsDomain) => {
    if (disposed || queued.has(domain)) return;
    queued.add(domain);
    enqueue(() => send(domain));
  };
  const change = (
    domain: CloudSettingsDomain,
    set: Record<string, unknown>,
    clear: readonly string[] = [],
    debounce = false,
  ): CloudSettingsState => {
    const base = confirmed.get(domain);
    if (disposed || base?.status !== 'ready' || stale.has(domain))
      throw new Error('CLOUD_SETTINGS_NOT_READY');
    pending.set(domain, merge(pending.get(domain), set, clear));
    touch(domain);
    clearTimeout(timers.get(domain));
    timers.delete(domain);
    if (debounce)
      timers.set(
        domain,
        setTimeout(() => {
          timers.delete(domain);
          schedule(domain);
        }, debounceMs),
      );
    else schedule(domain);
    notify();
    return view()[domain]!;
  };
  const retry = (domain: CloudSettingsDomain, patch: CloudSettingsPatch) => {
    if (disposed) return;
    enqueue(async () => {
      const latest = await refresh(domain);
      if (disposed) return;
      if (!latest) report(domain, 'unreachable', patch);
      else change(domain, patch.set, patch.clear);
    });
  };
  const view = () => {
    const states: Partial<Record<CloudSettingsDomain, CloudSettingsState>> = {};
    for (const [domain, state] of confirmed) {
      const sending = inflight?.domain === domain ? inflight.patch : checking.get(domain);
      const waiting = pending.get(domain);
      states[domain] = projectCloudSettings(
        state,
        sending && waiting ? merge(sending, waiting.set, waiting.clear) : (sending ?? waiting),
      );
    }
    return states;
  };
  return {
    view,
    change,
    /** Logical time to pass back to `ingest` with the result of a read started now. */
    stamp: () => clock,
    /** Accepts a page read unless the group changed locally after the read began. */
    ingest(states: readonly CloudSettingsState[], stamp: number) {
      if (disposed) return;
      for (const state of states)
        if (!busy(state.domain) && (touched.get(state.domain) ?? 0) <= stamp) {
          if (state.status === 'unreadable' && confirmed.get(state.domain)?.status === 'ready') {
            stale.add(state.domain);
            continue;
          }
          stale.delete(state.domain);
          confirmed.set(state.domain, state);
          noteRead(state);
        }
      notify();
    },
    /** Drops groups the instance no longer reports. */
    retain(domains: readonly CloudSettingsDomain[]) {
      for (const domain of confirmed.keys())
        if (!domains.includes(domain) && !busy(domain)) {
          confirmed.delete(domain);
          stale.delete(domain);
        }
    },
    /** True while the group shows its last value read because the latest read failed. */
    stale: (domain: CloudSettingsDomain) => stale.has(domain),
    /** A write that waits for the instance's receipt (explicit save buttons). */
    commit(state: CloudSettingsState, set: Record<string, unknown>, clear?: string[]) {
      return new Promise<{ state: CloudSettingsState; application: string }>((resolve, reject) =>
        enqueue(async () => {
          try {
            const saved = await client.save(confirmed.get(state.domain) ?? state, set, clear);
            if (!disposed) {
              stale.delete(state.domain);
              confirmed.set(state.domain, saved.state);
              touch(state.domain);
            }
            resolve(saved);
          } catch (error) {
            reject(error);
          }
        }),
      );
    },
    /** True while a write is waiting, in flight or being checked. */
    busy: () => running > 0 || timers.size > 0,
    /**
     * Leaving the page, the instance or the account. Changes still waiting (a number field's
     * debounce, or behind another write) go out at once, each exactly once; their results no
     * longer touch the page. Resolves when every write has finished, so the caller can close the
     * session after it. A changed account or instance is refused by the client's own scope check.
     */
    dispose(): Promise<void> {
      if (!disposed) {
        disposed = true;
        for (const done of [...waits]) done();
        for (const timer of timers.values()) clearTimeout(timer);
        timers.clear();
        for (const domain of pending.keys()) {
          if (queued.has(domain)) continue;
          queued.add(domain);
          enqueue(() => send(domain));
        }
      }
      return chain;
    },
  };
}
