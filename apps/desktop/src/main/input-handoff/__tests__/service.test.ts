import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InputHandoffSnapshot } from '@cindy/device-link';
import {
  inputHandoffRecordMessage,
  parseInputHandoffEndRecord,
  UI_ACTION_TRIGGER_PREFIX,
} from '@cindy/maker-shared/synthetic-trigger';
import { INPUT_HANDOFF_MAX_PER_TASK, InputHandoffService, buildInputHandoffContinuation } from '../service.js';
import { readInputHandoffSetting } from '../botPolicy.js';
import { fakeDesktop, type FakeStage } from './fakeDesktop.js';

const services: InputHandoffService[] = [];
afterEach(() => services.splice(0).forEach((s) => s.cleanupAll()));

function harness(start?: FakeStage) {
  const desktop = fakeDesktop({ start });
  const snapshots: InputHandoffSnapshot[] = [];
  const continued: string[] = [];
  const notified: InputHandoffSnapshot[] = [];
  let clock = 0;
  const service = new InputHandoffService({
    broadcast: (_channel, payload) => {
      const request = (payload as { request?: InputHandoffSnapshot }).request;
      if (request) snapshots.push(request);
    },
    createDriver: () => desktop.driver,
    hostPid: 1,
    remoteInputAvailable: () => true,
    continueAgent: async (_session, _request, message) => {
      continued.push(message);
    },
    notifyOwner: (_session, snapshot) => notified.push(snapshot),
    describeDevice: (deviceId) => (deviceId === 'phone-1' ? { name: 'Synthetic Phone', platform: 'mobile' } : {}),
    terminalRetentionMs: 0,
    sessionTiming: { now: () => clock, sleep: async (ms) => { clock += ms; }, finishingDelayMs: 5 },
  });
  services.push(service);
  const latest = () => snapshots[snapshots.length - 1];
  return { desktop, service, snapshots, latest, continued, notified, advance: (ms: number) => { clock += ms; } };
}

async function startReady(h: ReturnType<typeof harness>, sessionId = 'task') {
  const started = h.service.start({ sessionId, purpose: 'Sign in to Example', note: 'Not sure which option', target: { app: 'Example' } });
  if (!started.ok) throw new Error(started.errorCode);
  await vi.waitFor(() => expect(h.latest()?.phase).toBe('ready'));
  return started.requestId;
}

