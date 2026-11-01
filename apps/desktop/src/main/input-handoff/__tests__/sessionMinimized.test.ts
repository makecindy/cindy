import { describe, expect, it } from 'vitest';
import type { InputHandoffSnapshot } from '@cindy/device-link';
import type { HandoffDriver } from '../macDriver.js';
import { buildInputHandoffContinuation } from '../service.js';
import {
  InputHandoffSession,
  resolveHandoffTarget,
  type HandoffResult,
  type HandoffTargetSpec,
} from '../session.js';
import type { NativeAxNode, NativeWindowList } from '../types.js';

const node = (ref: string, role: string, extra: Partial<NativeAxNode> = {}): NativeAxNode => ({
  ref,
  role,
  depth: 1,
  fp: `${role}|${extra.title ?? ''}`,
  enabled: true,
  frame: [10, 10, 100, 20],
  ...extra,
});

const frame = [0, 0, 800, 600];
const chrome = { pid: 20, app: 'Google Chrome', bundleId: 'com.google.Chrome' };
const addressBar = node('0', 'AXTextField', {
  desc: '地址和搜索栏',
  placeholder: '问问 Google 或输入网址',
  hasValue: true,
});
const signInPage = [
  addressBar,
  node('1', 'AXWebArea', { url: 'https://appstoreconnect.apple.com/login', frame }),
  node('1.0', 'AXTextField', { title: 'Email' }),
  node('1.1', 'AXButton', { title: 'Continue' }),
];

/**
 * The owner's X window in front and Cindy's browser window minimized behind it.
 * A minimized window shows no page; bringing it back loads the page after `loadReads` reads.
 */
function browser(
  options: { loadReads?: number; titleAfterRaise?: string; ownWindow?: boolean } = {},
) {
  let minimized = true;
  let reads = 0;
  const title = () =>
    minimized ? 'App Store Connect' : (options.titleAfterRaise ?? 'App Store Connect');
  const raised: string[] = [];
  const driver: HandoffDriver = {
    permission: async () => 'granted',
    requestPermission: async () => undefined,
    windows: async () => ({
      frontmost: 20,
      apps: [
        {
          ...chrome,
          windows: [
            ...(options.ownWindow === false
              ? []
              : [{ index: 0, title: '主页 / X', frame, focused: minimized, minimized: false }]),
            { index: 1, title: title(), frame, focused: !minimized, minimized },
          ],
        },
      ],
    }),
    snapshot: async (_pid, window) => {
      if (window?.title === '主页 / X') {
        return {
          ...chrome,
          frontmost: true,
          window: { index: 0, title: '主页 / X', frame },
          nodes: [
            addressBar,
            node('1', 'AXWebArea', { url: 'https://x.com/home', frame }),
            node('1.0', 'AXButton', { title: 'Post' }),
          ],
        };
      }
      if (window?.title !== title()) return { error: 'target_gone' };
      const ready = !minimized && ++reads > (options.loadReads ?? 0);
      return {
        ...chrome,
        frontmost: true,
        window: { index: 1, title: title(), frame },
        nodes: ready ? signInPage : [addressBar],
      };
    },
    commandLine: async () => '',
    act: async () => ({ ok: true }),
    raise: async (target) => {
      raised.push(target.window.title);
      minimized = false;
      return { frame, windowId: 7 };
    },
    capture: async () => ({ error: 'unavailable' }),
  };
  return { driver, raised };
}

function start(driver: HandoffDriver, target: HandoffTargetSpec) {
  const published: InputHandoffSnapshot[] = [];
  const finished: HandoffResult[] = [];
  let clock = 0;
  const session = new InputHandoffSession({
    requestId: 'req1',
    purpose: 'Sign in',
    target,
    timeoutMs: 600_000,
    hostPid: 1,
    remoteInput: true,
    driver,
    publish: (s) => published.push(s),
    finish: (result) => finished.push(result),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    finishingDelayMs: 60_000,
    settleTimeoutMs: 2000,
  });
  return { session, finished, latest: () => published[published.length - 1] };
}

const fields = (card: InputHandoffSnapshot) =>
  card.controls.filter((control) => control.kind === 'text').map((control) => control.label);

