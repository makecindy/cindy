import { describe, expect, it } from 'vitest';

import { parseMarketSource, resolveLocalSourcePath } from '../sources/parse';

const HOME = '/home/tester';

function parse(input: { source: string; ref?: string; sparsePaths?: string[] }) {
  return parseMarketSource(input, HOME);
}

describe('parseMarketSource', () => {
  it('parses GitHub shorthand into an https git source', () => {
    const result = parse({ source: 'openai/plugins' });
    expect(result).toEqual({
      ok: true,
      source: {
        type: 'git',
        url: 'https://github.com/openai/plugins.git',
        sparsePaths: [],
      },
    });
  });

  it('keeps ref and sparse paths on git sources', () => {
    const result = parse({
      source: 'openai/plugins',
      ref: 'v1.2',
      sparsePaths: ['plugins/codex', ' plugins/extra ', ''],
    });
    expect(result).toEqual({
      ok: true,
      source: {
        type: 'git',
        url: 'https://github.com/openai/plugins.git',
        ref: 'v1.2',
        sparsePaths: ['plugins/codex', 'plugins/extra'],
      },
    });
  });

  it.each([
    'https://github.com/org/repo.git',
    'ssh://git@example.com/org/repo.git',
    'git@github.com:org/repo.git',
  ])('accepts full git URL %s', (source) => {
    const result = parse({ source });
    expect(result).toEqual({
      ok: true,
      source: { type: 'git', url: source, sparsePaths: [] },
    });
  });

  it.each([
    'https://user:token@example.com/org/repo.git',
    'https://oauth2@example.com/org/repo.git',
    'ssh://user:token@example.com/org/repo.git',
    'https://user@example.com:443/org/repo.git',
    'https://example.com/org/repo.git?access_token=SECRET',
    'https://example.com/org/repo.git?sig=abc&token=def',
    // fragment 与 query 一样能塞令牌/签名,并随 source 持久化、在 UI 摘要里露出。
    'https://example.com/org/repo.git#token=SECRET',
    'ssh://example.com/org/repo.git?token=SECRET',
    'ssh://example.com/org/repo.git#sig=abc',
    // scp 形态不是合法 URL,new URL 解析不了,得单独拦。
    'git@example.com:org/repo.git?token=SECRET',
    'git@example.com:org/repo.git#sig=abc',
  ])('rejects git URL with embedded credentials %s', (source) => {
    expect(parse({ source })).toEqual({ ok: false, code: 'CREDENTIALS_NOT_ALLOWED' });
  });

  it('resolves ~ against the injected home directory', () => {
    const result = parse({ source: '~/team/plugins' });
    expect(result).toEqual({
      ok: true,
      source: { type: 'local', path: `${HOME}/team/plugins` },
    });
  });

  it.each(['/abs/path', './rel/path', '../up/path'])(
    'treats %s as a local path',
    (source) => {
      const result = parse({ source });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.source.type).toBe('local');
    },
  );

  it('rejects ref and sparse paths for local sources', () => {
    expect(parse({ source: '~/x', ref: 'main' })).toEqual({
      ok: false,
      code: 'REF_NOT_ALLOWED_FOR_LOCAL',
    });
    expect(parse({ source: '~/x', sparsePaths: ['a'] })).toEqual({
      ok: false,
      code: 'SPARSE_NOT_ALLOWED_FOR_LOCAL',
    });
  });

  it('rejects empty and unrecognizable sources', () => {
    expect(parse({ source: '   ' })).toEqual({ ok: false, code: 'EMPTY_SOURCE' });
    expect(parse({ source: 'git://example.com/org/repo.git' })).toEqual({
      ok: false,
      code: 'INVALID_SOURCE_FORMAT',
    });
    expect(parse({ source: 'just-a-word' })).toEqual({
      ok: false,
      code: 'INVALID_SOURCE_FORMAT',
    });
    expect(parse({ source: 'a/b/c' })).toEqual({
      ok: false,
      code: 'INVALID_SOURCE_FORMAT',
    });
  });

  it('rejects option-injection shaped refs', () => {
    expect(parse({ source: 'openai/plugins', ref: '--upload-pack=evil' })).toEqual({
      ok: false,
      code: 'INVALID_REF',
    });
  });

  it('rejects sparse paths that look like git options', () => {
    for (const opt of ['--stdin', '--no-cone', '--cone', '-x']) {
      expect(parse({ source: 'openai/plugins', sparsePaths: [opt] })).toEqual({
        ok: false,
        code: 'INVALID_SPARSE_PATH',
      });
    }
  });

  it('rejects sparse paths escaping the repository', () => {
    expect(parse({ source: 'openai/plugins', sparsePaths: ['../outside'] })).toEqual({
      ok: false,
      code: 'INVALID_SPARSE_PATH',
    });
    expect(parse({ source: 'openai/plugins', sparsePaths: ['/abs'] })).toEqual({
      ok: false,
      code: 'INVALID_SPARSE_PATH',
    });
  });

  it('resolves local paths without touching the filesystem', () => {
    expect(resolveLocalSourcePath('~/a/b', HOME)).toBe(`${HOME}/a/b`);
  });

  it('rejects backslash in git URL authority (WHATWG/git 分歧,凭证闸失明)', () => {
    // new URL 把 \ 归一成 /,userinfo 看不见;git 实际连 evil.com。
    expect(parse({ source: 'https://github.com\\@evil.com/x/y.git' })).toEqual({
      ok: false,
      code: 'INVALID_SOURCE_FORMAT',
    });
    // 单段 token 形态:同样必须在 \ 处拒,不能落进 git 源。
    expect(parse({ source: 'https://ghp_secret\\@github.com/o/r.git' })).toEqual({
      ok: false,
      code: 'INVALID_SOURCE_FORMAT',
    });
  });

  it('rejects control/bidi chars in source and sparse paths', () => {
    expect(parse({ source: 'https://github.com/o/r‮.git' })).toEqual({
      ok: false,
      code: 'INVALID_SOURCE_FORMAT',
    });
    expect(
      parse({ source: 'https://github.com/o/r.git', sparsePaths: ['plugins/‎a'] }),
    ).toEqual({ ok: false, code: 'INVALID_SPARSE_PATH' });
  });

  it('unparseable https URL fails closed as possibly carrying credentials', () => {
    // new URL 抛错的串按"可能带凭证"拒,而不是 fail-open 放行。
    expect(parse({ source: 'https://[not-a-host/o/r.git' }).ok).toBe(false);
  });
});
