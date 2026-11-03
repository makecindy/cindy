import { testOauthSigningKey } from './fixtures.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  INPUT_HANDOFF_ACTION_ID,
  INPUT_HANDOFF_GHOST_ID,
  inputHandoffPresentation,
  type InputHandoffSnapshot,
} from '@cindy/device-link';
import { GhostSetupInteractionBridge } from '../../cindy-brain/ghostSetupInteractionBridge.js';
import { InputHandoffService } from '../../input-handoff/service.js';
import { fakeDesktop } from '../../input-handoff/__tests__/fakeDesktop.js';
import { initializePluginOauthCards } from '../cards.js';
import {
  handleAnswerInputHandoffPicture,
  handleOpenInputHandoffPicture,
  handleSubmitInputHandoff,
  type LocalOauthDeps,
} from '../localIpc.js';
import {
  invalidatePluginOauth,
  publishedPluginOauthIdentity,
  requestPluginOauth,
} from '../runtime.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((f) => f());
  invalidatePluginOauth();
  vi.restoreAllMocks();
});

async function harness(remoteInput = true, pictures = false) {
  const desktop = fakeDesktop({ pictures });
  const snapshots: InputHandoffSnapshot[] = [];
  const continued: string[] = [];
  let clock = 0;
  const service = new InputHandoffService({
    broadcast: (_channel, payload) => {
      const request = (payload as { request?: InputHandoffSnapshot }).request;
      if (request) snapshots.push(request);
    },
    createDriver: () => desktop.driver,
    hostPid: 1,
    remoteInputAvailable: () => remoteInput,
    continueAgent: async (_session, _request, message) => {
      continued.push(message);
    },
    terminalRetentionMs: 0,
    sessionTiming: { now: () => clock, sleep: async (ms) => { clock += ms; }, finishingDelayMs: 5 },
  });
  cleanups.push(() => service.cleanupAll());
  initializePluginOauthCards({
    loadKey: testOauthSigningKey,
    bridge: new GhostSetupInteractionBridge({ broadcast: () => {} }),
    bots: () => null,
    inputHandoff: () => service,
    owner: () => 'membership',
    available: () => true,
    identity: () => ({ deviceId: 'cloud-device', realm: 'global' as const, membershipId: 'membership' }),
  });
  const wire: unknown[] = [];
  const deps: LocalOauthDeps = {
    owner: () => 'membership',
    assertTarget: (device) => {
      if (device !== 'cloud-device') throw new Error('target');
    },
    localDeviceId: () => 'desktop',
    openExternal: async () => {
      throw new Error('No browser for a step form');
    },
    trustIdentity: async () => {},
    identity: async () => {
      const identity = (await publishedPluginOauthIdentity())!;
      const observedAtMs = Date.now();
      return {
        ...identity,
        deviceId: 'cloud-device',
        realm: 'global' as const,
        membershipId: 'membership',
        observedAtMs,
        expiresAtMs: observedAtMs + 60_000,
      };
    },
    invoke: async (_device, _channel, args) => {
      const result = await requestPluginOauth('desktop', args[0]);
      wire.push({ request: args[0], result });
      return { ok: true, result };
    },
  };
  const started = service.start({ sessionId: 'task', purpose: 'Sign in to Example', target: { app: 'Example' } });
  expect(started.ok).toBe(true);
  const latest = () => snapshots[snapshots.length - 1];
  await vi.waitFor(() => expect(latest()?.phase).toBe('ready'));
  const submit = (snapshot: InputHandoffSnapshot, values: Record<string, string>) =>
    handleSubmitInputHandoff(deps, {
      deviceId: 'cloud-device',
      ghostId: INPUT_HANDOFF_GHOST_ID,
      requestId: snapshot.requestId,
      actionId: INPUT_HANDOFF_ACTION_ID,
      expectedRevision: snapshot.revision,
      submission: { expectedRevision: snapshot.revision, values, action: { kind: 'submit' } },
      presentation: inputHandoffPresentation(snapshot),
    });
  return { desktop, service, deps, latest, submit, wire, continued };
}

