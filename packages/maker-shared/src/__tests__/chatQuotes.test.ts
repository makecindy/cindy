import { describe, expect, it } from 'vitest';
import {
  formatQuoteForSend,
  formatQuotesForSend,
  joinChatQuoteTextSegments,
  parseChatQuoteSegments,
  parseLeadingBlockquotes,
  quoteSourceBasename,
  quoteSourceDisplayLabel,
  stripChatQuoteMarkerLines,
} from '../chatQuotes';

/**
 * Snapshot of the quote-block scan used by the pre-comment client at
 * 6e114a3576a1c28883c176171ea617f141080a5d (the same logic is still on
 * origin/main at 3b3d0cfad93389a96942f642705b91f5d0ed8a05). It deliberately
 * knows nothing about comment boundaries: this is a forward-compatibility
 * fixture, not a second production parser.
 */
function parseWithPreCommentClient(content: string): { quoteText: string; body: string } {
  if (!content.startsWith('> ')) return { quoteText: '', body: content };
  const lines = content.split('\n');
  const quoteLines: string[] = [];
  let markerConsumed = false;
  let index = 0;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (
      line === '> <!-- cindy-composer-quote -->'
      && quoteLines.length === 0
      && !markerConsumed
    ) {
      markerConsumed = true;
      continue;
    }
    if (line.startsWith('> ')) {
      quoteLines.push(line.slice(2));
      continue;
    }
    if (line === '>') {
      quoteLines.push('');
      continue;
    }
    break;
  }
  return {
    quoteText: quoteLines.join('\n'),
    body: lines.slice(index).join('\n').replace(/^\n+/, ''),
  };
}

describe('formatQuotesForSend', () => {
  it('encodes one standalone quote for inline composer serialization', () => {
    expect(formatQuoteForSend({ text: 'a\n\nb', sourcePath: 'docs/x.md' })).toBe(
      '> <!-- cindy-composer-quote -->\n> a\n>\n> b\n> — source: docs/x.md',
    );
  });

  it('prefixes each quote line and separates quotes with a blank line (markdown semantics)', () => {
    expect(formatQuotesForSend([{ text: 'a\nb' }, { text: 'c' }], 'hello')).toBe(
      '> <!-- cindy-composer-quote -->\n> a\n> b\n\n> <!-- cindy-composer-quote -->\n> c\n\nhello',
    );
  });

  it('encodes intra-quote empty lines as a bare ">" (no trailing space to trim)', () => {
    expect(formatQuotesForSend([{ text: 'a\n\nb' }], 'hi')).toBe(
      '> <!-- cindy-composer-quote -->\n> a\n>\n> b\n\nhi',
    );
  });

  it('normalizes leading/trailing blank lines so the block never starts with a bare ">"', () => {
    // 开头裸 ">" 会被 parseLeadingBlockquotes 的早退守卫拒收(用户手打保护),
    // 采集侧选区吃进段落边界空行时必须在编码前剔除。
    expect(formatQuotesForSend([{ text: '\n\nselected\n' }], 'hi')).toBe(
      '> <!-- cindy-composer-quote -->\n> selected\n\nhi',
    );
    const sent = formatQuotesForSend([{ text: '\nfirst\n\nsecond\n\n', sourcePath: 'a.md' }], 'body');
    expect(sent).toBe(
      '> <!-- cindy-composer-quote -->\n> first\n>\n> second\n> — source: a.md\n\nbody',
    );
    expect(parseLeadingBlockquotes(sent)).toEqual({
      quotes: [{ text: 'first\n\nsecond', sourcePath: 'a.md' }],
      body: 'body',
    });
  });

  it('appends a source line for file quotes', () => {
    expect(formatQuotesForSend([{ text: 'a', sourcePath: 'docs/x.md' }], 'hi')).toBe(
      '> <!-- cindy-composer-quote -->\n> a\n> — source: docs/x.md\n\nhi',
    );
  });

  it('appends source line numbers for file quotes', () => {
    expect(
      formatQuotesForSend([{ text: 'a', sourcePath: 'docs/x.md', startLine: 12, endLine: 18 }], 'hi'),
    ).toBe('> <!-- cindy-composer-quote -->\n> a\n> — source: docs/x.md#L12-L18\n\nhi');
    expect(
      formatQuotesForSend([{ text: 'a', sourcePath: 'docs/x.md', startLine: 12, endLine: 12 }], 'hi'),
    ).toBe('> <!-- cindy-composer-quote -->\n> a\n> — source: docs/x.md#L12\n\nhi');
  });

  it('returns body untouched when there are no quotes', () => {
    expect(formatQuotesForSend([], 'hello')).toBe('hello');
  });

  it('wraps a comment in an explicit structural boundary after source metadata', () => {
    expect(formatQuoteForSend({ text: 'a', sourcePath: 'docs/x.md', comment: '说明' })).toBe(
      [
        '> <!-- cindy-composer-quote -->',
        '> a',
        '> — source: docs/x.md',
        '> <!-- cindy-composer-quote-comment:start -->',
        '> — comment: 说明',
        '> <!-- cindy-composer-quote-comment:end -->',
      ].join('\n'),
    );
  });

  it('round-trips multiline comments with internal blank lines and a trailing newline', () => {
    const quote = {
      text: 'selected',
      sourcePath: 'docs/spec.md',
      comment: '第一行\n\n第三行\n',
    };
    const sent = formatQuoteForSend(quote);

    expect(sent).toContain(
      '> <!-- cindy-composer-quote-comment:start -->\n'
        + '> — comment: 第一行\n>\n> 第三行\n>\n'
        + '> <!-- cindy-composer-quote-comment:end -->',
    );
    expect(parseLeadingBlockquotes(sent)).toEqual({ quotes: [quote], body: '' });
  });

  it('trims the trailing gap for quote-only sends', () => {
    expect(formatQuotesForSend([{ text: 'a' }], '')).toBe(
      '> <!-- cindy-composer-quote -->\n> a',
    );
  });
});

