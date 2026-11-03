import { describe, expect, it } from 'vitest';
import { formatQuoteForSend } from '@cindy/maker-shared/chat-quotes';
import {
  compactSessionMessageLabel,
  mobileSessionMessageDisplayText,
  sentSessionMessageChipLabel,
  splitAnchoredSessionMessageLinks,
} from '@/session/sessionMessageText';
import type { RemoteMessage } from '@/session/types';

function message(input: Partial<RemoteMessage>): RemoteMessage {
  return { id: 'm', role: 'user', content: '', createdAt: '2026-07-23T00:00:00Z', ...input } as RemoteMessage;
}

describe('mobile session message labels', () => {
  it('uses visible prose and hides quote markers', () => {
    expect(mobileSessionMessageDisplayText(message({
      content: JSON.stringify({
        text: `${formatQuoteForSend({ text: 'source' })}\n\nanswer`,
        quotesEncoded: true,
      }),
    }))).toBe('answer');
  });

  it('does not stringify tool metadata', () => {
    expect(mobileSessionMessageDisplayText(message({ role: 'tool_use', content: { secret: true } }))).toBeNull();
  });

  it('shows anchored message labels as short plain text instead of raw Markdown', () => {
    const label = sentSessionMessageChipLabel(
      '**1. 深色·打开过程**：第一帧\n\n![深色-打开过程](cindy-media://blobs/0b12b71b6dcbf531eb89a2ed3b9ba7b1)',
    );
    expect(label).toBe('1. 深色·打开过程：第一帧 深色-打开过程');
    expect(sentSessionMessageChipLabel('上次我用的是 Claude Code 自带的 `SendUserFile` 发文件，工具返回了已送达'))
      .toBe('上次我用的是 Claude Code 自带的…');
    expect(Array.from(sentSessionMessageChipLabel('😀'.repeat(40)))).toHaveLength(24);
  });

  it('keeps composer and task-title labels at the original length and text', () => {
    const title = `任务 *标题* ${'长'.repeat(60)}`;
    expect(compactSessionMessageLabel(title)).toBe(title);
    expect(compactSessionMessageLabel('![](cindy-media://blobs/abc)')).toBe('![](cindy-media://blobs/abc)');
    expect(compactSessionMessageLabel('x'.repeat(300))).toHaveLength(240);
  });

  it('returns no label when the message has no readable text, never the raw Markdown source', () => {
    expect(sentSessionMessageChipLabel('![](cindy-media://blobs/abc)')).toBe('');
    expect(sentSessionMessageChipLabel('  \n ')).toBe('');
  });

  it('strips images nested inside emphasis, strong and raw <img> tags', () => {
    expect(sentSessionMessageChipLabel('**![](cindy-media://blobs/abc)**')).toBe('');
    expect(sentSessionMessageChipLabel('*![图](cindy-media://blobs/x)* 后文')).toBe('图 后文');
    expect(sentSessionMessageChipLabel('**<img src="cindy-media://blobs/x">** 尾')).toBe('尾');
    expect(sentSessionMessageChipLabel('**加粗 ![说明](cindy-media://blobs/y) 中**')).toBe('加粗 说明 中');
    expect(sentSessionMessageChipLabel('***![](cindy-media://blobs/z)*** 字')).not.toContain('cindy-media');
  });

  it('never exposes image syntax, <img> or managed media URIs in any wrapper / length combination', () => {
    const longAlt = '说'.repeat(2_500);
    const tokens = [
      '![](cindy-media://blobs/abc)',
      '![图](cindy-media://blobs/abc)',
      `![${longAlt}](cindy-media://blobs/abc)`,
      `![alt](cindy-media://blobs/${'f'.repeat(3_000)})`,
      '<img src="cindy-media://blobs/abc" width="10">',
      '![x](xdt-image://abc)',
      'cindy-media://blobs/bare',
    ];
    const wrappers: Array<(token: string) => string> = [
      (token) => token,
      (token) => `**${token}**`,
      (token) => `*${token}*`,
      (token) => `***${token}***`,
      (token) => `**外 *内 ${token}* 外**`,
      (token) => `- ${token}`,
      (token) => `| ${token} |\n| --- |`,
      (token) => `前文 ${token} 后文`,
    ];
    for (const token of tokens) {
      for (const wrap of wrappers) {
        for (const tail of ['', '\n正文继续', `\n${'下一行\n'.repeat(1_000)}`]) {
          const label = sentSessionMessageChipLabel(`${wrap(token)}${tail}`);
          expect(label, `${wrap(token).slice(0, 60)}`).not.toMatch(/!\[|<img|cindy-media|xdt-image/i);
        }
      }
    }
  });

  it('summarizes long messages from a bounded prefix without leaking split Markdown', () => {
    const log = `**构建日志**\n${'line of output\n'.repeat(20_000)}![](cindy-media://blobs/tail)`;
    expect(sentSessionMessageChipLabel(log)).toBe('构建日志 line of output lin…');
    const longLine = `开头说明 ${'x'.repeat(5_000)}`;
    expect(sentSessionMessageChipLabel(longLine).startsWith('开头说明 x')).toBe(true);
  });

  it('truncates by visible characters without splitting multi-codepoint emoji', () => {
    const flag = '🇨🇳';
    const family = '👨‍👩‍👧';
    const skin = '👍🏽';
    expect(sentSessionMessageChipLabel(`${'a'.repeat(22)}${flag}bb`)).toBe(`${'a'.repeat(22)}${flag}…`);
    expect(sentSessionMessageChipLabel(`${'a'.repeat(22)}${family}bb`)).toBe(`${'a'.repeat(22)}${family}…`);
    expect(sentSessionMessageChipLabel(`${'a'.repeat(22)}${skin}bb`)).toBe(`${'a'.repeat(22)}${skin}…`);
    expect(sentSessionMessageChipLabel(`${flag}${flag}`)).toBe(`${flag}${flag}`);
    expect(sentSessionMessageChipLabel(`${'a'.repeat(23)}e\u0301`)).toBe(`${'a'.repeat(23)}e\u0301`);
  });

  it('splits message anchors while preserving adjacent punctuation and whole-session links', () => {
    expect(splitAnchoredSessionMessageLinks(
      'See cindy://session/s-1?message=m-2, then cindy://session/s-3.',
    )).toEqual([
      { kind: 'text', text: 'See ' },
      {
        kind: 'message-link',
        url: 'cindy://session/s-1?message=m-2',
        sessionId: 's-1',
        messageClientId: 'm-2',
      },
      { kind: 'text', text: ', then cindy://session/s-3.' },
    ]);
  });
});
