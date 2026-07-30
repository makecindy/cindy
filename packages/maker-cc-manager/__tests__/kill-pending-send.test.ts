/**
 * Greptile P1 回归:forceful kill 的终止窗口内 (inputQueue 已 end、consume
 * loop 未退出、alive 仍 true), sendMessage 必须显式拒绝
 * (SESSION_KILL_PENDING) — 不得把消息 push 进 ended queue 静默丢弃。
 */

import { describe, expect, it } from 'vitest';

import {
  SessionRegistry,
  type SdkQueryFactory,
  type SdkQueryLike,
} from '../src/session-registry.js';

function buildBlockingFactory(): SdkQueryFactory {
  return (opts): SdkQueryLike => {
    async function* gen(): AsyncGenerator<unknown> {
      yield { type: 'system', subtype: 'init', session_id: 'sdk-uuid', cwd: opts.cwd, model: opts.model };
      for await (const _ of opts.inputStream) {
        // drain
      }
      // inputQueue 已 end, 但 consume loop 还在等"SDK 的最终响应" — 正是
      // Greptile 描述的「alive 仍 true 的终止窗口」(interrupt 发出到
      // consume loop 真正退出之间)。
      await new Promise((r) => setTimeout(r, 150));
      yield { type: 'result', subtype: 'success' };
    }
    const g = gen();
    return {
      [Symbol.asyncIterator]: () => g,
      async interrupt() {},
      async setModel() {},
      async setPermissionMode() {},
      async applyFlagSettings() {},
    };
  };
}

describe('kill 终止窗口的 sendMessage 拒绝 (Greptile P1)', () => {
  it('rejects sendMessage with SESSION_KILL_PENDING while a forceful kill is still settling', async () => {
    const registry = new SessionRegistry({ sdkQueryFactory: buildBlockingFactory() });
    const session = await registry.create({ sessionId: 's1', cwd: '/repo', model: 'm', env: {} });

    // kill 发出后 consume loop 仍挂在线上 (inputStream 未消费新消息) —
    // alive 为 true、inputQueue 已 end 的窗口期。
    const killP = registry.kill('s1');
    // kill 内的 interrupt/end 是同步微任务, 先让它推进到窗口态。
    await new Promise((r) => setTimeout(r, 20));
    expect(session.alive).toBe(true); // 窗口确认:registry 仍报 alive

    expect(() => registry.sendMessage('s1', { text: 'hello' })).toThrowError(/SESSION_KILL_PENDING|being killed/);

    await killP;
  });

  it('still throws SESSION_NOT_FOUND after the session fully exits (not the kill-pending code)', async () => {
    const registry = new SessionRegistry({ sdkQueryFactory: buildBlockingFactory() });
    await registry.create({ sessionId: 's2', cwd: '/repo', model: 'm', env: {} });

    await registry.close('s2'); // close 路径: alive 立即 false
    expect(() => registry.sendMessage('s2', { text: 'hello' })).toThrowError(/SESSION_NOT_FOUND|no longer alive/);
  });
  it('kill resolves only after the consume loop has fully exited (daemon-side settle guarantee)', async () => {
    // Greptile R27:kill RPC 返回时 session 必然不再 alive — client 不再需要
    // 用固定期限轮询猜终止状态 (buildBlockingFactory 的 loop 在 end 后还挂
    // 150ms, 同步等待必须覆盖它)。
    const registry = new SessionRegistry({ sdkQueryFactory: buildBlockingFactory() });
    const session = await registry.create({ sessionId: 's3', cwd: '/repo', model: 'm', env: {} });
    await registry.kill('s3');
    expect(session.alive).toBe(false);
  });

  it('escalates to query.close() when the loop ignores interrupt, and resolves after the loop exits', async () => {
    // Greptile confidence 3/5:loop 无视 interrupt 时 kill 不能谎报退出。
    // 真实 SDK 的 close() 会终止 CLI 子进程 — transport 关闭后 iterator
    // 必然结束。fake: end 后继续挂起, 直到 close() 被调才放行。
    let closeCalls = 0;
    const factory: SdkQueryFactory = (opts): SdkQueryLike => {
      let release: (() => void) | undefined;
      async function* gen(): AsyncGenerator<unknown> {
        yield { type: 'system', subtype: 'init', session_id: 'sdk-uuid', cwd: opts.cwd, model: opts.model };
        for await (const _ of opts.inputStream) {
          // drain
        }
        // interrupt/end 都不退 — 模拟卡死的 SDK turn, 直到 close() 放行。
        await new Promise<void>((r) => {
          release = r;
        });
        yield { type: 'result', subtype: 'success' };
      }
      const g = gen();
      return {
        [Symbol.asyncIterator]: () => g,
        async interrupt() {},
        close() {
          closeCalls += 1;
          release?.();
        },
        async setModel() {},
        async setPermissionMode() {},
        async applyFlagSettings() {},
      };
    };
    const registry = new SessionRegistry({
      sdkQueryFactory: factory,
      killSettleWatchdogMs: 100,
      killCloseGraceMs: 1_000,
    });
    const session = await registry.create({ sessionId: 's4', cwd: '/repo', model: 'm', env: {} });

    await registry.kill('s4');

    expect(closeCalls).toBe(1);
    expect(session.alive).toBe(false);
  });

  it('throws SESSION_KILL_TIMEOUT when the loop never exits — keeps the session alive instead of a false exit', async () => {
    // Greptile confidence 3/5:绝不把未退出的 loop 谎报为已退出 — 否则
    // client 会用同 ID fresh start, 新旧 query 在远端重叠执行。
    let closeCalls = 0;
    const factory: SdkQueryFactory = (opts): SdkQueryLike => {
      async function* gen(): AsyncGenerator<unknown> {
        yield { type: 'system', subtype: 'init', session_id: 'sdk-uuid', cwd: opts.cwd, model: opts.model };
        for await (const _ of opts.inputStream) {
          // drain
        }
        await new Promise<void>(() => {}); // 永远挂起 (wedged)
      }
      const g = gen();
      return {
        [Symbol.asyncIterator]: () => g,
        async interrupt() {},
        close() {
          closeCalls += 1;
        },
        async setModel() {},
        async setPermissionMode() {},
        async applyFlagSettings() {},
      };
    };
    const registry = new SessionRegistry({
      sdkQueryFactory: factory,
      killSettleWatchdogMs: 100,
      killCloseGraceMs: 100,
    });
    const session = await registry.create({ sessionId: 's5', cwd: '/repo', model: 'm', env: {} });

    await expect(registry.kill('s5')).rejects.toThrowError(/SESSION_KILL_TIMEOUT/);

    // 不谎报退出:alive 仍 true, killing 窗口保持 (send 仍被拒绝)。
    expect(session.alive).toBe(true);
    expect(() => registry.sendMessage('s5', { text: 'hello' })).toThrowError(/SESSION_KILL_PENDING|being killed/);

    // 重试 kill 幂等重进升级流程 (close 再次被调), 不会重复 interrupt 崩溃。
    await expect(registry.kill('s5')).rejects.toThrowError(/SESSION_KILL_TIMEOUT/);
    expect(closeCalls).toBe(2);
  });
});
