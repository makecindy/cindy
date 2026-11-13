import { createViewState } from '@cindy/ext-apps';

// app=null has no host or App identity yet; its edits stay local to this hook.
function disconnected(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    get: () => value,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    set(next) {
      value = typeof next === 'function' ? next(value) : next;
      for (const listener of listeners) listener();
    },
  };
}

/// <reference path="../../../resources/system-skills/cindy-plugin-creator/references/examples/interactive-pages/cindy-ext-apps.d.ts" />
/** @type {typeof import('@cindy/ext-apps/react').createViewStateHooks} */
export function createViewStateHooks({ useState, useRef, useEffect, useCallback, useSyncExternalStore }) {
  // React 16.8/17 have no concurrent rendering. Subscribe and recheck after commit
  // to catch edits between render and subscription; React 18+ owns that guarantee.
  const useStore = useSyncExternalStore ?? ((subscribe, get) => {
    const [, update] = useState(0);
    const value = get();
    useEffect(() => {
      let seen = value;
      const changed = () => {
        const next = get();
        if (!Object.is(seen, next)) { seen = next; update(revision => revision + 1); }
      };
      const stop = subscribe(changed);
      changed();
      return stop;
    }, [subscribe, get]);
    return value;
  });
  function useViewState(app, initial, options) {
    const defaults = useRef(initial);
    const makeSlot = previous => {
      // Only edits made without an App can cross the connection boundary.
      // Connected drafts and their dirty flag remain owned by the previous App.
      const seed = previous?.app === null && previous.edited ? previous.controller.get() : undefined;
      const controller = app ? createViewState(app, defaults.current, options) : disconnected(seed ?? defaults.current);
      return { app, controller, seed: app ? seed : undefined, mounts: 0, edited: seed !== undefined };
    };
    const [slot, setSlot] = useState(() => makeSlot(undefined));
    let current = slot;
    if (slot.app !== app) {
      // React owns this render's candidate: a suspended/discarded render cannot
      // replace the slot still used by the committed editor's event handlers.
      current = makeSlot(slot);
      setSlot(current);
    }
    const value = useStore(current.controller.subscribe, current.controller.get, current.controller.get);
    const set = useCallback(next => {
      if (current.seed !== undefined) {
        const seed = current.seed; current.seed = undefined;
        current.controller.set(seed);
      }
      const before = current.controller.get();
      // The controller computes functional updates from the one shared snapshot,
      // then notifies all JS/React subscribers before a same-event flush can run.
      current.controller.set(next);
      current.edited ||= !Object.is(before, current.controller.get());
    }, [current]);
    const visible = current.seed ?? value;
    useEffect(() => {
      // Preserve pre-connect edits without a default-state paint or a render-time write.
      if (current.seed !== undefined) {
        const seed = current.seed; current.seed = undefined;
        current.controller.set(seed);
      }
    }, [current]);
    useEffect(() => {
      current.mounts++;
      return () => {
        current.mounts--;
        queueMicrotask(() => {
          if (current.mounts) return; // StrictMode's immediate effect replay.
          if (current.edited && app?.transport) void current.controller.flush().catch(() => {});
          // Subscription cleanup belongs to this hook; page teardown owns the
          // shared controller and must not cancel another component's save.
        });
      };
    }, [current]);
    return [visible, set];
  }
  return { useViewState };
}
