/**
 * findLastUserInputClientId.test.ts
 * ---------------------------------------------------------------------------
 * 自愈重连行的「此刻是不是我在飞」判据。
 *
 * 与同目录 findLastUserMessageClientId.test.ts 是**刻意成对**的两份：那份服务于「编辑
 * 最后一条消息」这个可见 affordance，必须跳过渲染成 null 的合成行；本份要回答「正在跑的
 * 这个 turn 是不是自动续跑发起的」——合成行恰恰是那个 turn 的发起者，跳过就答不了。
 * 两份对同一份消息列表给出不同答案是正确的，改动时不要"统一"它们。
 */

import { describe, expect, it } from 'vitest';
import {
  findLastUserInputClientId,
  findLastUserMessageClientId,
  isAutoResumeRowInFlight,
} from '../components/chat/MessageStream';
import type { ChatMessage } from '@/lib/makerChatStore';

const mk = (clientId: string, role: ChatMessage['role']): ChatMessage =>
  ({ clientId, role, content: clientId, isStreaming: false }) as ChatMessage;
const synthetic = (clientId: string): ChatMessage =>
  ({ ...mk(clientId, 'user'), isSyntheticTrigger: true }) as ChatMessage;

describe('findLastUserInputClientId', () => {
  it('空列表 / 没有 user 行 → null', () => {
    expect(findLastUserInputClientId([])).toBeNull();
    expect(findLastUserInputClientId([mk('a1', 'assistant'), mk('t1', 'thinking')])).toBeNull();
  });

  it('**含**合成行:自动续跑指令是最后一条用户侧输入', () => {
    const messages = [mk('u1', 'user'), mk('a1', 'assistant'), synthetic('resume1')];
    expect(findLastUserInputClientId(messages)).toBe('resume1');
    // 同一份列表,编辑入口那份刻意给出不同答案(它要的是可见的真实 user 行)。
    expect(findLastUserMessageClientId(messages)).toBe('u1');
  });

  it('续跑之后只有 thinking / tool 行 → 仍是续跑那条(它还在飞)', () => {
    const messages = [
      mk('u1', 'user'),
      mk('a1', 'assistant'),
      synthetic('resume1'),
      mk('th1', 'thinking'),
      mk('t1', 'tool_use'),
      mk('r1', 'tool_result'),
    ];
    expect(findLastUserInputClientId(messages)).toBe('resume1');
  });

  it('用户自己接手后 → 换成他那条,旧的重连行随之停转', () => {
    // 这是"只看会话在跑"会出错的场景:正在跑的已经是用户那个 turn 了。
    const messages = [synthetic('resume1'), mk('th1', 'thinking'), mk('u2', 'user')];
    expect(findLastUserInputClientId(messages)).toBe('u2');
  });

  it('插话(steer)不夺走归属:自愈 turn 里插一句,重连行仍在飞', () => {
    // steer 是同一个正在跑的 turn 内的追加输入,不是新 turn 的发起者。算进来的话正在跑的
    // 重连行会提前停转、退回静态(codex P2 / greptile P1)。这一支还是兜底判据成立的关键:
    // steer 被接受时 coordinator 会替换 activeTurn,首选判据(continuationInFlight)随之失效。
    const steer = { ...mk('s1', 'user'), delivery: 'steer' } as ChatMessage;
    const messages = [mk('u1', 'user'), synthetic('resume1'), steer];
    expect(findLastUserInputClientId(messages)).toBe('resume1');
  });

  it('插话之后又来一条真实用户消息(delivery=turn)→ 正常交接', () => {
    const steer = { ...mk('s1', 'user'), delivery: 'steer' } as ChatMessage;
    const real = { ...mk('u2', 'user'), delivery: 'turn' } as ChatMessage;
    const messages = [synthetic('resume1'), steer, real];
    expect(findLastUserInputClientId(messages)).toBe('u2');
  });

  it('连续两次重连 → 取后一条', () => {
    const messages = [synthetic('resume1'), synthetic('resume2')];
    expect(findLastUserInputClientId(messages)).toBe('resume2');
  });
});

describe('isAutoResumeRowInFlight', () => {
  const base = {
    isContinuationTurnOwner: false,
    sessionRunning: true,
    isLastUserInput: true,
    projectionCapability: 'supported' as const,
  };

  it('main owner 精确匹配覆盖已进入运行态、正文尚未到达的窗口', () => {
    expect(
      isAutoResumeRowInFlight({
        ...base,
        isContinuationTurnOwner: true,
      }),
    ).toBe(true);
  });

  it('renderer done 终态同步清除 stale continuation owner', async () => {
    const { EMPTY_SESSION_STATE, handleStreamEvent } = await import('@/lib/makerChatStore');
    const next = handleStreamEvent(
      {
        ...EMPTY_SESSION_STATE,
        continuationTurnClientId: 'resume-1',
        isStreaming: true,
        agentStatus: {
          ...EMPTY_SESSION_STATE.agentStatus,
          isRunning: true,
        },
      },
      { sessionId: 's1', type: 'done', data: {} },
    );

    expect(next.continuationTurnClientId).toBeNull();
    expect(next.agentStatus.isRunning).toBe(false);
  });

  it('新版 supported 未匹配 owner → 不把无关 Goal turn 误判成重连', () => {
    expect(isAutoResumeRowInFlight(base)).toBe(false);
  });

  it('尚未收到投影的 unknown fail closed', () => {
    expect(isAutoResumeRowInFlight({ ...base, projectionCapability: 'unknown' })).toBe(false);
  });

  it('旧被控端字段缺省时保留 running + last-input 兼容兜底', () => {
    expect(isAutoResumeRowInFlight({ ...base, projectionCapability: 'legacy' })).toBe(true);
  });

  it('旧端兼容兜底仍要求会话在跑且该行是最后一条非 steer 输入', () => {
    expect(
      isAutoResumeRowInFlight({
        ...base,
        projectionCapability: 'legacy',
        sessionRunning: false,
      }),
    ).toBe(false);
    expect(
      isAutoResumeRowInFlight({
        ...base,
        projectionCapability: 'legacy',
        isLastUserInput: false,
      }),
    ).toBe(false);
  });
});
