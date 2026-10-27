import { describe, expect, it } from 'vitest';
import type { InputHandoffSnapshot } from '@cindy/device-link';
import { InputHandoffSession, type HandoffResult } from '../session.js';
import type { HandoffDriver } from '../macDriver.js';
import type { NativeAxNode, NativeAxSnapshot, PointerRequest } from '../types.js';


const node = (ref: string, role: string, extra: Partial<NativeAxNode> = {}): NativeAxNode => ({
  ref, role, depth: 1, fp: `${role}|${extra.title ?? ''}`, enabled: true, frame: [150, 100, 100, 20], ...extra,
});

type Stage = 'canvas' | 'password' | 'form' | 'done';

/** A self-drawn sign-in (canvas): nothing to read until the owner gets past it on the picture. */
function canvasDesktop(options: { capture?: boolean; covered?: boolean } = {}) {
  let stage: Stage = 'canvas';
  const pointers: PointerRequest[] = [];
  const jpegs: Buffer[] = [];
  const app = { pid: 10, app: 'Game', bundleId: 'com.example.game' };
  const frame = [100, 50, 800, 600];
  const snapshot = (): NativeAxSnapshot => {
    const base = { ...app, frontmost: true, window: { index: 0, title: 'Game', frame } };
    if (stage === 'form')
      return { ...base, nodes: [node('0', 'AXTextField', { title: 'Nickname' }), node('1', 'AXButton', { title: 'Play' })] };
    if (stage === 'done') return { ...base, nodes: [node('0', 'AXStaticText', { value: 'Welcome' })] };
    return { ...base, nodes: [node('0', 'AXStaticText', { value: 'Sign in' })] };
  };
  const driver: HandoffDriver = {
    permission: async () => 'granted',
    requestPermission: async () => undefined,
    windows: async () => ({
      frontmost: 10,
      apps: [{ ...app, windows: [{ index: 0, title: 'Game', frame, focused: true, minimized: false }] }],
    }),
    snapshot: async () => snapshot(),
    commandLine: async () => '',
    act: async (request) => {
      if (stage === 'form' && request.kind === 'press') stage = 'done';
      return { ok: true };
    },
    ...(options.capture === false
      ? {}
      : {
          capture: async () => {
            const jpeg = Buffer.from(`shot-${stage}`);
            jpegs.push(jpeg);
            return { jpeg, width: 1600, height: 1200, area: frame, windowFrame: frame };
          },
        }),
    focusedField: async () => ({ editable: stage === 'password', secure: stage === 'password' }),
    pointer: async (request) => {
      pointers.push(request);
      if (request.kind === 'tap') {
        if (options.covered) return { error: 'covered' };
        if (stage === 'canvas') stage = 'password';
      } else if (stage === 'password' && request.submit) stage = 'form';
      return { ok: true };
    },
  };
  return { driver, pointers, jpegs, stage: () => stage };
}

function harness(driver: HandoffDriver) {
  const published: InputHandoffSnapshot[] = [];
  const finished: HandoffResult[] = [];
  let clock = 0;
  const session = new InputHandoffSession({
    requestId: 'req1',
    purpose: 'Sign in to Game',
    target: { app: 'Game' },
    timeoutMs: 600_000,
    hostPid: 1,
    remoteInput: true,
    driver,
    publish: (snapshot) => published.push(snapshot),
    finish: (result) => finished.push(result),
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    finishingDelayMs: 5,
  });
  return { session, published, finished, latest: () => published[published.length - 1]! };
}