describe('parseChatQuoteSegments', () => {
  it('preserves alternating quote and prose order', () => {
    const content = [
      formatQuoteForSend({ text: 'first quote' }),
      '',
      'first response',
      '',
      formatQuoteForSend({
        text: 'second quote',
        sourcePath: 'docs/spec.md',
        startLine: 8,
        endLine: 9,
      }),
      '',
      'second response',
    ].join('\n');

    expect(parseChatQuoteSegments(content)).toEqual([
      { kind: 'quote', quote: { text: 'first quote' } },
      { kind: 'text', text: 'first response' },
      {
        kind: 'quote',
        quote: {
          text: 'second quote',
          sourcePath: 'docs/spec.md',
          startLine: 8,
          endLine: 9,
        },
      },
      { kind: 'text', text: 'second response' },
    ]);
  });

  it('parses explicitly marked quotes nested under list indentation', () => {
    const content = '- before\n  > <!-- cindy-composer-quote -->\n  > quoted\n  after';
    expect(parseChatQuoteSegments(content)).toEqual([
      { kind: 'text', text: '- before' },
      { kind: 'quote', quote: { text: 'quoted' } },
      { kind: 'text', text: '  after' },
    ]);
    expect(stripChatQuoteMarkerLines(content)).toBe('- before\n  > quoted\n  after');
  });

  it('keeps internal quote and prose blank lines', () => {
    const content = `before\n\n${formatQuoteForSend({ text: 'a\n\nb' })}\n\nafter\n\nstill after`;
    expect(parseChatQuoteSegments(content)).toEqual([
      { kind: 'text', text: 'before' },
      { kind: 'quote', quote: { text: 'a\n\nb' } },
      { kind: 'text', text: 'after\n\nstill after' },
    ]);
  });

  it('keeps user-authored Markdown blockquotes in the body editable', () => {
    const content = `${formatQuoteForSend({ text: 'selected' })}\n\nHere is the original:\n> foo`;
    expect(parseChatQuoteSegments(content)).toEqual([
      { kind: 'quote', quote: { text: 'selected' } },
      { kind: 'text', text: 'Here is the original:\n> foo' },
    ]);
  });

  it('preserves lone and backslash-prefixed greater-than body lines', () => {
    const content = `${formatQuoteForSend({ text: 'selected' })}\n\n>\n\\> foo`;
    expect(parseChatQuoteSegments(content)).toEqual([
      { kind: 'quote', quote: { text: 'selected' } },
      { kind: 'text', text: '>\n\\> foo' },
    ]);
  });

  it('keeps compatibility with unmarked legacy leading quotes only', () => {
    expect(parseChatQuoteSegments('> old one\n\n> old two\n\nbody\n\n> manual')).toEqual([
      { kind: 'quote', quote: { text: 'old one' } },
      { kind: 'quote', quote: { text: 'old two' } },
      { kind: 'text', text: 'body\n\n> manual' },
    ]);
  });

  it('keeps markerless legacy parsing leading-only when prose contains Markdown blockquotes', () => {
    const content = '> old product quote\n\nHere is user Markdown:\n> keep this editable';
    expect(parseChatQuoteSegments(content)).toEqual([
      { kind: 'quote', quote: { text: 'old product quote' } },
      { kind: 'text', text: 'Here is user Markdown:\n> keep this editable' },
    ]);
  });

  it('never treats unmarked body blockquotes as product quotes when any explicit marker exists', () => {
    const content = `> leading manual\n\n正文开头\n\n${formatQuoteForSend({ text: 'selected' })}\n\n正文：\n> manual`;
    expect(parseChatQuoteSegments(content)).toEqual([
      { kind: 'text', text: '> leading manual\n\n正文开头' },
      { kind: 'quote', quote: { text: 'selected' } },
      { kind: 'text', text: '正文：\n> manual' },
    ]);
  });

  it('returns ordinary text unchanged', () => {
    expect(parseChatQuoteSegments('plain\ntext')).toEqual([
      { kind: 'text', text: 'plain\ntext' },
    ]);
  });
});

