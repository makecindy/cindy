import { Duplex } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { RpcClient } from '../src/client.js';
import { encodeMessage } from '../src/codec.js';

class ControlledDuplex extends Duplex {
  readonly writes: Buffer[] = [];
  private writeCallback: ((error?: Error | null) => void) | null = null;

  override _read(): void {}

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.writes.push(Buffer.from(chunk));
    this.writeCallback = callback;
  }

  completeWrite(): void {
    const callback = this.writeCallback;
    this.writeCallback = null;
    callback?.();
  }
}

describe('RpcClient request submission', () => {
  it('separates local Duplex submission from the correlated RPC response', async () => {
    const stream = new ControlledDuplex();
    const client = new RpcClient(stream);
    const pending = client.requestWithSubmission<{ ok: boolean }>('query/send', {
      message: 'hello',
    });
    const responseSettled = vi.fn();
    void pending.response.then(responseSettled, responseSettled);

    expect(responseSettled).not.toHaveBeenCalled();
    stream.completeWrite();
    await expect(pending.submitted).resolves.toBeUndefined();
    expect(responseSettled).not.toHaveBeenCalled();

    const request = JSON.parse(stream.writes[0].toString('utf8').trim()) as { id: number };
    stream.push(encodeMessage({ type: 'response', id: request.id, result: { ok: true } }));
    await expect(pending.response).resolves.toEqual({ ok: true });

    client.dispose();
    stream.destroy();
  });

  it('rejects submission when the RPC timeout beats a stalled Duplex write', async () => {
    const stream = new ControlledDuplex();
    const client = new RpcClient(stream);
    const pending = client.requestWithSubmission('query/send', { message: 'blocked' }, {
      timeoutMs: 5,
    });

    await Promise.all([
      expect(pending.submitted).rejects.toThrow('RPC query/send timed out after 5ms'),
      expect(pending.response).rejects.toThrow('RPC query/send timed out after 5ms'),
    ]);

    client.dispose();
    stream.destroy();
  });
});
