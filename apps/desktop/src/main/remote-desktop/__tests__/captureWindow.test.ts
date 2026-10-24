import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DesktopCaptureWindow } from '../captureWindow';
import { denyAppDesktopCapture } from '../capturePermissions';
import { buildContentSecurityPolicy } from '../../security/csp';

const fake = vi.hoisted(() => ({
  windows: [] as any[],
  sessions: [] as any[],
  loadFailure: false,
}));
vi.mock('electron', () => ({
  session: {
    fromPartition: vi.fn(() => {
      const ses = Object.assign(new EventEmitter(), {
        webRequest: { onHeadersReceived: vi.fn() },
        protocol: { handle: vi.fn() },
        setDisplayMediaRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
        setPermissionRequestHandler: vi.fn(),
      });
      fake.sessions.push(ses);
      return ses;
    }),
  },
  BrowserWindow: class {
    static fromWebContents(owner: any) { return owner; }
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: '', parent: null },
      isDestroyed: () => this.destroyed,
      setWindowOpenHandler: vi.fn(),
    });
    constructor(public options: any) {
      fake.windows.push(this);
    }
    loadURL = vi.fn(async (url: string) => {
      this.webContents.mainFrame.url = url;
      if (fake.loadFailure) throw new Error('load failed');
    });
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
      this.webContents.emit('destroyed');
    }
  },
}));
vi.mock('../../security/trustedAppRenderer', () => ({
  isTrustedAppRendererWindow: (owner: any) => owner?.kind === 'app' && owner.mainFrame.url === 'file:///app/index.html',
  isTrustedCindyRendererWindow: (owner: any) => owner?.mainFrame.url === 'file:///app/index.html',
}));
vi.mock('../../utils/ipcValidate', () => ({
  throwIpcError: () => {
    throw new Error('PERMISSION_DENIED');
  },
}));
const event = (window: any) =>
  ({ sender: window.webContents, senderFrame: window.webContents.mainFrame }) as any;
beforeEach(() => {
  fake.windows.length = fake.sessions.length = 0;
  fake.loadFailure = false;
  vi.stubGlobal('DESKTOP_CAPTURE_VITE_DEV_SERVER_URL', 'http://localhost:9988/');
  vi.stubGlobal('DESKTOP_CAPTURE_VITE_NAME', 'desktop_capture');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('only admits the registered top frame and kills the whole process on stop', async () => {
  const failed = vi.fn(),
    owner = new DesktopCaptureWindow(failed);
  const ready = owner.start();
  const win = fake.windows[0];
  const valid = event(win);
  expect(() => owner.registered({ ...valid, sender: {} })).toThrow('PERMISSION_DENIED');
  expect(() =>
    owner.registered({
      ...valid,
      senderFrame: { ...valid.senderFrame, parent: valid.senderFrame },
    }),
  ).toThrow('PERMISSION_DENIED');
  win.webContents.mainFrame.url = 'https://attacker.invalid/';
  expect(() => owner.registered(valid)).toThrow('PERMISSION_DENIED');
  win.webContents.mainFrame.url = 'http://localhost:9988/index.html';
  owner.registered(valid);
  await ready;
  expect(win.options).toMatchObject({
    show: false,
    focusable: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      backgroundThrottling: false,
    },
  });
  expect(win.webContents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: 'deny' });
  owner.dispose();
  expect(win.destroyed).toBe(true);
  expect(owner.contents).toBeNull();
  expect(() => owner.assertSender(valid)).toThrow('PERMISSION_DENIED');
  expect(failed).not.toHaveBeenCalled();
});

it('cancels pending readiness and rejects late old events without touching the replacement', async () => {
  const failed = vi.fn(),
    owner = new DesktopCaptureWindow(failed);
  const first = owner.start();
  const rejection = expect(first).rejects.toThrow('DESKTOP_VIDEO_STOPPED');
  const old = fake.windows[0];
  const second = owner.start();
  await rejection;
  const next = fake.windows[1];
  expect(() => owner.registered(event(old))).toThrow('PERMISSION_DENIED');
  old.webContents.emit('render-process-gone');
  old.webContents.emit('destroyed');
  expect(next.destroyed).toBe(false);
  expect(failed).not.toHaveBeenCalled();
  owner.registered(event(next));
  await second;
  expect(fake.sessions).toHaveLength(1); // bounded in-memory session, never persistent profiles
  owner.dispose();
});

