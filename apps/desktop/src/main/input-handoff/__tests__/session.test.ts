import { describe, expect, it, vi } from 'vitest';
import type { InputHandoffSnapshot } from '@cindy/device-link';
import { InputHandoffSession, type HandoffResult } from '../session.js';
import type { HandoffDriver } from '../macDriver.js';
import { fakeDesktop } from './fakeDesktop.js';

function harness(driver: HandoffDriver, extra: Partial<ConstructorParameters<typeof InputHandoffSession>[0]> = {}) {
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
    driver,
    publish: (snapshot) => published.push(snapshot),
    finish: (result) => finished.push(result),
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    finishingDelayMs: 5,
    ...extra,
  });
  const latest = () => published[published.length - 1];
  return { session, published, finished, latest };
}

const field = (step: InputHandoffSnapshot) => step.controls.find((control) => control.kind === 'text')!;

describe('InputHandoffSession', () => {
  it('asks only for the fields to type, confirms with the page button and follows the flow across apps', async () => {
    const desktop = fakeDesktop();
    const { session, finished, latest } = harness(desktop.driver);
    await session.start();
    let step = latest();
    expect(step.phase).toBe('ready');
    // Only the field: the page's Next button is Cindy's to press.
    expect(step.controls).toEqual([{ id: expect.any(String), kind: 'text', label: 'Email', contentType: 'email' }]);
    expect(await session.submit({ expectedRevision: step.revision, values: { [field(step).id]: 'owner@example.test' }, action: { kind: 'submit' } })).toBe(true);
    expect(desktop.acts.map((act) => act.kind)).toEqual(['text', 'press']);

    step = latest();
    expect(step.stepNumber).toBe(2);
    expect(step.source).toMatchObject({ app: 'Google Chrome', origin: 'https://auth.example.com' });
    expect(step.controls.map((control) => control.kind)).toEqual(['text']);
    await session.submit({ expectedRevision: step.revision, values: { [field(step).id]: 'synthetic-secret' }, action: { kind: 'submit' } });

    // The consent page has only buttons: nothing left for the owner, so it is handed back.
    expect(latest().phase).toBe('finishing');
    await vi.waitFor(() => expect(finished).toHaveLength(1));
    expect(finished[0]).toMatchObject({ status: 'succeeded', reason: 'detected', steps: 2, finalApp: 'Google Chrome' });
    expect(desktop.stage()).toBe('consent');
    expect(latest()).toMatchObject({ phase: 'succeeded', terminal: true });
    expect(JSON.stringify([finished, latest()])).not.toMatch(/owner@example|synthetic-secret/);
  });

  it('stays on a form that still asks when the owner switches to an app they already had open', async () => {
    const desktop = fakeDesktop({ rejects: true });
    const { session, finished, latest } = harness(desktop.driver);
    await session.start();
    const step = latest();
    const press = desktop.driver.act;
    desktop.driver.act = async (request) => {
      const result = await press(request);
      if (request.kind === 'press') desktop.switchToBrowser();
      return result;
    };
    await session.submit({ expectedRevision: step.revision, values: { [field(step).id]: 'owner@example.test' }, action: { kind: 'submit' } });
    expect(finished).toHaveLength(0);
    expect(latest()).toMatchObject({ phase: 'ready', source: { app: 'Example' } });
    expect(latest().controls.map((control) => control.kind)).toEqual(['text']);
  });

  it('never types for a request that ended while it waited for the desktop', async () => {
    // The first handoff holds the desktop; the second queues behind it and is cancelled meanwhile.
    const first = fakeDesktop();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const act = first.driver.act;
    first.driver.act = async (request) => {
      await held;
      return act(request);
    };
    const a = harness(first.driver);
    const second = fakeDesktop();
    const b = harness(second.driver, { requestId: 'req2' });
    await a.session.start();
    await b.session.start();
    const stepA = a.latest();
    const stepB = b.latest();
    const runningA = a.session.submit({ expectedRevision: stepA.revision, values: { [field(stepA).id]: 'owner@example.test' }, action: { kind: 'submit' } });
    const values = { [field(stepB).id]: 'other@example.test' };
    const queuedB = b.session.submit({ expectedRevision: stepB.revision, values, action: { kind: 'submit' } });
    await vi.waitFor(() => expect(b.latest().phase).toBe('working'));
    b.session.cancel();
    release();
    await Promise.all([runningA, queuedB]);
    expect(second.acts).toEqual([]);
    expect(b.finished[0]).toMatchObject({ status: 'cancelled' });
    // The values of the ended request are dropped, not kept for later.
    expect(values).toEqual({});
  });

  it('ends as screen_locked when the screen locks after the card opened', async () => {
    const desktop = fakeDesktop();
    const { session, finished, latest } = harness(desktop.driver);
    await session.start();
    const step = latest();
    const act = desktop.driver.act;
    let locked = false;
    desktop.driver.act = async (request) => {
      const result = await act(request);
      if (request.kind === 'press') locked = true;
      return result;
    };
    const windows = desktop.driver.windows;
    desktop.driver.windows = async () => {
      if (locked) throw new Error('locked');
      return windows();
    };
    const snapshot = desktop.driver.snapshot;
    desktop.driver.snapshot = async (pid, window) => (locked ? { error: 'locked' } : snapshot(pid, window));
    await session.submit({ expectedRevision: step.revision, values: { [field(step).id]: 'owner@example.test' }, action: { kind: 'submit' } });
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ status: 'failed', failure: 'screen_locked' });
    expect(latest()).toMatchObject({ terminal: true });
  });

  it('ends at once when the screen has nothing to type', async () => {
    const desktop = fakeDesktop({ start: 'choose' });
    const { session, finished, published } = harness(desktop.driver);
    await session.start();
    expect(finished[0]).toMatchObject({ status: 'cancelled', reason: 'detected', failure: 'nothing_to_fill', steps: 0 });
    // The radio buttons and Continue never reached the owner.
    expect(published.every((snapshot) => snapshot.controls.length === 0)).toBe(true);
    expect(desktop.acts).toEqual([]);
  });

  it('presses Return in the last field when the page has no main button', async () => {
    const desktop = fakeDesktop();
    const driver: HandoffDriver = {
      ...desktop.driver,
      snapshot: async (pid, window) => {
        const raw = await desktop.driver.snapshot(pid, window);
        return 'nodes' in raw ? { ...raw, nodes: raw.nodes.filter((n) => n.role !== 'AXButton') } : raw;
      },
    };
    const { session, latest } = harness(driver);
    await session.start();
    const step = latest();
    await session.submit({ expectedRevision: step.revision, values: { [field(step).id]: 'owner@example.test' }, action: { kind: 'submit' } });
    expect(desktop.acts.map((act) => [act.kind, act.value === 'return' ? 'return' : undefined])).toEqual([['text', undefined], ['key', 'return']]);
  });

  it('rejects stale or foreign submissions', async () => {
    const { session, latest } = harness(fakeDesktop().driver);
    await session.start();
    const step = latest();
    const submit = { kind: 'submit' } as const;
    expect(await session.submit({ expectedRevision: step.revision - 1, values: {}, action: submit })).toBe(false);
    expect(await session.submit({ expectedRevision: step.revision, values: { nope: 'x' }, action: submit })).toBe(false);
    // Typing without confirming belongs to screenshot steps only.
    expect(await session.submit({ expectedRevision: step.revision, values: { [field(step).id]: 'x' }, action: { kind: 'fill' } })).toBe(false);
  });

  it('lets the owner stay, hand back or cancel', async () => {
    const desktop = fakeDesktop({ start: 'password' });
    const { session, finished, latest } = harness(desktop.driver, { finishingDelayMs: 60_000, target: { app: 'Google Chrome' } });
    await session.start();
    const step = latest();
    await session.submit({ expectedRevision: step.revision, values: { [field(step).id]: 'synthetic-secret' }, action: { kind: 'submit' } });
    expect(latest().phase).toBe('finishing');
    expect(await session.decide({ kind: 'input_handoff', action: 'stay', expectedRevision: latest().revision })).toBe(true);
    expect(latest()).toMatchObject({ phase: 'ready', controls: [] });
    expect(await session.decide({ kind: 'input_handoff', action: 'done', expectedRevision: latest().revision })).toBe(true);
    expect(finished[0]).toMatchObject({ status: 'succeeded', reason: 'owner' });
    expect(await session.decide({ kind: 'input_handoff', action: 'cancel', expectedRevision: latest().revision })).toBe(false);
  });

  it('hands back once only a search box is left', async () => {
    const desktop = fakeDesktop({ start: 'done' });
    const { session, finished } = harness(desktop.driver);
    await session.start();
    expect(finished[0]).toMatchObject({ failure: 'nothing_to_fill' });
  });

  it('fails clearly without accessibility permission or target', async () => {
    const desktop = fakeDesktop();
    const noPermission = harness({ ...desktop.driver, permission: async () => 'missing' });
    await noPermission.session.start();
    expect(noPermission.finished[0]).toMatchObject({ status: 'failed', failure: 'permission' });
    const noTarget = harness(desktop.driver, { target: { app: 'Missing App' } });
    await noTarget.session.start();
    expect(noTarget.finished[0]).toMatchObject({ status: 'failed', failure: 'target_gone' });
    const host = harness(desktop.driver, { target: { pid: 1 } });
    await host.session.start();
    expect(host.finished[0]).toMatchObject({ status: 'failed', failure: 'target_gone' });
  });

  it('flags agent-controlled browsers', async () => {
    const desktop = fakeDesktop();
    const { session, latest } = harness({ ...desktop.driver, commandLine: async () => 'Chromium --remote-debugging-port=9222' });
    await session.start();
    expect(latest().agentControlled).toBe(true);
  });
});
