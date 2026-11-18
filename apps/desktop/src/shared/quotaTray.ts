import type { MenubarView } from './menubarQuota.js';
import type { MenubarSettingsPatch } from './menubarQuota.js';

export const TRAY_EVENT = 'quota-tray:event';
export const TRAY_VIEW = 'quota-tray:view';
export interface QuotaTrayBridge {
  ready(): void;
  painted(): void;
  refresh(): void;
  openApp(): void;
  openSession(id: string): void;
  detailAction(id: string): void;
  updateSettings(patch: MenubarSettingsPatch): void;
  openProviderSettings(): void;
  openRemoteControlSettings(): void;
  resize(height: number): void;
  onWindowHiddenChange(listener: (hidden: boolean) => void): () => void;
  subscribe(listener: (view: MenubarView | null) => void): () => void;
}
