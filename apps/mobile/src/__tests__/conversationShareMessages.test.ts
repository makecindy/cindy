import { describe, expect, it } from 'vitest';

import {
  collectConversationShareBlockIds,
  collectConversationShareMessages,
} from '@/session/conversationShareMessages';
import type {
  MobileMessageItem,
  MobileMessageRenderItem,
  MobileSubagentGroupItem,
  MobileWorkGroupItem,
} from '@/session/messageRenderModel';
import type { NormalizedRemoteMessage } from '@/session/messageNormalize';

function messageItem(
  clientId: string,
  kind: 'assistant' | 'user',
  options: Partial<NormalizedRemoteMessage> = {},
): MobileMessageItem {
  const message = {
    body: clientId,
    key: clientId,
    kind,
    source: { clientId, id: clientId },
    ...options,
  } as NormalizedRemoteMessage;
  return { key: `message-${clientId}`, message, type: 'message' };
}

function workGroup(
  key: string,
  children: MobileWorkGroupItem['children'],
): MobileWorkGroupItem {
  return { children, key, type: 'work_group' };
}

function subagentGroup(
  key: string,
  childItems: MobileMessageRenderItem[],
): MobileSubagentGroupItem {
  return {
    childItems,
    header: { description: null, subagentType: null },
    key,
    status: 'completed',
    summary: null,
    type: 'subagent_group',
  };
}

function projectedIds(
  items: readonly MobileMessageRenderItem[],
  expandedIds: readonly string[],
): string[] {
  const expanded = new Set(expandedIds);
  return collectConversationShareMessages(items, (blockId) =>
    expanded.has(blockId),
  ).map((message) => message.clientId);
}

describe('collectConversationShareMessages', () => {
  it('未挂载的长用户消息按桌面收起档位保守投影', () => {
    const longBody = Array.from({ length: 15 }, (_, index) => `line ${index + 1}`).join('\n');
    const automationBody = Array.from({ length: 6 }, (_, index) => `step ${index + 1}`).join('\n');
    const messages = collectConversationShareMessages([
      messageItem('long-user', 'user', { body: longBody }),
      messageItem('automation-user', 'user', {
        automationOrigin: { scheduleId: 'daily' },
        body: automationBody,
      }),
      messageItem('assistant', 'assistant', { body: longBody }),
    ], () => false);

    expect(messages[0]?.body.split('\n')).toHaveLength(10);
    expect(messages[1]?.body.split('\n')).toHaveLength(3);
    expect(messages[2]?.body).toBe(longBody);
  });

  it('窄屏下也按保守宽度截取未挂载的单行长消息', () => {
    const narrowBody = 'a'.repeat(450);
    const [message] = collectConversationShareMessages([
      messageItem('narrow-user', 'user', { body: narrowBody }),
    ], () => false);

    expect(message?.body.length).toBeLessThan(narrowBody.length);
  });

  it('只投影当前展开 work group 中的消息，并逐层尊重嵌套折叠态', () => {
    const nested = workGroup('work-nested', [
      messageItem('nested-assistant', 'assistant'),
    ]);
    const outer = workGroup('work-outer', [
      messageItem('direct-assistant', 'assistant'),
      nested,
    ]);
    const items = [messageItem('visible-user', 'user'), outer];

    expect(projectedIds(items, [])).toEqual(['visible-user']);
    expect(projectedIds(items, ['work-outer'])).toEqual([
      'visible-user',
      'direct-assistant',
    ]);
    expect(projectedIds(items, ['work-outer', 'work-nested'])).toEqual([
      'visible-user',
      'direct-assistant',
      'nested-assistant',
    ]);
  });

  it('折叠 subagent group 时排除隐藏消息，展开后才加入候选集', () => {
    const nested = subagentGroup('subagent-nested', [
      messageItem('nested-user', 'user'),
    ]);
    const outer = subagentGroup('subagent-outer', [
      messageItem('direct-assistant', 'assistant'),
      nested,
    ]);

    expect(projectedIds([outer], [])).toEqual([]);
    expect(projectedIds([outer], ['subagent-outer'])).toEqual([
      'direct-assistant',
    ]);
    expect(
      projectedIds([outer], ['subagent-outer', 'subagent-nested']),
    ).toEqual(['direct-assistant', 'nested-user']);
  });

  it('收集所有会影响分享候选集的折叠卡 key', () => {
    const items = [
      workGroup('work-outer', [workGroup('work-nested', [])]),
      subagentGroup('subagent-outer', [subagentGroup('subagent-nested', [])]),
    ];

    expect(collectConversationShareBlockIds(items)).toEqual([
      'work-outer',
      'work-nested',
      'subagent-outer',
      'subagent-nested',
    ]);
  });
});