describe('a target window that is minimized', () => {
  it("comes back for the owner when named, and asks only for the page's fields", async () => {
    const { driver, raised } = browser();
    const { session, latest } = start(driver, {
      app: 'Google Chrome',
      windowTitle: 'App Store Connect',
    });
    await session.start();
    expect(raised).toEqual(['App Store Connect']);
    expect(latest()).toMatchObject({
      phase: 'ready',
      source: { origin: 'https://appstoreconnect.apple.com' },
    });
    expect(fields(latest())).toEqual(['Email']);
  });

  it('waits for the page to load after coming back', async () => {
    const { driver } = browser({ loadReads: 3 });
    const { session, latest } = start(driver, {
      app: 'Google Chrome',
      windowTitle: 'App Store Connect',
    });
    await session.start();
    expect(fields(latest())).toEqual(['Email']);
  });

  it('follows the window when the page changes its title while loading', async () => {
    const { driver } = browser({ titleAfterRaise: 'Sign in - App Store Connect' });
    const { session, latest } = start(driver, {
      app: 'Google Chrome',
      windowTitle: 'App Store Connect',
    });
    await session.start();
    expect(fields(latest())).toEqual(['Email']);
  });

  it('comes back when it is all the app has, and leaves it alone when another window shows', async () => {
    const alone = browser({ ownWindow: false });
    await start(alone.driver, { app: 'Google Chrome' }).session.start();
    expect(alone.raised).toEqual(['App Store Connect']);

    const beside = browser();
    await start(beside.driver, { app: 'Google Chrome' }).session.start();
    expect(beside.raised).toEqual([]);
  });

  it('refuses to guess among several windows when the pre-check was skipped', async () => {
    const { driver, raised } = browser();
    const { session, finished } = start(driver, { app: 'Google Chrome' });
    await session.start();
    expect(raised).toEqual([]);
    expect(finished[0]).toMatchObject({
      status: 'failed',
      failure: 'target_gone',
      ambiguousTitles: ['主页 / X', 'App Store Connect'],
    });
    // The agent is told which windows there were and how to ask again.
    expect(buildInputHandoffContinuation(finished[0])).toMatch(
      /several windows .*App Store Connect.*target\.window_title/s,
    );
  });

  it('never offers the address bar when no page can be read', async () => {
    const { driver } = browser({ loadReads: Number.MAX_SAFE_INTEGER });
    const { session, finished, latest } = start(driver, {
      app: 'Google Chrome',
      windowTitle: 'App Store Connect',
    });
    await session.start();
    expect(fields(latest())).toEqual([]);
    // No picture on this fake either, so the request reports it could not read rather than asking for the toolbar.
    expect(finished[0]).toMatchObject({ status: 'failed', failure: 'unreadable' });
  });
});

describe('resolveHandoffTarget with minimized windows', () => {
  const window = (index: number, title: string, minimized: boolean) => ({
    index,
    title,
    frame,
    focused: false,
    minimized,
  });
  const list = (apps: NativeWindowList['apps']): NativeWindowList => ({ frontmost: 9, apps });

  it('prefers a shown window with the name over a minimized one', () => {
    const target = resolveHandoffTarget(
      list([{ ...chrome, windows: [window(0, 'Login', true), window(1, 'Login', false)] }]),
      { app: 'chrome', windowTitle: 'login' },
      1,
    );
    expect(target).toMatchObject({ window: { index: 1 } });
    expect(target?.minimized).toBeUndefined();
  });

  it('prefers an app that shows a window over one that only has minimized windows', () => {
    const hidden = {
      pid: 30,
      app: 'Chrome Canary',
      bundleId: 'com.google.Chrome.canary',
      windows: [window(0, 'A', true)],
    };
    const target = resolveHandoffTarget(
      list([hidden, { ...chrome, windows: [window(0, 'B', false)] }]),
      { app: 'chrome' },
      1,
    );
    expect(target?.pid).toBe(20);
  });

  it('finds a named window in any process of the same browser', () => {
    const second = { ...chrome, pid: 21 };
    const apps = [
      { ...chrome, windows: [window(0, 'X', false)] },
      { ...second, windows: [window(0, 'Login', true), window(1, 'Other', false)] },
    ];
    expect(
      resolveHandoffTarget(list(apps), { app: 'Google Chrome', windowTitle: 'login' }, 1),
    ).toMatchObject({ pid: 21, minimized: true });
    // A pid is exact, and with no name to look for the first process stands.
    expect(resolveHandoffTarget(list(apps), { pid: 21, windowTitle: 'login' }, 1)?.pid).toBe(21);
    // A title nothing matches is a miss, not whichever window has focus.
    expect(resolveHandoffTarget(list(apps), { pid: 20, windowTitle: 'login' }, 1)).toBeNull();
    expect(
      resolveHandoffTarget(list(apps), { app: 'Google Chrome', windowTitle: 'nope' }, 1),
    ).toBeNull();
    expect(resolveHandoffTarget(list(apps), { app: 'Google Chrome' }, 1)?.pid).toBe(20);
  });

  it('still never picks Cindy, minimized or not', () => {
    expect(
      resolveHandoffTarget(
        list([{ pid: 1, app: 'Cindy', bundleId: 'host', windows: [window(0, 'Cindy', true)] }]),
        { app: 'Cindy' },
        1,
      ),
    ).toBeNull();
  });
});
