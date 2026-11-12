import { createViewState } from '@cindy/ext-apps';

/// <reference path="../../../resources/system-skills/cindy-plugin-creator/references/examples/interactive-pages/cindy-ext-apps.d.ts" />
/** @type {typeof import('@cindy/ext-apps/react').createViewStateHooks} */
export function createViewStateHooks({ useState, useRef, useEffect, useCallback }) {
  function useViewState(app, initial, options) {
    const defaults = useRef(initial);
    const slot = useRef();
    if (!slot.current || slot.current.app !== app) {
      slot.current = { app, controller: app ? createViewState(app, defaults.current, options) : null, mounts: 0, edited: false };
    }
    const current = slot.current;
    const [local, update] = useState(() => ({ app, value: current.controller?.get() ?? defaults.current, edited: false }));
    let value = local.value;
    if (local.app !== app) {
      value = local.edited ? local.value : current.controller?.get() ?? defaults.current;
      // A same-component render update is applied before React commits any DOM.
      update({ ...local, app, value });
    }
    const set = useCallback(next => update(previous => ({ ...previous, edited: true,
      value: typeof next === 'function' ? next(previous.value) : next })), []);
    useEffect(() => {
      if (local.edited && current.controller) {
        current.edited = true;
        current.controller.set(value);
      }
    }, [current, value, local.edited]);
    useEffect(() => {
      current.mounts++;
      return () => {
        current.mounts--;
        // StrictMode replays setup immediately; do not dispose its live controller.
        queueMicrotask(() => {
          if (current.mounts) return;
          if (current.edited && app?.transport) {
            void current.controller?.flush().catch(() => {}).finally(() => current.controller?.dispose());
          } else current.controller?.dispose();
        });
      };
    }, [current]);
    return [value, set];
  }
  return { useViewState };
}
