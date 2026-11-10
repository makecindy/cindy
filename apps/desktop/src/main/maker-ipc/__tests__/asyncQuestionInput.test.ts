import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

// Exercise the actual Host dispatcher without booting Electron or a real account.
const source = readFileSync(new URL('../register.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('register.ts', source, ts.ScriptTarget.ES2022, true);
let body = '';
function visit(node: ts.Node): void {
  if (ts.isBinaryExpression(node) && node.left.getText(ast) === 'asyncQuestionInputDispatcher'
    && ts.isArrowFunction(node.right)) body = node.right.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
if (!body) throw new Error('Question input binding missing');
const compiled = ts.transpileModule(`return ${body}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function harness() {
  let paused = false;
  const generation = 1;
  let held = false;
  let uncertain = false;
  const inputBoundary = new AbortController();
  const session = { id: 'task', getTurnGeneration: () => 3 };
  const coordinator = {
    ensureQueueRestored: vi.fn(async () => {}),
    isExecutionPaused: () => held,
    getProjection: () => ({ queuePaused: paused }),
    getGeneration: () => generation,
    getInputAbortSignal: () => inputBoundary.signal,
    isPausedForUncertainDelivery: () => uncertain,
    steerControlInput: vi.fn(async () => 'not-attempted'),
    enqueue: vi.fn(), resume: vi.fn(),
  };
  const build = vi.fn(async (params: unknown) => params);
  const identityDeps = { getDeviceLinkInvokeContext: () => undefined, stampSharedTaskInput: (item: unknown) => item,
    stampTrustedDeviceLinkQueuedOrigin: (item: unknown) => item, stampTrustedDesktopQueuedOrigin: (item: unknown) => item,
    stampMobileClientOrigin: (item: unknown) => item, isMobileControllerInvoke: () => false, isDeviceLinkInvoke: () => false,
    readDeviceLinkInvokeSourceDevice: () => undefined };
  const run = new Function('maker', 'inputCoordinator', 'buildSessionControlInputItem', 'createHash', ...Object.keys(identityDeps), compiled)(
    { getSessionMeta: async () => ({}), getSession: () => session }, coordinator, build, createHash, ...Object.values(identityDeps),
  ) as (session: unknown, text: string, signal: AbortSignal, requestId: string) => Promise<void>;
  return { coordinator, build, run: (text = 'Answer') => run(session, text, new AbortController().signal, 'q1'),
    pause: () => { paused = true; }, stop: () => { inputBoundary.abort(); paused = true; }, hold: () => { held = true; }, uncertainPause: () => { paused = true; uncertain = true; } };
}

it.each(['steered', 'queued'])('does not replay or unpause a %s answer', async (outcome) => {
  const h = harness();
  h.coordinator.steerControlInput.mockImplementation(async () => { h.pause(); return outcome; });
  await h.run();
  expect(h.coordinator.enqueue).not.toHaveBeenCalled();
  expect(h.coordinator.resume).not.toHaveBeenCalled();
});

it('enqueues an idle answer with stable identity and the task execution settings', async () => {
  const h = harness();
  await h.run(); await h.run();
  expect(h.build.mock.calls[0][0]).toMatchObject({ targetSessionId: 'task', inheritTargetPlanMode: true });
  expect(h.coordinator.enqueue.mock.calls[0][1].clientId).toBe(h.coordinator.enqueue.mock.calls[1][1].clientId);
  expect(h.coordinator.resume).not.toHaveBeenCalled();
});

it('resumes an answer explicitly submitted after Stop', async () => {
  const h = harness(); h.pause();
  await h.run();
  expect(h.coordinator.steerControlInput).not.toHaveBeenCalled();
  expect(h.coordinator.enqueue).toHaveBeenCalledOnce();
  expect(h.coordinator.resume).toHaveBeenCalledWith('task');
});

it('keeps the protective pause of an ACK-uncertain steer when another answer is submitted', async () => {
  const h = harness(); h.uncertainPause();
  await h.run();
  expect(h.coordinator.steerControlInput).not.toHaveBeenCalled();
  expect(h.coordinator.enqueue).toHaveBeenCalledOnce();
  expect(h.coordinator.resume).not.toHaveBeenCalled();
});

it.each(['restore', 'build'])('does not override a newer Stop during %s', async (stage) => {
  const h = harness(); h.pause();
  if (stage === 'build') h.build.mockImplementation(async (params) => { h.stop(); return params; });
  else h.coordinator.ensureQueueRestored.mockImplementation(async () => { h.stop(); });
  await expect(h.run()).rejects.toThrow('Question session changed');
  expect(h.coordinator.enqueue).not.toHaveBeenCalled();
  expect(h.coordinator.resume).not.toHaveBeenCalled();
});

it('does not enqueue an answer when Stop lands while steering reports not-attempted', async () => {
  const h = harness();
  h.coordinator.steerControlInput.mockImplementation(async () => { h.stop(); return 'not-attempted'; });
  await expect(h.run()).rejects.toThrow('Question session changed');
  expect(h.coordinator.enqueue).not.toHaveBeenCalled();
  expect(h.coordinator.resume).not.toHaveBeenCalled();
});

it.each(['rejected', 'error', 'held'])('leaves %s admission unconsumed', async (mode) => {
  const h = harness();
  if (mode === 'held') h.hold();
  else if (mode === 'error') h.coordinator.steerControlInput.mockRejectedValueOnce(new Error('offline'));
  else h.coordinator.steerControlInput.mockResolvedValueOnce('rejected');
  await expect(h.run()).rejects.toThrow();
  expect(h.coordinator.enqueue).not.toHaveBeenCalled();
  expect(h.coordinator.resume).not.toHaveBeenCalled();
});
