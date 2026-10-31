import { describe, expect, it, vi } from 'vitest';
import type { InputHandoffSnapshot } from '@cindy/device-link';
import type { HandoffDriver } from '../macDriver.js';
import { InputHandoffSession, type HandoffResult, type HandoffTargetSpec } from '../session.js';
import type { NativeAxNode } from '../types.js';

const node = (ref: string, role: string, extra: Partial<NativeAxNode> = {}): NativeAxNode => ({
  ref, role, depth: 1, fp: `${role}|${extra.title ?? ''}`, enabled: true, frame: [10, 10, 100, 20], ...extra,
});
const frame = [0, 0, 800, 600];
const chrome = { pid: 20, app: 'Google Chrome', bundleId: 'com.google.Chrome' };
const page = (url: string, nodes: NativeAxNode[]) => [
  node('0', 'AXTextField', { desc: '地址和搜索栏', hasValue: true }),
  node('1', 'AXWebArea', { url, frame }),
  ...nodes,
];
const screens = {
  email: page('https://login.example.com/', [node('1.0', 'AXTextField', { title: 'Email' }), node('1.1', 'AXButton', { title: 'Continue' })]),
  password: page('https://login.example.com/', [node('1.0', 'AXTextField', { title: 'Password', secure: true })]),
  blank: page('https://login.example.com/', []),
  signedIn: page('https://app.example.com/inbox', [node('1.0', 'AXTextArea', { title: 'Reply' })]),
  address: page('https://shop.example.com/', [node('1.0', 'AXTextField', { title: 'Street' })]),
};

function desktop(first: keyof typeof screens = 'email') {
  const state = {
    screen: first as keyof typeof screens,
    windowTitle: 'Sign in',
    closed: false,
    minimized: false,
    frontmost: 20,
    running: true,
    raised: 0,
  };
  const driver: HandoffDriver = {
    permission: async () => 'granted',
    requestPermission: async () => undefined,
    windows: async () => ({
      frontmost: state.frontmost,
      apps: state.running
        ? [{ ...chrome, windows: [
            { index: 0, title: 'X', frame, focused: true, minimized: false },
            ...(state.closed ? [] : [{ index: 1, title: state.windowTitle, frame, focused: false, minimized: state.minimized }]),
          ] }]
        : [],
    }),
    snapshot: async (_pid, window) => (window?.title === state.windowTitle && !state.closed
      ? { ...chrome, frontmost: true, window: { index: 1, title: state.windowTitle, frame }, nodes: screens[state.screen] }
      : { error: 'target_gone' }),
    commandLine: async () => (state.running ? 'Google Chrome' : ''),
    act: async () => ({ ok: true }),
    raise: async () => {
      state.raised++;
      return { frame, windowId: 7 };
    },
  };
  return { driver, state };
}

