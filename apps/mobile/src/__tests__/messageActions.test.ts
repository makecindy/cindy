import { beforeAll, describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import {
  buildMobileMessageControlItems,
  buildMobileMessageCopyText,
  copyMessageText,
  formatMessageAbsoluteTime,
  formatMessageRelativeTime,
  formatMessageTurnCostUsd,
} from '@/session/messageActions';
import type { NormalizedRemoteMessage } from '@/session/messageNormalize';

// 文案已 i18n 化;固定 zh-CN 让字面量断言与语言环境解耦(全局 mock 默认 en-US)。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

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
    expect(formatMessageTurnCostUsd(12.34)).toBe('$12');
    expect(formatMessageTurnCostUsd(0.034)).toBe('$0.03');
    expect(formatMessageTurnCostUsd(0.0034)).toBe('$0.003');
    expect(formatMessageTurnCostUsd(0.0004)).toBe('<$0.001');
    expect(formatMessageTurnCostUsd(0.034, true)).toBe('价值 $0.03');
    expect(formatMessageTurnCostUsd(0)).toBe('');
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
