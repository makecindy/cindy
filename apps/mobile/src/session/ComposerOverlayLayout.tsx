import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';

type Geometry = Readonly<{ height: number; inputTop: number }>;

/** Layout samples belong to the surfaces that use them, not SessionScreen's
 * message projection, composer and subscriptions. Animated height emits a sample
 * every frame; lifting those samples into page state re-renders that entire tree.
 */
export function createComposerOverlayLayout() {
  let geometry: Geometry = { height: 0, inputTop: 0 };
  let historyHeight = 0;
  let settle: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach(listener => listener());
  return {
    getSnapshot: () => geometry,
    getHeight: () => historyHeight,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose: () => { clearTimeout(settle); },
    update: (patch: Partial<Geometry>, nativeOwnsClearance = false) => {
      const height = patch.height ?? geometry.height;
      const inputTop = patch.inputTop ?? geometry.inputTop;
      if (height === geometry.height && inputTop === geometry.inputTop) return;
      geometry = { height, inputTop };
      if (patch.height !== undefined) {
        clearTimeout(settle);
        if (nativeOwnsClearance && historyHeight > 0) {
          // Native already keeps the history clear on every frame. React only
          // needs the settled size for the return-to-bottom button/threshold;
          // republishing the resident history each frame stalls Fabric commits.
          settle = setTimeout(() => { historyHeight = geometry.height; publish(); }, 50);
        } else { historyHeight = height; }
      }
      publish();
    },
  };
}

export function useComposerOverlayLayout() {
  const [source] = useState(createComposerOverlayLayout);
  useEffect(() => () => source.dispose(), [source]);
  return source;
}

/** No native wrapper: preserve the existing layout and responder hierarchy. */
export function ComposerOverlayLayout({ source, children }: {
  source: ReturnType<typeof createComposerOverlayLayout>;
  children(geometry: Geometry): ReactNode;
}) {
  const geometry = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  return children(geometry);
}

/** Input-top movement only affects the backdrop, not the history's clearance. */
export function ComposerOverlayHeight({ source, children }: {
  source: ReturnType<typeof createComposerOverlayLayout>;
  children(height: number): ReactNode;
}) {
  return children(useSyncExternalStore(source.subscribe, source.getHeight, source.getHeight));
}
