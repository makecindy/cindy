/**
 * botCollaborationMessages.test.ts
 * ---------------------------------------------------------------------------
 * 伙伴协作在消息流里的投影：主进程把结构化标记写进 `agent_meta.botCollaboration`，
 * mapServerMessages 据此派生协作卡与客座气泡。
 *
 * 这组用例锁住三件事：
 *  - 判据只认结构化标记，不认正文（否则任何人贴一段方括号文本就能冒充别的伙伴）；
 *  - 客座气泡显示的是伙伴说的那句话，不是给 agent 读的机读协议全文；
 *  - **没有标记的老镜像消息照旧按普通文本渲染** —— 本批不回填历史。
 */

import { describe, expect, it } from 'vitest';

import { makerChatStore } from '@/lib/makerChatStore';
import type { Message } from '@/lib/ccAgent.types';
import {
  readBotCollaborationMeta,
  readBotDelegationCompletionBody,
} from '../../shared/botCollaboration';

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

describe('readBotDelegationCompletionBody', () => {
  it('pulls the teammate answer out of the machine-readable completion payload', () => {
    const completion = [
      '[Cindy Bot delegation delegation-1 completed]',
      'Target Bot: bot-planner',
      'Objective: 给伙伴协作做一版方案',
      'Result:\n方案定三条。',
      'Child task: child-1',
    ].join('\n\n');
    expect(readBotDelegationCompletionBody(completion)).toEqual({
      text: '方案定三条。',
      error: null,
    });
  });

  it('keeps the failure reason and never swallows an unrecognized payload', () => {
    const failed = [
      '[Cindy Bot delegation delegation-1 failed]',
      'Target Bot: bot-planner',
      'Objective: 做点什么',
      'Error: Bot delegation exceeded its configured timeout.',
    ].join('\n\n');
    expect(readBotDelegationCompletionBody(failed)).toEqual({
      text: '',
      error: 'Bot delegation exceeded its configured timeout.',
    });
    expect(readBotDelegationCompletionBody('普通一句话')).toEqual({
      text: '普通一句话',
      error: null,
    });
    // 形状对但内容缺失时原样返回，宁可露出协议文本也不要凭空吞掉内容。
    expect(
      readBotDelegationCompletionBody('[Cindy Bot delegation d1 completed]\n\nTarget Bot: b'),
    ).toEqual({ text: '[Cindy Bot delegation d1 completed]\n\nTarget Bot: b', error: null });
  });
});

describe('mapServerMessages — Bot collaboration', () => {
  it('derives the inline collaboration card from the delegation anchor row', () => {
    const [mapped] = makerChatStore.__mapServerMessagesForTest([
      row({ clientId: 'bot-delegation-request:delegation-1', agentMeta: { botCollaboration: META } }),
    ]);
    expect(mapped.systemCardType).toBe('bot-collab');
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
    expect(mapped.systemCardType).toBe('bot-collab');
    expect(mapped.systemCardData).toMatchObject({
      role: 'interjection',
      text: '先别铺开，我只要三条。',
    });
  });

  it('turns the completion mirror into a guest bubble carrying only the answer', () => {
    const [mapped] = makerChatStore.__mapServerMessagesForTest([
      row({
        clientId: 'bot-delegation-completion:delegation-1',
        role: 'user',
        content: [
          '[Cindy Bot delegation delegation-1 completed]',
          'Target Bot: bot-planner',
          'Objective: 给伙伴协作做一版方案',
          'Result:\n方案定三条。',
          'Child task: child-1',
        ].join('\n\n'),
        agentMeta: { botCollaboration: { ...META, role: 'guest-result' } },
      }),
    ]);
    expect(mapped.guestBot).toEqual({
      botId: 'bot-planner',
      name: 'Planner',
      delegationId: 'delegation-1',
      linkedSessionId: 'child-1',
    });
    expect(mapped.content).toBe('方案定三条。');
    expect(mapped.systemCardType).toBeUndefined();
  });

  it('turns the inbound request into the same live collaboration card', () => {
    const [mapped] = makerChatStore.__mapServerMessagesForTest([
      row({
        clientId: 'bot-delegation-target-request:delegation-1',
        role: 'assistant',
        content: '',
        agentMeta: { botCollaboration: { ...META, role: 'guest-request' } },
      }),
    ]);
    expect(mapped.systemCardType).toBe('bot-collab');
    expect(mapped.systemCardData).toMatchObject({
      role: 'guest-request',
      fromBotName: 'Cindy',
      parentSessionId: SESSION_ID,
      childSessionId: 'child-1',
    });
    expect(mapped.guestBot).toBeUndefined();
  });

  it('turns the inbound result mirror into a collaboration report, not a wall of text', () => {
    const [mapped] = makerChatStore.__mapServerMessagesForTest([
      row({
        clientId: 'bot-delegation-target-result:delegation-1',
        role: 'assistant',
        content: '',
        agentMeta: { botCollaboration: { ...META, role: 'result-mirror' } },
      }),
    ]);
    expect(mapped.systemCardType).toBe('bot-collab');
    expect(mapped.systemCardData).toMatchObject({ role: 'result-mirror' });
    expect(mapped.content).toBe('');
  });

  it('leaves pre-marker mirror rows exactly as they were', () => {
    const legacy = [
      '[Cindy Bot delegation legacy-1 completed]',
      'Target Bot: bot-planner',
      'Result:\n老数据没有标记。',
    ].join('\n\n');
    const [mapped] = makerChatStore.__mapServerMessagesForTest([
      row({ clientId: 'bot-delegation-completion:legacy-1', role: 'user', content: legacy }),
    ]);
    expect(mapped.guestBot).toBeUndefined();
    expect(mapped.systemCardType).toBeUndefined();
    expect(mapped.content).toBe(legacy);
  });
});
