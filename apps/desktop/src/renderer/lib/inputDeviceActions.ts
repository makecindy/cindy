import type { InputDeviceRendererAction } from '../../shared/inputDevices';

export type InputDeviceActionHandler = (action: InputDeviceRendererAction) => boolean | void;

const handlers = new Set<InputDeviceActionHandler>();
const bridges = new Set<() => void>();

/**
 * Hardware adapters fan into one renderer bus. Newest subscribers run first
 * so the focused task can consume a command before the shell fallback.
 */
export function subscribeInputDeviceAction(handler: InputDeviceActionHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

export function dispatchInputDeviceAction(action: InputDeviceRendererAction): void {
  for (const listener of [...handlers].reverse()) {
    if (listener(action) === true) break;
  }
}

/** Let an adapter attach its preload channel without owning the subscriber set. */
export function attachInputDeviceActionBridge(connect: () => (() => void) | null | undefined): void {
  if (typeof window === 'undefined') return;
  const unsubscribe = connect();
  if (unsubscribe) bridges.add(unsubscribe);
}

export function __resetInputDeviceActionsForTests(): void {
  handlers.clear();
  for (const unsubscribe of bridges) unsubscribe();
  bridges.clear();
}
