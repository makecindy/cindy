/**
 * 测试价值：openLocalAgentRuntime 的发送、停止和关闭是授权撤销的最终执行点。
 * 规则：通用 API 撤销后不能再启动或发送；原投影测试没有跨 await 的生命周期覆盖。
 * 最小失败输入：setEffort 或重开会话挂起时并发 send / interrupt / close。
 * tier: integration（只使用系统临时目录与可控原生句柄，无 Electron、模型或账号）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
vi.mock('@cindy/maker-core', () => ({
  LOCAL_AGENT_CLIENT: Symbol('local-agent-client'),
  assertSendDispatched: (result: { accepted: boolean }) => {
    if (!result.accepted) throw new Error('not dispatched');
  },
}));
import { openLocalAgentRuntime } from '../runtime.js';
import type { AgentEvent } from '@cindy/maker-core';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function handle(id: string) {
  const ended = deferred();
  return {
    sdkSessionId: id,
    send: vi.fn(async () => ({ accepted: true })),
    steer: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    setEffort: vi.fn(async () => {}),
    setInteractionListener: vi.fn(),
    onEvent: vi.fn((_listener: (event: AgentEvent) => void) => () => {}),
    onStatusChange: vi.fn(),
    beginTurnContinuationWait: vi.fn<() => string | null>(() => null),
    getObservedCurrentTurnTerminal: vi.fn(() => ({ kind: 'none' })),
    close: vi.fn(async () => {
      ended.resolve();
    }),
  };
}
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-local-runtime-'));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const first = handle('first');
  const maker = { startLocalAgentSession: vi.fn(async () => first) };
  const events: unknown[] = [];
  const runtime = await openLocalAgentRuntime(
    maker as any,
    directory,
    {
      isolationKey: 'grant-a',
      mcpName: 'client',
      legacyRuntime: false,
      cwd: directory,
      model: {
        id: 'route',
        label: 'Model',
        provider: 'provider',
        model: 'model',
        engine: 'pi',
        efforts: ['high'],
        images: true,
        isDefault: true,
      },
      access: 'none',
      tools: [],
    },
    {
      url: 'http://127.0.0.1:1/mcp/fixture',
      token: 'invalid-fixture-token',
      emit: (event) => events.push(event),
    },
  );
  cleanups.push(() => runtime.close());
  return { runtime, maker, first, directory, events };
}
const image = { type: 'image', mimeType: 'image/png', data: Buffer.from('png').toString('base64') };
async function inputFiles(directory: string) {
  const root = path.join(directory, 'clients', 'grant-a');
  const inputs = (await fs.readdir(root)).filter((name) => name.startsWith('input-'));
  return (await Promise.all(inputs.map((name) => fs.readdir(path.join(root, name))))).flat();
}
const message = { parts: [{ type: 'text', text: 'hello' }], effort: 'high' };

describe('local client runtime lifecycle', () => {
  it('passes slash-prefixed app text as a literal instead of rejecting paths or running a native command', async () => {
    const f = await fixture();
    await f.runtime.call('send', { parts: [{ type: 'text', text: '/workspace/example' }] });
    expect(f.first.send).toHaveBeenCalledWith({
      type: 'user',
      content: [{ type: 'text', text: ' /workspace/example' }],
    });
  });
  it('keeps the app execution busy across a provider continuation until Session observes its final boundary', async () => {
    const f = await fixture();
    await f.runtime.call('send', { parts: message.parts });
    const deliver = f.first.onEvent.mock.calls[0][0];
    f.first.beginTurnContinuationWait.mockReturnValueOnce('active');
    deliver({ type: 'done', turnContinuationId: 7, data: { status: 'completed' } });
    await expect(f.runtime.call('send', { parts: message.parts })).rejects.toMatchObject({
      code: 'BUSY',
    });
    f.first.getObservedCurrentTurnTerminal.mockReturnValue({ kind: 'done' });
    deliver({ type: 'done', data: { status: 'completed' } });
    await f.runtime.call('send', { parts: message.parts });
    expect(f.first.send).toHaveBeenCalledTimes(2);
  });
  it('reserves a send before awaiting effort so a concurrent send cannot double-submit', async () => {
    const f = await fixture(),
      entered = deferred(),
      held = deferred();
    f.first.setEffort.mockImplementation(async () => {
      entered.resolve();
      await held.promise;
    });
    const sending = f.runtime.call('send', message);
    await entered.promise;
    const rejected = expect(f.runtime.call('send', message)).rejects.toMatchObject({
      code: 'BUSY',
    });
    held.resolve();
    await sending;
    await rejected;
    expect(f.first.send).toHaveBeenCalledTimes(1);
  });
  it('does not send after an interrupt arrives during effort preparation', async () => {
    const f = await fixture(),
      entered = deferred(),
      held = deferred();
    f.first.setEffort.mockImplementation(async () => {
      entered.resolve();
      await held.promise;
    });
    const sending = f.runtime.call('send', message);
    const rejected = expect(sending).rejects.toMatchObject({ code: 'INTERRUPTED' });
    await entered.promise;
    await f.runtime.call('interrupt', {});
    held.resolve();
    await rejected;
    expect(f.first.send).not.toHaveBeenCalled();
  });
  it('does not restart an engine after close during an instructions rebuild', async () => {
    const f = await fixture(),
      entered = deferred(),
      held = deferred();
    f.first.close.mockImplementation(async () => {
      entered.resolve();
      await held.promise;
    });
    await f.runtime.call('instructions', { instructions: 'new context' });
    const sending = f.runtime.call('send', message);
    const rejected = expect(sending).rejects.toMatchObject({ code: 'SESSION_UNAVAILABLE' });
    await entered.promise;
    const closing = f.runtime.close();
    held.resolve();
    await closing;
    await rejected;
    expect(f.maker.startLocalAgentSession).toHaveBeenCalledTimes(1);
    expect(f.first.send).not.toHaveBeenCalled();
  });
  it('closes a late replacement engine instead of sending after its grant was closed', async () => {
    const f = await fixture(),
      entered = deferred(),
      held = deferred(),
      late = handle('late');
    cleanups.push(() => late.close());
    f.maker.startLocalAgentSession.mockImplementationOnce(async () => {
      entered.resolve();
      await held.promise;
      return late;
    });
    await f.runtime.call('instructions', { instructions: 'new context' });
    const sending = f.runtime.call('send', message);
    const rejected = expect(sending).rejects.toMatchObject({ code: 'SESSION_UNAVAILABLE' });
    await entered.promise;
    await f.runtime.close();
    held.resolve();
    await rejected;
    expect(late.close).toHaveBeenCalledTimes(1);
    expect(late.close).toHaveBeenCalledWith({ reason: 'account-boundary' });
    expect(late.send).not.toHaveBeenCalled();
  });
  it('rebuilds again when instructions change while a rebuild is still starting', async () => {
    const f = await fixture(),
      entered = deferred(),
      held = deferred(),
      second = handle('second'),
      third = handle('third');
    cleanups.push(() => second.close(), () => third.close());
    f.maker.startLocalAgentSession
      .mockImplementationOnce(async () => {
        entered.resolve();
        await held.promise;
        return second;
      })
      .mockImplementationOnce(async () => third);
    await f.runtime.call('instructions', { instructions: 'first update' });
    const sending = f.runtime.call('send', message);
    await entered.promise;
    await f.runtime.call('instructions', { instructions: 'latest' });
    held.resolve();
    await sending;
    second.getObservedCurrentTurnTerminal.mockReturnValue({ kind: 'done' });
    second.onEvent.mock.calls[0][0]({ type: 'done', data: { status: 'completed' } });
    await f.runtime.call('send', message);
    expect(f.maker.startLocalAgentSession).toHaveBeenLastCalledWith(
      'pi',
      expect.objectContaining({ userPrompt: 'latest' }),
    );
    expect(third.send).toHaveBeenCalledTimes(1);
  });
  it('releases the execution when the engine declines a send before dispatch', async () => {
    const f = await fixture();
    f.first.send.mockResolvedValueOnce({ accepted: false });
    await f.runtime.call('send', message);
    await vi.waitFor(() => expect(f.runtime.call('send', message)).resolves.toEqual({}));
    expect(f.first.send).toHaveBeenCalledTimes(2);
  });
  it('ends a send that an interrupt cancels before the supplier accepts it', async () => {
    const f = await fixture(),
      reserved = deferred();
    let cancel!: (value: { accepted: boolean }) => void;
    f.first.send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          cancel = resolve;
          reserved.resolve();
        }),
    );
    f.first.abort.mockImplementationOnce(async () => cancel({ accepted: false }));
    await f.runtime.call('send', { parts: message.parts });
    await reserved.promise;
    await f.runtime.call('interrupt', {});
    await vi.waitFor(() =>
      expect(f.events).toContainEqual({
        type: 'turn_end',
        data: { status: 'interrupted', message: '' },
      }),
    );
  });
  it('keeps the effort chosen by send.effort when instructions rebuild the session', async () => {
    const f = await fixture(),
      second = handle('second');
    cleanups.push(() => second.close());
    f.maker.startLocalAgentSession.mockImplementationOnce(async () => second);
    await f.runtime.call('send', message);
    f.first.getObservedCurrentTurnTerminal.mockReturnValue({ kind: 'done' });
    f.first.onEvent.mock.calls[0][0]({ type: 'done', data: { status: 'completed' } });
    await f.runtime.call('instructions', { instructions: 'new context' });
    await f.runtime.call('send', { parts: message.parts });
    expect(f.maker.startLocalAgentSession).toHaveBeenLastCalledWith(
      'pi',
      expect.objectContaining({ effort: 'high', userPrompt: 'new context' }),
    );
  });
  it('removes accepted input images once their turn settles', async () => {
    const f = await fixture();
    await f.runtime.call('send', { parts: [image] });
    expect(await inputFiles(f.directory)).toHaveLength(1);
    f.first.getObservedCurrentTurnTerminal.mockReturnValue({ kind: 'done' });
    f.first.onEvent.mock.calls[0][0]({ type: 'done', data: { status: 'completed' } });
    await vi.waitFor(async () => expect(await inputFiles(f.directory)).toEqual([]));
  });
  it('removes images written for a send that is rejected before the engine takes it', async () => {
    const f = await fixture();
    await expect(
      f.runtime.call('send', { parts: [image, { type: 'unsupported' }] }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    f.first.setEffort.mockRejectedValueOnce(new Error('effort unavailable'));
    await expect(f.runtime.call('send', { ...message, parts: [image] })).rejects.toThrow(
      'effort unavailable',
    );
    expect(await inputFiles(f.directory)).toEqual([]);
    await f.runtime.call('send', { parts: [image] });
    expect(await inputFiles(f.directory)).toHaveLength(1);
  });
});
