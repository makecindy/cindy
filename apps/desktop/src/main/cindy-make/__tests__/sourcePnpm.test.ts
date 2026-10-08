import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { parseMakeDependencyProgress, runSourcePnpm } from '../sourcePnpm.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('node:fs/promises', () => ({
  stat: vi.fn(async () => ({ isFile: () => true })),
  access: vi.fn(async () => undefined),
}));

it('preserves a scrubbed check failure and exit code without relying on the truncated pnpm tail', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  const run = expect(
    runSourcePnpm(
      { PATH: process.platform === 'win32' ? 'C:/make-tools' : '/make-tools' },
      ['test:unit:related'],
      '.',
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({
    code: 'installFailed',
    diagnostic: {
      kind: 'process',
      exitCode: 1,
      message: 'Error: token=[REDACTED]\nERR_PNPM_FETCH_404: dependency unavailable',
    },
  });
  await vi.waitFor(() => expect(child.stdout.listenerCount('data')).toBe(1));
  child.stderr.write(Buffer.from('Error: token=' + 'fake-secret'.repeat(300)));
  child.stdout.write(Buffer.from('\nERR_PNPM_FETCH_404: dependency unavailable\n'));
  child.emit('close', 1);
  await run;
});

describe('dependency progress projection', () => {
  it('streams scrubbed lines from both pipes and preserves UTF-8 split across buffers', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    const output = vi.fn();
    const run = runSourcePnpm(
      { PATH: process.platform === 'win32' ? 'C:/make-tools' : '/make-tools' },
      ['test:unit:related'],
      '.',
      new AbortController().signal,
      undefined,
      output,
    );
    await vi.waitFor(() => expect(child.stdout.listenerCount('data')).toBe(1));
    const line = Buffer.from('测试通过\n');
    child.stdout.write(line.subarray(0, 2));
    child.stderr.write('warning token=not-a-');
    child.stdout.write(line.subarray(2));
    child.stderr.write('real-secret\n');
    child.stdout.write('Done');
    child.emit('close', 0);
    await run;
    expect(output.mock.calls.flat()).toEqual(['测试通过', 'warning token=[REDACTED]', 'Done']);
  });
  it('keeps the actual counters when pnpm moves into installation scripts', () => {
    const counters = { resolved: 12, reused: 8, downloaded: 4, added: 12 };
    expect(
      parseMakeDependencyProgress(
        'apps/desktop postinstall$ node install.js\nprivate output',
        counters,
      ),
    ).toEqual({ ...counters, activity: 'scripts' });
  });
  it('returns the latest real pnpm counts without leaking raw output', () => {
    expect(
      parseMakeDependencyProgress(
        'private path and credentials\nProgress: resolved 12, reused 4, downloaded 6, added 2\nProgress: resolved 30, reused 14, downloaded 16, added 20',
      ),
    ).toEqual({ resolved: 30, reused: 14, downloaded: 16, added: 20 });
  });
  it('does not invent a percentage or counters from other output', () => {
    expect(parseMakeDependencyProgress('apps/desktop postinstall$ node install.js')).toEqual({
      activity: 'scripts',
    });
    expect(parseMakeDependencyProgress('Downloading package: 42%')).toBeUndefined();
    expect(
      parseMakeDependencyProgress('Progress: resolved 2, reused 1, downloaded'),
    ).toBeUndefined();
  });
});

it('accepts fixed colon-separated script names while rejecting shell operators before launch', async () => {
  const signal = new AbortController().signal;
  await expect(runSourcePnpm({ PATH: '' }, ['test:unit:related'], '.', signal)).rejects.toThrow(
    'pnpm not found',
  );
  for (const argument of [
    'test:unit&whoami',
    'test:unit|whoami',
    'test:unit;whoami',
    '$(whoami)',
    '%SECRET%',
  ]) {
    await expect(runSourcePnpm({ PATH: '' }, [argument], '.', signal)).rejects.toThrow(
      'unsafe pnpm argument',
    );
  }
});