describe('代输入 screenshot steps', () => {
  it('answers an unreadable window on its picture, then returns to the form', async () => {
    const desktop = canvasDesktop();
    const { session, published, latest } = harness(desktop.driver);
    await session.start();

    let step = latest();
    expect(step).toMatchObject({ phase: 'ready', picture: true, controls: [], source: { app: 'Game', window: 'Game' } });
    const picture = session.pictureFor(step.revision)!;
    expect(picture).toMatchObject({ mime: 'image/jpeg', width: 1600, height: 1200 });
    expect(Buffer.from(picture.data, 'base64').toString()).toBe('shot-canvas');
    // Pixels are handed out only for the step they belong to.
    expect(session.pictureFor(step.revision - 1)).toBeNull();

    expect(await session.submit({ expectedRevision: step.revision, values: {}, action: { kind: 'tap', x: 0.5, y: 0.25 } })).toBe(true);
    expect(desktop.pointers[0]).toMatchObject({ kind: 'tap', pid: 10, point: [500, 200], area: [100, 50, 800, 600] });

    step = latest();
    expect(step).toMatchObject({ phase: 'ready', picture: true, stepNumber: 1 });
    expect(step.controls).toEqual([{ id: 'typed', kind: 'text', label: '', contentType: 'password' }]);
    expect(await session.submit({ expectedRevision: step.revision, values: { typed: 'hunter2' }, action: { kind: 'submit' } })).toBe(true);
    expect(desktop.pointers[1]).toMatchObject({ kind: 'type', value: 'hunter2', submit: true, secure: true });

    step = latest();
    expect(step.picture).toBeUndefined();
    expect(step.stepNumber).toBe(2);
    expect(step.controls.some((control) => control.kind === 'text' && control.label === 'Nickname')).toBe(true);
    expect(session.pictureFor(step.revision)).toBeNull();
    // Earlier pictures are wiped once the step moves on; no value or pixels are ever published.
    expect(desktop.jpegs.every((jpeg) => jpeg.every((byte) => byte === 0))).toBe(true);
    expect(JSON.stringify(published)).not.toContain('hunter2');
    expect(JSON.stringify(published)).not.toContain(picture.data);
  });

  it('accepts only typing into a focused field on a picture', async () => {
    const desktop = canvasDesktop();
    const { session, latest } = harness(desktop.driver);
    await session.start();
    const step = latest();
    expect(await session.submit({ expectedRevision: step.revision, values: { typed: 'x' }, action: { kind: 'submit' } })).toBe(false);
    expect(await session.submit({ expectedRevision: step.revision, values: {}, action: { kind: 'fill' } })).toBe(true);
    // Typing with no focused field does nothing on the target.
    expect(desktop.pointers).toHaveLength(0);
    expect(latest().failure).toBe('action_failed');
  });

  it('lets the owner ask for the picture of a readable step and go back to the form', async () => {
    const desktop = canvasDesktop();
    const { session, latest } = harness(desktop.driver);
    await session.start();
    await session.submit({ expectedRevision: latest().revision, values: {}, action: { kind: 'tap', x: 0.1, y: 0.1 } });
    await session.submit({ expectedRevision: latest().revision, values: { typed: 'pw' }, action: { kind: 'submit' } });
    const form = latest();
    expect(form.picture).toBeUndefined();

    expect(await session.decide({ kind: 'input_handoff', action: 'picture', expectedRevision: form.revision })).toBe(true);
    expect(latest()).toMatchObject({ picture: true, phase: 'ready' });
    expect(Buffer.from(session.pictureFor(latest().revision)!.data, 'base64').toString()).toBe('shot-form');

    expect(await session.decide({ kind: 'input_handoff', action: 'refresh', expectedRevision: latest().revision })).toBe(true);
    expect(latest().picture).toBeUndefined();
    expect(latest().controls.some((control) => control.kind === 'text' && control.label === 'Nickname')).toBe(true);
  });

  it('reports a covered or moved window instead of tapping something else', async () => {
    const desktop = canvasDesktop({ covered: true });
    const { session, latest } = harness(desktop.driver);
    await session.start();
    await session.submit({ expectedRevision: latest().revision, values: {}, action: { kind: 'tap', x: 0.5, y: 0.5 } });
    expect(latest()).toMatchObject({ picture: true, failure: 'action_failed' });
    expect(desktop.stage()).toBe('canvas');
  });

  it('fails clearly when the window can be neither read nor photographed', async () => {
    const { session, finished, published } = harness(canvasDesktop({ capture: false }).driver);
    await session.start();
    expect(finished[0]).toMatchObject({ status: 'failed', failure: 'unreadable' });
    expect(published.some((snapshot) => snapshot.picture)).toBe(false);
  });
});