describe('stripChatQuoteMarkerLines', () => {
  it('removes only exact private marker lines from copied quote Markdown', () => {
    const content = [
      '> <!-- cindy-composer-quote -->',
      '> selected text',
      '> — source: docs/spec.md#L4-L6',
      '',
      'reply',
      '> <!-- cindy-composer-quote --> suffix',
    ].join('\n');

    expect(stripChatQuoteMarkerLines(content)).toBe([
      '> selected text',
      '> — source: docs/spec.md#L4-L6',
      '',
      'reply',
      '> <!-- cindy-composer-quote --> suffix',
    ].join('\n'));
  });

  it('leaves ordinary Markdown untouched', () => {
    const content = '> handwritten quote\n\nbody';
    expect(stripChatQuoteMarkerLines(content)).toBe(content);
  });

  it('removes comment boundary markers without removing the readable comment', () => {
    const sent = formatQuoteForSend({ text: 'selected', comment: 'why\nsecond line' });
    expect(stripChatQuoteMarkerLines(sent)).toBe(
      '> selected\n> — comment: why\n> second line',
    );
  });

  it('removes structural escapes from the first readable comment line', () => {
    const comments = [
      '— source: fake.ts',
      '<!-- cindy-composer-quote -->',
      '<!-- cindy-composer-quote-comment:start -->',
      '<!-- cindy-composer-quote-comment:end -->',
      '\u2060user-authored word joiner',
    ];

    for (const comment of comments) {
      expect(stripChatQuoteMarkerLines(formatQuoteForSend({ text: 'selected', comment }))).toBe(
        `> selected\n> — comment: ${comment}`,
      );
    }
  });
});

describe('joinChatQuoteTextSegments', () => {
  it('separates text islands without duplicating preserved user line breaks', () => {
    expect(joinChatQuoteTextSegments([
      { kind: 'text', text: 'first' },
      { kind: 'quote', quote: { text: 'selected' } },
      { kind: 'text', text: 'second' },
    ])).toBe('first\n\nsecond');

    expect(joinChatQuoteTextSegments([
      { kind: 'text', text: 'first\n' },
      { kind: 'quote', quote: { text: 'selected' } },
      { kind: 'text', text: 'second' },
    ])).toBe('first\n\nsecond');

    expect(joinChatQuoteTextSegments([
      { kind: 'text', text: 'first\n\n\n' },
      { kind: 'quote', quote: { text: 'selected' } },
      { kind: 'text', text: '\nsecond' },
    ])).toBe('first\n\n\n\nsecond');
  });

  it('returns an empty body for quote-only segments', () => {
    expect(joinChatQuoteTextSegments([
      { kind: 'quote', quote: { text: 'selected' } },
    ])).toBe('');
  });
});