it.each(['render-process-gone', 'will-navigate', 'will-redirect', 'destroyed'])(
  'closes the lease on unexpected %s, once',
  async (name) => {
    const failed = vi.fn(),
      owner = new DesktopCaptureWindow(failed);
    const ready = owner.start();
    const win = fake.windows[0];
    owner.registered(event(win));
    await ready;
    const preventDefault = vi.fn();
    win.webContents.emit(name, { preventDefault });
    expect(win.destroyed).toBe(true);
    expect(failed).toHaveBeenCalledTimes(1);
    if (name.startsWith('will-')) expect(preventDefault).toHaveBeenCalled();
  },
);

it.each(['timeout', 'load'])('bounds %s failure without recreating a process', async (kind) => {
  vi.useFakeTimers();
  fake.loadFailure = kind === 'load';
  const failed = vi.fn(),
    owner = new DesktopCaptureWindow(failed);
  const ready = owner.start();
  const rejected = expect(ready).rejects.toThrow('DESKTOP_VIDEO_STOPPED');
  await vi.advanceTimersByTimeAsync(10_000);
  await rejected;
  expect(fake.windows).toHaveLength(1);
  expect(fake.windows[0].destroyed).toBe(true);
  expect(failed).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('denies app display/legacy capture while preserving physical microphone and camera', () => {
  const ses = {
    setDisplayMediaRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
  };
  const owner = { kind: 'app', mainFrame: { url: 'file:///app/index.html' }, isDestroyed: () => false };
  const voice = { ...owner, kind: 'voice' };
  const details = { isMainFrame: true, requestingUrl: owner.mainFrame.url };
  denyAppDesktopCapture(ses as any, (candidate) => candidate === voice as any);
  const check = ses.setPermissionCheckHandler.mock.calls[0][0];
  const request = ses.setPermissionRequestHandler.mock.calls[0][0];
  for (const mediaType of ['unknown', undefined])
    expect(check(owner, 'media', '', { ...details, mediaType })).toBe(false);
  for (const mediaType of ['audio', 'video'])
    expect(check(owner, 'media', '', { ...details, mediaType })).toBe(true);
  for (const types of [[], undefined, ['unknown']]) {
    const reply = vi.fn();
    request(owner, 'media', reply, { ...details, mediaTypes: types });
    expect(reply).toHaveBeenCalledWith(false);
  }
  const reply = vi.fn();
  request(owner, 'media', reply, { ...details, mediaTypes: ['audio'] });
  expect(reply).toHaveBeenLastCalledWith(true);
  request(voice, 'media', reply, { ...details, mediaTypes: ['audio'] });
  expect(reply).toHaveBeenLastCalledWith(true);
  for (const permission of ['notifications', 'geolocation', 'midi', 'hid', 'display-capture', 'unknown']) {
    expect(check(owner, permission, '', details)).toBe(false);
    request(owner, permission, reply, details);
    expect(reply).toHaveBeenLastCalledWith(false);
  }
  for (const [candidate, requestDetails] of [
    [null, details],
    [{ ...owner, kind: 'foreign' }, details],
    [owner, { ...details, isMainFrame: false }],
    [owner, { ...details, requestingUrl: 'https://evil.example/' }],
    [{ ...voice, mainFrame: { url: 'https://evil.example/' } }, details],
  ]) {
    expect(check(candidate, 'media', '', { ...requestDetails, mediaType: 'audio' })).toBe(false);
    request(candidate, 'media', reply, { ...requestDetails, mediaTypes: ['audio'] });
    expect(reply).toHaveBeenLastCalledWith(false);
  }
  expect(check(owner, 'clipboard-sanitized-write', '', details)).toBe(true);
  request(owner, 'clipboard-sanitized-write', reply, details);
  expect(reply).toHaveBeenLastCalledWith(true);
  request(null, 'display-capture', reply, {});
  expect(reply).toHaveBeenLastCalledWith(false);
  ses.setDisplayMediaRequestHandler.mock.calls[0][0]({}, reply);
  expect(reply).toHaveBeenLastCalledWith({});
});

it('capture CSP forbids arbitrary network, application frames and inline/eval scripts', () => {
  const csp = buildContentSecurityPolicy({
    isDev: false,
    devServerOrigin: null,
    desktopCapture: true,
  });
  expect(csp).toContain("connect-src 'none'");
  expect(csp).toContain("frame-src 'none'");
  expect(csp).not.toMatch(/https:|wss:|unsafe-inline|unsafe-eval/);
});

it.each(['files', 'direct'] as const)('keeps %s transport separate and denies capture permissions', async (mode) => {
  const owner = new DesktopCaptureWindow(vi.fn(), mode);
  const ready = owner.start();
  const win = fake.windows[0], ses = fake.sessions[0];
  expect(win.webContents.mainFrame.url).toBe(`http://localhost:9988/index.html?mode=${mode}`);
  owner.registered(event(win));
  await ready;
  const check = ses.setPermissionCheckHandler.mock.calls[0][0];
  expect(check(win.webContents, 'media', '', {})).toBe(false);
  expect(check(win.webContents, 'display-capture', '', {})).toBe(false);
  const result = vi.fn();
  ses.setPermissionRequestHandler.mock.calls[0][0](win.webContents, 'media', result, {});
  expect(result).toHaveBeenCalledWith(false);
  owner.dispose();
});

// Regression: denying Chromium's media permission check suppresses physical
// interface discovery for data-only WebRTC under a VPN. Actual media requests
// must remain denied. Entry: DesktopCaptureWindow.start and session handlers.
// Existing coverage only tested denial, not the check/request distinction.
// Minimal input: trusted data-window audio/video check. Tier: unit.
it.each(['files', 'direct'] as const)('allows interface discovery only for the trusted %s frame, without capture', async (mode) => {
  const owner = new DesktopCaptureWindow(vi.fn(), mode);
  const ready = owner.start();
  const win = fake.windows[0], ses = fake.sessions[0];
  owner.registered(event(win));
  await ready;
  const check = ses.setPermissionCheckHandler.mock.calls[0][0];
  const request = ses.setPermissionRequestHandler.mock.calls[0][0];
  const origin = 'http://localhost:9988';
  const details = { isMainFrame: true, requestingUrl: win.webContents.mainFrame.url };
  for (const mediaType of ['audio', 'video']) {
    expect(check(win.webContents, 'media', origin, { ...details, mediaType })).toBe(true);
    expect(check(win.webContents, 'media', `${origin}/`, { ...details, mediaType })).toBe(true);
  }
  for (const [candidate, permission, requestingOrigin, extra] of [
    [null, 'media', origin, { mediaType: 'audio' }],
    [{ ...win.webContents }, 'media', origin, { mediaType: 'audio' }],
    [win.webContents, 'media', 'https://foreign.invalid', { mediaType: 'audio' }],
    [win.webContents, 'media', origin, { mediaType: 'unknown' }],
    [win.webContents, 'media', origin, { mediaType: 'audio', isMainFrame: false }],
    [win.webContents, 'media', origin, { mediaType: 'audio', requestingUrl: `${origin}/other.html` }],
    [win.webContents, 'display-capture', origin, { mediaType: 'video' }],
  ] as const) {
    expect(check(candidate, permission, requestingOrigin, { ...details, ...extra })).toBe(false);
  }
  for (const mediaTypes of [[], ['audio'], ['video'], ['audio', 'video']]) {
    const reply = vi.fn();
    request(win.webContents, 'media', reply, { ...details, mediaTypes });
    expect(reply).toHaveBeenCalledWith(false);
  }
  win.webContents.mainFrame.url = 'https://foreign.invalid/';
  expect(check(win.webContents, 'media', origin, { ...details, mediaType: 'audio' })).toBe(false);
  owner.dispose();
});
