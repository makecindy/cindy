/**
 * Session.send 视觉桥集成测试。
 *
 * 验证层 B 钩子在 session.send 的真实调用语义：
 *  - hook 被调用且 applied → 消息被替换后派发；
 *  - hook 返回 applied:false + note → 消息原样派发、note 上报（不阻塞）；
 *  - hook 抛错 → 消息原样派发（防御性兜底，零干扰契约）。
 */
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { Session } from './session.js';
import type { AgentSessionHandle } from './agents/base-agent.js';
import type { UserMessage } from './types/common.js';
import type { VisionBridgeHook } from './types/vision-bridge.js';

/** 与 session.origin.test.ts 同款的 mock logger（Session 构造必需）。debug 是 vi.fn 供断言取消留痕。 */
function createLogger() {
  const logger = {
    trace() {}, debug: vi.fn(), info() {}, warn() {}, error() {}, fatal() {},
    child() { return logger; },
  };
  return logger;
}

/** 记录 send 收到的消息，便于断言视觉桥替换效果。 */
function makeRecordingHandle() {
  const sent: UserMessage[] = [];
  let turnRunning = false;
  const handle: AgentSessionHandle = {
    id: 'thread-1',
    agentKind: 'claude-code',
    model: 'deepseek-v4',
    async send(msg: UserMessage) {
      sent.push(msg);
      turnRunning = true;
    },
    async steer() {},
    async abort() {},
    async close() {
      turnRunning = false;
    },
    async *events() {
      // 无事件流：send 后直接结束 turn（避免 await events 卡住）。
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      turnRunning = false;
    },
    getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
    setInteractionResolver: () => undefined,
    isTurnRunning: () => turnRunning,
  } as unknown as AgentSessionHandle;
  return { handle, sent };
}

function makeSession(
  handle: AgentSessionHandle,
  visionBridge?: VisionBridgeHook,
  logger: ReturnType<typeof createLogger> = createLogger(),
): Session {
  return new Session({
    id: 'session-vb',
    agentKind: 'claude-code',
    workDir: path.join('workspace', 'repo'),
    handle,
    capabilities: {} as never,
    logger: logger as never,
    ...(visionBridge ? { visionBridge } : {}),
  });
}

