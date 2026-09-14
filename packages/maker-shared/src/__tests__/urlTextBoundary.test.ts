import { describe, expect, it } from 'vitest';
import {
  BARE_HTTP_URL_RE_SOURCE,
  clipBareHttpAutolinkText,
} from '../urlTextBoundary.js';

function matchBareHttp(text: string): string | null {
  const match = new RegExp(BARE_HTTP_URL_RE_SOURCE, 'g').exec(text);
  return match?.[0] ?? null;
}

describe('clipBareHttpAutolinkText', () => {
  it('strips fullwidth parentheses and CJK punctuation glued to a URL', () => {
    expect(
      clipBareHttpAutolinkText(
        'https://github.com/example/app/issues/3561#issuecomment-5391602790（无 @）',
      ),
    ).toBe('https://github.com/example/app/issues/3561#issuecomment-5391602790');
    expect(clipBareHttpAutolinkText('https://example.com/path（说明）')).toBe(
      'https://example.com/path',
    );
    expect(clipBareHttpAutolinkText('https://example.com/path。')).toBe(
      'https://example.com/path',
    );
  });

  it('keeps balanced Wikipedia-style parentheses', () => {
    expect(
      clipBareHttpAutolinkText('https://en.wikipedia.org/wiki/Foo_(bar)'),
    ).toBe('https://en.wikipedia.org/wiki/Foo_(bar)');
  });

  it('does not swallow a wrapping closer from surrounding prose', () => {
    expect(
      clipBareHttpAutolinkText('https://example.com/path)', { prefix: '见 (' }),
    ).toBe('https://example.com/path');
  });

  it('strips trailing English sentence punctuation', () => {
    expect(clipBareHttpAutolinkText('https://example.com/path,')).toBe(
      'https://example.com/path',
    );
    expect(clipBareHttpAutolinkText('https://example.com/path.')).toBe(
      'https://example.com/path',
    );
  });

  it('keeps mixed ASCII/CJK domains and paths that URL can parse', () => {
    expect(clipBareHttpAutolinkText('https://example.com/路径')).toBe(
      'https://example.com/路径',
    );
    expect(clipBareHttpAutolinkText('https://例子.测试/path')).toBe(
      'https://例子.测试/path',
    );
    expect(clipBareHttpAutolinkText('https://www.例子.com/path')).toBe(
      'https://www.例子.com/path',
    );
    expect(clipBareHttpAutolinkText('https://example.com/2024年报告')).toBe(
      'https://example.com/2024年报告',
    );
    expect(clipBareHttpAutolinkText('https://example.com/abc中文')).toBe(
      'https://example.com/abc中文',
    );
    expect(clipBareHttpAutolinkText('https://例子123.测试/path')).toBe(
      'https://例子123.测试/path',
    );
    expect(clipBareHttpAutolinkText('https://example.com/ＡＢＣ')).toBe(
      'https://example.com/ＡＢＣ',
    );
    expect(clipBareHttpAutolinkText('https://example.com/ｶﾀｶﾅ')).toBe(
      'https://example.com/ｶﾀｶﾅ',
    );
    expect(clipBareHttpAutolinkText('https://example.com/abc々def')).toBe(
      'https://example.com/abc々def',
    );
    expect(clipBareHttpAutolinkText('https://例子。测试/path')).toBe(
      'https://例子。测试/path',
    );
    expect(clipBareHttpAutolinkText('https://例子．测试/path')).toBe(
      'https://例子．测试/path',
    );
    expect(clipBareHttpAutolinkText('https://例子｡测试/path')).toBe(
      'https://例子｡测试/path',
    );
    expect(clipBareHttpAutolinkText('https://example.com/path。然后')).toBe(
      'https://example.com/path',
    );
    expect(clipBareHttpAutolinkText('http://localhost:3000。然后')).toBe(
      'http://localhost:3000',
    );
    expect(clipBareHttpAutolinkText('https://[::1]:3000。然后')).toBe(
      'https://[::1]:3000',
    );
    expect(clipBareHttpAutolinkText('https://例子。测试:443/path')).toBe(
      'https://例子。测试:443/path',
    );
    expect(clipBareHttpAutolinkText('https://例子。测试。')).toBe(
      'https://例子。测试',
    );
    expect(clipBareHttpAutolinkText('https://子域。例子。测试')).toBe(
      'https://子域。例子。测试',
    );
    expect(clipBareHttpAutolinkText('https://www。例子。测试')).toBe(
      'https://www。例子。测试',
    );
    expect(clipBareHttpAutolinkText('https://пример。онлайн/path')).toBe(
      'https://пример。онлайн/path',
    );
    expect(clipBareHttpAutolinkText('https://子域。四字域名。测试')).toBe(
      'https://子域。四字域名。测试',
    );
    expect(clipBareHttpAutolinkText('https://例子。测试。这是说明')).toBe(
      'https://例子。测试',
    );
    expect(clipBareHttpAutolinkText('https://example.com。这是说明')).toBe(
      'https://example.com',
    );
    expect(clipBareHttpAutolinkText('https://例子。ファッション/path')).toBe(
      'https://例子。ファッション/path',
    );
    expect(clipBareHttpAutolinkText('https://example.com/path・说明')).toBe(
      'https://example.com/path',
    );
    expect(clipBareHttpAutolinkText('https://example.com/path—说明')).toBe(
      'https://example.com/path',
    );
    expect(
      clipBareHttpAutolinkText('https://example.com/api/[id]', { cutPathBrackets: false }),
    ).toBe('https://example.com/api/[id]');
    expect(clipBareHttpAutolinkText('https://example.com/api/[id]')).toBe(
      'https://example.com/api/',
    );
  });
});

describe('BARE_HTTP_URL_RE_SOURCE', () => {
  it('stops the match before fullwidth / CJK punctuation, not before letters', () => {
    expect(
      matchBareHttp(
        '诊断已写在 https://github.com/example/app/issues/3561#issuecomment-5391602790（无 @）。',
      ),
    ).toBe('https://github.com/example/app/issues/3561#issuecomment-5391602790');
    expect(matchBareHttp('打开 https://例子。测试/path 看')).toBe(
      'https://例子。测试/path',
    );
    expect(matchBareHttp('看 https://example.com/path。然后')).toBe(
      'https://example.com/path。然后',
    );
    expect(matchBareHttp('打开 https://example.com/路径 看')).toBe(
      'https://example.com/路径',
    );
    expect(matchBareHttp('打开 https://例子.测试/path 看')).toBe(
      'https://例子.测试/path',
    );
    expect(matchBareHttp('打开 https://example.com/ＡＢＣ 看')).toBe(
      'https://example.com/ＡＢＣ',
    );
    expect(matchBareHttp('看 https://example.com/path\u00A0然后')).toBe(
      'https://example.com/path',
    );
    expect(matchBareHttp('看 https://example.com/path\u202F然后')).toBe(
      'https://example.com/path',
    );
  });

  it('includes balanced ASCII parentheses for later clip', () => {
    expect(matchBareHttp('https://en.wikipedia.org/wiki/Foo_(bar) next')).toBe(
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    );
  });
});
