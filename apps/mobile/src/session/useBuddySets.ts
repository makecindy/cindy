import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import {
  emptyBuddySets,
  normalizeBuddySets,
  type BuddySetsState,
} from '@cindy/maker-shared/buddy-sets';
import { getHomeViewSession, useRetainedHomeState, type HomeViewSession } from './homeViewSession';
import { readBuddySets, saveBuddySets } from './buddySetsStore';

/** Cold-start read state. A failed read must never let a fresh empty state be saved. */
export type BuddySetsStatus = 'loading' | 'ready' | 'error';

interface Load {
  promise: Promise<BuddySetsState>;
  value?: BuddySetsState;
  applied: boolean;
}

/** One read per (view session, account): a second Home/Sidebar mount must not
 *  start a fresh read that could resolve with an older blob and overwrite edits. */
const loads = new WeakMap<HomeViewSession, Map<string, Load>>();

const STATUS_PREFIX = 'buddySetsStatus:';
const SAVE_FAILED_PREFIX = 'buddySetsSaveFailed:';
const GENERATION_PREFIX = 'buddySetsGeneration:';
const keyFor = (prefix: string, owner: string): string => prefix + encodeURIComponent(owner);

function loadFor(session: HomeViewSession, owner: string): Load {
  let byOwner = loads.get(session);
  if (!byOwner) {
    byOwner = new Map();
    loads.set(session, byOwner);
  }
  let load = byOwner.get(owner);
  if (!load) {
    load = { promise: readBuddySets(owner), applied: false };
    byOwner.set(owner, load);
  }
  return load;
}

/** Status and save failures live in the view session, so every mounted Home /
 *  sidebar instance observes the same hydration and retry state synchronously. */
function persist(session: HomeViewSession, owner: string, state: BuddySetsState): void {
  void saveBuddySets(owner, state).then(
    () => { session.write(keyFor(SAVE_FAILED_PREFIX, owner), false); },
    // A write that never landed must not look saved: surface a retry to the user.
    () => { session.write(keyFor(SAVE_FAILED_PREFIX, owner), true); },
  );
}

/**
 * 「伙伴集」展示偏好:首页视图会话持有当前值(与折叠偏好同口径),按账号落本机
 * AsyncStorage。只存 override;冷启动读回,读取成功前不接受修改,失败时给出重试。
 */
export function useBuddySets(owner: string): [
  BuddySetsState,
  (next: BuddySetsState | ((current: BuddySetsState) => BuddySetsState)) => void,
  BuddySetsStatus,
  () => void,
  boolean,
  () => void,
] {
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const session = getHomeViewSession();
  const statusKey = keyFor(STATUS_PREFIX, owner);
  const saveFailedKey = keyFor(SAVE_FAILED_PREFIX, owner);
  const generationKey = keyFor(GENERATION_PREFIX, owner);

  const subscribeStatus = useCallback((listener: () => void) => session.subscribe(statusKey, listener), [session, statusKey]);
  const readStatus = useCallback(() => session.read(statusKey, owner ? 'loading' : 'ready') as BuddySetsStatus, [session, statusKey, owner]);
  const status = useSyncExternalStore(subscribeStatus, readStatus, readStatus);
  const statusRef = useRef(status);
  statusRef.current = status;

  const subscribeSaveFailed = useCallback((listener: () => void) => session.subscribe(saveFailedKey, listener), [session, saveFailedKey]);
  const readSaveFailed = useCallback(() => session.read(saveFailedKey, false) as boolean, [session, saveFailedKey]);
  const saveFailed = useSyncExternalStore(subscribeSaveFailed, readSaveFailed, readSaveFailed);

  const subscribeGeneration = useCallback((listener: () => void) => session.subscribe(generationKey, listener), [session, generationKey]);
  const readGeneration = useCallback(() => session.read(generationKey, 0) as number, [session, generationKey]);
  const generation = useSyncExternalStore(subscribeGeneration, readGeneration, readGeneration);

  const [state, setState] = useRetainedHomeState<BuddySetsState>(
    session,
    'buddySets',
    emptyBuddySets(),
    (next) => {
      const activeOwner = ownerRef.current;
      // Only a successful hydration may unlock writes: otherwise a failed read
      // followed by a user edit would replace the whole valid on-disk record.
      if (activeOwner && statusRef.current === 'ready') {
        persist(getHomeViewSession(), activeOwner, next);
      }
    },
  );

  useEffect(() => {
    const active = getHomeViewSession();
    if (!owner) {
      // No account means no owner-scoped store; nothing to read or persist.
      active.write(statusKey, 'ready');
      return undefined;
    }
    const load = loadFor(active, owner);
    const applyIfReady = (stored: BuddySetsState) => {
      if (load.applied) return;
      load.applied = true;
      active.write('buddySets', stored);
    };
    const settled = active.read(statusKey, 'loading') as BuddySetsStatus;
    // A read may have settled while no hook was mounted. Apply its snapshot
    // before allowing edits, even if this is the first mount to see `ready`.
    if (settled === 'ready' && load.value !== undefined) {
      applyIfReady(load.value);
      return undefined;
    }
    if (settled === 'error') return undefined;
    active.write(statusKey, 'loading');
    void load.promise.then((stored) => {
      load.value = stored;
      // Guard account switches; an abandoned view session must never be revived.
      if (getHomeViewSession() !== active) return;
      // Publish `ready` only after the disk snapshot is in the view session:
      // otherwise an empty state could be edited and overwrite the whole record.
      applyIfReady(stored);
      active.write(statusKey, 'ready');
    }).catch(() => {
      if (getHomeViewSession() !== active) return;
      active.write(statusKey, 'error');
    });
    return undefined;
  }, [owner, generation, statusKey]);

  const update = useCallback((input: BuddySetsState | ((current: BuddySetsState) => BuddySetsState)) => {
    if (statusRef.current !== 'ready') return;
    setState((current) => normalizeBuddySets(typeof input === 'function' ? input(current) : input));
  }, [setState]);

  const retry = useCallback(() => {
    const active = getHomeViewSession();
    const activeOwner = ownerRef.current;
    if (!activeOwner) return;
    // Drop the rejected read; a bumped generation re-runs the effect in every
    // mounted instance, so all of them leave the error state together.
    loads.get(active)?.delete(activeOwner);
    // The fresh read replaces the unsaved in-memory state, so any earlier write
    // warning no longer describes what the user is looking at.
    active.write(keyFor(SAVE_FAILED_PREFIX, activeOwner), false);
    active.write(keyFor(GENERATION_PREFIX, activeOwner), active.read(keyFor(GENERATION_PREFIX, activeOwner), 0) + 1);
    active.write(keyFor(STATUS_PREFIX, activeOwner), 'loading');
  }, []);

  const retrySave = useCallback(() => {
    const active = getHomeViewSession();
    const activeOwner = ownerRef.current;
    if (!activeOwner || statusRef.current !== 'ready') return;
    persist(active, activeOwner, active.read('buddySets', emptyBuddySets()) as BuddySetsState);
  }, []);

  return [owner ? state : emptyBuddySets(), update, status, retry, saveFailed, retrySave];
}
