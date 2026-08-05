/**
 * Main-owned RSB popup surface IPC contract.
 *
 * Popup pages are real child browsing contexts created by Chromium. Main adopts
 * the exact pre-created WebContents into a WebContentsView; renderer only owns
 * the sidebar tab chrome and reports the slot bounds.
 */

export const RSB_NATIVE_POPUP_CLAIM_CHANNEL = 'rsb-native-popup:claim';
export const RSB_NATIVE_POPUP_SET_BOUNDS_CHANNEL = 'rsb-native-popup:set-bounds';
export const RSB_NATIVE_POPUP_COMMAND_CHANNEL = 'rsb-native-popup:command';
export const RSB_NATIVE_POPUP_CLOSE_CHANNEL = 'rsb-native-popup:close';
export const RSB_NATIVE_POPUP_EVENT_CHANNEL = 'rsb-native-popup:event';

export interface RsbNativePopupBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RsbNativePopupSnapshot {
  url: string;
  title: string;
  favicon: string | null;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  isAudible: boolean;
  crash: { reason: string } | null;
}

export type RsbNativePopupEvent =
  | { surfaceId: string; type: 'state'; snapshot: RsbNativePopupSnapshot }
  | { surfaceId: string; type: 'closed' };

export type RsbNativePopupCommand =
  { command: 'navigate'; url: string } | { command: 'reload' | 'go-back' | 'go-forward' | 'stop' };

export interface RsbNativePopupClaimInput {
  surfaceId: string;
  sessionId: string;
  tabId: string;
}

export type RsbNativePopupClaimResult =
  { alive: true; snapshot: RsbNativePopupSnapshot } | { alive: false };
