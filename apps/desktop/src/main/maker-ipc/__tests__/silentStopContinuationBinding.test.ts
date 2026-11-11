/**
 * silentStopContinuationBinding.test.ts
 * ---------------------------------------------------------------------------
 * silent-stop 自动续跑走 Session.sendHostTurnContinuation()，不经过 send 事务
 * (makerSendTransaction)，因此不会触发把 onTurnReserved 转发给输入协调器的常规
 * 接线。这条旁路必须自己完成两件事（背景见 silentStopContinuationBinding.ts 文件头，
 * 2026-09-24 僵尸 activeTurn 实报）：
 *   1. 预约时把新 vendor generation 交给协调器(noteHostTurnContinuation)；
 *   2. send 在派发确认前失败(Session 回滚 turnGeneration)时回滚绑定
 *      (noteHostTurnContinuationFailed)。
 *
 * 行为部分用真实 maker-core Session + fake handle 驱动 `sendHostTurnContinuation`：
 * 覆盖预约回调时序（先于 provider dispatch）、成功派发、未派发收口回滚、
 * 派发前取消（无预约时回滚必须 no-op）。
 * register 侧接线由源码契约守住（register.ts 依赖 Electron main，无法在单测导入，
 * 仓库内所有既有测试同样 mock register）。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Session, type AgentEvent, type AgentSessionHandle } from '@cindy/maker-core';
import {
  bindSilentStopContinuationGeneration,
  type SilentStopContinuationBindingDeps,
} from '../silentStopContinuationBinding.js';

const registerSource = readFileSync(resolve(__dirname, '..', 'register.ts'), 'utf8').replace(
  /\r\n?/g,
  '\n',
);

function extractBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) {
    throw new Error(`source markers not found: ${startMarker} .. ${endMarker}`);
  }
  return source.slice(start, end);
}

describe('silent-stop continuation generation binding (wiring contract)', () => {
  it('binds the reserved generation via the extracted helper and rolls back on send failure', () => {
    const resumeBlock = extractBetween(
      registerSource,
      'async function handleSilentStopTurnEnd(',
      'function isFencedStaleProductTerminal(',
    );
    // 预约/回滚接线集中到 helper；sendOpts 必须真的并入续跑调用。
    expect(resumeBlock).toContain('bindSilentStopContinuationGeneration(session.id');
    expect(resumeBlock).toContain('...binding.sendOpts,');
    // 未派发(not accepted)与抛出两条失败收口都要回滚绑定。
    expect(resumeBlock.match(/binding\.rollbackBinding\(\);/g)).toHaveLength(2);
  });
});

describe('silent-stop continuation generation binding (behavior on a real Session)', () => {
  const SID = 'silent-stop-binding';

  function createHarness() {
    const calls: string[] = [];
    const queued: AgentEvent[] = [];
    let releaseEvents: (() => void) | null = null;
    const noteHostTurnContinuation = vi.fn();
    const noteHostTurnContinuationFailed = vi.fn();
    const deps: SilentStopContinuationBindingDeps = {
      noteHostTurnContinuation: (sessionId, generation) => {
        calls.push('reserved');
        noteHostTurnContinuation(sessionId, generation);
      },
      noteHostTurnContinuationFailed,
    };
    const handle = {
      id: 'provider-thread',
      agentKind: 'pi',
      model: 'test-model',
      send: vi.fn(async () => {
        calls.push('send');
      }),
      abort: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      setInteractionResolver: vi.fn(),
      async *events() {
        // 事件泵随 Session 常驻；收到 close 后由 close 兜底结束流。
        try {
          while (true) {
            while (queued.length > 0) yield queued.shift()!;
            await new Promise<void>((resolve) => {
              releaseEvents = resolve;
            });
          }
        } finally {
          releaseEvents = null;
        }
      },
    } as unknown as AgentSessionHandle;
    const emit = (event: AgentEvent) => {
      queued.push(event);
      releaseEvents?.();
      releaseEvents = null;
    };
    const logger = {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      child: () => logger,
    };
    const session = new Session({
      id: SID,
      agentKind: 'pi',
      workDir: process.cwd(),
      handle,
      capabilities: {} as never,
      logger,
      turnStallMs: 0,
    });
    return {
      session,
      handle,
      emit,
      calls,
      noteHostTurnContinuation,
      noteHostTurnContinuationFailed,
      binding: bindSilentStopContinuationGeneration(SID, deps),
    };
  }

  it('hands the reserved generation to the coordinator before the provider turn starts', async () => {
    const h = createHarness();
    try {
      const result = await h.session.sendHostTurnContinuation(
        { type: 'user', content: 'continue' },
        { ...h.binding.sendOpts },
      );
      expect(result.accepted).toBe(true);
      // 时序契约:预约回调先于 provider dispatch —— 协调器的新绑定在 provider
      // 开始前落位，任何早期终态事件都落在新 generation 上。
      expect(h.calls).toEqual(['reserved', 'send']);
      expect(h.noteHostTurnContinuation).toHaveBeenCalledWith(SID, 1);
      expect(h.session.getTurnGeneration()).toBe(1);
    } finally {
      h.emit({ type: 'status', data: { isRunning: false }, source: 'pi' } as AgentEvent);
      h.emit({ type: 'done', data: {}, source: 'pi' } as AgentEvent);
      await h.session.close().catch(() => {});
    }
  });

  it('restores the binding through rollbackBinding when the provider rejects the send', async () => {
    const h = createHarness();
    h.handle.send = vi.fn(async () => {
      throw new Error('provider rejected');
    });
    try {
      await expect(
        h.session.sendHostTurnContinuation({ type: 'user', content: 'continue' }, { ...h.binding.sendOpts }),
      ).rejects.toThrow('provider rejected');

      // 失败前提:预约回调已经用 N+1 绑定过，Session 把 turnGeneration 回滚到 0。
      expect(h.calls).toContain('reserved');
      expect(h.noteHostTurnContinuation).toHaveBeenCalledWith(SID, 1);
      expect(h.session.getTurnGeneration()).toBe(0);

      // register 失败收口调用的正是 rollbackBinding；协调器回滚后，
      // settleSilentStopDone 的合成 done(无 generation)才能匹配绑定。
      h.binding.rollbackBinding();
      expect(h.noteHostTurnContinuationFailed).toHaveBeenCalledWith(SID, 1);
    } finally {
      await h.session.close().catch(() => {});
    }
  });

  it('keeps rollbackBinding a no-op when the send was cancelled before reservation', async () => {
    const h = createHarness();
    try {
      const controller = new AbortController();
      controller.abort();
      const result = await h.session.sendHostTurnContinuation(
        { type: 'user', content: 'continue' },
        { ...h.binding.sendOpts, signal: controller.signal },
      );
      expect(result.accepted).toBe(false);
      expect(h.calls).not.toContain('reserved');
      expect(h.noteHostTurnContinuation).not.toHaveBeenCalled();
      // 预约回调根本没触发:回滚必须 no-op，不得误回滚协调器绑定。
      h.binding.rollbackBinding();
      expect(h.noteHostTurnContinuationFailed).not.toHaveBeenCalled();
    } finally {
      await h.session.close().catch(() => {});
    }
  });
});
