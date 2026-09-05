/**
 * botCollaborationMessages.test.ts
 * ---------------------------------------------------------------------------
 * 伙伴后台任务在消息流里的投影：主进程把结构化标记写进
 * `agent_meta.botCollaboration`，mapServerMessages 据此派生唯一任务卡与补充消息留痕。
 *
 * 这组用例锁住三件事：
 *  - 判据只认结构化标记，不认正文（否则任何人贴一段方括号文本就能冒充别的伙伴）；
 *  - 给 agent 读的完成指令不会泄漏到用户时间线；
 *  - 历史目标侧镜像不再重复投影任务卡。
 */

import { describe, expect, it } from 'vitest';

import { makerChatStore } from '@/lib/makerChatStore';
import type { Message } from '@/lib/ccAgent.types';
import { readBotCollaborationMeta } from '../../shared/botCollaboration';
import { readBotDirectMessageMeta } from '../../shared/botDirectMessage';
import { UI_ACTION_TRIGGER_PREFIX } from '../../shared/interruptedTurn';

const SESSION_ID = 'parent-session';

const META = {
  v: 1 as const,
  role: 'delegation-request' as const,
  delegationId: 'delegation-1',
  fromBotId: 'bot-cindy',
  fromBotName: 'Cindy',
  toBotId: 'bot-planner',
  toBotName: 'Planner',
  parentSessionId: SESSION_ID,
  childSessionId: 'child-1',
  objective: '给伙伴协作做一版方案',
};

function row(overrides: Partial<Message> & { clientId: string }): Message {
  return {
    id: `row-${overrides.clientId}`,
    sessionId: SESSION_ID,
    role: 'assistant',
    content: '',
    createdAt: '2026-08-19T00:00:00.000Z',
    ...overrides,
  } as unknown as Message;
}

describe('readBotCollaborationMeta', () => {
  it('refuses anything that is not an exact v1 marker', () => {
    expect(readBotCollaborationMeta(undefined)).toBeNull();
    expect(readBotCollaborationMeta({ ...META, v: 2 })).toBeNull();
    expect(readBotCollaborationMeta({ ...META, role: 'whatever' })).toBeNull();
    expect(readBotCollaborationMeta({ ...META, delegationId: '' })).toBeNull();
    expect(readBotCollaborationMeta({ ...META, parentSessionId: 7 })).toBeNull();
    expect(readBotCollaborationMeta({ ...META, childSessionId: null })).toMatchObject({
      childSessionId: null,
    });
  });
});

describe('readBotDirectMessageMeta', () => {
  const direct = {
    v: 1 as const,
    threadId: 'dm-1',
    viewerBotId: 'bot-cindy',
    peerBotId: 'bot-planner',
    peerBotName: 'Planner',
    direction: 'sent' as const,
    sequence: 1,
    preview: '对齐一下发布口径。',
  };

  it('accepts only a complete v1 timeline marker', () => {
    expect(readBotDirectMessageMeta(direct)).toEqual(direct);
    expect(readBotDirectMessageMeta({ ...direct, v: 2 })).toBeNull();
    expect(readBotDirectMessageMeta({ ...direct, viewerBotId: '' })).toBeNull();
    expect(readBotDirectMessageMeta({ ...direct, direction: 'sideways' })).toBeNull();
  });
});

describe('readBotDelegationCompletionBody(已移除) —— 完成回执不再有机读正文', () => {
  it('机读协议文本不再出现:完成回执统一走 synthetic-trigger 隐藏行', () => {
    // 旧协议把 [Cindy Bot delegation …] 机读块落进可见时间线;新协议下这类
    // 正文不存在了,这里只钉住取代它的隐藏前缀确实是全端统一的那一个。
    expect(UI_ACTION_TRIGGER_PREFIX).toBe('[UI_ACTION_TRIGGER]');
  });
});

describe('mapServerMessages — Bot collaboration', () => {
  it('derives a private-conversation entrance without putting its preview in the timeline', () => {
    const [mapped] = makerChatStore.__mapServerMessagesForTest([
      row({
        clientId: 'bot-dm-thread:dm-1:parent-session',
        content: '',
        agentMeta: {
          botDirectMessage: {
            v: 1,
            threadId: 'dm-1',
            viewerBotId: 'bot-cindy',
            peerBotId: 'bot-planner',
            peerBotName: 'Planner',
            direction: 'sent',
            sequence: 1,
            preview: '对齐一下发布口径。',
          },
        },
      }),
    ]);
    expect(mapped.content).toBe('');
    expect(mapped.systemCardType).toBe('bot-direct-message');
    expect(mapped.systemCardData).toMatchObject({ threadId: 'dm-1', peerBotName: 'Planner' });
  });

  it('derives the tracked task card from the delegation anchor row', () => {
    const [mapped] = makerChatStore.__mapServerMessagesForTest([
      row({
        clientId: 'bot-delegation-request:delegation-1',
        agentMeta: { botCollaboration: META },
      }),
    ]);
    expect(mapped.systemCardType).toBe('bot-session-task');
    expect(mapped.systemCardData).toMatchObject({
      role: 'delegation-request',
      delegationId: 'delegation-1',
      toBotName: 'Planner',
    });
  });

  it('derives the nudge trace and keeps the sentence that was actually sent', () => {
    const [mapped] = makerChatStore.__mapServerMessagesForTest([
      row({
        clientId: 'bot-delegation-interject-mirror:delegation-1:n1',
        content: '先别铺开，我只要三条。',
        agentMeta: { botCollaboration: { ...META, role: 'interjection' } },
      }),
    ]);
    expect(mapped.systemCardType).toBe('bot-session-task-message');
    expect(mapped.systemCardData).toMatchObject({
      role: 'interjection',
      text: '先别铺开，我只要三条。',
    });
  });

  it('hides the delegation completion instruction from the visible stream', () => {
    // 完成回传是给模型的内部指令,不是给人的消息:可见终态由协作卡承载。
    // 它复用 synthetic-trigger 隐藏行判定,和「继续任务」那类合成指令同一条链。
    const [mapped] = makerChatStore.__mapServerMessagesForTest([
      row({
        clientId: 'bot-delegation-completion:delegation-1',
        role: 'user',
        content: `${UI_ACTION_TRIGGER_PREFIX}[协作回执] 你委派给「Planner」的工作已完成。\n\n结果:\n方案定三条。`,
      }),
    ]);
    // 行保留在时序里(error-tail 判定需要它),但正文清空、标成合成指令,
    // MessageStream 对它渲染 null —— 用户看不到任何机读文本。
    expect(mapped.isSyntheticTrigger).toBe(true);
    expect(mapped.content).toBe('');
    expect(mapped.systemCardType).toBeUndefined();
  });

  it('does not turn a historical target-side request mirror into another task card', () => {
    const [mapped] = makerChatStore.__mapServerMessagesForTest([
      row({
        clientId: 'bot-delegation-target-request:delegation-1',
        role: 'assistant',
        content: '',
        agentMeta: { botCollaboration: { ...META, role: 'guest-request' } },
      }),
    ]);
    expect(mapped.systemCardType).toBeUndefined();
  });

  it('does not turn a historical target-side result mirror into another task card', () => {
    const [mapped] = makerChatStore.__mapServerMessagesForTest([
      row({
        clientId: 'bot-delegation-target-result:delegation-1',
        role: 'assistant',
        content: '',
        agentMeta: { botCollaboration: { ...META, role: 'result-mirror' } },
      }),
    ]);
    expect(mapped.systemCardType).toBeUndefined();
    expect(mapped.content).toBe('');
  });
});
