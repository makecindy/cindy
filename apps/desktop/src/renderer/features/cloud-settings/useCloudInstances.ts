import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import type {
  CloudInstanceCapacity,
  CloudSettingsRendererApi,
} from '../../../shared/cloudSettingsClient';
import type { CloudInstanceView } from '../../../shared/cloudInstanceControl';
import { stableInstanceState, canChangeInstancePower } from './instanceState';
import {
  SETTLE_DELAYS_MS,
  useSettleUnknown,
  useSettleUnknownByKey,
  type SettleState,
} from './useSettleUnknown';
import { cloudRefusalKey } from './refusal';

export type CloudInstancesApi = Pick<
  CloudSettingsRendererApi,
  'instanceList' | 'instanceClaim' | 'instanceInitialize' | 'instancePower'
> &
  Partial<Pick<CloudSettingsRendererApi, 'instanceCapacity'>> & {
    onLoginCompleted?(cb: () => void): () => void;
  };
/** A sleep or wake just requested; `uncertain` while its unknown result is read back. */
export type PowerPending = { deviceId: string; action: 'wake' | 'sleep'; uncertain: boolean };
/**
 * What the instance list said about an unknown sleep or wake, or that it could not be read; or that
 * CIS refused it (`refusal` is the message key), which certainly changed nothing.
 */
export type PowerNote = {
  deviceId: string;
  action: 'wake' | 'sleep';
  kind: 'notTaken' | 'unreadable' | 'refused';
  refusal?: string;
};
/** An unknown claim: being read back, not claimed after all, or the list could not be read. */
export type ClaimState = SettleState | 'notClaimed';

/** The sleep confirmation, as the card asks it (and as a simulated frame shows it). */
export const sleepConfirmation = (t: (key: string, values?: Record<string, string>) => string, name: string) => ({
  title: t('cloudSettings.instance.sleepTitle', { name }),
  description: t('cloudSettings.instance.sleepBody', { name }),
  confirmText: t('cloudSettings.instance.sleepConfirm'),
  // As the local delete and update confirmations: the main button has focus.
  autoFocusConfirm: true,
});

const powerVerdict = (list: readonly CloudInstanceView[], pending: PowerPending) =>
  list.find((item) => item.deviceId === pending.deviceId)?.desiredState ===
  (pending.action === 'wake' ? 'running' : 'stopped')
    ? 'done'
    : 'notDone';

/**
 * The owner's CIS instance list with its claim, login and power actions, polled once per view:
 * every 30 s, every 5 s while an instance is changing, never while the window is hidden.
 * Membership discovery is read-only; only an explicit claim ensures a first instance.
 * A claim, sleep or wake with an unknown result is read back, never submitted again.
 * Each instance sleeps and wakes on its own: one still waking never holds up another.
 */
