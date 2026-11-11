import { BrowserWindow, ipcMain } from 'electron';
import {
  isTrustedCindyRendererWindow,
  isTrustedTopLevelCindyRendererEvent,
} from '../security/trustedAppRenderer.js';
import { isAppContentWindow } from '../windowFocusClassifier.js';
import type { VoiceInputMicrophonePermissionCache } from './permissions.js';

// Auxiliary voice windows need this read-only bootstrap, not app-content powers.
const auxiliaryReaders = new WeakSet<BrowserWindow>();
const subscribers = new Set<BrowserWindow>();

export function markMicrophonePermissionReaderWindow(window: BrowserWindow): void {
  auxiliaryReaders.add(window);
}

function isReader(window: BrowserWindow | null): window is BrowserWindow {
  return Boolean(window && !window.isDestroyed()
    && (isAppContentWindow(window) || auxiliaryReaders.has(window)));
}

export function registerMicrophonePermissionIpc(read: () => VoiceInputMicrophonePermissionCache): void {
  ipcMain.on('voice-input:get-microphone-permission-cached', event => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!isReader(window) || !isTrustedTopLevelCindyRendererEvent(event)) {
      // sendSync needs a reply even on denial. Assign exactly once: Electron's
      // returnValue setter sends the response immediately.
      event.returnValue = { ok: false, status: 'unavailable', error: 'PERMISSION_DENIED' };
      return;
    }
    if (!subscribers.has(window)) {
      subscribers.add(window);
      window.webContents.once('destroyed', () => subscribers.delete(window));
    }
    event.returnValue = read();
  });
}

export function publishMicrophonePermissionSnapshot(snapshot: VoiceInputMicrophonePermissionCache): void {
  for (const window of subscribers) {
    // A previously registered window may have navigated since its bootstrap.
    if (!isReader(window) || !isTrustedCindyRendererWindow(window)) subscribers.delete(window);
    else window.webContents.send('voice-input:microphone-permission-changed', snapshot);
  }
}
