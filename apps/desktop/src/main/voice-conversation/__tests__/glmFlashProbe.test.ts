import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGlmFlashProbeBatch, probeGlmFlash } from '../glmFlashProbe.js';
import { GLM_REALTIME_FLASH } from '../../../shared/glmRealtimeDiscovery.js';

afterEach(() => vi.useRealTimers());

async function openedProbe() {
  const ws = Object.assign(new EventEmitter(), { send: vi.fn(), terminate: vi.fn() });
  const connect = vi.fn(async () => ws as unknown as WebSocket);
  const headers = { authorization: 'Bearer fixture' };
  const result = probeGlmFlash(headers, () => true, connect);
  await Promise.resolve();
  ws.emit('open');
  expect(connect).toHaveBeenCalledWith({
    url: 'wss://open.bigmodel.cn/api/paas/v4/realtime', protocol: 'glm-realtime', headers,
  }, expect.any(Function));
  return { ws, result, message: (event: object) => ws.emit('message', Buffer.from(JSON.stringify(event))) };
}

describe('GLM Flash discovery handshake', () => {
  it.each([
    [{ type: 'session.updated', session: { model: GLM_REALTIME_FLASH } }, 'available'],
    [{ type: 'session.updated', session: {} }, 'unknown'],
    [{ type: 'session.updated', session: { model: 'glm-realtime-air' } }, 'unknown'],
    [{ type: 'error', error: { code: 'model_not_found' } }, 'unavailable'],
    [{ type: 'error', error: { code: 'rate_limit_exceeded' } }, 'unknown'],
  ] as const)('classifies %j and closes without generating output', async (ack, expected) => {
    const { ws, result, message } = await openedProbe();
    message({ type: 'session.created', session: { model: GLM_REALTIME_FLASH } });
    expect(ws.terminate).not.toHaveBeenCalled();
    message(ack);
    expect(await result).toBe(expected);
    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(ws.send.mock.calls[0][0])).toMatchObject({
      type: 'session.update', session: { model: GLM_REALTIME_FLASH, beta_fields: { greeting_config: { enable: false } } },
    });
    expect(ws.terminate).toHaveBeenCalledOnce();
  });

  it('enforces the deadline even while the proxy is resolving', async () => {
    vi.useFakeTimers();
    let resolve!: (ws: WebSocket) => void;
    const result = probeGlmFlash({}, () => true, () => new Promise(done => { resolve = done; }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(await result).toBe('unknown');
    const ws = Object.assign(new EventEmitter(), { send: vi.fn(), terminate: vi.fn() });
    resolve(ws as unknown as WebSocket);
    await Promise.resolve();
    ws.emit('open');
    expect(ws.send).not.toHaveBeenCalled();
    expect(ws.terminate).toHaveBeenCalledOnce();
  });

  it('shares one result per gesture and credential, including sequential runtime fetches', async () => {
    const probe = vi.fn(async () => 'available' as const);
    const run = createGlmFlashProbeBatch(probe);
    const headers = { authorization: 'Bearer test-one' };
    let current = true;
    await Promise.all([run(headers, () => current, 'a'), run(headers, () => current, 'a')]);
    await run(headers, () => current, 'a');
    expect(probe).toHaveBeenCalledTimes(1);
    await run(headers, () => true, 'b');
    await run({ authorization: 'Bearer test-two' }, () => true, 'a');
    current = false;
    await run(headers, () => true, 'a');
    expect(probe).toHaveBeenCalledTimes(4);
  });
});