describe('parseLeadingBlockquotes', () => {
  it('round-trips quotes containing internal empty lines', () => {
    const quotes = [{ text: '第一段\n\n空行后继续' }, { text: 'b', sourcePath: 'x.md' }];
    const sent = formatQuotesForSend(quotes, 'body');
    expect(parseLeadingBlockquotes(sent)).toEqual({ quotes, body: 'body' });
  });

  it('round-trips quote text that happens to equal the internal marker', () => {
    const quotes = [{ text: '<!-- cindy-composer-quote -->' }];
    const sent = formatQuotesForSend(quotes, 'body');
    expect(parseLeadingBlockquotes(sent)).toEqual({
      quotes,
      body: 'body',
    });
    expect(stripChatQuoteMarkerLines(sent)).toBe('> <!-- cindy-composer-quote -->\n\nbody');
  });

  it('does not swallow a lone leading ">" line typed by the user', () => {
    expect(parseLeadingBlockquotes('>\nbody')).toEqual({ quotes: [], body: '>\nbody' });
  });

  it('round-trips chat and file quotes produced by formatQuotesForSend', () => {
    const quotes = [
      { text: '第一段\n跨两行' },
      { text: '文件里选的', sourcePath: 'src/app/main.ts' },
    ];
    const sent = formatQuotesForSend(quotes, '正文内容');
    expect(parseLeadingBlockquotes(sent)).toEqual({ quotes, body: '正文内容' });
  });

  it('round-trips leading indentation (whitespace-sensitive code quotes)', () => {
    const quotes = [{ text: '    if (x) {\n      return;\n    }', sourcePath: 'src/a.py' }];
    const sent = formatQuotesForSend(quotes, 'fix this');
    expect(parseLeadingBlockquotes(sent)).toEqual({ quotes, body: 'fix this' });
  });

  it('round-trips quote-only content', () => {
    const sent = formatQuotesForSend([{ text: 'only quote', sourcePath: 'a.md' }], '');
    expect(parseLeadingBlockquotes(sent)).toEqual({
      quotes: [{ text: 'only quote', sourcePath: 'a.md' }],
      body: '',
    });
  });

  it('round-trips file quote line numbers', () => {
    const quotes = [{ text: 'selected', sourcePath: 'docs/spec.md', startLine: 4, endLine: 6 }];
    const sent = formatQuotesForSend(quotes, 'fix it');
    expect(parseLeadingBlockquotes(sent)).toEqual({ quotes, body: 'fix it' });
  });

  it('round-trips comments after source metadata', () => {
    const quotes = [{
      text: 'selected',
      sourcePath: 'docs/spec.md',
      startLine: 4,
      endLine: 6,
      comment: '这里要改',
    }];
    const sent = formatQuotesForSend(quotes, 'fix it');
    expect(parseLeadingBlockquotes(sent)).toEqual({ quotes, body: 'fix it' });
  });

  it('never treats source text beginning with the comment prefix as comment metadata', () => {
    const quotes = [
      { text: '— comment: first line' },
      { text: 'before\n— comment: ' },
      { text: 'before\n— comment: one\n— comment: two' },
    ];

    for (const quote of quotes) {
      expect(parseLeadingBlockquotes(formatQuoteForSend(quote))).toEqual({
        quotes: [quote],
        body: '',
      });
    }
  });

  it('round-trips quote text ending in a source-looking line', () => {
    const quote = { text: '\u2060selected\n— source: user-authored.md#L7-L9' };
    const sent = formatQuoteForSend(quote);

    expect(parseLeadingBlockquotes(sent)).toEqual({
      quotes: [quote],
      body: '',
    });
    expect(parseChatQuoteSegments(sent)).toEqual([
      { kind: 'quote', quote },
    ]);
    expect(stripChatQuoteMarkerLines(sent)).toBe(
      '> \u2060selected\n> — source: user-authored.md#L7-L9',
    );
  });

  it('round-trips a complete comment-marker structure inside quote text', () => {
    const quote = {
      text: [
        'selected',
        '<!-- cindy-composer-quote-comment:start -->',
        '— comment: user-authored text',
        '<!-- cindy-composer-quote-comment:end -->',
      ].join('\n'),
      comment: 'actual comment metadata',
    };

    expect(parseLeadingBlockquotes(formatQuoteForSend(quote))).toEqual({
      quotes: [quote],
      body: '',
    });
    expect(parseChatQuoteSegments(formatQuoteForSend(quote))).toEqual([
      { kind: 'quote', quote },
    ]);
  });

  it('round-trips a comment that contains the legacy comment prefix', () => {
    const quote = {
      text: 'selected',
      comment: '— comment: this is still comment text\nnext',
    };
    expect(parseLeadingBlockquotes(formatQuoteForSend(quote))).toEqual({
      quotes: [quote],
      body: '',
    });
  });

  it('does not treat a lone source-looking line as a source (needs preceding text)', () => {
    expect(parseLeadingBlockquotes('> — source: a.md\n\nbody')).toEqual({
      quotes: [{ text: '— source: a.md' }],
      body: 'body',
    });
  });

  it('returns plain content untouched', () => {
    expect(parseLeadingBlockquotes('just text\n> not leading')).toEqual({
      quotes: [],
      body: 'just text\n> not leading',
    });
  });

  it('stops the quote block at the first non-quote line', () => {
    expect(parseLeadingBlockquotes('> q\nbody\n> tail')).toEqual({
      quotes: [{ text: 'q' }],
      body: 'body\n> tail',
    });
  });
});

