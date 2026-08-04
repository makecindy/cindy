/**
 * accepted 回调 runner 的错误分流。
 *
 * 这个回调跑在 vendor dispatch **之前**,是排队方唯一能拦下派发的时机。默认吞掉异常是
 * 刻意的(副作用失败不该毁掉一次已受理的 turn),但"取消这次派发"必须能穿透 —— 否则调度
 * 心跳明明已顺延/终止,prompt 却脱离 run 继续执行并烧 token(review #944 第十一轮 P1)。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  AcceptedCallbackDispatchCancelled,
  runAcceptedCallback,
  runAcceptedRollback,
} from '../acceptedCallbackRunner.js';

function createLog() {
  return { warn: vi.fn() };
}

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
