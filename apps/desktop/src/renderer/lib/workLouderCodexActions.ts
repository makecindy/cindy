import {
  attachInputDeviceActionBridge,
  dispatchInputDeviceAction,
  subscribeInputDeviceAction,
  type InputDeviceActionHandler,
} from './inputDeviceActions';

export type WorkLouderCodexActionHandler = InputDeviceActionHandler;

let bridged = false;

/**
 * Codex Micro still owns the preload channel. The subscriber set is shared
 * so a later keyboard can attach another bridge without a second bus.
 */
export function subscribeWorkLouderCodexAction(handler: InputDeviceActionHandler): () => void {
  ensureCodexMicroBridge();
  return subscribeInputDeviceAction(handler);
}

function ensureCodexMicroBridge(): void {
  if (bridged) return;
  bridged = true;
  attachInputDeviceActionBridge(
    () =>
      window.electronAPI?.workLouderCodex?.onAction((action) => {
        if (action.type === 'keycap') return;
        dispatchInputDeviceAction(action);
      }) ?? null,
  );
}
