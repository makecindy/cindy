import { EventEmitter } from 'node:events';
import type { Session, WebContents } from 'electron';
import { expect, it, vi } from 'vitest';

import {
  attachGhostLocalServiceGuest,
  guardGhostLocalServiceSession,
  reconcileGhostLocalServiceGuests,
} from '../ghostLocalServiceGuests.js';

// Unit: exercise the installed Electron callbacks. Even two loopback
// services on different ports must never receive each other's requests.
it('restricts local plugin guest traffic and revokes a removed installation', async () => {
  const onBeforeRequest = vi.fn();
  const session = Object.assign(new EventEmitter(), {
    webRequest: { onBeforeRequest, onHeadersReceived: vi.fn() },
    setProxy: vi.fn(async () => {}),
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
  });
  const guest = Object.assign(new EventEmitter(), {
    id: 12,
    session,
    close: vi.fn(),
    isDestroyed: () => false,
    setWebRTCIPHandlingPolicy: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  });
  const origin = 'http://127.0.0.1:41237';
  guardGhostLocalServiceSession(session as unknown as Session, origin);
  attachGhostLocalServiceGuest(guest as unknown as WebContents, 'fixture', origin, () => false);
  const check = (url: string, resourceType = 'mainFrame', webContentsId = guest.id) => {
    return new Promise(resolve => onBeforeRequest.mock.calls[0][0]({ url, resourceType, webContentsId }, resolve));
  };
  try {
    expect(await check(origin + '/status')).toEqual({ cancel: false });
    expect(await check('ws://127.0.0.1:41237/events', 'webSocket')).toEqual({ cancel: false });
    expect(await check(origin + '/status', 'mainFrame', 13)).toEqual({ cancel: true });
    for (const url of ['http://127.0.0.1:41238/status', 'http://localhost:41237/status',
      'https://127.0.0.1:41237/status', 'blob:' + origin + '/fixture']) {
      expect(await check(url)).toEqual({ cancel: true });
      const preventDefault = vi.fn();
      guest.emit('will-redirect', { url, preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
    }
    expect(session.setProxy).toHaveBeenCalledExactlyOnceWith({
      mode: 'fixed_servers', proxyRules: origin,
      proxyBypassRules: '<-loopback>;http://127.0.0.1:41237;ws://127.0.0.1:41237',
    });
    expect(guest.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: 'deny' });
    expect(session.setPermissionCheckHandler.mock.calls[0][0]()).toBe(false);
    reconcileGhostLocalServiceGuests([]);
    expect(guest.close).toHaveBeenCalledOnce();
    expect(await check(origin + '/status')).toEqual({ cancel: true });
  } finally {
    guest.emit('destroyed');
  }
});
