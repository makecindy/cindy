import { ipcMain, type BrowserWindow, type WebContents } from 'electron';
import { InteractiveAuthenticationError, type KeyboardInteractiveHandler } from '@cindy/maker-remote-ssh';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { assertTrustedAppRendererEvent, isTrustedAppRendererWindow } from '../security/trustedAppRenderer.js';
import { SshAuthenticationBroker } from './authentication-broker.js';

const broker = new SshAuthenticationBroker();
let getWindow: () => BrowserWindow | null = () => null;
const tracked = new WeakSet<WebContents>();

/** Secret submissions stay local. No generic device-link invoke is exposed. */
export function registerSshAuthenticationIpc(window: () => BrowserWindow | null): void {
  getWindow = window;
  ipcMain.handle('maker:remote-ssh:authentication-pending', event => {
    assertTrustedAppRendererEvent(event);
    return broker.list(event.sender.id);
  });
  ipcMain.handle('maker:remote-ssh:authentication-answer', (event, requestId: unknown, answers: unknown) => {
    try {
      assertTrustedAppRendererEvent(event);
      return { accepted: broker.submit(event.sender.id, requestId, answers) };
    } finally {
      if (Array.isArray(answers)) answers.fill('');
    }
  });
}

export function cancelSshAuthenticationPrompts(): void { broker.cancelAll(); }

export const requestSshAuthentication: KeyboardInteractiveHandler = async (challenge, signal) => {
  const parent = getWindow();
  if (!parent || !isTrustedAppRendererWindow(parent) || !parent.isVisible()
    || signal.aborted || isAppSessionBoundaryPending()) throw new InteractiveAuthenticationError('required');
  const contents = parent.webContents;
  const owner = activeOwnerScopeKey();
  if (!tracked.has(contents)) {
    tracked.add(contents);
    const cancel = () => broker.cancelTarget(contents.id);
    parent.on('close', cancel);
    contents.once('destroyed', cancel);
    contents.on('render-process-gone', cancel);
    contents.on('did-start-navigation', (_event, _url, _sameDocument, mainFrame) => {
      if (mainFrame) cancel();
    });
  }
  const current = () => !signal.aborted && !isAppSessionBoundaryPending()
    && activeOwnerScopeKey() === owner && isTrustedAppRendererWindow(parent);
  const answers = await broker.request({
    id: contents.id, current,
    send: request => {
      if (!current()) throw new Error('SSH authentication window is no longer current');
      contents.send('maker:remote-ssh:authentication-request', request);
    },
    dismiss: id => { if (isTrustedAppRendererWindow(parent)) contents.send('maker:remote-ssh:authentication-dismissed', id); },
  }, challenge, signal);
  if (!current()) { answers?.fill(''); return null; }
  return answers;
};
