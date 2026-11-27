import { describe, expect, it } from 'vitest';
import type { InputHandoffSnapshot } from '@cindy/device-link';
import { isHumanDesktopInputActive } from '../../remote-desktop/inputOwnership.js';
import type { HandoffDriver } from '../macDriver.js';
import { InputHandoffSession, type HandoffResult, type HandoffSessionOptions } from '../session.js';
import type { NativeActRequest, NativeAxNode } from '../types.js';
import { clearSecretPages, isSecretPage, markSecretEntered } from '../secretTaint.js';

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
  fields?: HandoffSessionOptions["fields"],
) {
  const published: InputHandoffSnapshot[] = [];
  const finished: HandoffResult[] = [];
  let clock = 0;
  const session = new InputHandoffSession({
    requestId: 'req1',
    purpose: 'Sign in',
    fields,
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
  // Unit/security: rejecting a form or field plan must not discard its known URL.
  // Exercise the actual page-read taint before capture and after picture typing.
  it.each(['capacity', 'truncated', 'plan-mismatch', 'plan-ambiguous'])('protects the page when %s forces picture input', async (reason) => {
    clearSecretPages();
    const page = loginPage('--remote-debugging-port=9222');
    const url = 'https://login.example.com/signin';
    const rejectedPlan = reason.startsWith('plan-');
    const read = page.driver.snapshot;
    page.driver.snapshot = async (...args) => {
      const raw = await read(...args);
      if ('error' in raw) return raw;
      if (rejectedPlan) {
        if (reason === 'plan-ambiguous') raw.nodes[2].title = 'Email';
        return raw;
      }
      raw.nodes = [raw.nodes[0], ...Array.from({ length: reason === 'capacity' ? 40 : 1 }, (_, i) =>
        node(`0.${i}`, 'AXTextField', { title: `Field ${i}` })),
        ...(reason === 'capacity' ? [node('0.40', 'AXTextField', { title: 'Password', secure: true })] : [])];
      // A truncated tree may end before the focused password appears.
      raw.truncated = reason === 'truncated';
      return raw;
    };
    const protectedAtCapture: boolean[] = [];
    page.driver.capture = async () => {
      protectedAtCapture.push(isSecretPage(url));
      return { jpeg: Buffer.from('synthetic'), width: 800, height: 600, area: [0, 0, 800, 600], windowFrame: [0, 0, 800, 600] };
    };
    page.driver.focusedField = async () => ({ editable: true, secure: true });
    const typed: unknown[] = [];
    page.driver.pointer = async request => { typed.push(request); return { ok: true }; };
    const entered: Array<string | undefined> = [];
    const { session, latest } = start(page.driver, target => {
      entered.push(target.url);
      markSecretEntered(target.url);
    }, rejectedPlan ? [
      { label: 'Account', contentType: 'username', targets: [{ label: reason === 'plan-mismatch' ? 'Missing label' : 'Email' }] },
      { label: 'Password', contentType: 'password', targets: [{ label: 'Password' }] },
    ] : undefined);
    try {
      await session.start();
      expect(latest()).toMatchObject({ phase: 'ready', picture: true, source: { origin: 'https://login.example.com' } });
      expect(protectedAtCapture).toEqual([true]);
      expect(latest().controls).toEqual([{ id: 'typed', kind: 'text', label: '', contentType: 'password' }]);
      // Recovery must not depend on another successful AX read after typing.
      if (rejectedPlan) page.driver.snapshot = async () => { throw new Error('AX unavailable'); };
      await session.submit({ expectedRevision: latest().revision, values: { typed: 'synthetic-secret' }, action: { kind: 'submit' } });
      expect(typed).toEqual([expect.objectContaining({ kind: 'type', secure: true, value: 'synthetic-secret' })]);
      expect(entered.length).toBeGreaterThan(1);
      expect(entered.every(value => value === url)).toBe(true);
      expect(isSecretPage(url)).toBe(true);
      expect(latest()).toMatchObject({ picture: true, source: { origin: 'https://login.example.com' } });
      session.cancel();
      expect(isSecretPage(url)).toBe(true);
    } finally {
      session.cancel();
      clearSecretPages();
    }
  });

  // Unit: static validation text can shift AX refs after the first fill. Keep
  // stable targets usable, but do not confuse a removed/replaced field with a shift.
  it.each(['dom', 'stale-dom', 'fingerprint', 'replaced', 'removed'])('handles a static-node insertion using %s identity', async (mode) => {
    const page = loginPage();
    const read = page.driver.snapshot;
    let changed = false;
    let lateShift = false;
    page.driver.snapshot = async (...args) => {
      const raw = await read(...args);
      if ('error' in raw) return raw;
      const offset = changed ? (lateShift ? 2 : 1) : 0;
      raw.nodes = [raw.nodes[0],
        ...(changed ? [node('0.0', 'AXStaticText', { value: 'Looks good', frame: [10, 20, 100, 20] })] : []),
        ...(lateShift ? [node('0.1', 'AXStaticText', { value: 'Still checking', frame: [200, 20, 100, 20] })] : []),
        ...['First name', 'Last name'].flatMap((label, i) => changed && mode === 'removed' && i === 1 ? [] : [
          node(`0.${offset + i * 2}`, 'AXStaticText', { value: label, frame: [10, 60 + i * 80, 100, 20] }),
          node(`0.${offset + i * 2 + 1}`, 'AXTextField', {
            ...(mode === 'fingerprint' ? { title: label } : { domId: changed && mode === 'replaced' && i === 1 ? 'replacement' : `name-${i}` }),
            frame: [10, 85 + i * 80, 100, 20],
          }),
        ]), node(`0.${offset + 4}`, 'AXButton', { title: 'Continue' })];
      return raw;
    };
    const act = page.driver.act;
    page.driver.act = async request => {
      // A final shift can happen after sameFields, before the native action.
      if (mode === 'stale-dom' && changed && request.kind === 'text') lateShift = true;
      const raw = await page.driver.snapshot(request.pid, request.window);
      if ('error' in raw || !raw.nodes.some(n => n.ref === request.ref && n.fp === request.fp)) return { error: 'stale' };
      const result = await act(request);
      if (request.kind === 'text') changed = true;
      return result;
    };
    const { session, latest } = start(page.driver);
    await session.start();
    const fields = latest().controls.filter(c => c.kind === 'text');
    await session.submit({ expectedRevision: latest().revision, values: {
      [fields[0].id]: 'Ada', [fields[1].id]: 'Lovelace',
    }, action: { kind: 'submit' } });
    expect(page.acts.map(a => [a.kind, a.ref, a.value])).toEqual(
      mode === 'removed' || mode === 'replaced' ? [['text', '0.1', 'Ada']] :
        [['text', '0.1', 'Ada'], ['text', lateShift ? '0.5' : '0.4', 'Lovelace'], ['press', lateShift ? '0.6' : '0.5', undefined]],
    );
    session.cancel();
  });

  // Unit: native fingerprints omit nearby labels and DOM ids. Existing fixtures
  // all had distinct native titles; equal fingerprints must still fill the right targets.
  it.each([false, true])('distinguishes nearby-labelled fields with equal fingerprints (reordered: %s)', async (reordered) => {
    const page = loginPage();
    const read = page.driver.snapshot;
    let swap = false;
    page.driver.snapshot = async (...args) => {
      const raw = await read(...args);
      if ('error' in raw) return raw;
      const labels = swap ? ['Last name', 'First name'] : ['First name', 'Last name'];
      raw.nodes = [raw.nodes[0], ...labels.flatMap((label, i) => [
        node(`0.${i * 2}`, 'AXStaticText', { value: label, frame: [10, 60 + i * 80, 100, 20] }),
        node(`0.${i * 2 + 1}`, 'AXTextField', { frame: [10, 85 + i * 80, 100, 20] }),
      ]), node('0.4', 'AXButton', { title: 'Continue' })];
      return raw;
    };
    const { session, latest } = start(page.driver);
    await session.start();
    const fields = latest().controls.filter(c => c.kind === 'text');
    expect(fields.map(c => c.label)).toEqual(['First name', 'Last name']);
    swap = reordered;
    await session.submit({ expectedRevision: latest().revision, values: {
      [fields[0].id]: 'Ada', [fields[1].id]: 'Lovelace',
    }, action: { kind: 'submit' } });
    expect(page.acts.filter(a => a.kind === 'text').map(a => [a.ref, a.value])).toEqual(
      reordered ? [] : [['0.1', 'Ada'], ['0.3', 'Lovelace']],
    );
    session.cancel();
  });

  // Unit regression: a logical password plan can upgrade a custom text field.
  // Existing tests only use native secure fields; submit must still fill and shield this field.
  it('submits a planned password in a native plain field', async () => {
    const page = loginPage('--remote-debugging-port=9222');
    const read = page.driver.snapshot;
    page.driver.snapshot = async (...args) => {
      const raw = await read(...args);
      if (!('error' in raw)) for (const field of raw.nodes) {
        if (field.title === 'Password') { delete field.subrole; delete field.secure; }
      }
      return raw;
    };
    const entered: unknown[] = [];
    const { session, latest } = start(page.driver, target => entered.push(target), [
      { label: 'Account', contentType: 'username', targets: [{ label: 'Email' }] },
      { label: 'Password', contentType: 'password', targets: [{ label: 'Password' }] },
    ]);
    await session.start();
    expect(latest().controls).toEqual(expect.arrayContaining([expect.objectContaining({ contentType: 'password' })]));
    await session.submit(answer(latest()));
    expect(page.acts.filter(a => a.kind === 'text').map(a => a.value)).toEqual(['someone@example.test', 'synthetic-pass']);
    expect(entered.length).toBeGreaterThan(0);
    session.cancel();
  });

  // Unit regression: old structure must not receive values after dynamic fields appear.
  // Existing origin-change tests keep the same fields; this changes them on the same page.
  it.each(['before', 'during'])('does not submit a form changed %s filling', async (when) => {
    const page = loginPage();
    const read = page.driver.snapshot;
    let changed = false;
    page.driver.snapshot = async (...args) => {
      const raw = await read(...args);
      if (!('error' in raw) && changed) raw.nodes.push(node('0.4', 'AXTextField', { title: 'New required key', required: true }));
      return raw;
    };
    const act = page.driver.act;
    page.driver.act = async (request) => {
      const result = await act(request);
      changed = true;
      return result;
    };
    const { session, latest } = start(page.driver);
    await session.start();
    const submission = answer(latest());
    changed = when === 'before';
    await session.submit(submission);
    expect(page.acts.map(a => a.kind)).toEqual(when === 'before' ? [] : ['text']);
    expect(submission.values).toEqual({});
    session.cancel();
  });

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

  // Unit: a page may navigate after the username input; the password must not follow it.
  it('checks the destination again between account and password', async () => {
    const page = loginPage();
    const act = page.driver.act;
    page.driver.act = async (request) => {
      const result = await act(request);
      if (request.kind === 'text') page.navigate('https://other.example/signin');
      return result;
    };
    const { session, latest } = start(page.driver);
    await session.start();
    await session.submit(answer(latest()));
    expect(page.acts.filter((a) => a.kind === 'text').map((a) => a.value)).toEqual(['someone@example.test']);
    expect(latest().failure).toBe('origin_changed');
    session.cancel();
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

// Unit: submission must distribute one owner code, never submit a partial code,
// and abort if origin changes between segments. Existing tests only fill whole fields.
describe('split code submission', () => {
  const plan: HandoffSessionOptions['fields'] = [{ label: 'Code', contentType: 'one-time-code', targets: [
    { label: 'User code 0', length: 1 }, { label: 'User code 2', length: 1 },
  ] }];
  function setup(changeOrigin = false, nextField?: string, advanceAfter = '0.2') {
    let advanced = false;
    const page = loginPage();
    const original = page.driver.snapshot;
    page.driver.snapshot = async (...args) => {
      const raw = await original(...args);
      if ('error' in raw) return raw;
      raw.nodes = advanced ? [raw.nodes[0], node('0.4', 'AXTextField', { title: nextField, secure: nextField === 'Password' }),
        node('0.5', 'AXButton', { title: 'Continue' })] : [raw.nodes[0], node('0.0', 'AXTextField', { title: 'User code 0' }),
        node('0.2', 'AXTextField', { title: 'User code 2' }), node('0.3', 'AXButton', { title: 'Continue' })];
      return raw;
    };
    const act = page.driver.act;
    page.driver.act = async (request) => {
      const result = await act(request);
      if (changeOrigin && request.kind === 'text') page.navigate('https://other.example/');
      if (nextField && request.kind === 'text' && request.ref === advanceAfter) advanced = true;
      return result;
    };
    return { ...page, ...start(page.driver, undefined, plan) };
  }
  it.each([['AB', ['A', 'B']], ['A', []]])('fills only complete codes: %s', async (value, expected) => {
    const run = setup();
    await run.session.start();
    const step = run.latest();
    expect(step.controls).toHaveLength(1);
    const values = { [step.controls[0].id]: value };
    await run.session.submit({ expectedRevision: step.revision, values, action: { kind: 'submit' } });
    expect(run.acts.filter((a) => a.kind === 'text').map((a) => a.value)).toEqual(expected);
    expect(values).toEqual({});
    if (!expected.length) expect(run.acts).toHaveLength(0);
    run.session.cancel();
  });
  // Unit/regression #11083: the previous split-code fixture never auto-submitted.
  // Two filled cells replacing themselves at the same URL/title must finish a
  // sign-in or show its next private field, without pressing the old action.
  it.each(['Message', 'Password'])('handles automatic advance to %s after the whole code', async (nextField) => {
    const run = setup(false, nextField);
    try {
      await run.session.start();
      const step = run.latest();
      await run.session.submit({ expectedRevision: step.revision, values: { [step.controls[0].id]: 'AB' }, action: { kind: 'submit' } });
      expect(run.acts.map(({ kind, value }) => ({ kind, value }))).toEqual([
        { kind: 'text', value: 'A' }, { kind: 'text', value: 'B' },
      ]);
      expect(run.latest().failure).toBeUndefined();
      expect(run.latest().phase).toBe(nextField === 'Message' ? 'finishing' : 'ready');
      expect(run.latest().controls.filter(control => control.kind === 'text').map(control => control.label)).toEqual(nextField === 'Message' ? [] : ['Password']);
    } finally { run.session.cancel(); }
  });
  it('does not treat a changed form after only the first cell as completed input', async () => {
    const run = setup(false, 'Password', '0.0');
    try {
      await run.session.start();
      const step = run.latest();
      await run.session.submit({ expectedRevision: step.revision, values: { [step.controls[0].id]: 'AB' }, action: { kind: 'submit' } });
      expect(run.acts.map(a => a.value)).toEqual(['A']);
      expect(run.latest()).toMatchObject({ phase: 'ready', failure: 'action_failed' });
    } finally { run.session.cancel(); }
  });
  it('stops before the second character when the page changes origin', async () => {
    const run = setup(true);
    await run.session.start();
    const step = run.latest();
    await run.session.submit({ expectedRevision: step.revision, values: { [step.controls[0].id]: 'AB' }, action: { kind: 'submit' } });
    expect(run.acts.map((a) => a.value)).toEqual(['A']);
    run.session.cancel();
  });
});
