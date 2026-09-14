/**
 * `!stop` 控制指令路由回归(issue #867)。
 *
 * 断言 messageHandler 把 `!stop` 从普通消息流里分流出来:
 *   - 命中 → turnRunner.stopActiveTurn(不进 runAgentTurn / slash / 不入队)
 *   - 回复 stopDone / stopIdle
 *   - 带附件 / 非精确匹配的文本不受影响, 照常走 agent turn
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelIM, IMAttachment, IMMessageEvent } from '@cindy/im';

const mocks = vi.hoisted(() => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../../logger', () => ({
  createLogger: () => mocks.logger,
}));

// slashCommands 模块运行时依赖 maker-host / localDb 等重模块 — messageHandler
// 只用到 looksLikeSlashCommand 这个纯函数, 整模块 mock 掉避免拖进 electron 依赖。
vi.mock('../slashCommands', () => ({
  looksLikeSlashCommand: (text: string) => text.startsWith('/'),
}));

import { createMessageHandler, isStopCommand } from '../messageHandler';
import { enterControl, exitControl } from '../controlState';
import {
  activateImAccountBoundary,
  captureImAccountGeneration,
  deactivateImAccountBoundary,
  waitForImAccountGenerationIdle,
} from '../../accountBoundary';
import type { ImSlashHandlers } from '../slashCommands';
import type { ImTurnRunner } from '../turnRunner';
import type { ImChannelAdapter } from '../types';
import { ui as slackUi } from './threadUiFixture';

function makeEvent(overrides: Partial<IMMessageEvent> = {}): IMMessageEvent {
  return {
    channelName: 'slack',
    senderId: 'U123456789',
    chatId: 'D123456789',
    contextId: 'bot-ctx',
    messageId: 'msg-1',
    text: '!stop',
    attachments: [],
    unsupported: [],
    scopeKey: '1234.5678',
    ...overrides,
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('isStopCommand', () => {
  it('matches half/full-width exclamation and any letter case, ignoring surrounding spaces', () => {
    expect(isStopCommand('!stop')).toBe(true);
    expect(isStopCommand('!STOP')).toBe(true);
    expect(isStopCommand('  !Stop  ')).toBe(true);
    expect(isStopCommand('！stop')).toBe(true);
    expect(isStopCommand('！STOP')).toBe(true);
  });

  it('rejects anything that is not exactly the stop command', () => {
    expect(isStopCommand('stop')).toBe(false);
    expect(isStopCommand('!stops')).toBe(false);
    expect(isStopCommand('!stop now')).toBe(false);
    expect(isStopCommand('please !stop')).toBe(false);
    expect(isStopCommand('')).toBe(false);
  });
});

describe('messageHandler !stop routing', () => {
  let stopActiveTurn: ReturnType<typeof vi.fn>;
  let runAgentTurn: ReturnType<typeof vi.fn>;
  let handleSlashCommand: ReturnType<typeof vi.fn>;
  let sendMarkdownText: ReturnType<typeof vi.fn>;
  let sendText: ReturnType<typeof vi.fn>;
  let consumePendingOpenerCard: ReturnType<typeof vi.fn>;
  let consumePendingOpenerAsCard: ReturnType<typeof vi.fn>;
  let deliver: (event: IMMessageEvent) => void;

  function wire(threadScoped: boolean): void {
    stopActiveTurn = vi.fn(async () => ({ stopped: true, droppedQueued: 0 }));
    runAgentTurn = vi.fn(async () => undefined);
    handleSlashCommand = vi.fn(async () => true);
    sendMarkdownText = vi.fn(async () => undefined);
    sendText = vi.fn(async () => undefined);
    // 群主流 @ 开话题的开场白卡收口能力(仅 feishu 实现; 这里模拟富卡渠道)。
    consumePendingOpenerCard = vi.fn(async () => false);
    consumePendingOpenerAsCard = vi.fn(async () => false);

    const im = {
      onMessage(handler: (event: IMMessageEvent) => void) {
        deliver = handler;
        return () => undefined;
      },
      sendMarkdownText,
      sendText,
      consumePendingOpenerCard,
      consumePendingOpenerAsCard,
    } as unknown as ChannelIM;

    const adapter = {
      channel: 'slack',
      im,
      output: { kind: 'rich-card', im },
      ui: slackUi,
      threadScoped,
    } as unknown as ImChannelAdapter;

    const attach = createMessageHandler(
      adapter,
      { handleSlashCommand } as unknown as ImSlashHandlers,
      { stopActiveTurn, runAgentTurn } as unknown as ImTurnRunner,
    );
    attach(im);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    exitControl('bot-ctx', 'U123456789');
    activateImAccountBoundary();
    wire(true);
  });

  it('silently drops messages delivered after logout closes the account boundary', async () => {
    deactivateImAccountBoundary();
    deliver(makeEvent({ text: 'after logout' }));
    await flushMicrotasks();

    expect(stopActiveTurn).not.toHaveBeenCalled();
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(handleSlashCommand).not.toHaveBeenCalled();
    expect(sendMarkdownText).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it('drops an old-account message that was queued before logout and relogin', async () => {
    const firstTurn = deferred();
    runAgentTurn.mockImplementationOnce(async () => firstTurn.promise);

    deliver(makeEvent({ messageId: 'old-1', text: 'first old message' }));
    await vi.waitFor(() => expect(runAgentTurn).toHaveBeenCalledTimes(1));
    deliver(makeEvent({ messageId: 'old-2', text: 'queued old message' }));

    deactivateImAccountBoundary();
    activateImAccountBoundary();
    firstTurn.resolve();
    await vi.waitFor(() =>
      expect(mocks.logger.info).toHaveBeenCalledWith(
        'drop inbound message from stale account generation channel=slack',
      ),
    );

    expect(runAgentTurn).toHaveBeenCalledTimes(1);
  });

  it('keeps an already-started message turn inside the closing account scope', async () => {
    const turn = deferred();
    runAgentTurn.mockImplementationOnce(async () => turn.promise);
    const accountGeneration = captureImAccountGeneration();
    expect(accountGeneration).not.toBeNull();

    deliver(makeEvent({ messageId: 'old-running', text: 'in-flight old message' }));
    await vi.waitFor(() => expect(runAgentTurn).toHaveBeenCalledTimes(1));
    deactivateImAccountBoundary();

    let drained = false;
    const draining = waitForImAccountGenerationIdle(accountGeneration!).then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    turn.resolve();
    await draining;
    expect(drained).toBe(true);
  });

  it('keeps detached turn background work inside the closing account scope', async () => {
    const background = deferred();
    runAgentTurn.mockImplementationOnce(
      async (args: Parameters<ImTurnRunner['runAgentTurn']>[0]) => {
        args.trackBackgroundTask?.(() => background.promise);
      },
    );
    const accountGeneration = captureImAccountGeneration();
    expect(accountGeneration).not.toBeNull();

    deliver(makeEvent({ messageId: 'old-title', text: 'generate a title' }));
    await vi.waitFor(() => expect(runAgentTurn).toHaveBeenCalledTimes(1));
    deactivateImAccountBoundary();

    let drained = false;
    const draining = waitForImAccountGenerationIdle(accountGeneration!).then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    background.resolve();
    await draining;
    expect(drained).toBe(true);
  });

  it('routes !stop to stopActiveTurn with the thread scopeKey and replies stopDone', async () => {
    deliver(makeEvent());
    await flushMicrotasks();

    expect(stopActiveTurn).toHaveBeenCalledTimes(1);
    expect(stopActiveTurn).toHaveBeenCalledWith({
      botContextId: 'bot-ctx',
      userId: 'U123456789',
      scopeKey: '1234.5678',
    });
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(handleSlashCommand).not.toHaveBeenCalled();
    expect(sendMarkdownText).toHaveBeenCalledWith('U123456789', slackUi.agent.stopDone(0), {
      threadTs: '1234.5678',
    });
  });

  it('mentions dropped queued messages in the stopDone reply', async () => {
    stopActiveTurn.mockResolvedValue({ stopped: true, droppedQueued: 2 });
    deliver(makeEvent());
    await flushMicrotasks();

    expect(sendMarkdownText).toHaveBeenCalledWith('U123456789', slackUi.agent.stopDone(2), {
      threadTs: '1234.5678',
    });
  });

  it('replies stopIdle when nothing is running', async () => {
    stopActiveTurn.mockResolvedValue({ stopped: false, droppedQueued: 0 });
    deliver(makeEvent());
    await flushMicrotasks();

    expect(sendMarkdownText).toHaveBeenCalledWith('U123456789', slackUi.agent.stopIdle, {
      threadTs: '1234.5678',
    });
    expect(runAgentTurn).not.toHaveBeenCalled();
  });

  it('omits scopeKey for non-threadScoped channels', async () => {
    wire(false);
    deliver(makeEvent({ channelName: 'feishu', scopeKey: undefined }));
    await flushMicrotasks();

    expect(stopActiveTurn).toHaveBeenCalledWith({
      botContextId: 'bot-ctx',
      userId: 'U123456789',
      scopeKey: undefined,
    });
  });

  // ── 控制命令的主人门 ──────────────────────────────────────────────────────
  // 群消息的 senderId 是群 lane, 所以任何群成员的 !stop 都会解析到同一个群会话,
  // 等于掐掉主人正在跑的那一轮; slash 则会去动主人的目录/会话。speaker 存在即
  // 代表这是群里的一次发言, 必须 isOwner 才放行(fail-closed)。
  const groupSpeaker = (isOwner: boolean): IMMessageEvent['speaker'] => ({
    id: 'member-9001',
    name: '群友',
    isOwner,
  });

  it('群成员的 !stop 静默丢弃: 不掐主人的 turn、不回提示、不落 agent', async () => {
    deliver(makeEvent({ text: '!stop', speaker: groupSpeaker(false) }));
    await flushMicrotasks();

    expect(stopActiveTurn).not.toHaveBeenCalled();
    expect(sendMarkdownText).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(runAgentTurn).not.toHaveBeenCalled();
  });

  it('群成员的 slash 命令同样静默丢弃(不动主人的目录/会话)', async () => {
    deliver(makeEvent({ text: '/project', speaker: groupSpeaker(false) }));
    await flushMicrotasks();

    expect(handleSlashCommand).not.toHaveBeenCalled();
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(sendMarkdownText).not.toHaveBeenCalled();
  });

  it('群主人的 !stop 照常执行', async () => {
    deliver(makeEvent({ text: '!stop', speaker: groupSpeaker(true) }));
    await flushMicrotasks();

    expect(stopActiveTurn).toHaveBeenCalledTimes(1);
    expect(sendMarkdownText).toHaveBeenCalledWith('U123456789', slackUi.agent.stopDone(0), {
      threadTs: '1234.5678',
    });
  });

  it('群主人的 slash 命令照常执行', async () => {
    deliver(makeEvent({ text: '/project', speaker: groupSpeaker(true) }));
    await flushMicrotasks();

    expect(handleSlashCommand).toHaveBeenCalledTimes(1);
  });

  it('无 speaker(私聊/单人对话)放行: 各渠道入站已做过 owner 门', async () => {
    deliver(makeEvent({ text: '!stop' }));
    await flushMicrotasks();

    expect(stopActiveTurn).toHaveBeenCalledTimes(1);
  });

  it('群成员的普通消息不受影响: 仍照常进 agent', async () => {
    deliver(makeEvent({ text: '帮我看看这个', speaker: groupSpeaker(false) }));
    await flushMicrotasks();

    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    expect(stopActiveTurn).not.toHaveBeenCalled();
  });

  // 文本 + unsupported(音视频/超限/未知类型)不是"裸命令": 必须留在原有的
  // unsupportedNotice + agent 路径上, 否则连"你那个音频我处理不了"的反馈一起被吞。
  const unsupportedEntry = [{ type: 'audio', label: '语音（暂不支持）' }] as IMMessageEvent['unsupported'];

  it('群成员发 !stop 但带 unsupported 内容: 不当命令, 照常走 unsupported + agent', async () => {
    deliver(
      makeEvent({ text: '!stop', speaker: groupSpeaker(false), unsupported: unsupportedEntry }),
    );
    await flushMicrotasks();

    expect(stopActiveTurn).not.toHaveBeenCalled();
    // 关键: 没有被主人门静默丢掉 —— 反馈与 agent 路径都还在。
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
  });

  it('群成员发 slash 但带 unsupported 内容: 不当命令, 照常走 unsupported + agent', async () => {
    deliver(
      makeEvent({ text: '/project', speaker: groupSpeaker(false), unsupported: unsupportedEntry }),
    );
    await flushMicrotasks();

    expect(handleSlashCommand).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
  });

  it('主人发 !stop 但带 unsupported 内容: 同样不当命令(判据与门逐字一致)', async () => {
    deliver(
      makeEvent({ text: '!stop', speaker: groupSpeaker(true), unsupported: unsupportedEntry }),
    );
    await flushMicrotasks();

    expect(stopActiveTurn).not.toHaveBeenCalled();
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
  });

  it('群成员带附件发 !stop: 不是命令, 照常进 agent(不被门误伤)', async () => {
    deliver(
      makeEvent({
        text: '!stop',
        speaker: groupSpeaker(false),
        attachments: [{ kind: 'image', absPath: '/tmp/a.png' } as unknown as IMAttachment],
      }),
    );
    await flushMicrotasks();

    expect(stopActiveTurn).not.toHaveBeenCalled();
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
  });

  it('treats !stop with attachments as a normal agent message', async () => {
    deliver(
      makeEvent({
        attachments: [{ kind: 'image' }] as unknown as IMAttachment[],
      }),
    );
    await flushMicrotasks();

    expect(stopActiveTurn).not.toHaveBeenCalled();
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
  });

  it('leaves near-miss texts to the normal agent path', async () => {
    deliver(makeEvent({ text: '!stop 那个任务' }));
    await flushMicrotasks();

    expect(stopActiveTurn).not.toHaveBeenCalled();
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
  });

  it('replies an internal error (and does not crash) when stopActiveTurn throws', async () => {
    stopActiveTurn.mockRejectedValue(new Error('abort exploded'));
    deliver(makeEvent());
    await flushMicrotasks();

    expect(sendMarkdownText).toHaveBeenCalledWith(
      'U123456789',
      slackUi.agent.sendInternalError('abort exploded'),
      { threadTs: '1234.5678' },
    );
    expect(runAgentTurn).not.toHaveBeenCalled();
  });

  // ── 群主流 @ 开话题的开场白卡收口(仅富卡渠道) ────────────────────────────
  // 非流式终态分支若让「思考中」开场白卡留在话题里: 卡卡住, 且同话题下一条
  // 真消息会把答案 patch 到这张旧卡上。终态分支要么消费卡 patch 回复, 要么
  // 撤回卡让自备回复成为第一条实质内容。

  it('!stop 首条消费开场白卡: patch 回复, 不再另发', async () => {
    consumePendingOpenerCard.mockResolvedValue(true);
    deliver(makeEvent({ groupContextLane: { chatId: 'C1', threadId: '' } }));
    await flushMicrotasks();

    expect(consumePendingOpenerCard).toHaveBeenCalledWith(
      'U123456789',
      slackUi.agent.stopDone(0),
    );
    expect(sendMarkdownText).not.toHaveBeenCalled();
    expect(stopActiveTurn).toHaveBeenCalledTimes(1);
  });

  it('consume 返回 false 时回落正常发送(有 pending opener 但消费失败)', async () => {
    deliver(makeEvent({ groupContextLane: { chatId: 'C1', threadId: '' } }));
    await flushMicrotasks();

    expect(consumePendingOpenerCard).toHaveBeenCalledTimes(1);
    expect(sendMarkdownText).toHaveBeenCalledWith('U123456789', slackUi.agent.stopDone(0), {
      threadTs: '1234.5678',
    });
  });

  it('slash 抛错时用内部错误收口开场白卡(sink 未被调用过)', async () => {
    handleSlashCommand.mockRejectedValueOnce(new Error('list projects failed'));
    consumePendingOpenerCard.mockResolvedValue(true);
    deliver(makeEvent({ text: '/ctr', groupContextLane: { chatId: 'C1', threadId: '' } }));
    await flushMicrotasks();

    expect(consumePendingOpenerCard).toHaveBeenCalledWith(
      'U123456789',
      slackUi.agent.sendInternalError('list projects failed'),
    );
    expect(sendMarkdownText).not.toHaveBeenCalled();
    expect(runAgentTurn).not.toHaveBeenCalled();
  });

  it('slash 抛错且 opener 收口返回 false 时补发内部错误', async () => {
    handleSlashCommand.mockRejectedValueOnce(new Error('list projects failed'));
    consumePendingOpenerCard.mockResolvedValue(false);
    deliver(makeEvent({ text: '/ctr', groupContextLane: { chatId: 'C1', threadId: '' } }));
    await flushMicrotasks();

    expect(consumePendingOpenerCard).toHaveBeenCalledWith(
      'U123456789',
      slackUi.agent.sendInternalError('list projects failed'),
    );
    expect(sendMarkdownText).toHaveBeenCalledWith(
      'U123456789',
      slackUi.agent.sendInternalError('list projects failed'),
      { threadTs: '1234.5678' },
    );
    expect(runAgentTurn).not.toHaveBeenCalled();
  });

  it('runAgentTurn 抛错且本条开了话题: 用内部错误收口开场白卡', async () => {
    runAgentTurn.mockRejectedValueOnce(new Error('provider exploded'));
    consumePendingOpenerCard.mockResolvedValue(true);
    deliver(makeEvent({ text: '帮我看看', groupContextLane: { chatId: 'C1', threadId: '' } }));
    await flushMicrotasks();

    expect(consumePendingOpenerCard).toHaveBeenCalledWith(
      'U123456789',
      slackUi.agent.sendInternalError('provider exploded'),
    );
    expect(sendText).not.toHaveBeenCalled();
  });

  it('早期拒绝终态(missing_auth)经 onEarlyReject 收口开场白卡', async () => {
    let capturedArgs: Parameters<ImTurnRunner['runAgentTurn']>[0] | undefined;
    runAgentTurn.mockImplementationOnce(async (args: Parameters<ImTurnRunner['runAgentTurn']>[0]) => {
      capturedArgs = args;
      const consumed = (await args.onEarlyReject?.('missing_auth', 'AUTH_MISSING_TEXT')) ?? false;
      expect(consumed).toBe(true);
    });
    consumePendingOpenerCard.mockResolvedValue(true);
    deliver(makeEvent({ text: '帮我看看', groupContextLane: { chatId: 'C1', threadId: '' } }));
    await flushMicrotasks();

    expect(capturedArgs).toBeDefined();
    expect(consumePendingOpenerCard).toHaveBeenCalledWith('U123456789', 'AUTH_MISSING_TEXT');
  });

  it('同话题后续 !stop 不消费上一轮的 pending opener(归属不抢占)', async () => {
    // 消息 A 已开话题且其 pending opener 尚未被流式认领; 本条 B 是同一话题的
    // 后续消息(groupContextLane 缺省)— B 不得 patch A 的思考卡。
    consumePendingOpenerCard.mockResolvedValue(true);
    deliver(makeEvent({ text: '!stop' }));
    await flushMicrotasks();

    expect(consumePendingOpenerCard).not.toHaveBeenCalled();
    expect(sendMarkdownText).toHaveBeenCalledWith('U123456789', slackUi.agent.stopDone(0), {
      threadTs: '1234.5678',
    });
  });

  it('同话题后续 slash 不注入 opener sink', async () => {
    let capturedCtx: Parameters<typeof handleSlashCommand>[1] | undefined;
    handleSlashCommand.mockImplementation(async (_text: string, ctx: Parameters<typeof handleSlashCommand>[1]) => {
      capturedCtx = ctx;
      return true;
    });
    deliver(makeEvent({ text: '/project' }));
    await flushMicrotasks();

    expect(handleSlashCommand).toHaveBeenCalledTimes(1);
    expect(capturedCtx?.consumePendingOpener).toBeUndefined();
  });

  it('consume patch 抛错时回落正常发送(回复不丢, 认领已完成)', async () => {
    consumePendingOpenerCard.mockRejectedValue(new Error('patch failed'));
    deliver(makeEvent({ groupContextLane: { chatId: 'C1', threadId: '' } }));
    await flushMicrotasks();

    expect(sendMarkdownText).toHaveBeenCalledWith('U123456789', slackUi.agent.stopDone(0), {
      threadTs: '1234.5678',
    });
    expect(runAgentTurn).not.toHaveBeenCalled();
  });

  it('slash 首条注入 opener sink: 首个回复就地消费开场白卡', async () => {
    let capturedCtx: Parameters<typeof handleSlashCommand>[1] | undefined;
    handleSlashCommand.mockImplementation(async (_text: string, ctx: Parameters<typeof handleSlashCommand>[1]) => {
      capturedCtx = ctx;
      return true;
    });
    consumePendingOpenerCard.mockResolvedValue(true);
    deliver(makeEvent({ text: '/project', groupContextLane: { chatId: 'C1', threadId: '' } }));
    await flushMicrotasks();

    expect(handleSlashCommand).toHaveBeenCalledTimes(1);
    expect(runAgentTurn).not.toHaveBeenCalled();

    // sink 存在且首个 withMarkdown 消费开场白卡(第二次起回落)。
    expect(capturedCtx?.consumePendingOpener).toBeDefined();
    await expect(capturedCtx!.consumePendingOpener!.withMarkdown('U123456789', '回复')).resolves.toBe(true);
    expect(consumePendingOpenerCard).toHaveBeenCalledWith('U123456789', '回复');
    await expect(capturedCtx!.consumePendingOpener!.withMarkdown('U123456789', '第二条')).resolves.toBe(false);
    expect(consumePendingOpenerCard).toHaveBeenCalledTimes(1);
  });

  it('纯 unsupported 首条消费开场白卡: patch 提示, 不再另发', async () => {
    consumePendingOpenerCard.mockResolvedValue(true);
    deliver(
      makeEvent({
        text: '',
        unsupported: [{ type: 'audio', label: '语音（暂不支持）' }] as IMMessageEvent['unsupported'],
        groupContextLane: { chatId: 'C1', threadId: '' },
      }),
    );
    await flushMicrotasks();

    expect(consumePendingOpenerCard).toHaveBeenCalledWith(
      'U123456789',
      slackUi.agent.unsupportedOnly([{ type: 'audio', label: '语音（暂不支持）' }]),
    );
    expect(sendText).not.toHaveBeenCalled();
    expect(runAgentTurn).not.toHaveBeenCalled();
  });

  it('同话题后续 !stop 不消费上一轮的 pending opener(归属不抢占)', async () => {
    // 消息 A 已开话题且其 pending opener 尚未被流式认领; 本条 B 是同一话题的
    // 后续消息(groupContextLane 缺省)— B 不得 patch A 的思考卡。
    consumePendingOpenerCard.mockResolvedValue(true);
    deliver(makeEvent({ text: '!stop' }));
    await flushMicrotasks();

    expect(consumePendingOpenerCard).not.toHaveBeenCalled();
    expect(sendMarkdownText).toHaveBeenCalledWith('U123456789', slackUi.agent.stopDone(0), {
      threadTs: '1234.5678',
    });
  });

  it('同话题后续 slash 不注入 opener sink', async () => {
    let capturedCtx: Parameters<typeof handleSlashCommand>[1] | undefined;
    handleSlashCommand.mockImplementation(async (_text: string, ctx: Parameters<typeof handleSlashCommand>[1]) => {
      capturedCtx = ctx;
      return true;
    });
    deliver(makeEvent({ text: '/project' }));
    await flushMicrotasks();

    expect(handleSlashCommand).toHaveBeenCalledTimes(1);
    expect(capturedCtx?.consumePendingOpener).toBeUndefined();
  });

  it('同话题后续纯 unsupported 不消费上一轮的 pending opener', async () => {
    consumePendingOpenerCard.mockResolvedValue(true);
    deliver(
      makeEvent({
        text: '',
        unsupported: [{ type: 'audio', label: '语音（暂不支持）' }] as IMMessageEvent['unsupported'],
      }),
    );
    await flushMicrotasks();

    expect(consumePendingOpenerCard).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(runAgentTurn).not.toHaveBeenCalled();
  });
});
