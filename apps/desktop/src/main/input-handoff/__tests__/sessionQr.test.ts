import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InputHandoffSnapshot } from '@cindy/device-link';
import { InputHandoffSession, type HandoffResult } from '../session.js';
import type { HandoffDriver } from '../macDriver.js';
import type { NativeAxNode, NativeAxSnapshot, NativeWindowList } from '../types.js';

const node = (ref: string, role: string, extra: Partial<NativeAxNode> = {}): NativeAxNode => ({
  ref, role, depth: 1, fp: `${role}|${extra.title ?? ''}`, enabled: true, frame: [150, 100, 100, 20], ...extra,
});

type Stage = 'qr' | 'confirm' | 'code' | 'home' | 'closed';

/**
 * A generic scan-to-sign-in window: a QR code with a button (nothing to type),
 * then "confirm on your phone" once scanned, then the app's main window.
 */
function qrDesktop(options: { web?: boolean } = {}) {
  let stage: Stage = 'qr';
  let code = 'https://login.example.com/qr?token=first';
  let front = 10;
  let titled: string | null = null;
  let broken = false;
  const looks: Array<number[] | null> = [];
  const app = options.web
    ? { pid: 10, app: 'Google Chrome', bundleId: 'com.google.Chrome' }
    : { pid: 10, app: 'Chat', bundleId: 'com.example.chat' };
  const frame = [100, 50, 400, 500];
  const title = () => titled ?? (stage === 'home' ? 'Chat' : 'Sign in');
  const windows = (): NativeWindowList => ({
    frontmost: front,
    apps: [
      { ...app, windows: stage === 'closed' ? [] : [{ index: 0, title: title(), frame, focused: true, minimized: false }] },
      { pid: 30, app: 'Notes', bundleId: 'com.example.notes', windows: [{ index: 0, title: 'Notes', frame, focused: true, minimized: false }] },
    ],
  });
  const snapshot = (): NativeAxSnapshot => {
    const base = { ...app, frontmost: true, window: { index: 0, title: title(), frame } };
    const page = (url: string, nodes: NativeAxNode[]) =>
      options.web ? [node('9', 'AXWebArea', { url, frame }), ...nodes.map((n) => ({ ...n, ref: `9.${n.ref}` }))] : nodes;
    if (stage === 'code')
      return { ...base, nodes: page('https://login.example.com/qr', [node('0', 'AXTextField', { title: 'Code' }), node('1', 'AXButton', { title: 'Verify' })]) };
    if (stage === 'home')
      return { ...base, nodes: page('https://app.example.com/', [node('0', 'AXButton', { title: 'New chat' })]) };
    return {
      ...base,
      nodes: page('https://login.example.com/qr', [
        node('0', 'AXStaticText', { value: stage === 'qr' ? 'Scan to sign in' : 'Confirm on your phone' }),
        node('1', 'AXButton', { title: 'Switch account' }),
      ]),
    };
  };
  const driver: HandoffDriver = {
    permission: async () => 'granted',
    requestPermission: async () => undefined,
    windows: async () => windows(),
    snapshot: async () => snapshot(),
    commandLine: async () => '',
    act: async () => ({ ok: true }),
    capture: async () => ({ jpeg: Buffer.from('window'), width: 800, height: 1000, area: frame, windowFrame: frame }),
    focusedField: async () => ({ editable: false, secure: false }),
    pointer: async () => ({ ok: true }),
    qr: async (_target, at) => {
      looks.push(at);
      if (broken) return { error: 'unavailable' as const };
      if (stage !== 'qr') return null;
      return { text: code, capture: { jpeg: Buffer.from(`code:${code}`), width: 360, height: 360, area: [200, 150, 180, 180], windowFrame: frame } };
    },
  };
  return {
    driver,
    looks,
    set stage(next: Stage) { stage = next; },
    set code(next: string) { code = next; },
    set front(pid: number) { front = pid; },
    set title(next: string | null) { titled = next; },
    set broken(next: boolean) { broken = next; },
  };
}

function harness(driver: HandoffDriver, app = 'Chat') {
  const published: InputHandoffSnapshot[] = [];
  const finished: HandoffResult[] = [];
  let clock = 0;
  const session = new InputHandoffSession({
    requestId: 'req1',
    purpose: 'Sign in to Chat',
    target: { app },
    timeoutMs: 600_000,
    hostPid: 1,
    remoteInput: true,
    driver,
    publish: (snapshot) => published.push(snapshot),
    finish: (result) => finished.push(result),
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    finishingDelayMs: 3000,
  });
  return { session, published, finished, latest: () => published[published.length - 1] };
}

const watch = () => vi.advanceTimersByTimeAsync(2000);

