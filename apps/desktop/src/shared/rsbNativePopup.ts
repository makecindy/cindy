/**
 * Main-owned RSB popup surface IPC contract.
 *
 * Popup pages are real child browsing contexts created by Chromium. Main adopts
 * the exact pre-created WebContents into a WebContentsView; renderer only owns
 * the sidebar tab chrome and reports the slot bounds.
 */
import { IPC_CHANNELS } from '@cindy/cindy-ipc';

export const RSB_NATIVE_POPUP_CLAIM_CHANNEL = IPC_CHANNELS.RSB_NATIVE_POPUP.CLAIM;
export const RSB_NATIVE_POPUP_SET_BOUNDS_CHANNEL = IPC_CHANNELS.RSB_NATIVE_POPUP.SET_BOUNDS;
export const RSB_NATIVE_POPUP_COMMAND_CHANNEL = IPC_CHANNELS.RSB_NATIVE_POPUP.COMMAND;
export const RSB_NATIVE_POPUP_CLOSE_CHANNEL = IPC_CHANNELS.RSB_NATIVE_POPUP.CLOSE;
export const RSB_NATIVE_POPUP_EVENT_CHANNEL = IPC_CHANNELS.RSB_NATIVE_POPUP.EVENT;

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
