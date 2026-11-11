import { EventEmitter } from 'node:events';
import { session } from 'electron';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DesktopCaptureWindow } from '../captureWindow';
import { denyAppDesktopCapture, markPlaybackFullscreenWindow } from '../capturePermissions';
import { isCaptureWindowWebContents } from '../captureWindowRegistry';
import { buildContentSecurityPolicy } from '../../security/csp';

const fake = vi.hoisted(() => ({
  windows: [] as any[],
  sessions: [] as any[],
  loadFailure: false,
  info: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('../../logger', () => ({ createLogger: () => ({ info: fake.info, warn: fake.warn }) }));
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
  BrowserWindow: class extends EventEmitter {
    static fromWebContents(owner: any) { return owner; }
    destroyed = false;
    id = 1;
    visible = false;
    calls: string[] = [];
    topArgs: unknown[] = [];
    getNativeWindowHandle = () => Buffer.from([6, 4, 18, 0]);
    isVisible = () => this.visible;
    isFocused = () => false;
    isMinimized = () => false;
    getBounds = () => ({ x: 0, y: 0, width: 135, height: 38 });
    getContentBounds = () => ({ x: 0, y: 0, width: 120, height: 0 });
    show = () => { this.calls.push('show'); this.visible = true; this.emit('show'); };
    showInactive = () => { this.calls.push('showInactive'); this.visible = true; };
    restore = () => { this.calls.push('restore'); };
    focus = () => { this.calls.push('focus'); };
    setAlwaysOnTop = (...args: unknown[]) => { this.calls.push('setAlwaysOnTop'); this.topArgs = args; };
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: '', parent: null },
      isDestroyed: () => this.destroyed,
      setWindowOpenHandler: vi.fn(),
      setWebRTCIPHandlingPolicy: vi.fn(),
    });
    constructor(public options: any) {
      super();
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
  fake.info.mockReset();
  fake.warn.mockReset();
  vi.stubGlobal('DESKTOP_CAPTURE_VITE_DEV_SERVER_URL', 'http://localhost:9988/');
  vi.stubGlobal('DESKTOP_CAPTURE_VITE_NAME', 'desktop_capture');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// #9437 / unit: real host startup and visibility methods. Existing capture tests
// covered transport/security but could not distinguish JS activation from native
// show events. A hidden host being shown is the minimum diagnostic input.
it('records sanitized JS callers separately from native events without changing visibility', async () => {
  const owner = new DesktopCaptureWindow(vi.fn(), 'direct');
  const ready = owner.start(), win = fake.windows[0];
  owner.registered(event(win)); await ready;
  expect(win.visible).toBe(false);
  expect(fake.warn).not.toHaveBeenCalled();
  expect(fake.info.mock.calls[0][1]).toMatchObject({ mode: 'direct', nativeHandle: '00120406' });
  win.emit('show'); // Native event without a JS method call is not a caller stack.
  expect(fake.warn.mock.calls[0][1]).toMatchObject({ action: 'show', origin: 'native-event' });
  expect(fake.warn.mock.calls[0][1]).not.toHaveProperty('stack');
  win.show();
  expect(win.visible).toBe(true);
  const call = fake.warn.mock.calls.find(([, details]) => details.origin === 'js-call')![1];
  expect(call).toMatchObject({ action: 'show', mode: 'direct', contentBounds: { height: 0 } });
  expect(call.stack.length).toBeGreaterThan(0);
  expect(call.stack.join('\n')).not.toMatch(/[\\/]|https?:|file:/);
  expect(call.stack.join('\n')).toContain('captureWindow.test.ts:');
  owner.dispose();
});

it('bounds diagnostic records and preserves calls/arguments even when logging fails', async () => {
  const owner = new DesktopCaptureWindow(vi.fn());
  const ready = owner.start(), win = fake.windows[0];
  owner.registered(event(win)); await ready;
  fake.warn.mockImplementationOnce(() => { throw new Error('synthetic logger failure'); });
  win.showInactive(); win.restore(); win.focus(); win.setAlwaysOnTop(true, 'screen-saver', 1);
  for (let i = 0; i < 100; i++) win.show();
  expect(win.calls).toHaveLength(104);
  expect(win.calls.slice(0, 4)).toEqual(['showInactive', 'restore', 'focus', 'setAlwaysOnTop']);
  expect(win.topArgs).toEqual([true, 'screen-saver', 1]);
  expect(fake.info.mock.calls.filter(([message]) => message.includes('limit reached'))).toHaveLength(1);
  expect(fake.info.mock.calls.length + fake.warn.mock.calls.length).toBe(33);
  owner.dispose();
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
  expect(win.webContents.setWebRTCIPHandlingPolicy).not.toHaveBeenCalled();
  expect(isCaptureWindowWebContents(win.webContents)).toBe(true);
  owner.dispose();
  // Unit regression: native gone may reach app after local destroyed cleanup.
  // Keep this factory's identity so a capture crash cannot tear down device-link.
  expect(isCaptureWindowWebContents(win.webContents)).toBe(true);
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

// Unit, Electron security §3/§5: local recording adds physical audio only to
// its isolated process. Existing remote desktop tests never enable microphones.
// Minimal failure: audio-enabled host receives camera or foreign-frame request.
it.each([
  { system: true, microphone: false },
  { system: false, microphone: true },
])('confines recording permissions to its selected audio sources: %j', async (options) => {
  const owner = new DesktopCaptureWindow(vi.fn(), 'recording', options);
  const ready = owner.start(), win = fake.windows[0];
  owner.registered(event(win)); await ready;
  const handler = fake.sessions[0].setPermissionRequestHandler.mock.calls[0][0];
  const details = { isMainFrame: true, requestingUrl: win.webContents.mainFrame.url };
  const check = (contents: any, mediaTypes: string[], extra = {}) => {
    const reply = vi.fn(); handler(contents, 'media', reply, { ...details, mediaTypes, ...extra });
    return reply.mock.calls[0][0];
  };
  expect(check(win.webContents, [])).toBe(options.system);
  expect(check(win.webContents, ['audio'])).toBe(options.microphone);
  expect(check(win.webContents, ['video'])).toBe(false);
  expect(check(win.webContents, ['audio'], { isMainFrame: false })).toBe(false);
  expect(check({}, ['audio'])).toBe(false);
  owner.dispose();
  expect(check(win.webContents, ['audio'])).toBe(false);
});

// Unit regression from the packaged Electron smoke: a second recording shares
// the partition and must neither register its protocol twice nor keep old grants.
it('reuses recording assets while granting media only to the new owner', async () => {
  vi.stubGlobal('DESKTOP_CAPTURE_VITE_DEV_SERVER_URL', undefined);
  const first = new DesktopCaptureWindow(vi.fn(), 'recording', { system: true, microphone: false });
  const initial = first.start(), old = fake.windows[0];
  first.registered(event(old)); await initial; first.dispose();
  const ses = fake.sessions[0];
  vi.mocked(session.fromPartition).mockReturnValueOnce(ses);
  const next = new DesktopCaptureWindow(vi.fn(), 'recording', { system: false, microphone: true });
  const ready = next.start(), win = fake.windows[1];
  next.registered(event(win)); await ready;
  expect(ses.protocol.handle).toHaveBeenCalledOnce();
  expect(ses.listenerCount('will-download')).toBe(1);
  const grant = ses.setPermissionRequestHandler.mock.calls.at(-1)[0];
  const reply = vi.fn();
  const details = { isMainFrame: true, requestingUrl: win.webContents.mainFrame.url, mediaTypes: ['audio'] };
  grant(old.webContents, 'media', reply, details); expect(reply).toHaveBeenLastCalledWith(false);
  grant(win.webContents, 'media', reply, details); expect(reply).toHaveBeenLastCalledWith(true);
  next.dispose();
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
  expect(isCaptureWindowWebContents(win.webContents)).toBe(true);
  // Unit regression: routed private networks cannot resolve Chromium's default
  // mDNS candidates. Exercise the real window factory: opt in only the direct
  // data window, before navigation, without granting media or changing files/video.
  // Actual ICE and byte transfer are covered by provider-share-direct-smoke.mjs.
  if (mode === 'direct') {
    expect(win.webContents.setWebRTCIPHandlingPolicy).toHaveBeenCalledExactlyOnceWith('default_public_and_private_interfaces');
    expect(win.webContents.setWebRTCIPHandlingPolicy.mock.invocationCallOrder[0])
      .toBeLessThan(win.loadURL.mock.invocationCallOrder[0]);
  } else expect(win.webContents.setWebRTCIPHandlingPolicy).not.toHaveBeenCalled();
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
