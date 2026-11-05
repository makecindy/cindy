// R5/W1 boundary: execute the new IPC adapter and complete-app filter with the existing
// trusted-renderer predicate, real isolated read-state files, and actual window object identity.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const electron = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: electron.from } }));
import { markAppContentWindow } from '../../windowFocusClassifier';
import { isTrustedAppRendererEventForLocation, isTrustedAppRendererWindowForLocation } from '../../security/trustedAppRenderer';
import { throwIpcError } from '../../utils/ipcValidate';
import { createBotReadStateIpc, createBotWindowAccess } from '../botReadStateLocalIpc';

const location = { devServerUrl: 'http://localhost:5173', packagedRendererFile: '/unused/index.html' };
let root: string;
let main: BrowserWindow;
let secondary: BrowserWindow;
let utility: BrowserWindow;
let owner: { dataOwnerId: string; generation: number };
let roots: ReturnType<typeof vi.fn>;
let currentOwner: ReturnType<typeof vi.fn>;
let access: ReturnType<typeof createBotWindowAccess>;
let handler: ReturnType<typeof createBotReadStateIpc>;
function makeWindow(url = 'http://localhost:5173/') {
  const frame = { url, parent: null };
  return { isDestroyed: () => false, webContents: { isDestroyed: () => false, mainFrame: frame } } as unknown as BrowserWindow;
}
const event = (window: BrowserWindow) => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame }) as IpcMainInvokeEvent;
const request = (action: 'snapshot' | 'merge', time = 100) => action === 'snapshot' ? { action, owner: { ...owner } }
  : { action, owner: { ...owner }, positions: [{ identity: { kind: 'group', id: 'room' }, ackAt: time }] };

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'cindy-bot-read-ipc-'));
  owner = { dataOwnerId: 'account-a', generation: 1 };
  main = makeWindow(); secondary = makeWindow(); utility = makeWindow();
  // Detached utility panels really are app-content too; that alone must not grant this protocol.
  for (const window of [main, secondary, utility]) markAppContentWindow(window);
  const windows = new Map<WebContents, BrowserWindow>([main, secondary, utility].map(window => [window.webContents, window]));
  electron.from.mockImplementation((sender: WebContents) => windows.get(sender) ?? null);
  access = createBotWindowAccess({ mainWindow: () => main, isSecondary: window => window === secondary,
    isTrustedWindow: window => isTrustedAppRendererWindowForLocation(window, location),
    windowFromSender: sender => electron.from(sender),
    assertTrustedSender: incoming => {
      if (!isTrustedAppRendererEventForLocation(incoming, location)) throwIpcError('PERMISSION_DENIED', '测试来源不受信');
    } });
  roots = vi.fn(() => path.join(root, owner.dataOwnerId));
  currentOwner = vi.fn(() => owner);
  handler = createBotReadStateIpc({ assertTrustedSender: access.assertSender, currentOwner,
    boundaryPending: () => false, ownerRoot: roots });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

it('shares committed positions through real main/secondary IPC entries', async () => {
  await handler(event(main), request('merge'));
  expect((await handler(event(secondary), request('snapshot'))).positions).toEqual([
    { identity: { kind: 'group', id: 'room' }, ackAt: 100 },
  ]);
});

it('rejects a trusted app-content utility before consulting the owner or disk', () => {
  expect(() => handler(event(utility), request('snapshot'))).toThrow('完整应用窗口');
  expect(currentOwner).not.toHaveBeenCalled();
  expect(roots).not.toHaveBeenCalled();
});

it('rejects child frames and external navigation without modifying the saved position', async () => {
  await handler(event(main), request('merge', 100));
  const child = { ...event(secondary), senderFrame: { url: location.devServerUrl, parent: secondary.webContents.mainFrame } } as unknown as IpcMainInvokeEvent;
  expect(() => handler(child, request('merge', 999))).toThrow('来源不受信');
  Object.assign(secondary.webContents.mainFrame, { url: 'https://untrusted.example/' });
  expect(() => handler(event(secondary), request('snapshot'))).toThrow('来源不受信');
  expect((await handler(event(main), request('snapshot'))).positions[0]?.ackAt).toBe(100);
});

it('uses the same complete-window and current-URL filter for local invalidation recipients', () => {
  expect([main, secondary, utility].filter(access.accepts)).toEqual([main, secondary]);
  Object.assign(secondary.webContents.mainFrame, { url: 'https://untrusted.example/' });
  expect([main, secondary, utility].filter(access.accepts)).toEqual([main]);
  expect(access.accepts(null)).toBe(false);
});
