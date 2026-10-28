import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DesktopCaptureWindow } from '../captureWindow';
import { denyAppDesktopCapture, markPlaybackFullscreenWindow } from '../capturePermissions';
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
  // Regression: the capture filter also denied the native video Fullscreen API.
  // Tier 1: real permission handlers must allow host playback but keep automatic
  // entry, foreign frames, voice windows and desktop capture denied.
  expect(check(owner, 'fullscreen', '', details)).toBe(true);
  request(owner, 'fullscreen', reply, details);
  expect(reply).toHaveBeenLastCalledWith(true);
  expect(check(voice, 'fullscreen', '', details)).toBe(false);
  request(voice, 'fullscreen', reply, details);
  expect(reply).toHaveBeenLastCalledWith(false);
  for (const permission of ['automatic-fullscreen', 'notifications', 'geolocation', 'midi', 'hid', 'display-capture', 'unknown']) {
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
    expect(check(candidate, 'fullscreen', '', requestDetails)).toBe(false);
    request(candidate, 'fullscreen', reply, requestDetails);
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

// User regression: the recording preview's native fullscreen button did nothing.
// Existing permission cases only cover app/voice owners, not playback-only windows.
// Minimal input: registered preview top frame requests fullscreen; both production
// handlers must allow it without granting capture or trusting a foreign frame. Tier: unit.
it('grants registered playback windows only user-initiated fullscreen', () => {
  const ses = {
    setDisplayMediaRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
  };
  const preview = { kind: 'preview', mainFrame: { url: 'file:///app/index.html' }, isDestroyed: () => false };
  const details = { isMainFrame: true, requestingUrl: preview.mainFrame.url };
  denyAppDesktopCapture(ses as any);
  const check = ses.setPermissionCheckHandler.mock.calls[0][0];
  const request = ses.setPermissionRequestHandler.mock.calls[0][0];
  const assertPermission = (owner: unknown, permission: string, requestDetails: unknown, allowed: boolean) => {
    expect(check(owner, permission, '', requestDetails)).toBe(allowed);
    const reply = vi.fn();
    request(owner, permission, reply, requestDetails);
    expect(reply).toHaveBeenCalledWith(allowed);
  };
  assertPermission(preview, 'fullscreen', details, false);
  markPlaybackFullscreenWindow(preview as any);
  assertPermission(preview, 'fullscreen', details, true);
  for (const permission of ['media', 'display-capture', 'clipboard-sanitized-write', 'automatic-fullscreen']) {
    assertPermission(preview, permission, { ...details, mediaType: 'audio', mediaTypes: ['audio'] }, false);
  }
  assertPermission({ ...preview }, 'fullscreen', details, false);
  assertPermission(preview, 'fullscreen', { ...details, isMainFrame: false }, false);
  assertPermission(preview, 'fullscreen', { ...details, requestingUrl: 'https://foreign.example/' }, false);
  preview.mainFrame.url = 'https://foreign.example/';
  assertPermission(preview, 'fullscreen', { ...details, requestingUrl: preview.mainFrame.url }, false);
  preview.mainFrame.url = details.requestingUrl;
  preview.isDestroyed = () => true;
  assertPermission(preview, 'fullscreen', details, false);
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