function start(driver: HandoffDriver, target: HandoffTargetSpec = { app: 'Google Chrome', windowTitle: 'Sign in' }) {
  const published: InputHandoffSnapshot[] = [];
  const finished: HandoffResult[] = [];
  const guarded: Array<string | undefined> = [];
  const session = new InputHandoffSession({
    requestId: 'req1', purpose: 'Sign in', target, timeoutMs: 600_000, hostPid: 1, remoteInput: true, driver,
    publish: (snapshot) => published.push(snapshot), finish: (result) => finished.push(result),
    onSecretEntered: ({ url }) => guarded.push(url),
    sleep: async () => undefined, finishingDelayMs: 1, settleTimeoutMs: 50, windowWatchMs: 2,
  });
  return { session, finished, guarded, published, latest: () => published[published.length - 1] };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

describe('a sign-in step', () => {
  it('is done on the window: it comes forward, and the form stays for clients without a live view', async () => {
    const { driver, state } = desktop();
    const run = start(driver);
    await run.session.start();
    expect(state.raised).toBe(1);
    expect(run.latest()).toMatchObject({ phase: 'ready', directSignIn: true });
    expect(run.latest().controls.map((control) => control.kind === 'text' && control.contentType)).toEqual(['email']);
    run.session.cancel();
  });

  it('leaves other forms as forms, without taking the screen', async () => {
    const { driver, state } = desktop('address');
    const run = start(driver);
    await run.session.start();
    expect(state.raised).toBe(0);
    expect(run.latest().directSignIn).toBeUndefined();
    run.session.cancel();
  });

  it('brings the window forward again when the owner asks', async () => {
    const { driver, state } = desktop();
    const run = start(driver);
    await run.session.start();
    expect(await run.session.bringToFront()).toBe(true);
    expect(state.raised).toBe(2);
    run.session.cancel();
    expect(await run.session.bringToFront()).toBe(false);
  });

  it('follows the owner to the next step and guards the page once a password shows', async () => {
    const { driver, state } = desktop();
    const run = start(driver);
    await run.session.start();
    expect(run.guarded).toEqual([]);
    state.screen = 'password';
    await vi.waitFor(() => expect(run.latest().controls.map((c) => c.kind === 'text' && c.contentType)).toEqual(['password']));
    expect(run.latest().directSignIn).toBe(true);
    expect(run.guarded).toContain('https://login.example.com/');
    run.session.cancel();
  });

  it('hands back when the owner finished on the window, even if the signed-in page has fields of its own', async () => {
    const { driver, state } = desktop();
    const run = start(driver);
    await run.session.start();
    state.screen = 'signedIn';
    state.windowTitle = 'Inbox';
    await vi.waitFor(() => expect(run.finished).toHaveLength(1));
    expect(run.finished[0]).toMatchObject({ status: 'succeeded', reason: 'detected', steps: 0, finalWindow: 'Inbox' });
    expect(run.published.some((snapshot) => snapshot.controls.some((c) => c.kind === 'text' && c.label === 'Reply'))).toBe(false);
  });

  it('does not hand back on a page that only clears its form for a moment', async () => {
    const { driver, state } = desktop();
    const run = start(driver);
    await run.session.start();
    // One read's worth of blank, then the form is back: fewer reads than it takes to conclude.
    const read = driver.snapshot.bind(driver);
    let blanks = 1;
    driver.snapshot = async (pid, window) => {
      const shot = await read(pid, window);
      if (blanks > 0 && 'nodes' in shot) {
        blanks--;
        return { ...shot, nodes: screens.blank };
      }
      return shot;
    };
    await settle();
    expect(run.finished).toEqual([]);
    expect(run.latest().directSignIn).toBe(true);
    state.screen = 'email';
    run.session.cancel();
  });
});

describe('a waiting card watching its window', () => {
  it('ends when a form that is not a sign-in goes away', async () => {
    const { driver, state } = desktop('address');
    const run = start(driver);
    await run.session.start();
    state.screen = 'blank';
    await vi.waitFor(() => expect(run.finished).toHaveLength(1));
    expect(run.finished[0]).toMatchObject({ status: 'succeeded', reason: 'detected', steps: 0 });
  });

  it('ends when the window closes while its app is in front', async () => {
    const { driver, state } = desktop();
    const run = start(driver);
    await run.session.start();
    state.closed = true;
    await vi.waitFor(() => expect(run.finished).toHaveLength(1));
    expect(run.finished[0]).toMatchObject({ status: 'failed', failure: 'target_gone' });
  });

  it('ends when the program quits', async () => {
    const { driver, state } = desktop();
    const run = start(driver);
    await run.session.start();
    state.running = false;
    await vi.waitFor(() => expect(run.finished).toHaveLength(1));
    expect(run.finished[0]).toMatchObject({ status: 'failed', failure: 'target_gone' });
  });

  it('concludes nothing from a window out of reach', async () => {
    const { driver, state } = desktop();
    const run = start(driver);
    await run.session.start();
    // Minimized again, with its form no longer readable.
    state.minimized = true;
    state.screen = 'blank';
    await settle();
    expect(run.finished).toEqual([]);
    // Not listed while another app is in front: it may be on another desktop.
    state.minimized = false;
    state.closed = true;
    state.frontmost = 99;
    await settle();
    expect(run.finished).toEqual([]);
    run.session.cancel();
  });

  it('stays out of the way while the owner is answering through the form', async () => {
    const { driver, state } = desktop();
    const run = start(driver);
    await run.session.start();
    await run.session.decide({ kind: 'input_handoff', action: 'claim', expectedRevision: run.latest().revision }, { deviceId: 'phone' });
    state.screen = 'blank';
    await settle();
    expect(run.finished).toEqual([]);
    run.session.cancel();
  });

  it('stops looking once the request has ended', async () => {
    const { driver } = desktop();
    const snapshot = vi.spyOn(driver, 'snapshot');
    const run = start(driver);
    await run.session.start();
    run.session.cancel();
    snapshot.mockClear();
    await settle();
    expect(snapshot).not.toHaveBeenCalled();
  });
});
