type KeyDownListener = (event: KeyboardEvent) => void;

const listeners = new Set<KeyDownListener>();
let disposeInstalledCapture: (() => void) | null = null;

/**
 * 在 React 挂载前注册 window capture 监听,确保后注册的快捷键即使调用
 * stopImmediatePropagation,也不会挡住需要观察所有 keydown 的状态机。
 */
export function installEarlyKeyDownCapture(): () => void {
  if (disposeInstalledCapture) return disposeInstalledCapture;

  const handleKeyDown = (event: KeyboardEvent) => {
    for (const listener of listeners) listener(event);
  };
  window.addEventListener('keydown', handleKeyDown, true);
  disposeInstalledCapture = () => {
    window.removeEventListener('keydown', handleKeyDown, true);
    disposeInstalledCapture = null;
  };
  return disposeInstalledCapture;
}

export function isEarlyKeyDownCaptureInstalled(): boolean {
  return disposeInstalledCapture != null;
}

export function subscribeEarlyKeyDownCapture(listener: KeyDownListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