export function useCloudInstances(api: CloudInstancesApi, onOpen: (deviceId: string) => void) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [instances, setInstances] = useState<CloudInstanceView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // Failed list reads, counted so a caller can try again after each (useBlockRetry).
  const [failures, setFailures] = useState(0);
  const [waiting, setWaiting] = useState<string>();
  // Per instance: the sleep or wake under way, and what one that did not happen left to say.
  const [powerPending, setPowerPending] = useState<ReadonlyMap<string, PowerPending>>(
    () => new Map(),
  );
  const [notTaken, setNotTaken] = useState<ReadonlyMap<string, PowerPending['action']>>(
    () => new Map(),
  );
  const [refusedPower, setRefusedPower] = useState<ReadonlyMap<string, PowerNote>>(
    () => new Map(),
  );
  const [notClaimed, setNotClaimed] = useState(false);
  // How many instances the owner has and may have; another is offered only below the limit.
  // Read with the list when its length changes or on an explicit refresh, never on a timer.
  const [capacity, setCapacity] = useState<CloudInstanceCapacity | null>(null);
  const capacityCount = useRef(-1);
  const powerRef = useRef<ReadonlyMap<string, PowerPending>>(new Map());
  const markPower = (deviceId: string, value: PowerPending | undefined) => {
    const next = new Map(powerRef.current);
    if (value) next.set(deviceId, value);
    else next.delete(deviceId);
    powerRef.current = next;
    setPowerPending(next);
  };
  const without = <V,>(map: ReadonlyMap<string, V>, deviceId: string) => {
    if (!map.has(deviceId)) return map;
    const next = new Map(map);
    next.delete(deviceId);
    return next;
  };
  const live = useRef(false),
    inFlight = useRef(false),
    openWhenReady = useRef<string | undefined>(undefined);
  const settlePower = (verdict: 'done' | 'notDone', pending: PowerPending) => {
    if (!live.current) return;
    // Arrived: wait for it like a confirmed request. Not arrived: say so, and allow it again.
    if (verdict === 'done') markPower(pending.deviceId, { ...pending, uncertain: false });
    else {
      markPower(pending.deviceId, undefined);
      setNotTaken((notes) => new Map(notes).set(pending.deviceId, pending.action));
    }
  };
  const readList = async () => {
    const next = await api.instanceList({});
    if (live.current) {
      setInstances(next);
      setError(undefined);
    }
    return next;
  };
  const powerCheck = useSettleUnknownByKey<PowerPending>({
    keyOf: (pending) => pending.deviceId,
    delays: SETTLE_DELAYS_MS.power,
    check: async (pending) => powerVerdict(await readList(), pending),
    onSettled: settlePower,
  });
  const claimCheck = useSettleUnknown<readonly string[]>({
    delays: SETTLE_DELAYS_MS.claim,
    // Found: the list has an instance it did not have when the claim was sent.
    check: async (known) =>
      (await readList()).some((view) => !known.includes(view.deviceId)) ? 'done' : 'notDone',
    onSettled: (verdict) => {
      if (live.current) setNotClaimed(verdict === 'notDone');
    },
  });
  const checks = useRef({ power: powerCheck, claim: claimCheck });
  checks.current = { power: powerCheck, claim: claimCheck };
  const load = useCallback(
    async (explicit = false) => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const next = await api.instanceList({});
        const counted =
          api.instanceCapacity && (explicit || capacityCount.current !== next.length)
            ? await api.instanceCapacity({}).catch(() => null)
            : undefined;
        if (live.current) {
          setInstances(next);
          setError(undefined);
          if (counted !== undefined) {
            capacityCount.current = next.length;
            setCapacity(counted);
          }
          const { power: powerState, claim } = checks.current;
          for (const pending of powerRef.current.values()) {
            // A list that answers after the read-backs ran out settles them as well.
            if (pending.uncertain && powerState.entries.get(pending.deviceId)?.state === 'unreadable') {
              powerState.stop(pending.deviceId);
              settlePower(powerVerdict(next, pending), pending);
            } else if (
              !pending.uncertain &&
              next.some(
                (item) =>
                  item.deviceId === pending.deviceId &&
                  powerVerdict([item], pending) === 'done' &&
                  stableInstanceState(item),
              )
            )
              markPower(pending.deviceId, undefined);
          }
          // "It did not go to sleep" holds until the instance gets there some other way.
          const arrived = (deviceId: string, action: PowerPending['action']) =>
            next.some(
              (v) =>
                v.deviceId === deviceId &&
                powerVerdict([v], { deviceId, action, uncertain: false }) === 'done',
            );
          setNotTaken((notes) => {
            let kept = notes;
            for (const [deviceId, action] of notes)
              if (arrived(deviceId, action)) kept = without(kept, deviceId);
            return kept;
          });
          if (claim.state === 'unreadable' && claim.context) {
            const known = claim.context;
            claim.stop();
            setNotClaimed(!next.some((view) => !known.includes(view.deviceId)));
          }
          setRefusedPower((notes) => {
            let kept = notes;
            for (const note of notes.values())
              if (arrived(note.deviceId, note.action)) kept = without(kept, note.deviceId);
            return kept;
          });
        }
      } catch {
        if (live.current) {
          setError('readFailed');
          setFailures((count) => count + 1);
        }
      } finally {
        inFlight.current = false;
      }
    },
    [api],
  );
  useEffect(() => {
    live.current = true;
    void load();
    return () => {
      live.current = false;
    };
  }, [load]);
  useEffect(
    () =>
      api.onLoginCompleted?.(() => {
        void load();
      }),
    [api, load],
  );
  const checking =
    [...powerCheck.entries.values()].some((entry) => entry.state === 'checking') ||
    claimCheck.state === 'checking';
  // An update was just requested from the card's dialog: the list is read every 2 s for 30 s, so
  // the card moves from scheduled to updating soon.
  const [hurrying, setHurrying] = useState(0);
  useEffect(() => {
    if (!hurrying) return;
    const timer = setTimeout(() => setHurrying(0), 30_000);
    return () => clearTimeout(timer);
  }, [hurrying]);
  useEffect(() => {
    const pending =
      powerPending.size > 0 || instances?.some((v) => v.loginRequired || !stableInstanceState(v));
    const timer = setInterval(
      () => {
        // While a result is read back on its own schedule, the list waits for it.
        if (document.visibilityState !== 'hidden' && !checking) void load();
      },
      hurrying ? 2_000 : pending ? 5_000 : 30_000,
    );
    const visible = () => {
      if (document.visibilityState !== 'hidden' && !checking) void load();
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [instances, load, powerPending, checking, hurrying]);
  useEffect(() => {
    const completed = instances?.find(
      (v) => v.deviceId === openWhenReady.current && !v.loginRequired && v.ready,
    );
    if (completed) {
      openWhenReady.current = undefined;
      onOpen(completed.deviceId);
    }
  }, [instances, onOpen]);

  const initialize = async (deviceId: string) => {
    await api.instanceInitialize({ deviceId });
    if (live.current) {
      setWaiting(deviceId);
      // An auxiliary login must not navigate the workspace when it completes.
      if (!api.onLoginCompleted) openWhenReady.current = deviceId;
    }
  };
  const act = async (claim: boolean, deviceId?: string) => {
    if (inFlight.current || claimCheck.state) return;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    let creating = claim;
    try {
      if (claim) {
        setNotClaimed(false);
        const next = await api.instanceClaim({});
        if (!live.current) return;
        setInstances(next);
        creating = false;
        capacityCount.current = -1;
        if (next.length === 1 && next[0]!.loginRequired) await initialize(next[0]!.deviceId);
        else if (next.length === 1) openWhenReady.current = next[0]!.deviceId;
      } else if (deviceId) await initialize(deviceId);
    } catch (caught) {
      if (live.current) {
        // A refusal created nothing: it says why, and is not read back.
        const refusal = cloudRefusalKey(caught);
        if (refusal) setError(refusal);
        // An unknown claim is read back from the list; claiming again could make a second one.
        else if (creating) void claimCheck.start(instances?.map((view) => view.deviceId) ?? []);
        else setError('loginFailed');
      }
    } finally {
      inFlight.current = false;
      if (live.current) setBusy(false);
    }
  };
  /**
   * `confirmed`: the user already confirmed this request once (its retry); no second ask.
   * Only this instance's own sleep or wake waits for it; the others stay free.
   */
  const power = async (instance: CloudInstanceView, name: string, options?: { confirmed?: boolean }) => {
    if (
      inFlight.current ||
      powerRef.current.has(instance.deviceId) ||
      error ||
      !canChangeInstancePower(instance)
    )
      return;
    inFlight.current = true;
    setBusy(true);
    const action = instance.desiredState === 'stopped' ? 'wake' : 'sleep';
    let unknown = false;
    try {
      if (action === 'sleep' && !options?.confirmed && !(await confirm(sleepConfirmation(t, name))))
        return;
      if (!live.current) return;
      if (action === 'sleep') {
        if (openWhenReady.current === instance.deviceId) openWhenReady.current = undefined;
        setWaiting((current) => (current === instance.deviceId ? undefined : current));
      }
      setNotTaken((notes) => without(notes, instance.deviceId));
      setRefusedPower((notes) => without(notes, instance.deviceId));
      markPower(instance.deviceId, { deviceId: instance.deviceId, action, uncertain: false });
      await api.instancePower({ deviceId: instance.deviceId, action });
    } catch (caught) {
      const refusal = cloudRefusalKey(caught);
      if (live.current && refusal) {
        // A refusal certainly changed nothing: say why on the card, nothing to read back.
        markPower(instance.deviceId, undefined);
        setRefusedPower((notes) =>
          new Map(notes).set(instance.deviceId, {
            deviceId: instance.deviceId,
            action,
            kind: 'refused',
            refusal,
          }),
        );
      } else if (live.current) {
        unknown = true;
        const pending = { deviceId: instance.deviceId, action, uncertain: true } as const;
        markPower(instance.deviceId, pending);
        void powerCheck.start(pending);
      }
    } finally {
      inFlight.current = false;
      if (live.current) {
        setBusy(false);
        if (!unknown) await load();
      }
    }
  };
  /** What this instance's last unknown sleep or wake turned out to be, or why CIS refused it. */
  const powerNote = (deviceId: string): PowerNote | undefined => {
    const check = powerCheck.entries.get(deviceId);
    if (check?.state === 'unreadable') {
      const { deviceId: target, action } = check.context;
      return { deviceId: target, action, kind: 'unreadable' };
    }
    const refused = refusedPower.get(deviceId);
    if (refused) return refused;
    const action = notTaken.get(deviceId);
    return action && { deviceId, action, kind: 'notTaken' };
  };
  /** Asks first, then claims one more instance; a new one waiting for its sign-in starts it. */
  const claimAnother = async () => {
    if (inFlight.current || claimCheck.state || error) return;
    const ok = await confirm({
      title: t('cloudSettings.onboarding.claimAnotherTitle'),
      description: t('cloudSettings.onboarding.claimAnotherBody'),
      confirmText: t('cloudSettings.onboarding.claimAnother'),
      autoFocusConfirm: true,
    });
    if (!ok || !live.current || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    setNotClaimed(false);
    const known = instances?.map((view) => view.deviceId) ?? [];
    let unknown = false;
    try {
      const next = await api.instanceClaim({ another: true });
      if (!live.current) return;
      setInstances(next);
      const created = next.find((view) => !known.includes(view.deviceId));
      if (created?.loginRequired) await initialize(created.deviceId);
    } catch (caught) {
      if (!live.current) return;
      const refusal = cloudRefusalKey(caught);
      if (refusal) setError(refusal);
      else {
        unknown = true;
        void claimCheck.start(known);
      }
    } finally {
      inFlight.current = false;
      if (live.current) {
        setBusy(false);
        capacityCount.current = -1;
        if (!unknown) await load();
      }
    }
  };
  return {
    instances,
    busy,
    error,
    failures,
    /** Reads the list more often for a while, after an update was requested. */
    hurry: () => setHurrying((count) => count + 1),
    waiting,
    /** This instance's own sleep or wake under way, its read-back included. */
    powerPending: (deviceId: string) => powerPending.get(deviceId),
    powerNote,
    /** After this instance's power read-backs ran out: read the list once more. */
    reloadPower: powerCheck.reload,
    claim: (claimCheck.state ?? (notClaimed ? 'notClaimed' : undefined)) as ClaimState | undefined,
    /** After the claim read-backs ran out: read the list once more, never claim again. */
    reloadClaim: claimCheck.reload,
    load,
    act,
    power,
    /** How many the owner has and may have; null when CIS did not say. */
    capacity,
    claimAnother,
  };
}
