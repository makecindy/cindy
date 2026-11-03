import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { NodeRequestScopes } from '../nodeRequestScope';

describe('call-bound Node async context', () => {
  it('keeps interleaved readline requests separate and rejects late work after cancellation', async () => {
    const scopes = new NodeRequestScopes();
    const stream = new PassThrough();
    const lines = createInterface({ input: stream });
    const release: Array<() => void> = [];
    const work: Promise<string | undefined>[] = [];
    lines.on('line', () => {
      work.push(
        (async () => {
          await new Promise<void>((resolve) => release.push(resolve));
          return scopes.currentRpcId();
        })(),
      );
    });
    try {
      for (const id of ['1', '2'])
        scopes.feed(JSON.stringify({ id, cindy: { cancelWithCall: true } }) + '\n', (x) =>
          stream.write(x),
        );
      scopes.finish('1');
      const cancelled = expect(work[0]).rejects.toThrow('has ended');
      release[1]();
      expect(await work[1]).toBe('2');
      release[0]();
      await cancelled;
      scopes.finish('2');
      expect(scopes.currentRpcId()).toBeUndefined();
    } finally {
      lines.close();
      stream.destroy();
    }
  });

  it('preserves unbound legacy and background stdin behavior', async () => {
    const scopes = new NodeRequestScopes();
    let result: Promise<string | undefined>;
    scopes.feed('{"id":"3","method":"tools/call"}\n', () => {
      result = Promise.resolve().then(() => scopes.currentRpcId());
    });
    expect(await result!).toBeUndefined();
  });
});