describe('代输入 over the signed per-step exchange', () => {
  it('applies each step the owner answers from another computer, sealed end to end', async () => {
    const h = await harness();
    let step = h.latest();
    expect(step.remoteInput).toBe(true);
    const email = step.controls.find((c) => c.kind === 'text')!;
    await expect(h.submit(step, { [email.id]: 'owner@example.test' })).resolves.toEqual({ accepted: true });
    await vi.waitFor(() => expect(h.latest().stepNumber).toBe(2));

    step = h.latest();
    expect(step.source.app).toBe('Google Chrome');
    const password = step.controls.find((c) => c.kind === 'text')!;
    await expect(h.submit(step, { [password.id]: 'synthetic-secret' })).resolves.toEqual({ accepted: true });
    expect(h.desktop.acts.filter((act) => act.kind === 'text').map((act) => act.value)).toEqual(['owner@example.test', 'synthetic-secret']);
    // Only sealed boxes cross the wire; the values never appear in plain payloads.
    expect(JSON.stringify(h.wire)).not.toMatch(/owner@example|synthetic-secret/);
    await vi.waitFor(() => expect(h.desktop.stage()).toBe('consent'));
  });

  it('reports success for a terminal password that ended the handoff when it was typed', async () => {
    const h = await harness();
    const answers: Array<string | null> = [];
    const asked = h.service.startTerminalPrompt({
      sessionId: 'other-task',
      prompt: '[sudo] password for someone:',
      program: 'sudo',
      command: 'sudo -A true',
      answer: (value) => answers.push(value),
    });
    expect(asked.ok).toBe(true);
    await vi.waitFor(() => expect(h.latest()).toMatchObject({ source: { app: 'sudo' }, phase: 'ready' }));
    const prompt = h.latest();
    await expect(h.submit(prompt, { answer: 'synthetic-pass' })).resolves.toEqual({ accepted: true });
    expect(answers).toEqual(['synthetic-pass']);
    expect(JSON.stringify(h.wire)).not.toContain('synthetic-pass');
  });

  it('refuses an answer for a screen that has already moved on', async () => {
    const h = await harness();
    const first = h.latest();
    const email = first.controls.find((c) => c.kind === 'text')!;
    await h.submit(first, { [email.id]: 'owner@example.test' });
    await vi.waitFor(() => expect(h.latest().stepNumber).toBe(2));
    await expect(h.submit(first, { [email.id]: 'someone-else@example.test' })).rejects.toThrow();
    expect(h.desktop.stage()).toBe('password');
    expect(h.desktop.acts.filter((act) => act.kind === 'text')).toHaveLength(1);
  });
});

describe('代输入 screenshot step from another computer', () => {
  const target = (snapshot: InputHandoffSnapshot) => ({
    deviceId: 'cloud-device',
    ghostId: INPUT_HANDOFF_GHOST_ID,
    requestId: snapshot.requestId,
    actionId: INPUT_HANDOFF_ACTION_ID,
    expectedRevision: snapshot.revision,
    presentation: inputHandoffPresentation(snapshot),
  });

  async function pictureStep() {
    const h = await harness(true, true);
    const form = h.latest();
    expect(h.service.resolve(form.requestId, { kind: 'input_handoff', action: 'picture', expectedRevision: form.revision })).toBe(true);
    await vi.waitFor(() => expect(h.latest().picture).toBe(true));
    return h;
  }

  it('shows the picture to that window only, sealed on the wire, and applies the tap', async () => {
    const h = await pictureStep();
    const step = h.latest();
    expect(JSON.stringify(step)).not.toContain('picture-of');
    const opened = await handleOpenInputHandoffPicture(h.deps, target(step), 7);
    expect(Buffer.from(opened.picture.data, 'base64').toString()).toBe('picture-of-account');
    expect(JSON.stringify(h.wire)).not.toContain(opened.picture.data);

    // Only the window that opened it can answer.
    const tap = { expectedRevision: step.revision, values: {}, action: { kind: 'tap', x: 0.9, y: 0.9 } };
    await expect(handleAnswerInputHandoffPicture({ token: opened.token, submission: tap }, 8)).resolves.toEqual({ accepted: false });
    await expect(handleAnswerInputHandoffPicture({ token: opened.token, submission: tap }, 7)).resolves.toEqual({ accepted: true });
    expect(h.desktop.pointers[0]).toMatchObject({ kind: 'tap', point: [720, 540] });
    await vi.waitFor(() => expect(h.desktop.stage()).toBe('password'));
    // A used exchange cannot be answered twice.
    await expect(handleAnswerInputHandoffPicture({ token: opened.token, submission: tap }, 7)).resolves.toEqual({ accepted: false });
  });

  it('closes the exchange without touching the target when the owner leaves', async () => {
    const h = await pictureStep();
    const step = h.latest();
    const opened = await handleOpenInputHandoffPicture(h.deps, target(step), 7);
    await expect(handleAnswerInputHandoffPicture({ token: opened.token, submission: null }, 7)).resolves.toEqual({ accepted: false });
    const stale = { expectedRevision: step.revision - 1, values: {}, action: { kind: 'tap', x: 0.5, y: 0.5 } };
    const again = await handleOpenInputHandoffPicture(h.deps, target(step), 7);
    await expect(handleAnswerInputHandoffPicture({ token: again.token, submission: stale }, 7)).resolves.toEqual({ accepted: false });
    expect(h.desktop.pointers).toHaveLength(0);
  });

  it('refuses to open a picture for a form step or a step that moved on', async () => {
    const h = await harness(true, true);
    const form = h.latest();
    await expect(handleOpenInputHandoffPicture(h.deps, target(form), 7)).rejects.toThrow();
    const presentation = { ...inputHandoffPresentation(form), picture: true };
    await expect(handleOpenInputHandoffPicture(h.deps, { ...target(form), presentation }, 7)).rejects.toThrow();
  });
});