describe('Session.send vision bridge hook', () => {
  it('replaces the message with the bridged message when applied', async () => {
    const { handle, sent } = makeRecordingHandle();
    const hook: VisionBridgeHook = async (msg, ctx) => {
      expect(ctx.model).toBe('deepseek-v4');
      return { applied: true, message: { type: 'user', content: [{ type: 'text', text: '[desc] the image shows a red button' }] } };
    };
    const session = makeSession(handle, hook);
    await session.send({
      type: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image', path: '/tmp/ui.png' },
      ],
    });
    expect(sent).toHaveLength(1);
    // 派发给 handle 的是替换后的消息（无 image block）。
    expect(sent[0].content).toEqual([{ type: 'text', text: '[desc] the image shows a red button' }]);
  });

  it('passes through unchanged when applied=false with note (note not blocking)', async () => {
    const { handle, sent } = makeRecordingHandle();
    const hook: VisionBridgeHook = async (msg) => ({ applied: false, message: msg, note: 'vision backend down' });
    const session = makeSession(handle, hook);
    const msg: UserMessage = { type: 'user', content: [{ type: 'image', path: '/tmp/a.png' }] };
    await session.send(msg);
    expect(sent).toHaveLength(1);
    // applied=false → 原样派发（image block 保留），note 不影响 send 流程。
    expect(sent[0]).toBe(msg);
  });

  it('does not block send when the hook throws (defensive passthrough)', async () => {
    const { handle, sent } = makeRecordingHandle();
    const hook: VisionBridgeHook = async () => {
      throw new Error('boom');
    };
    const session = makeSession(handle, hook);
    const msg: UserMessage = { type: 'user', content: [{ type: 'text', text: 'hi' }] };
    await session.send(msg);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe(msg);
  });

  it('rejects a concurrent send while vision hook is in-flight (sendReservation guard)', async () => {
    // send1 的视觉 hook 挂起（永不 resolve）→ 视觉阶段 isTurnRunning 仍 false，
    // 但 sendReservation 已建立。send2 并发必须被 SESSION_RUNNING 拒绝，
    // 不能覆盖 sendReservation 让 send1 白调视觉。
    let releaseVision!: () => void;
    const visionGate = new Promise<void>((resolve) => {
      releaseVision = resolve;
    });
    const { handle } = makeRecordingHandle();
    const hook: VisionBridgeHook = async () => {
      await visionGate;
      return { applied: false, message: { type: 'user', content: [{ type: 'text', text: 'late' }] } };
    };
    const session = makeSession(handle, hook);

    const send1 = session.send({
      type: 'user',
      content: [{ type: 'image', path: '/tmp/a.png' }],
    });
    // 等 send1 进入视觉 hook（await visionGate）。
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    // send2 并发：应被 sendReservation guard 拒绝（SESSION_RUNNING）。
    await expect(
      session.send({ type: 'user', content: [{ type: 'text', text: 'second' }] }),
    ).rejects.toThrow(/running/i);

    // 释放 send1 的视觉 hook，让它完成（applied=false → 原样透传，handle.send 收到原消息）。
    releaseVision();
    const r1 = await send1;
    expect(r1.accepted).toBe(true);
  });

  it('returns cancelled-before-dispatch when external signal aborts during vision hook', async () => {
    // send 带外部 signal；视觉 hook 挂起时 abort signal → hook 感知 ctx.signal.aborted，
    // 返回后 session 复查取消，send 返回 cancelled-before-dispatch（不 dispatch handle）。
    const controller = new AbortController();
    let released = false;
    const hook: VisionBridgeHook = async (_msg, ctx) => {
      // 等 abort（signal 触发）或 200ms 兜底。
      await new Promise<void>((resolve) => {
        ctx.signal?.addEventListener('abort', () => {
          released = true;
          resolve();
        });
        setTimeout(resolve, 200);
      });
      return { applied: false, message: { type: 'user', content: [{ type: 'text', text: 'x' }] } };
    };
    const { handle, sent } = makeRecordingHandle();
    const session = makeSession(handle, hook);
    const p = session.send({ type: 'user', content: [{ type: 'image', path: '/tmp/a.png' }] }, { signal: controller.signal });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const r = await p;
    expect(released).toBe(true);
    // toEqual 收窄联合类型：accepted=false + reason 为 cancelled-before-dispatch。
    expect(r).toEqual({ accepted: false, reason: 'cancelled-before-dispatch' });
    // handle 未被 dispatch（视觉阶段就取消了）。
    expect(sent).toHaveLength(0);
  });

  it('aborts in-flight vision hook reservation when session detaches', async () => {
    // 视觉 hook 挂起（await ctx.signal.abort）；send 进入视觉阶段后 session.detach()
    // 应立即 abort reservation signal → hook 感知取消，handle.send 不被 dispatch。
    let abortedByDetach = false;
    let releaseHook: (() => void) | undefined;
    const hook: VisionBridgeHook = async (_msg, ctx) => {
      await new Promise<void>((resolve) => {
        ctx.signal?.addEventListener('abort', () => {
          abortedByDetach = true;
          resolve();
        });
        releaseHook = resolve;
      });
      return { applied: false, message: { type: 'user', content: [{ type: 'text', text: 'late' }] } };
    };
    const { handle, sent } = makeRecordingHandle();
    const session = makeSession(handle, hook);
    const p = session.send({ type: 'user', content: [{ type: 'image', path: '/tmp/a.png' }] });

    // 等 send 进入视觉 hook（reservation 已建立）。
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    // detach 应立即 abort 视觉 fetch（不再等 handle.detach/超时）。
    await session.detach();

    expect(abortedByDetach).toBe(true);
    // send 因 reservation abort → cancelled-before-dispatch，handle.send 未 dispatch。
    const r = await p;
    expect(r).toEqual({ accepted: false, reason: 'cancelled-before-dispatch' });
    expect(sent).toHaveLength(0);
    // 兜底 release（若 hook 未被 abort，避免悬挂）。
    releaseHook?.();
  });

  it('logs debug when vision bridge cancellation is caught before dispatch', async () => {
    const logger = createLogger();
    const controller = new AbortController();
    const hook: VisionBridgeHook = async (_msg, ctx) => {
      await new Promise<void>((resolve) => {
        ctx.signal?.addEventListener('abort', () => resolve());
        setTimeout(resolve, 200);
      });
      return { applied: false, message: { type: 'user', content: [{ type: 'text', text: 'x' }] } };
    };
    const { handle, sent } = makeRecordingHandle();
    const session = makeSession(handle, hook, logger);
    const p = session.send({ type: 'user', content: [{ type: 'image', path: '/tmp/a.png' }] }, { signal: controller.signal });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const r = await p;
    expect(r).toEqual({ accepted: false, reason: 'cancelled-before-dispatch' });
    expect(sent).toHaveLength(0);
    // 取消留痕：session debug 记录 vision bridge cancelled before dispatch + reason。
    expect(logger.debug).toHaveBeenCalledWith(
      'vision bridge cancelled before dispatch',
      expect.objectContaining({ reason: 'cancelled-before-dispatch' }),
    );
  });
});