describe('cross-version quote compatibility', () => {
  it('keeps old no-comment wire readable in the new parser', () => {
    const oldWire = [
      '> <!-- cindy-composer-quote -->',
      '> selected before comment support',
      '> — source: docs/legacy.md#L2-L3',
      '',
      'legacy reply body',
    ].join('\n');

    expect(parseChatQuoteSegments(oldWire)).toEqual([
      {
        kind: 'quote',
        quote: {
          text: 'selected before comment support',
          sourcePath: 'docs/legacy.md',
          startLine: 2,
          endLine: 3,
        },
      },
      { kind: 'text', text: 'legacy reply body' },
    ]);
  });

  it('lets the pre-comment client read new comment wire without throwing or losing payload', () => {
    const newWire = [
      '> <!-- cindy-composer-quote -->',
      '> selected body line 1',
      '>',
      '> selected body line 3',
      '> — source: docs/spec.md#L4-L6',
      '> <!-- cindy-composer-quote-comment:start -->',
      '> — comment: first comment line',
      '>',
      '> third comment line',
      '> <!-- cindy-composer-quote-comment:end -->',
      '',
      'user reply body',
    ].join('\n');

    expect(() => parseWithPreCommentClient(newWire)).not.toThrow();
    const restored = parseWithPreCommentClient(newWire);
    expect(restored.body).toBe('user reply body');
    expect(restored.quoteText).toContain('selected body line 1');
    expect(restored.quoteText).toContain('selected body line 3');
    expect(restored.quoteText).toContain('docs/spec.md#L4-L6');
    expect(restored.quoteText).toContain('first comment line');
    expect(restored.quoteText).toContain('third comment line');
  });
});

describe('quoteSourceBasename', () => {
  it('extracts the basename across separators', () => {
    expect(quoteSourceBasename('docs/design/spec.md')).toBe('spec.md');
    expect(quoteSourceBasename('win\\path\\a.ts')).toBe('a.ts');
    expect(quoteSourceBasename('single.md')).toBe('single.md');
  });
});

describe('quoteSourceDisplayLabel', () => {
  it('keeps file line labels visible for UI consumers', () => {
    expect(quoteSourceDisplayLabel({ text: 'a', sourcePath: 'docs/design/spec.md' })).toBe(
      'spec.md',
    );
    expect(
      quoteSourceDisplayLabel({
        text: 'a',
        sourcePath: 'docs/design/spec.md',
        startLine: 12,
        endLine: 18,
      }),
    ).toBe('spec.md:L12-L18');
    expect(
      quoteSourceDisplayLabel({
        text: 'a',
        sourcePath: 'docs/design/spec.md',
        startLine: 12,
        endLine: 8,
      }),
    ).toBe('spec.md:L12');
  });

  it('returns null for chat-only quotes without source path', () => {
    expect(quoteSourceDisplayLabel({ text: 'a' })).toBeNull();
  });
});
