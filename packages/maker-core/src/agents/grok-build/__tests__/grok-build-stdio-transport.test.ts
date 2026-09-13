import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { createGrokStdioTransport, type GrokSpawnFn } from '../stdio-transport.js';

type FakeChild = EventEmitter & {
  pid: number;
  killed: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  kill: (signal?: NodeJS.Signals) => boolean;
  signals: NodeJS.Signals[];
};

function makeChild(opts?: { ignoreTerm?: boolean }): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4242;
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.signals = [];
  child.kill = (signal: NodeJS.Signals = 'SIGTERM') => {
    child.signals.push(signal);
    // Node sets killed=true after SIGTERM even when the process is still alive.
    child.killed = true;
    if (signal === 'SIGTERM' && opts?.ignoreTerm) {
      return true;
    }
    child.exitCode = signal === 'SIGKILL' ? null : 0;
    child.signalCode = signal === 'SIGKILL' ? 'SIGKILL' : null;
    child.emit('exit', child.exitCode, child.signalCode);
    return true;
  };
  return child;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('createGrokStdioTransport close()', () => {
  it('sends SIGKILL if the child ignores SIGTERM (does not use child.killed)', async () => {
    const child = makeChild({ ignoreTerm: true });
    const transport = createGrokStdioTransport({
      binaryPath: '/grok',
      args: ['agent', 'stdio'],
      spawnImpl: (() => child) as unknown as GrokSpawnFn,
    });

    const closing = transport.close('test');
    expect(child.signals).toEqual(['SIGTERM']);
    expect(child.killed).toBe(true);
    expect(child.exitCode).toBeNull();

    await delay(1_500);
    expect(child.signals).toEqual(['SIGTERM']);

    await delay(800);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    await closing;
  });

  it('does not send SIGKILL when the child exits after SIGTERM', async () => {
    const child = makeChild({ ignoreTerm: false });
    const transport = createGrokStdioTransport({
      binaryPath: '/grok',
      args: ['agent', 'stdio'],
      spawnImpl: (() => child) as unknown as GrokSpawnFn,
    });

    await transport.close('test');
    expect(child.signals).toEqual(['SIGTERM']);
    await delay(2_100);
    expect(child.signals).toEqual(['SIGTERM']);
  });
});
