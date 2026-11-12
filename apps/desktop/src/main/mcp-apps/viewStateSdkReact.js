import { createViewState } from '@cindy/ext-apps';

/// <reference path="../../../resources/system-skills/cindy-plugin-creator/references/examples/interactive-pages/cindy-ext-apps.d.ts" />
/** @type {typeof import('@cindy/ext-apps/react').createViewStateHooks} */
export function createViewStateHooks({ useState, useRef, useEffect, useCallback }) {
  function useViewState(app, initial, options) {
    const defaults = useRef(initial);
    const slot = useRef();
    if (!slot.current || slot.current.app !== app) {
      const previous = slot.current;
      const controller = app ? createViewState(app, defaults.current, options) : null;
      slot.current = { app, controller, mounts: 0, edited: previous?.edited ?? false,
        value: previous?.edited ? previous.value : controller?.get() ?? defaults.current };
    }
    const current = slot.current;
    const [, update] = useState(0);
    const set = useCallback(next => {
      const current = slot.current;
      // Publish before React schedules a render: a same-event flush must see this
      // edit. Evaluate functional updates once, outside React's replayable updater.
      current.value = typeof next === 'function' ? next(current.value) : next;
      current.edited = true;
      current.controller?.set(current.value);
      update(revision => revision + 1);
    }, []);
    useEffect(() => {
      // Only the connection transition needs an effect, for edits made with app=null.
      if (current.edited) current.controller?.set(current.value);
    }, [current]);
    useEffect(() => {
      current.mounts++;
      return () => {
        current.mounts--;
        // StrictMode replays setup immediately; do not flush its live controller.
        queueMicrotask(() => {
          if (current.mounts) return;
          if (current.edited && app?.transport) void current.controller?.flush().catch(() => {});
          // The App, not this component, owns the shared controller. Page teardown
          // disposes it; a late save must not dispose a newly mounted editor.
        });
      };
    }, [current]);
    return [current.value, set];
  }
  return { useViewState };
}
