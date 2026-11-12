export const ACCESSIBILITY_SUPPORT_GET = 'accessibility-support:get-sync';
export const ACCESSIBILITY_SUPPORT_CHANGED = 'accessibility-support:changed';

/** Local viewer state, independent of the machine executing a remote task. */
export interface AccessibilitySupportBridge {
  getSync(): boolean;
  onChanged(callback: (enabled: boolean) => void): () => void;
}
