import { describe, expect, it } from 'vitest';
import type { InputHandoffSnapshot } from '@cindy/device-link';
import { InputHandoffSession, type HandoffResult } from '../session.js';
import type { HandoffDriver } from '../macDriver.js';
import type { NativeAxNode } from '../types.js';

const node = (ref: string, role: string, extra: Partial<NativeAxNode> = {}): NativeAxNode => ({
  ref, role, depth: 1, fp: `${role}|${extra.title ?? extra.value ?? ''}`, enabled: true, frame: [10, 10, 100, 20], ...extra,
});

/** A CLI-style app the agent already moved to "sign in with a code": it shows the code and waits. */
function codeApp() {
  const app = { pid: 10, app: 'Example', bundleId: 'com.example.app' };
  const driver: HandoffDriver = {
    permission: async () => 'granted',
    requestPermission: async () => undefined,
    windows: async () => ({
      frontmost: 10,
      apps: [{ ...app, windows: [{ index: 0, title: 'Sign in', frame: [0, 0, 800, 600], focused: true, minimized: false }] }],
    }),
    snapshot: async () => ({
      ...app,
      frontmost: true,
      window: { index: 0, title: 'Sign in', frame: [0, 0, 800, 600] },
      nodes: [
        node('0', 'AXStaticText', { value: 'Open github.com/login/device and enter WDJB-MJHT' }),
        node('1', 'AXButton', { title: 'Cancel' }),
      ],
    }),
    commandLine: async () => '',
    act: async () => ({ ok: true }),
  };
  return driver;
}

describe('device-code sign-in in a 代输入 session', () => {
  it('shows the code to open elsewhere and waits for the owner instead of finishing on its own', async () => {
    const published: InputHandoffSnapshot[] = [];
    const finished: HandoffResult[] = [];
    let clock = 0;
    const session = new InputHandoffSession({
      requestId: 'req1',
      purpose: 'Sign in to Example',
      target: { app: 'Example' },
      timeoutMs: 600_000,
      hostPid: 1,
      remoteInput: true,
      driver: codeApp(),
      publish: (snapshot) => published.push(snapshot),
      finish: (result) => finished.push(result),
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      finishingDelayMs: 5,
    });
    const latest = () => published[published.length - 1];
    await session.start();

    // Nothing to type, yet the code still has to be used elsewhere: the card shows it and waits.
    const code = latest();
    expect(code.phase).toBe('ready');
    expect(code.deviceCode).toEqual({ code: 'WDJB-MJHT', url: 'https://github.com/login/device', origin: 'https://github.com' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(finished).toHaveLength(0);

    expect(await session.decide({ kind: 'input_handoff', action: 'done', expectedRevision: code.revision })).toBe(true);
    expect(finished[0]).toMatchObject({ status: 'succeeded', reason: 'owner' });
    expect(latest().deviceCode).toBeUndefined();
  });
});

describe('a locked computer in a 代输入 session', () => {
  it('ends with screen_locked instead of blaming the window', async () => {
    const finished: HandoffResult[] = [];
    const driver: HandoffDriver = {
      ...codeApp(),
      windows: async () => {
        throw new Error('locked');
      },
    };
    const session = new InputHandoffSession({
      requestId: 'req2',
      purpose: 'Sign in to Example',
      target: { app: 'Example' },
      timeoutMs: 600_000,
      hostPid: 1,
      remoteInput: true,
      driver,
      publish: () => undefined,
      finish: (result) => finished.push(result),
      finishingDelayMs: 5,
    });
    await session.start();
    expect(finished[0]).toMatchObject({ status: 'failed', failure: 'screen_locked' });
  });
});