describe('Session.steer vision bridge hook', () => {
  it('replaces the image message with the bridged text before steering', async () => {
    const steered: UserMessage[] = [];
    const handle = {
      id: 'thread-1',
      agentKind: 'claude-code',
      model: 'deepseek-v4',
      async send() {},
      async steer(msg: UserMessage) {
        steered.push(msg);
      },
      async abort() {},
      async close() {},
      async *events() {},
      getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
      setInteractionResolver: () => undefined,
      isTurnRunning: () => true,
    } as unknown as AgentSessionHandle;
    const hook: VisionBridgeHook = async (msg) => ({
      applied: true,
      message: { type: 'user', content: [{ type: 'text', text: '[desc] the image shows a chat list' }] },
    });
    // steer 需要 sameTurnSteer capability；这里构造带该 capability 的 session。
    const session = new Session({
      id: 'session-vb-steer',
      agentKind: 'claude-code',
      workDir: path.join('workspace', 'repo'),
      handle,
      capabilities: { sameTurnSteer: { supported: true } } as never,
      logger: createLogger() as never,
      visionBridge: hook,
    });
    await session.steer({
      type: 'user',
      content: [
        { type: 'text', text: 'steer this' },
        { type: 'image', path: '/tmp/a.png' },
      ],
    });
    // 视觉桥把 image block 替换为描述文本后交给 handle.steer。
    expect(steered).toHaveLength(1);
    expect(steered[0].content).toEqual([{ type: 'text', text: '[desc] the image shows a chat list' }]);
  });

  it('does not steer when the turn ends during async vision conversion', async () => {
    // turn 在视觉转换期间结束：steer 必须先复查生命周期再调 handle.steer，
    // 否则底层以「No active turn to steer」拒绝或 Pi 把迟到消息交给已结束的 turn。
    const steered: UserMessage[] = [];
    const handle = {
      id: 'thread-1',
      agentKind: 'claude-code',
      model: 'deepseek-v4',
      async send() {},
      async steer(msg: UserMessage) {
        steered.push(msg);
      },
      async abort() {},
      async close() {},
      async *events() {},
      getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
      setInteractionResolver: () => undefined,
      // 第一次检查为 true（视觉转换前），转换完成后变为 false（turn 已结束）。
      isTurnRunning: vi
        .fn()
        .mockReturnValueOnce(true)
        .mockReturnValue(false),
    } as unknown as AgentSessionHandle;
    const hook: VisionBridgeHook = async (msg) => {
      // 模拟视觉转换耗时：期间 turn 结束。
      await new Promise((r) => setTimeout(r, 5));
      return {
        applied: true,
        message: { type: 'user', content: [{ type: 'text', text: '[desc] slow bridge' }] },
      };
    };
    const session = new Session({
      id: 'session-vb-steer-stale',
      agentKind: 'claude-code',
      workDir: path.join('workspace', 'repo'),
      handle,
      capabilities: { sameTurnSteer: { supported: true } } as never,
      logger: createLogger() as never,
      visionBridge: hook,
    });
    await expect(
      session.steer({
        type: 'user',
        content: [
          { type: 'text', text: 'steer this' },
          { type: 'image', path: '/tmp/a.png' },
        ],
      }),
    ).rejects.toThrow('has no active turn to steer');
    // 底层 handle.steer 绝不能被调用（迟到消息不交给已结束的 turn）。
    expect(steered).toHaveLength(0);
  });

  it('does not steer when a new turn started during async vision conversion', async () => {
    // 原 turn 在视觉转换期间结束、同 Session 随后启动新 turn：isTurnRunning 会因
    // 新 turn 而通过（恒 true），但 generation 已变化——迟到 steer 若投出会串到
    // 错误的新 turn。必须校验 generation 仍一致才投递（Greptile P1）。
    const steered: UserMessage[] = [];
    const handle = {
      id: 'thread-1',
      agentKind: 'claude-code',
      model: 'deepseek-v4',
      async send() {},
      async steer(msg: UserMessage) {
        steered.push(msg);
      },
      async abort() {},
      async close() {},
      async *events() {},
      getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
      setInteractionResolver: () => undefined,
      // 新 turn 在跑：isTurnRunning 始终 true。
      isTurnRunning: () => true,
    } as unknown as AgentSessionHandle;
    const hook: VisionBridgeHook = async (msg) => {
      // 模拟视觉转换耗时：期间新 turn 已启动。
      await new Promise((r) => setTimeout(r, 5));
      return {
        applied: true,
        message: { type: 'user', content: [{ type: 'text', text: '[desc] slow bridge' }] },
      };
    };
    const session = new Session({
      id: 'session-vb-steer-new-turn',
      agentKind: 'claude-code',
      workDir: path.join('workspace', 'repo'),
      handle,
      capabilities: { sameTurnSteer: { supported: true } } as never,
      logger: createLogger() as never,
      visionBridge: hook,
    });
    // 发起时 generation = 1，转换后 = 2（模拟新 turn 递增）→ 拒绝投递。
    const genSpy = vi
      .spyOn(session, 'getTurnGeneration')
      .mockReturnValueOnce(1)
      .mockReturnValue(2);
    await expect(
      session.steer({
        type: 'user',
        content: [
          { type: 'text', text: 'steer this' },
          { type: 'image', path: '/tmp/a.png' },
        ],
      }),
    ).rejects.toThrow('has no active turn to steer');
    expect(steered).toHaveLength(0);
    genSpy.mockRestore();
  });
});
