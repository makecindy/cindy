/**
 * accepted 回调 runner 的错误分流。
 *
 * 这个回调跑在 vendor dispatch **之前**,是排队方唯一能拦下派发的时机。默认吞掉异常是
 * 刻意的(副作用失败不该毁掉一次已受理的 turn),但"取消这次派发"必须能穿透 —— 否则调度
 * 心跳明明已顺延/终止,prompt 却脱离 run 继续执行并烧 token(review #944 第十一轮 P1)。
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentInputQueuedMessage } from '../../../shared/agentInputQueue.js';
import { createQueuedAcceptedCallbacks } from '../queuedAcceptedCallbacks.js';

import {
  AcceptedCallbackDispatchCancelled,
  runAcceptedCallback,
  runAcceptedRollback,
} from '../acceptedCallbackRunner.js';

function createLog() {
  return { warn: vi.fn() };
}

describe('queued acceptance settlement', () => {
  const item: AgentInputQueuedMessage = {
    clientId: 'queued', text: 'continue', persistedContent: 'continue',
    model: 'test', effort: '', permissionMode: 'ask', workingDir: '/tmp',
    chatMessage: { clientId: 'queued', role: 'user', content: 'continue' },
    createOpts: { agentKind: 'claude-code', model: 'test', workingDir: '/tmp' },
  };
  const sendOpts = { persistUserMessage: { clientId: item.clientId, content: item.text, delivery: 'turn' as const } };

  it('commits accepted side effects once only after dispatch succeeds', async () => {
    const callbacks = createQueuedAcceptedCallbacks();
    const events: string[] = [];
    callbacks.register(item.clientId, () => { events.push('accepted'); },
      () => { events.push('rollback'); }, () => { events.push('commit'); });
    await callbacks.run('s', item);
    expect(events).toEqual(['accepted']);
    const outcome = { kind: 'session-dispatch' as const, source: 'orca', dispatched: true as const };
    await callbacks.settle('s', sendOpts, outcome);
    await callbacks.settle('s', sendOpts, outcome);
    await callbacks.rollback('s', item.clientId);
    expect(events).toEqual(['accepted', 'commit']);
  });

  it('rolls back a cancelled acceptance once and never commits it', async () => {
    const callbacks = createQueuedAcceptedCallbacks();
    const rollback = vi.fn();
    const commit = vi.fn();
    const cancelled = new AcceptedCallbackDispatchCancelled('delivery revoked');
    callbacks.register(item.clientId, () => { throw cancelled; }, rollback, commit);
    await expect(callbacks.run('s', item)).rejects.toBe(cancelled);
    await callbacks.settle('s', sendOpts, { kind: 'session-dispatch', source: 'orca', dispatched: false,
      reason: 'cancelled-before-dispatch', message: 'delivery revoked', context: 'test' });
    await callbacks.rollback('s', item.clientId);
    expect(rollback).toHaveBeenCalledExactlyOnceWith('cancelled-before-dispatch');
    expect(commit).not.toHaveBeenCalled();
  });

  it('discarding an unaccepted item has no accepted, commit or rollback side effects', async () => {
    const callbacks = createQueuedAcceptedCallbacks();
    const accepted = vi.fn(), rollback = vi.fn(), commit = vi.fn();
    callbacks.register(item.clientId, accepted, rollback, commit);
    callbacks.discard(item.clientId);
    await callbacks.run('s', item);
    await callbacks.rollback('s', item.clientId);
    expect(accepted).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });
});

describe('runAcceptedCallback', () => {
  it('普通副作用失败只记日志,不拦派发', async () => {
    const log = createLog();
    await expect(
      runAcceptedCallback(
        () => {
          throw new Error('side effect blew up');
        },
        's1',
        'c1',
        log,
      ),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith('accepted callback failed', expect.objectContaining({
      sessionId: 's1',
      clientId: 'c1',
    }));
  });

  it('AcceptedCallbackDispatchCancelled 原样上抛,让调用方回滚派发', async () => {
    const log = createLog();
    const err = new AcceptedCallbackDispatchCancelled('queued heartbeat dispatch cancelled');
    await expect(runAcceptedCallback(() => { throw err; }, 's1', 'c1', log)).rejects.toBe(err);
    expect(log.warn).toHaveBeenCalledWith(
      'accepted callback cancelled this dispatch',
      expect.objectContaining({ sessionId: 's1', clientId: 'c1' }),
    );
  });

  it('异步抛出的取消信号同样上抛', async () => {
    const log = createLog();
    await expect(
      runAcceptedCallback(
        async () => {
          await Promise.resolve();
          throw new AcceptedCallbackDispatchCancelled('cancelled later');
        },
        's1',
        'c1',
        log,
      ),
    ).rejects.toBeInstanceOf(AcceptedCallbackDispatchCancelled);
  });

  it('没有回调时是 no-op', async () => {
    const log = createLog();
    await expect(runAcceptedCallback(undefined, 's1', 'c1', log)).resolves.toBeUndefined();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('rollback 失败照旧只记日志(取消信号也不例外 —— 回滚阶段已无派发可拦)', async () => {
    const log = createLog();
    await expect(
      runAcceptedRollback(
        () => {
          throw new AcceptedCallbackDispatchCancelled('too late to matter');
        },
        's1',
        'c1',
        log,
      ),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith('accepted rollback failed', expect.objectContaining({
      sessionId: 's1',
    }));
  });
});
