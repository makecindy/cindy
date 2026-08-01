import { beforeAll, describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import {
  buildMobileMessageControlItems,
  buildMobileMessageCopyText,
  copyMessageText,
  formatMessageAbsoluteTime,
  formatMessageRelativeTime,
  formatMessageTurnCost,
  formatMessageTurnTokens,
  mobileMessageShowsActionBar,
} from '@/session/messageActions';
import type { NormalizedRemoteMessage } from '@/session/messageNormalize';
import type { RemoteMoney, RemoteMoneyCurrency } from '@/session/remoteMoney';

// 文案已 i18n 化;固定 zh-CN 让字面量断言与语言环境解耦(全局 mock 默认 en-US)。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

function money(
  amount: number,
  currency: RemoteMoneyCurrency = 'USD',
  estimate = false,
): RemoteMoney {
  return {
    amount,
    currency,
    approximate: estimate,
    kind: estimate ? 'value-estimate' : 'actual-cost',
  };
}

describe('messageActions', () => {
  it('builds completed-message controls in stable desktop-compatible order', () => {
    expect(buildMobileMessageControlItems({
      canCopy: true,
      canFork: true,
      canRewind: true,
      isStreaming: false,
    })).toEqual(['copy', 'rewind', 'fork']);

    expect(buildMobileMessageControlItems({
      canCopy: true,
      canFork: true,
      canRewind: true,
      isStreaming: true,
    })).toEqual([]);
  });

  it('hangs the completed action bar only on real turn-final utterances', () => {
    const base = {
      hasSystemCard: false,
      isStreamingAssistant: false,
      isTurnFinalAssistant: false,
    };

    // user 消息与本轮收尾正文照常挂。
    expect(mobileMessageShowsActionBar({ ...base, kind: 'user' })).toBe(true);
    expect(mobileMessageShowsActionBar({
      ...base,
      kind: 'assistant',
      isTurnFinalAssistant: true,
    })).toBe(true);

    // turn 中间句不挂;流式 assistant 只显示「生成中」也不挂。
    expect(mobileMessageShowsActionBar({ ...base, kind: 'assistant' })).toBe(false);
    expect(mobileMessageShowsActionBar({
      ...base,
      kind: 'assistant',
      isStreamingAssistant: true,
      isTurnFinalAssistant: true,
    })).toBe(false);

    // 系统边界卡整行不挂:跨 Agent 切换分隔线(kind='system')、goal 卡(role
    // assistant 派生),以及「user 行渲染系统卡」被渲染层降级前后的 auto-resume 行。
    expect(mobileMessageShowsActionBar({ ...base, hasSystemCard: true, kind: 'system' })).toBe(false);
    expect(mobileMessageShowsActionBar({
      ...base,
      hasSystemCard: true,
      kind: 'assistant',
      isTurnFinalAssistant: true,
    })).toBe(false);
    expect(mobileMessageShowsActionBar({ ...base, hasSystemCard: true, kind: 'user' })).toBe(false);
  });

  it('builds desktop-compatible copy text with attachment names', () => {
    expect(buildMobileMessageCopyText(normalizedMessage({
      body: 'Please inspect this.',
      attachments: [
        { kind: 'file', name: 'app.ts', path: '/repo/app.ts', previewable: false },
        { kind: 'image', name: 'screen.png', uri: 'file://screen.png', previewable: true },
      ],
    }))).toBe('Please inspect this.\n\n附件：app.ts, screen.png');
  });

  it('includes secondary body when copying structured messages', () => {
    expect(buildMobileMessageCopyText(normalizedMessage({
      body: 'Tool input',
      secondaryBody: 'Tool output',
    }))).toBe('Tool input\n\nTool output');
  });

  it('keeps copied quote Markdown readable without exposing private marker lines', () => {
    expect(buildMobileMessageCopyText(normalizedMessage({
      body: [
        '> <!-- cindy-composer-quote -->',
        '> first quote',
        '',
        'first reply',
        '',
        '> <!-- cindy-composer-quote -->',
        '> second quote',
        '',
        'second reply',
      ].join('\n'),
      quotesEncoded: true,
    }))).toBe([
      '> first quote',
      '',
      'first reply',
      '',
      '> second quote',
      '',
      'second reply',
    ].join('\n'));

    const handwritten = '> <!-- cindy-composer-quote -->\n> handwritten';
    expect(buildMobileMessageCopyText(normalizedMessage({
      body: handwritten,
      quotesEncoded: false,
    }))).toBe(handwritten);
  });

  it('returns explicit copy statuses', async () => {
    await expect(copyMessageText('  ')).resolves.toBe('empty');
    await expect(copyMessageText('hello', async () => undefined)).resolves.toBe('copied');
    await expect(copyMessageText('hello', async () => {
      throw new Error('denied');
    })).resolves.toBe('failed');
  });

  it('formats relative and absolute message times', () => {
    const now = new Date('2026-06-16T12:00:00.000Z').getTime();
    expect(formatMessageRelativeTime('2026-06-16T11:59:31.000Z', now)).toBe('刚刚');
    expect(formatMessageRelativeTime('2026-06-16T11:42:00.000Z', now)).toBe('18 分钟前');
    expect(formatMessageRelativeTime('2026-06-16T09:00:00.000Z', now)).toBe('3 小时前');
    expect(formatMessageRelativeTime('2026-06-15T09:00:00.000Z', now)).toContain('06-15');
    expect(formatMessageAbsoluteTime('2026-06-16T09:00:05.000Z')).toContain('2026-06-16');
  });

  it('formats per-turn cost like the desktop action bar', () => {
    expect(formatMessageTurnCost(money(12.34))).toBe('$12');
    expect(formatMessageTurnCost(money(0.034))).toBe('$0.03');
    expect(formatMessageTurnCost(money(0.0034))).toBe('$0.003');
    expect(formatMessageTurnCost(money(0.0004))).toBe('<$0.001');
    expect(formatMessageTurnCost(money(0.034, 'USD', true))).toBe('价值 $0.03');
    expect(formatMessageTurnCost(money(0.034, 'CNY'))).toBe('¥0.03');
    expect(formatMessageTurnCost(money(0))).toBe('');
  });

  // 金额缺席时(桌面算不出模型报价)操作行退回显示本轮 token,数字口径与桌面同源。
  it('formats the per-turn token fallback like the desktop action bar', () => {
    expect(formatMessageTurnTokens(2_107_700)).toBe('2.1M tokens');
    expect(formatMessageTurnTokens(12_400)).toBe('12.4k tokens');
    expect(formatMessageTurnTokens(842)).toBe('842 tokens');
    // 没有可展示的事实时给空串,由调用方决定不渲染那一格。
    expect(formatMessageTurnTokens(0)).toBe('');
    expect(formatMessageTurnTokens(-1)).toBe('');
    expect(formatMessageTurnTokens(undefined)).toBe('');
    expect(formatMessageTurnTokens(Number.NaN)).toBe('');
  });
});

function normalizedMessage(overrides: Partial<NormalizedRemoteMessage>): NormalizedRemoteMessage {
  return {
    key: 'm1',
    source: {
      id: 'm1',
      clientId: 'm1',
      sessionId: 's1',
      role: 'user',
      content: 'Please inspect this.',
      toolUseId: null,
      agentMeta: null,
      createdAt: '2026-06-16T12:00:00.000Z',
    },
    kind: 'user',
    role: 'user',
    label: 'user',
    body: 'Please inspect this.',
    align: 'user',
    createdAt: '2026-06-16T12:00:00.000Z',
    ...overrides,
  };
}
