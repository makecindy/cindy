import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InputHandoffSnapshot } from '@cindy/device-link';
import {
  inputHandoffRecordMessage,
  parseInputHandoffEndRecord,
  UI_ACTION_TRIGGER_PREFIX,
} from '@cindy/maker-shared/synthetic-trigger';
import { INPUT_HANDOFF_MAX_PER_TASK, InputHandoffService, buildInputHandoffContinuation, type InputHandoffServiceDeps } from '../service.js';
import { readInputHandoffSetting } from '../botPolicy.js';
import { fakeDesktop, type FakeStage } from './fakeDesktop.js';

const services: InputHandoffService[] = [];
afterEach(() => services.splice(0).forEach((s) => s.cleanupAll()));

function harness(start?: FakeStage, qrFromPicture?: InputHandoffServiceDeps['qrFromPicture']) {
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
    ...(qrFromPicture ? { qrFromPicture } : {}),
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

// ask_owner (2026-10-30): a target the host cannot use is reported when the agent
// asks, not as target_gone after its turn ended; a QR code in the agent's own
// screenshot (a simulator inside Cindy) is scanned and handed back by the owner.
describe('代输入 requests the agent makes', () => {
  it.each([
    [{ app: 'Cindy' }, 'TARGET_IS_CINDY'],
    [{ pid: 1 }, 'TARGET_IS_CINDY'],
    [{ app: 'Feishu' }, 'TARGET_NOT_FOUND'],
    [{ app: 'Example' }, null],
  ] as const)('checks target %j before starting', async (target, errorCode) => {
    const problem = await harness().service.checkTarget(target);
    expect(problem?.errorCode ?? null).toBe(errorCode);
    if (errorCode === 'TARGET_NOT_FOUND') expect(problem!.message).toContain('Example, Google Chrome');
    if (errorCode === 'TARGET_IS_CINDY') expect(problem!.message).toContain('kind="scan"');
  });

  it('closes a waiting card when the owner writes in the task, without a second turn, and tells the agent once', async () => {
    const h = harness();
    await startReady(h);
    h.service.dismissForOwnerMessage('task');
    expect(h.latest()).toMatchObject({ phase: 'cancelled', terminal: true });
    expect(h.continued).toEqual([]);
    // A refused steer falls back to a normal send: the note stays until it is delivered.
    expect(h.service.ownerMessageNote('task')).toContain('owner sent the message');
    expect(h.service.ownerMessageNote('task')).toContain('owner sent the message');
    h.service.ownerMessageNoteDelivered('task');
    expect(h.service.ownerMessageNote('task')).toBeNull();
    // Nothing was waiting: nothing to say.
    h.service.dismissForOwnerMessage('task');
    expect(h.service.ownerMessageNote('task')).toBeNull();
  });

  it('leaves a terminal prompt to the owner when they write: its command would fail', async () => {
    const h = harness();
    const answers: Array<string | null> = [];
    const started = h.service.startTerminalPrompt({
      sessionId: 'task', prompt: 'Password:', program: 'sudo', command: 'sudo ls', answer: (value) => answers.push(value),
    });
    if (!started.ok) throw new Error(started.errorCode);
    h.service.dismissForOwnerMessage('task');
    expect(answers).toEqual([]);
    expect(h.service.ownerMessageNote('task')).toBeNull();
    started.abandon?.();
  });

  it('replaces a waiting card when the agent asks again, but not a terminal prompt', async () => {
    const h = harness();
    const first = await startReady(h);
    const second = await startReady(h);
    expect(second).not.toBe(first);
    expect(h.continued).toEqual([]);
    expect(h.service.pendingSnapshots('task').map((entry) => entry.request.requestId)).toEqual([second]);

    const answers: Array<string | null> = [];
    const prompt = h.service.startTerminalPrompt({
      sessionId: 'shell', prompt: 'Password:', program: 'sudo', command: 'sudo ls', answer: (value) => answers.push(value),
    });
    if (!prompt.ok) throw new Error(prompt.errorCode);
    expect(h.service.start({ sessionId: 'shell', purpose: 'Sign in', target: { app: 'Example' } })).toMatchObject({ ok: false, errorCode: 'HANDOFF_ACTIVE' });
    prompt.abandon?.();
  });

  it('asks for a window title when the windows are spread over several processes of one app', async () => {
    const h = harness();
    const shown = { frame: [0, 0, 800, 600], focused: true, minimized: false };
    h.desktop.driver.windows = async () => ({ frontmost: 5, apps: [
      { pid: 5, app: 'Google Chrome', bundleId: 'com.google.Chrome', windows: [{ ...shown, index: 0, title: 'Home' }] },
      { pid: 6, app: 'Google Chrome', bundleId: 'com.google.Chrome', windows: [{ ...shown, index: 0, title: 'Sign in' }] },
    ] });
    expect((await h.service.checkTarget({ app: 'Google Chrome' }))?.errorCode).toBe('TARGET_AMBIGUOUS');
    expect(await h.service.checkTarget({ pid: 6 })).toBeNull();
    expect(await h.service.checkTarget({ app: 'Google Chrome', windowTitle: 'Sign in' })).toBeNull();
  });

  it('asks the agent to name a window instead of guessing among several', async () => {
    const h = harness();
    const shown = { frame: [0, 0, 800, 600], focused: false, minimized: false };
    h.desktop.driver.windows = async () => ({ frontmost: 5, apps: [
      { pid: 5, app: 'Google Chrome', bundleId: 'com.google.Chrome', windows: [
        { ...shown, index: 0, title: 'Home', focused: true }, { ...shown, index: 1, title: 'App Store Connect', minimized: true },
      ] },
    ] });
    const problem = await h.service.checkTarget({ app: 'Google Chrome' });
    expect(problem?.errorCode).toBe('TARGET_AMBIGUOUS');
    expect(problem?.message).toContain('"App Store Connect"');
    expect(await h.service.checkTarget({ app: 'Google Chrome', windowTitle: 'App Store Connect' })).toBeNull();
    // A name that matches nothing is reported, not answered with whichever window has focus.
    const missing = await h.service.checkTarget({ app: 'Google Chrome', windowTitle: 'Gone' });
    expect(missing?.errorCode).toBe('TARGET_NOT_FOUND');
    expect(missing?.message).toContain('"Home"');
  });

  // Seen in a real run: a Chinese desktop lists Finder as 访达, and a dev build
  // runs as Electron, so "Finder" and "Cindy" both came back TARGET_NOT_FOUND.
  it('finds an app named in English on a localized desktop and knows a dev build is Cindy', async () => {
    const h = harness();
    const shown = { index: 0, title: '', frame: [0, 0, 800, 600], focused: true, minimized: false };
    h.desktop.driver.windows = async () => ({ frontmost: 5, apps: [
      { pid: 5, app: '访达', bundleId: 'com.apple.finder', windows: [shown] },
      { pid: 1, app: 'Electron', bundleId: 'com.github.Electron', windows: [shown] },
    ] });
    expect(await h.service.checkTarget({ app: 'Finder' })).toBeNull();
    expect((await h.service.checkTarget({ app: 'Cindy' }))?.errorCode).toBe('TARGET_IS_CINDY');
  });

  it('scans a code from the agent\'s screenshot, shows where it leads, and hands back on the owner\'s word', async () => {
    const h = harness(undefined, async () => ({ text: 'https://passport.feishu.cn/qr/abc', jpeg: Buffer.from('jpeg'), width: 8, height: 8 }));
    const started = await h.service.startImageQr({ sessionId: 'task', purpose: 'Scan to sign in', image: Buffer.from('png') });
    if (!started.ok) throw new Error(started.errorCode);
    const card = h.latest();
    expect(card).toMatchObject({
      phase: 'ready', picture: true, qr: 'scan', agentPicture: true, agentControlled: true, controls: [],
      source: { app: 'Cindy', origin: 'https://passport.feishu.cn' },
    });
    expect(h.notified).toHaveLength(1);
    expect(h.service.picture(started.requestId, card.revision)?.qr).toEqual({ text: 'https://passport.feishu.cn/qr/abc', url: 'https://passport.feishu.cn/qr/abc' });
    // Nothing on the agent's screen can be tapped or typed into from here.
    expect(await h.service.submit(started.requestId, { expectedRevision: card.revision, values: {}, action: { kind: 'tap', x: 0.5, y: 0.5 } })).toBe(false);
    h.service.resolve(started.requestId, { kind: 'input_handoff', action: 'done', expectedRevision: card.revision }, { deviceId: 'phone-1' });
    await vi.waitFor(() => expect(h.continued).toHaveLength(1));
    expect(h.continued[0]).toContain('status=succeeded');
    expect(h.continued[0]).toContain('scanned the code');
    expect(h.continued[0]).not.toContain('/qr/abc');
  });

  it.each([
    [null, 'NO_QR_FOUND'],
    [{ error: 'not_image' as const }, 'NOT_AN_IMAGE'],
    [{ error: 'unreadable' as const }, 'QR_UNREADABLE'],
    [undefined, 'UNSUPPORTED'],
  ])('refuses a screenshot it cannot use (%j) without showing anything', async (found, errorCode) => {
    const h = harness(undefined, found === undefined ? undefined : async () => found);
    expect(await h.service.startImageQr({ sessionId: 'task', purpose: 'Scan', image: Buffer.from('png') }))
      .toMatchObject({ ok: false, errorCode });
    expect(h.snapshots).toEqual([]);
    expect(h.notified).toEqual([]);
  });

  // PR #8083 review: closing the task while the picture is read must not pop a card later.
  it('shows nothing when the task closes while the screenshot is being read', async () => {
    let decoded!: (value: { text: string; jpeg: Buffer; width: number; height: number }) => void;
    const h = harness(undefined, () => new Promise((resolve) => { decoded = resolve; }));
    const pending = h.service.startImageQr({ sessionId: 'task', purpose: 'Scan', image: Buffer.from('png') });
    await vi.waitFor(() => expect(decoded).toBeTypeOf('function'));
    h.service.cleanupForSession('task');
    const jpeg = Buffer.from('jpeg');
    decoded({ text: 'https://passport.feishu.cn/qr/abc', jpeg, width: 8, height: 8 });
    expect(await pending).toMatchObject({ ok: false, errorCode: 'NO_SESSION_CONTEXT' });
    expect(h.snapshots).toEqual([]);
    expect(h.notified).toEqual([]);
    expect(jpeg.every((byte) => byte === 0)).toBe(true);
  });

  // PR #8083 review: once a device takes over, a decision sent against the earlier revision is stale.
  it('refuses a stale decision from before another device took over the scan', async () => {
    const h = harness(undefined, async () => ({ text: 'https://passport.feishu.cn/qr/abc', jpeg: Buffer.from('jpeg'), width: 8, height: 8 }));
    const started = await h.service.startImageQr({ sessionId: 'task', purpose: 'Scan', image: Buffer.from('png') });
    if (!started.ok) throw new Error(started.errorCode);
    const before = h.latest().revision;
    h.service.resolve(started.requestId, { kind: 'input_handoff', action: 'claim', expectedRevision: before }, { deviceId: 'phone-1' });
    await vi.waitFor(() => expect(h.latest().holder).toMatchObject({ deviceId: 'phone-1' }));
    h.service.resolve(started.requestId, { kind: 'input_handoff', action: 'cancel', expectedRevision: before }, { local: true });
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.service.isCurrent(started.requestId)).toBe(true);
    expect(h.continued).toEqual([]);
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
