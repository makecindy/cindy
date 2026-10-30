import { ipcMain, type BrowserWindow, type WebContents } from 'electron';
import type { LocalAgentConfirmation } from '../../shared/localAgent.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { assertTrustedAppRendererEvent, isTrustedAppRendererWindow } from '../security/trustedAppRenderer.js';
import { WindowConfirmationBridge } from '../windowConfirmationBridge.js';

type Copy = Omit<LocalAgentConfirmation, 'requestId'>;
const bridge = new WindowConfirmationBridge<Copy>();
let getWindow: () => BrowserWindow | null = () => null;
const tracked = new WeakSet<WebContents>();

/** Local only: no device-link allowlist or external HTTP decision endpoint. */
export function registerLocalAgentConfirmationIpc(window: () => BrowserWindow | null): void {
  getWindow = window;
  ipcMain.handle('local-agent:confirmation:answer', (event, requestId: unknown, confirmed: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (typeof requestId !== 'string' || requestId.length > 128 || typeof confirmed !== 'boolean')
      return false;
    if (isAppSessionBoundaryPending()) return false;
    return bridge.resolve(event.sender.id, requestId, confirmed);
  });
}

export function cancelLocalAgentConfirmations(): void { bridge.cancelAll(); }

export async function confirmLocalAgent(copy: Copy, signal?: AbortSignal): Promise<boolean> {
  const parent = getWindow();
  if (!parent || !isTrustedAppRendererWindow(parent) || !parent.isVisible() ||
    signal?.aborted || isAppSessionBoundaryPending()) return false;
  const contents = parent.webContents;
  const owner = activeOwnerScopeKey();
  if (!tracked.has(contents)) {
    tracked.add(contents);
    const cancel = () => bridge.cancelRequester(contents.id);
    parent.on('close', cancel);
    contents.once('destroyed', cancel);
    contents.on('render-process-gone', cancel);
    // Even an in-page navigation retires the prompt and its queued response.
    contents.on('did-start-navigation', (_event, _url, _sameDocument, mainFrame) => {
      if (mainFrame) cancel();
    });
  }
  const current = () => !signal?.aborted && !isAppSessionBoundaryPending() &&
    activeOwnerScopeKey() === owner && isTrustedAppRendererWindow(parent);
  try {
    const approved = await bridge.request({
      id: contents.id,
      send: request => {
        if (!current()) return false;
        contents.send('local-agent:confirmation', request);
        return true;
      },
      dismiss: requestId => {
        if (isTrustedAppRendererWindow(parent))
          contents.send('local-agent:confirmation:dismissed', requestId);
      },
    }, copy, { signal });
    return approved && current();
  } catch {
    return false;
  }
}
