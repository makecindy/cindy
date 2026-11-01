import { describe, expect, it } from 'vitest';
import type { InputHandoffSnapshot } from '@cindy/device-link';
import { isHumanDesktopInputActive } from '../../remote-desktop/inputOwnership.js';
import type { HandoffDriver } from '../macDriver.js';
import { InputHandoffSession, type HandoffResult } from '../session.js';
import type { NativeActRequest, NativeAxNode } from '../types.js';

const node = (ref: string, role: string, extra: Partial<NativeAxNode> = {}): NativeAxNode => ({
  ref,
  role,
  depth: 1,
  fp: `${role}|${extra.title ?? ''}`,
  enabled: true,
  frame: [10, 10, 100, 20],
  ...extra,
});

/** A sign-in page in a browser whose address can change under the card. */
function loginPage(commandLine = '') {
  let url = 'https://login.example.com/signin';
  let form = true;
  const acts: Array<NativeActRequest & { humanActive: boolean }> = [];
  const browser = { pid: 20, app: 'Google Chrome', bundleId: 'com.google.Chrome' };
  const driver: HandoffDriver = {
    permission: async () => 'granted',
    requestPermission: async () => undefined,
    windows: async () => ({
      frontmost: 20,
      apps: [
        {
          ...browser,
          windows: [
            {
              index: 0,
              title: 'Sign in',
              frame: [0, 0, 800, 600],
              focused: true,
              minimized: false,
            },
          ],
        },
      ],
    }),
    snapshot: async () => ({
      ...browser,
      frontmost: true,
      window: { index: 0, title: 'Sign in', frame: [0, 0, 800, 600] },
      nodes: [
        node('0', 'AXWebArea', { url, frame: [0, 0, 800, 600] }),
        ...(form
          ? [
              node('0.0', 'AXTextField', { title: 'Email' }),
              node('0.1', 'AXTextField', {
                title: 'Password',
                subrole: 'AXSecureTextField',
                secure: true,
              }),
            ]
          : [node('0.3', 'AXStaticText', { value: 'Choose an account' })]),
        node('0.2', 'AXButton', { title: 'Sign in' }),
      ],
    }),
    commandLine: async () => commandLine,
    act: async (request) => {
      acts.push({ ...request, humanActive: isHumanDesktopInputActive() });
      return { ok: true };
    },
  };
  return {
    driver,
    acts,
    navigate: (next: string, keepForm = true) => {
      url = next;
      form = keepForm;
    },
  };
}

function start(
  driver: HandoffDriver,
  onSecretEntered?: (target: { pid: number; url?: string }) => void,
) {
  const published: InputHandoffSnapshot[] = [];
  const finished: HandoffResult[] = [];
  let clock = 0;
  const session = new InputHandoffSession({
    requestId: 'req1',
    purpose: 'Sign in',
    target: { app: 'Google Chrome' },
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
    ...(onSecretEntered ? { onSecretEntered } : {}),
  });
  return { session, finished, latest: () => published[published.length - 1] };
}

function answer(step: InputHandoffSnapshot) {
  const [email, password] = step.controls.filter((c) => c.kind === 'text');
  return {
    expectedRevision: step.revision,
    values: { [email.id]: 'someone@example.test', [password.id]: 'synthetic-pass' },
    action: { kind: 'submit' as const },
  };
}

describe('代输入 secrets', () => {
  it('types while holding the desktop, so the agent cannot act in between', async () => {
    const page = loginPage();
    const { session, latest } = start(page.driver);
    await session.start();
    await session.submit(answer(latest()));
    expect(page.acts.length).toBeGreaterThan(0);
    expect(page.acts.every((act) => act.humanActive)).toBe(true);
    expect(isHumanDesktopInputActive()).toBe(false);
  });

  it('fills nothing when the page changed after the owner saw it', async () => {
    const page = loginPage();
    const { session, latest } = start(page.driver);
    await session.start();
    const step = latest();
    page.navigate('https://login.example.net/signin');
    await session.submit(answer(step));
    expect(page.acts.filter((act) => act.kind === 'text')).toEqual([]);
    expect(latest()).toMatchObject({
      phase: 'ready',
      failure: 'origin_changed',
      source: { origin: 'https://login.example.net' },
    });
  });

  it('ends as a changed page, not as nothing to fill, when the new page asks for nothing', async () => {
    const page = loginPage();
    const { session, finished, latest } = start(page.driver);
    await session.start();
    const step = latest();
    page.navigate('https://login.example.net/choose', false);
    await session.submit(answer(step));
    expect(page.acts.filter((act) => act.kind === 'text')).toEqual([]);
    expect(finished[0]).toMatchObject({ status: 'failed', failure: 'origin_changed' });
  });

  it('reports a sign-in page as soon as it shows a password, in any browser, and a secret typed into a browser the agent drives', async () => {
    const page = 'https://login.example.com/signin';
    const entered: Array<{ pid: number; url?: string }> = [];
    const driven = loginPage(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222',
    );
    const { session, latest } = start(driven.driver, (target) => entered.push(target));
    await session.start();
    // The owner may type straight into the window, so the page is guarded before any answer.
    expect(entered.length).toBeGreaterThan(0);
    expect(new Set(entered.map((target) => target.url))).toEqual(new Set([page]));
    const before = entered.length;
    await session.submit(answer(latest()));
    expect(entered.length).toBeGreaterThan(before);

    // The owner's own Chrome, reached through the extension, carries no automation flag and is guarded too.
    const own: Array<{ pid: number; url?: string }> = [];
    const second = start(loginPage().driver, (target) => own.push(target));
    await second.session.start();
    expect(new Set(own.map((target) => target.url))).toEqual(new Set([page]));
  });
});
