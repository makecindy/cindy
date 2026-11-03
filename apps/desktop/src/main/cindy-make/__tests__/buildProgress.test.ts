import { afterEach, expect, it, vi } from 'vitest';
import { createMakeBuildLineOutput, runMakeBuildStep } from '../buildProgress';
import type { CindyMakePersonalBuildState } from '../../../shared/cindyMakeSession';

afterEach(() => vi.useRealTimers());

it('joins complete lines before redacting split credentials, terminal escapes and paths', () => {
  const lines = vi.fn();
  const output = createMakeBuildLineOutput(lines);
  output.append('\u001b[32m正在检查 token=not-a-');
  expect(lines).not.toHaveBeenCalled();
  output.append('real-secret\u001b[0m\r');
  output.append('\nCompiling C:/private/source.ts\n');
  output.append('\u001b[?25l\r');
  output.append('Finished /Users/private/source');
  output.finish();
  expect(lines.mock.calls.flat()).toEqual([
    '正在检查 token=[REDACTED]',
    'Compiling <path>',
    'Finished <path>',
  ]);
});

it('drops oversized lines through their boundary and retains only bounded display text', () => {
  const lines = vi.fn();
  const output = createMakeBuildLineOutput(lines);
  output.append('token=' + 'fake-secret'.repeat(4000));
  output.append('sensitive continuation\nTest Files 57 passed\r');
  output.append('Test Files 57 passed\n');
  output.append('x'.repeat(500) + '\n');
  expect(lines.mock.calls.flat()).toEqual(['Test Files 57 passed', 'x'.repeat(300)]);
});

it('coalesces noisy output, serializes slow writes, and drains before the next stage', async () => {
  vi.useFakeTimers();
  const states: CindyMakePersonalBuildState[] = [];
  let unblockWrite!: () => void;
  const publish = vi.fn(async (state: CindyMakePersonalBuildState) => {
    states.push(state);
    if (state.outputLine === 'Test 99')
      await new Promise<void>((resolve) => {
        unblockWrite = resolve;
      });
  });
  let emit!: (line: string) => void;
  let finish!: () => void;
  const stage = { status: 'checking', checkStep: 'tests' } as const;
  const run = runMakeBuildStep(stage, new AbortController().signal, publish, async (onLine) => {
    emit = onLine;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  await Promise.resolve();
  for (let i = 0; i < 100; i++) emit('Test ' + i);
  expect(states).toEqual([stage]);
  await vi.advanceTimersByTimeAsync(1000);
  for (let i = 100; i < 200; i++) emit('Test ' + i);
  await vi.advanceTimersByTimeAsync(5000);
  expect(states).toEqual([stage, { ...stage, outputLine: 'Test 99' }]);
  finish();
  unblockWrite();
  await run;
  expect(states.at(-1)).toEqual({ ...stage, outputLine: 'Test 199' });
  await publish({ status: 'packaging' });
  emit('late check output');
  await vi.runAllTimersAsync();
  expect(states.at(-1)).toEqual({ status: 'packaging' });
  expect(states).toHaveLength(4);
});

it('discards queued and late output after cancellation', async () => {
  vi.useFakeTimers();
  const abort = new AbortController();
  const publish = vi.fn(async (_state: CindyMakePersonalBuildState) => {});
  await runMakeBuildStep({ status: 'packaging' }, abort.signal, publish, async (emit) => {
    emit('Building installer');
    abort.abort();
    emit('Late output');
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(publish).toHaveBeenCalledExactlyOnceWith({ status: 'packaging' });
  expect(vi.getTimerCount()).toBe(0);
});

it('drains the final line without swallowing a process failure or leaving a timer', async () => {
  vi.useFakeTimers();
  const publish = vi.fn(async (_state: CindyMakePersonalBuildState) => {});
  const error = new Error('compiler failed');
  await expect(
    runMakeBuildStep(
      { status: 'checking', checkStep: 'types' },
      new AbortController().signal,
      publish,
      async (emit) => {
        emit('error TS2322');
        throw error;
      },
    ),
  ).rejects.toBe(error);
  expect(publish).toHaveBeenLastCalledWith({
    status: 'checking',
    checkStep: 'types',
    outputLine: 'error TS2322',
  });
  expect(vi.getTimerCount()).toBe(0);
});

it('reports a failed progress write and does not silently continue with stale state', async () => {
  const error = new Error('write failed');
  const publish = vi.fn(async (state: CindyMakePersonalBuildState) => {
    if (state.outputLine) throw error;
  });
  await expect(
    runMakeBuildStep({ status: 'packaging' }, new AbortController().signal, publish, async (emit) =>
      emit('Building installer'),
    ),
  ).rejects.toBe(error);
});