describe('代输入 scan-to-sign-in', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('hands a QR code on a screen with nothing to type to the owner, with what it says', async () => {
    const desktop = qrDesktop();
    const { session, latest } = harness(desktop.driver);
    await session.start();
    expect(latest()).toMatchObject({ phase: 'ready', qr: 'scan', picture: true, controls: [], source: { app: 'Chat' } });
    // The content travels only with the sealed picture, never in the snapshot.
    expect(JSON.stringify(latest())).not.toContain('token=first');
    expect(session.pictureFor(latest().revision)).toMatchObject({
      data: Buffer.from('code:https://login.example.com/qr?token=first').toString('base64'),
      qr: { text: 'https://login.example.com/qr?token=first', url: 'https://login.example.com/qr?token=first' },
    });
    // The first look brings the window forward; it is not left to an agent's guess.
    expect(desktop.looks).toEqual([null]);
    session.cancel();
  });

  it('follows a refreshed code without bringing the window forward again', async () => {
    const desktop = qrDesktop();
    const { session, published, latest } = harness(desktop.driver);
    await session.start();
    const first = published.length;
    await watch();
    expect(published.length).toBe(first);
    desktop.code = 'https://login.example.com/qr?token=second';
    await watch();
    expect(latest()).toMatchObject({ phase: 'ready', qr: 'scan' });
    expect(session.pictureFor(latest().revision)?.qr?.text).toBe('https://login.example.com/qr?token=second');
    expect(desktop.looks.slice(1).every((frame) => Array.isArray(frame))).toBe(true);
    session.cancel();
  });

  it('waits after the scan, then hands back once the window moves on', async () => {
    const desktop = qrDesktop();
    const { session, finished, latest } = harness(desktop.driver);
    await session.start();
    desktop.stage = 'confirm';
    await watch();
    expect(latest()).toMatchObject({ phase: 'ready', qr: 'scanned', controls: [] });
    expect(latest().picture).toBeUndefined();
    expect(session.pictureFor(latest().revision)).toBeNull();
    await watch();
    expect(finished).toEqual([]);
    desktop.stage = 'home';
    await watch();
    expect(latest()).toMatchObject({ phase: 'finishing' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(finished).toEqual([expect.objectContaining({ status: 'succeeded', reason: 'detected', steps: 1 })]);
  });

  it('goes back to the code when it comes back (expired, or the scan was cancelled)', async () => {
    const desktop = qrDesktop();
    const { session, latest } = harness(desktop.driver);
    await session.start();
    desktop.stage = 'confirm';
    await watch();
    expect(latest().qr).toBe('scanned');
    desktop.stage = 'qr';
    desktop.code = 'https://login.example.com/qr?token=again';
    await watch();
    expect(latest()).toMatchObject({ qr: 'scan', picture: true });
    expect(session.pictureFor(latest().revision)?.qr?.text).toBe('https://login.example.com/qr?token=again');
    session.cancel();
  });

  it('keeps waiting when a look at the code fails', async () => {
    const desktop = qrDesktop();
    const { session, published, finished } = harness(desktop.driver);
    await session.start();
    const before = published.length;
    desktop.broken = true;
    await watch();
    await watch();
    expect(published.length).toBe(before);
    expect(published[published.length - 1].qr).toBe('scan');
    expect(finished).toEqual([]);
    session.cancel();
  });

  it('does not take a title change for a sign-in while the code still shows', async () => {
    const desktop = qrDesktop();
    const { session, published, finished } = harness(desktop.driver);
    await session.start();
    desktop.title = '(1) Sign in';
    await watch();
    expect(published[published.length - 1]).toMatchObject({ phase: 'ready', qr: 'scan' });
    // The flow then really moves on.
    desktop.title = null;
    desktop.stage = 'home';
    await watch();
    expect(published[published.length - 1]).toMatchObject({ phase: 'finishing' });
    expect(finished).toEqual([]);
    session.cancel();
  });

  it('draws no conclusion while another app covers the window', async () => {
    const desktop = qrDesktop();
    const { session, published, finished } = harness(desktop.driver);
    await session.start();
    const before = published.length;
    desktop.front = 30;
    desktop.stage = 'confirm';
    await watch();
    await watch();
    expect(published.length).toBe(before);
    // Back in front: now it can be seen that the code was scanned.
    desktop.front = 10;
    await watch();
    expect(published[published.length - 1].qr).toBe('scanned');
    // A title change while covered still counts: that is this window moving on, not the app in front.
    desktop.front = 30;
    desktop.stage = 'home';
    await watch();
    expect(published[published.length - 1]).toMatchObject({ phase: 'finishing', source: { app: 'Chat', window: 'Chat' } });
    expect(finished).toEqual([]);
    session.cancel();
  });

  it('asks for what comes next when the scan leads to something to type', async () => {
    const desktop = qrDesktop({ web: true });
    const { session, latest } = harness(desktop.driver, 'Google Chrome');
    await session.start();
    expect(latest()).toMatchObject({ qr: 'scan', source: { origin: 'https://login.example.com' } });
    desktop.stage = 'code';
    await watch();
    expect(latest()).toMatchObject({ phase: 'ready', controls: [expect.objectContaining({ kind: 'text', label: 'Code' })] });
    expect(latest().qr).toBeUndefined();
    session.cancel();
  });

  it('ends when the window with the code closes', async () => {
    const desktop = qrDesktop();
    const { session, finished } = harness(desktop.driver);
    await session.start();
    desktop.stage = 'closed';
    await watch();
    expect(finished).toEqual([expect.objectContaining({ status: 'succeeded', reason: 'detected' })]);
  });

  it('shows content that is not a link as text only', async () => {
    const desktop = qrDesktop();
    desktop.code = 'WIFI:S:home;T:WPA;P:secret;;';
    const { session, latest } = harness(desktop.driver);
    await session.start();
    expect(session.pictureFor(latest().revision)?.qr).toEqual({ text: 'WIFI:S:home;T:WPA;P:secret;;' });
    session.cancel();
  });

  it('shows the whole window when the owner asks to see it, and stops watching the code', async () => {
    const desktop = qrDesktop();
    const { session, latest } = harness(desktop.driver);
    await session.start();
    await session.decide({ kind: 'input_handoff', action: 'picture', expectedRevision: latest().revision });
    expect(latest()).toMatchObject({ picture: true });
    expect(latest().qr).toBeUndefined();
    const looks = desktop.looks.length;
    await watch();
    expect(desktop.looks.length).toBe(looks);
    session.cancel();
  });
});
