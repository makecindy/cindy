import { ipcRenderer } from 'electron';
import {
  ACCESSIBILITY_SUPPORT_CHANGED,
  ACCESSIBILITY_SUPPORT_GET,
  type AccessibilitySupportBridge,
} from '../shared/accessibilitySupport';

export function createAccessibilitySupportBridge(): AccessibilitySupportBridge {
  // An unavailable initial snapshot must not hide text from assistive technology.
  let current = ipcRenderer.sendSync(ACCESSIBILITY_SUPPORT_GET) !== false;
  const subscribers = new Set<(enabled: boolean) => void>();
  ipcRenderer.on(ACCESSIBILITY_SUPPORT_CHANGED, (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') return;
    current = enabled;
    subscribers.forEach(callback => callback(enabled));
  });
  return {
    getSync: () => current,
    onChanged(callback) {
      subscribers.add(callback);
      // Catch changes between initial render and effect subscription.
      callback(current);
      return () => { subscribers.delete(callback); };
    },
  };
}