describe('代输入 owner controls', () => {
  it('shows the agent note and records which device holds the handoff', async () => {
    const h = harness();
    const requestId = await startReady(h);
    expect(h.latest().note).toBe('Not sure which option');
    expect(h.latest().holder).toBeUndefined();

    const before = h.latest().revision;
    expect(h.service.resolve(requestId, { kind: 'input_handoff', action: 'claim', expectedRevision: before }, { deviceId: 'phone-1' })).toBe(true);
    await vi.waitFor(() => expect(h.latest().holder).toEqual({ deviceId: 'phone-1', name: 'Synthetic Phone', platform: 'mobile' }));
    // Taking over invalidates an answer another device prepared for the previous revision.
    expect(h.latest().revision).toBeGreaterThan(before);

    const step = h.latest();
    const email = step.controls.find((c) => c.kind === 'text')!;
    const submit = { kind: 'submit' } as const;
    expect(await h.service.submit(requestId, { expectedRevision: before, values: { [email.id]: 'owner@example.test' }, action: submit })).toBe(false);

    // The host Desktop takes it back by answering.
    expect(await h.service.submit(requestId, { expectedRevision: step.revision, values: { [email.id]: 'owner@example.test' }, action: submit })).toBe(true);
    await vi.waitFor(() => expect(h.latest().stepNumber).toBe(2));
    expect(h.latest().holder).toEqual({ local: true });
  });

  it('keeps a fast answer from the device whose first keystroke claimed the screen', async () => {
    const h = harness();
    const requestId = await startReady(h);
    const before = h.latest();
    const email = before.controls.find((c) => c.kind === 'text')!;
    const answer = { expectedRevision: before.revision, values: { [email.id]: 'owner@example.test' }, action: { kind: 'submit' } as const };
    // A password manager fills and submits before the claim's new revision reaches the phone.
    expect(h.service.resolve(requestId, { kind: 'input_handoff', action: 'claim', expectedRevision: before.revision }, { deviceId: 'phone-1' })).toBe(true);
    expect(h.service.actionable(requestId, before.revision)?.revision).toBe(before.revision);
    expect(await h.service.submit(requestId, answer, { deviceId: 'phone-1' })).toBe(true);
    await vi.waitFor(() => expect(h.latest().stepNumber).toBe(2));
  });

  it('turns the end into a value-free record line naming the answering device', async () => {
    const h = harness();
    const requestId = await startReady(h);
    const step = h.latest();
    const email = step.controls.find((c) => c.kind === 'text')!;
    await h.service.submit(requestId, { expectedRevision: step.revision, values: { [email.id]: 'owner@example.test' }, action: { kind: 'submit' } }, { deviceId: 'phone-1' });
    await vi.waitFor(() => expect(h.latest().stepNumber).toBe(2));
    h.service.resolve(requestId, { kind: 'input_handoff', action: 'done', expectedRevision: h.latest().revision });
    await vi.waitFor(() => expect(h.continued).toHaveLength(1));

    const record = parseInputHandoffEndRecord(`${UI_ACTION_TRIGGER_PREFIX}${h.continued[0]}`)!;
    expect(record).toMatchObject({ status: 'succeeded', nothingToFill: false, steps: 1, answeredOn: { kind: 'named', name: 'Synthetic Phone' } });
    expect(inputHandoffRecordMessage(record)).toEqual({ key: 'doneOn', params: { count: 1, device: 'Synthetic Phone' } });
    expect(h.continued[0]).not.toContain('owner@example');
  });

  it('never shows a card or pages the owner when there is nothing to type', async () => {
    const h = harness('choose');
    const started = h.service.start({ sessionId: 'task', purpose: 'Sign in to Example', target: { app: 'Example' } });
    expect(started.ok).toBe(true);
    await vi.waitFor(() => expect(h.continued).toHaveLength(1));
    expect(h.snapshots).toEqual([]);
    expect(h.notified).toEqual([]);
    expect(h.continued[0]).toContain('failure=nothing_to_fill');
    const record = parseInputHandoffEndRecord(`${UI_ACTION_TRIGGER_PREFIX}${h.continued[0]}`)!;
    expect(record).toMatchObject({ nothingToFill: true });
    expect(inputHandoffRecordMessage(record)).toEqual({ key: 'nothingToFill' });
  });

  it('pages the owner once the fields are ready', async () => {
    const h = harness();
    await startReady(h);
    expect(h.notified).toHaveLength(1);
    expect(h.notified[0].phase).toBe('ready');
  });

  it('limits how often one task can page the owner', async () => {
    const h = harness();
    for (let i = 0; i < INPUT_HANDOFF_MAX_PER_TASK; i++) {
      const requestId = await startReady(h);
      h.service.resolve(requestId, { kind: 'input_handoff', action: 'cancel', expectedRevision: h.latest().revision });
      await vi.waitFor(() => expect(h.continued).toHaveLength(i + 1));
    }
    expect(h.service.start({ sessionId: 'task', purpose: 'Again', target: { app: 'Example' } })).toMatchObject({ ok: false, errorCode: 'RATE_LIMITED' });
    h.advance(60 * 60_000);
    expect(h.service.start({ sessionId: 'task', purpose: 'Later', target: { app: 'Example' } }).ok).toBe(true);
  });
});

describe('代输入 continuation for the agent', () => {
  it('asks the owner to unlock a locked computer instead of retrying on its own', () => {
    const text = buildInputHandoffContinuation({ status: 'failed', reason: 'failure', steps: 0, failure: 'screen_locked' });
    expect(text).toContain('failure=screen_locked');
    expect(text).toContain('only after they say it is unlocked');
  });
});

describe('teammate 代输入 setting', () => {
  it('is on unless the owner explicitly turned it off', () => {
    expect(readInputHandoffSetting('{}')).toBe(true);
    expect(readInputHandoffSetting('{"inputHandoff":true}')).toBe(true);
    expect(readInputHandoffSetting('{"inputHandoff":false}')).toBe(false);
    expect(readInputHandoffSetting('not json')).toBe(true);
  });
});
