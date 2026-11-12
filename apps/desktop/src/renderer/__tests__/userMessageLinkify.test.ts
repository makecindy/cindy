import { describe, expect, it } from 'vitest';

// GitLab MR URL fixture(边界/截断逻辑对 gitlab.com 适用)
const GITLAB_MR_URL = `https://gitlab.com/acme/app/-/merge_requests/42`;

import { findLinkifyMatches } from '../components/chat/userMessageLinkify';

function urls(text: string): string[] {
  return findLinkifyMatches(text)
    .filter((match) => match.kind === 'url')
    .map((match) => match.text);
}

describe('userMessageLinkify', () => {
  it('strips prose punctuation from plain-text URL matches', () => {
    expect(urls('看 https://example.com/path, 然后')).toEqual(['https://example.com/path']);
    expect(urls('看 https://example.com/path. 然后')).toEqual(['https://example.com/path']);
    expect(urls('看 https://example.com/path; 然后')).toEqual(['https://example.com/path']);
    const [match] = findLinkifyMatches('看 https://example.com/path, 然后');
    expect(match).toMatchObject({
      index: 2,
      length: 'https://example.com/path'.length,
      text: 'https://example.com/path',
    });
  });

  it('keeps URL-valid markdown formatting characters at plain-text URL endings', () => {
    expect(urls('看 https://example.com/Foo* 然后')).toEqual(['https://example.com/Foo*']);
    expect(urls('看 https://example.com/Foo_ 然后')).toEqual(['https://example.com/Foo_']);
    expect(urls('看 https://example.com/Foo~ 然后')).toEqual(['https://example.com/Foo~']);
  });

  it('strips closing markdown wrap markers around plain-text URLs', () => {
    expect(urls('**https://github.com/makecindy/cindy/pull/163**(ready for review,非 draft)')).toEqual([
      'https://github.com/makecindy/cindy/pull/163',
    ]);
    expect(urls('**https://github.com/makecindy/cindy/pull/283(base,OPEN)**')).toEqual([
      'https://github.com/makecindy/cindy/pull/283',
    ]);
    expect(urls('*https://example.com/Foo* next')).toEqual(['https://example.com/Foo']);
    expect(urls('__https://example.com/Foo__ next')).toEqual(['https://example.com/Foo']);
    expect(urls('_https://example.com/Foo_ next')).toEqual(['https://example.com/Foo']);
    expect(urls('~~https://example.com/Foo~~ next')).toEqual(['https://example.com/Foo']);
    expect(urls('~https://example.com/Foo~ next')).toEqual(['https://example.com/Foo']);
    expect(urls('**https://example.com/pr/163**ready for review')).toEqual([
      'https://example.com/pr/163',
    ]);
    expect(urls('**https://example.com**ready** next')).toEqual([
      'https://example.com',
    ]);
    expect(urls('_https://github.com/user_name/repo_ next')).toEqual([
      'https://github.com/user_name/repo',
    ]);
    expect(urls('__https://github.com/user__name/repo__ next')).toEqual([
      'https://github.com/user__name/repo',
    ]);
    expect(urls('*https://example.com/releases/v1*beta* next')).toEqual([
      'https://example.com/releases/v1',
    ]);
    expect(urls('~https://example.com/releases/v1~beta~ next')).toEqual([
      'https://example.com/releases/v1',
    ]);
    expect(urls('-**https://example.com/pr/1** done')).toEqual([
      'https://example.com/pr/1',
    ]);
    expect(urls('/__https://example.com/pr/2__ done')).toEqual([
      'https://example.com/pr/2',
    ]);
  });

  it('keeps formatting-looking URL endings when there is no markdown opener', () => {
    expect(urls('tag_https://example.com/Foo_ next')).toEqual(['https://example.com/Foo_']);
    expect(urls('tag*https://example.com/Foo* next')).toEqual(['https://example.com/Foo*']);
    expect(urls('tag~https://example.com/Foo~ next')).toEqual(['https://example.com/Foo~']);
    expect(urls('tag**https://example.com/Foo** next')).toEqual([
      'https://example.com/Foo**',
    ]);
    expect(urls('tag__https://example.com/Foo__ next')).toEqual([
      'https://example.com/Foo__',
    ]);
    expect(urls('tag~~https://example.com/Foo~~ next')).toEqual([
      'https://example.com/Foo~~',
    ]);
  });

  it('stops URL matches before ASCII quotes and CJK punctuation', () => {
    expect(urls('看 "https://example.com/path"然后')).toEqual(['https://example.com/path']);
    expect(urls('看 https://example.com/path。然后')).toEqual(['https://example.com/path']);
  });

  it('keeps Unicode domain and path segments', () => {
    expect(urls('打开 https://example.com/路径 与 https://例子.测试/path')).toEqual([
      'https://example.com/路径',
      'https://例子.测试/path',
    ]);
    expect(urls('打开 https://www.例子.com/2024年报告')).toEqual([
      'https://www.例子.com/2024年报告',
    ]);
    expect(urls('打开 https://例子。测试/path')).toEqual([
      'https://例子。测试/path',
    ]);
    expect(urls('看 http://localhost:3000。然后')).toEqual([
      'http://localhost:3000',
    ]);
    expect(urls('打开 https://example.com/ＡＢＣ 与 https://example.com/ｶﾀｶﾅ')).toEqual([
      'https://example.com/ＡＢＣ',
      'https://example.com/ｶﾀｶﾅ',
    ]);
    expect(urls('看 https://example.com/path\u00A0然后')).toEqual([
      'https://example.com/path',
    ]);
  });

  it('keeps apostrophes inside URL paths and at URL endings', () => {
    expect(urls("看 https://en.wikipedia.org/wiki/Guns_N'_Roses 然后")).toEqual([
      "https://en.wikipedia.org/wiki/Guns_N'_Roses",
    ]);
    expect(urls("看 https://example.com/path' 然后")).toEqual(["https://example.com/path'"]);
  });

  it('strips wrapping apostrophes around URL matches', () => {
    expect(urls("看 'https://example.com/path' 然后")).toEqual(['https://example.com/path']);
  });

  it('keeps query / fragment brackets but cuts path-level bracket prose', () => {
    expect(urls('看 https://example.com/search?q=[a]#frag[b] 然后')).toEqual([
      'https://example.com/search?q=[a]#frag[b]',
    ]);
    expect(urls('看 https://example.com/search?q={a}&tag=[b] 然后')).toEqual([
      'https://example.com/search?q={a}&tag=[b]',
    ]);
    expect(urls('看 [https://example.com/search?q=a] 然后')).toEqual([
      'https://example.com/search?q=a',
    ]);
    expect(urls('看 {https://example.com/search#frag} 然后')).toEqual([
      'https://example.com/search#frag',
    ]);
    expect(urls('看 [https://example.com/search?q=[a]] 然后')).toEqual([
      'https://example.com/search?q=[a]',
    ]);
    expect(urls('看 https://example.com/foo[bar] 然后')).toEqual([
      'https://example.com/foo',
    ]);
    expect(urls('看 https://example.com/foo{bar} 然后')).toEqual([
      'https://example.com/foo',
    ]);
  });

  it('cuts authority-only outer brackets while preserving IPv6 host brackets', () => {
    expect(urls('看 [https://example.com] 然后')).toEqual(['https://example.com']);
    expect(urls('看 {https://example.com} 然后')).toEqual(['https://example.com']);
    expect(urls('看 https://[::1] 然后')).toEqual(['https://[::1]']);
    expect(urls('看 [https://[::1]] 然后')).toEqual(['https://[::1]']);
    expect(urls('看 https://[::1]:3000/path 然后')).toEqual([
      'https://[::1]:3000/path',
    ]);
  });

  it('continues scanning after path-level bracket prose cuts', () => {
    expect(urls('看 https://a.test/foo[bar]https://b.test/ok 然后')).toEqual([
      'https://a.test/foo',
      'https://b.test/ok',
    ]);
    expect(urls('看 https://a.test/foo{bar}https://b.test/ok 然后')).toEqual([
      'https://a.test/foo',
      'https://b.test/ok',
    ]);
  });

  it('keeps paired parentheses and strips dangling parentheses', () => {
    expect(urls('看 https://en.wikipedia.org/wiki/Foo_(bar) 然后')).toEqual([
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    ]);
    expect(urls('看 https://example.com/search?q=(foo 然后')).toEqual([
      'https://example.com/search?q=(foo',
    ]);
    expect(urls('看 https://example.com/search?q=( 然后')).toEqual([
      'https://example.com/search?q=(',
    ]);
    expect(urls('看 https://example.com/search?q=a)b 然后')).toEqual([
      'https://example.com/search?q=a)b',
    ]);
    expect(urls('看 https://example.com/search?q=a) 然后')).toEqual([
      'https://example.com/search?q=a)',
    ]);
    expect(urls('看 https://example.com/search#frag)a 然后')).toEqual([
      'https://example.com/search#frag)a',
    ]);
    expect(urls('看 https://example.com/search#frag) 然后')).toEqual([
      'https://example.com/search#frag)',
    ]);
    expect(urls('看 (https://example.com/search?q=a) 然后')).toEqual([
      'https://example.com/search?q=a',
    ]);
    expect(urls('看 (https://example.com/search?q=a)then')).toEqual([
      'https://example.com/search?q=a',
    ]);
    expect(urls('看 (https://example.com/search?q=a)b) 然后')).toEqual([
      'https://example.com/search?q=a)b',
    ]);
    expect(urls('看 (https://example.com/search?q=a)b)then')).toEqual([
      'https://example.com/search?q=a)b',
    ]);
    expect(urls('看 (https://example.com/search?q=a)) 然后')).toEqual([
      'https://example.com/search?q=a)',
    ]);
    expect(urls('看 (https://example.com/search?q=a))then')).toEqual([
      'https://example.com/search?q=a)',
    ]);
    expect(urls('看 (https://example.com/search#frag) 然后')).toEqual([
      'https://example.com/search#frag',
    ]);
    expect(urls('看 (https://example.com/search#frag)then')).toEqual([
      'https://example.com/search#frag',
    ]);
    expect(urls('看 (https://example.com/search#frag)) 然后')).toEqual([
      'https://example.com/search#frag)',
    ]);
    expect(urls('看 https://example.com/article/123(v2) 然后')).toEqual([
      'https://example.com/article/123(v2)',
    ]);
    expect(urls('看 https://example.com/issues/123(v2) 然后')).toEqual([
      'https://example.com/issues/123(v2)',
    ]);
    expect(urls('看 https://example.com/pull/123(foo) 然后')).toEqual([
      'https://example.com/pull/123(foo)',
    ]);
    expect(urls('看 (https://x.com/foo) 然后')).toEqual(['https://x.com/foo']);
    expect(urls('看 (https://x.com/foo)then')).toEqual(['https://x.com/foo']);
    expect(urls('看 (https://x.com/foo)-bar')).toEqual(['https://x.com/foo']);
    expect(urls('看 https://x.com/foo(中文说明')).toEqual(['https://x.com/foo']);
    expect(urls('已提交 https://github.com/makecindy/cindy/pull/283(base main,OPEN)')).toEqual([
      'https://github.com/makecindy/cindy/pull/283',
    ]);
    expect(urls('已提交 https://github.com/makecindy/cindy/pull/283(base,OPEN)')).toEqual([
      'https://github.com/makecindy/cindy/pull/283',
    ]);
    expect(urls('已提交 https://github.com/makecindy/cindy/pull/283/(base,OPEN)')).toEqual([
      'https://github.com/makecindy/cindy/pull/283/',
    ]);
    expect(urls('已提交 https://github.com/makecindy/cindy/pull/283(base,OPEN).')).toEqual([
      'https://github.com/makecindy/cindy/pull/283',
    ]);
    expect(urls('已提交 https://github.com/makecindy/cindy/pull/283#discussion_r1(base,OPEN)')).toEqual([
      'https://github.com/makecindy/cindy/pull/283#discussion_r1',
    ]);
    expect(urls('已提交 https://github.com/makecindy/cindy/pull/283#discussion_r1(base main,OPEN)')).toEqual([
      'https://github.com/makecindy/cindy/pull/283#discussion_r1',
    ]);
    expect(urls('已提交 https://github.com/makecindy/cindy/pull/283?diff=split(base,OPEN)')).toEqual([
      'https://github.com/makecindy/cindy/pull/283?diff=split',
    ]);
    expect(urls('已提交 https://github.com/makecindy/cindy/pull/283?diff=split(base main,OPEN)')).toEqual([
      'https://github.com/makecindy/cindy/pull/283?diff=split',
    ]);
    expect(urls('看 https://example.com/pull/123#frag(base,OPEN) 然后')).toEqual([
      'https://example.com/pull/123#frag(base,OPEN)',
    ]);
    expect(urls('看 https://github.com/org/repo/pull/283?check=(linux,OK) 然后')).toEqual([
      'https://github.com/org/repo/pull/283?check=(linux,OK)',
    ]);
    expect(urls('看 https://github.com/org/repo/pull/283?check=(base,OPEN) 然后')).toEqual([
      'https://github.com/org/repo/pull/283?check=(base,OPEN)',
    ]);
    expect(urls('看 https://github.com/org/repo/pull/283?check=linux(base,OPEN) 然后')).toEqual([
      'https://github.com/org/repo/pull/283?check=linux(base,OPEN)',
    ]);
    expect(urls('看 https://github.com/org/repo/pull/283#check=(base,OPEN) 然后')).toEqual([
      'https://github.com/org/repo/pull/283#check=(base,OPEN)',
    ]);
    expect(urls('看 https://github.com/org/repo/pull/283#check=linux(base,OPEN) 然后')).toEqual([
      'https://github.com/org/repo/pull/283#check=linux(base,OPEN)',
    ]);
    expect(urls('看 https://github.com/org/repo/pull/283?check=(base 然后')).toEqual([
      'https://github.com/org/repo/pull/283?check=(base',
    ]);
    expect(urls('看 https://github.com/org/repo/pull/283?check=linux(base main,OPEN) 然后')).toEqual([
      'https://github.com/org/repo/pull/283?check=linux(base',
    ]);
    expect(urls('看 (https://github.com/makecindy/cindy/pull/283(base,OPEN))')).toEqual([
      'https://github.com/makecindy/cindy/pull/283',
    ]);
    expect(urls('看 (https://github.com/makecindy/cindy/pull/283(base,OPEN)).')).toEqual([
      'https://github.com/makecindy/cindy/pull/283',
    ]);
    expect(urls('看 (https://github.com/makecindy/cindy/pull/283(base,OPEN))，状态')).toEqual([
      'https://github.com/makecindy/cindy/pull/283',
    ]);
    expect(urls('**(see https://github.com/makecindy/cindy/pull/283(base,OPEN))**')).toEqual([
      'https://github.com/makecindy/cindy/pull/283',
    ]);
    expect(urls(`已提交 ${GITLAB_MR_URL}(base,OPEN)`)).toEqual([
      GITLAB_MR_URL,
    ]);
    expect(urls(`已提交 ${GITLAB_MR_URL}/(base,OPEN)`)).toEqual([
      `${GITLAB_MR_URL}/`,
    ]);
  });

  it('matches bare session deep links as session kind', () => {
    const sessionUrl = 'xdt-maker://session/03e0c22d-19db-4ac5-814f-1ea04040b471';
    const matches = findLinkifyMatches(`看这个 ${sessionUrl} 的会话`);
    expect(matches).toEqual([
      {
        kind: 'session',
        index: 4,
        length: sessionUrl.length,
        text: sessionUrl,
        href: sessionUrl,
      },
    ]);
  });

  it('matches markdown-form session links with an explicit label', () => {
    const sessionUrl = 'xdt-maker://session/03e0c22d-19db-4ac5-814f-1ea04040b471';
    const md = `[修复语音输入白屏](${sessionUrl})`;
    const matches = findLinkifyMatches(`帮我看下 ${md} 这个任务`);
    expect(matches).toEqual([
      {
        kind: 'session',
        index: 5,
        length: md.length,
        text: md,
        href: sessionUrl,
        label: '修复语音输入白屏',
      },
    ]);
  });

  it('keeps the message anchor inside markdown-form session links', () => {
    const withAnchor = 'xdt-maker://session/abc-123?message=client-9';
    const md = `[某条消息](${withAnchor})`;
    expect(findLinkifyMatches(md)).toEqual([
      {
        kind: 'session',
        index: 0,
        length: md.length,
        text: md,
        href: withAnchor,
        label: '某条消息',
      },
    ]);
  });

  it('keeps square brackets inside markdown labels intact (review P1)', () => {
    const sessionUrl = 'xdt-maker://session/abc-123';
    const md = `[[WIP] 修复白屏](${sessionUrl})`;
    expect(findLinkifyMatches(md)).toEqual([
      {
        kind: 'session',
        index: 0,
        length: md.length,
        text: md,
        href: sessionUrl,
        label: '[WIP] 修复白屏',
      },
    ]);
  });

  it('does not swallow preceding bracketed text into the label (review P1 round 2)', () => {
    const sessionUrl = 'xdt-maker://session/abc-123';
    const inner = `[修复白屏](${sessionUrl})`;
    const matches = findLinkifyMatches(`[x] ${inner}`);
    expect(matches).toEqual([
      {
        kind: 'session',
        index: 4,
        length: inner.length,
        text: inner,
        href: sessionUrl,
        label: '修复白屏',
      },
    ]);
  });

  it('treats escaped brackets in labels as literals (review P1 round 3)', () => {
    const sessionUrl = 'xdt-maker://session/abc-123';
    const md = `[修复 \\] 白屏](${sessionUrl})`;
    expect(findLinkifyMatches(md)).toEqual([
      {
        kind: 'session',
        index: 0,
        length: md.length,
        text: md,
        href: sessionUrl,
        label: '修复 ] 白屏',
      },
    ]);
    // 锚点 `]` 自身被转义 → 整段不按 markdown 链接识别,内部 href 裸链接降级。
    const escapedClose = `[标题\\](${sessionUrl})`;
    expect(findLinkifyMatches(escapedClose)).toEqual([
      {
        kind: 'session',
        index: escapedClose.indexOf(sessionUrl),
        length: sessionUrl.length,
        text: sessionUrl,
        href: sessionUrl,
      },
    ]);
  });

  it('omits label when markdown label is empty or equals the href', () => {
    const sessionUrl = 'xdt-maker://session/abc-123';
    expect(findLinkifyMatches(`[](${sessionUrl})`)[0]).not.toHaveProperty('label');
    expect(findLinkifyMatches(`[${sessionUrl}](${sessionUrl})`)[0]).not.toHaveProperty('label');
    // 无论 label 形态,整段 markdown 只产出一个 session 匹配(内部裸链接被
    // 重叠过滤丢弃,不重复渲染 chip)。
    expect(findLinkifyMatches(`[${sessionUrl}](${sessionUrl})`)).toHaveLength(1);
  });

  it('keeps the message anchor and trims trailing punctuation on session links', () => {
    const withAnchor = 'xdt-maker://session/abc-123?message=client-9';
    expect(findLinkifyMatches(`跳到 ${withAnchor}，谢谢`)[0]).toMatchObject({
      kind: 'session',
      text: withAnchor,
    });
    expect(findLinkifyMatches(`see ${withAnchor}.`)[0]).toMatchObject({
      kind: 'session',
      text: withAnchor,
    });
  });

  it('matches bare project deep links as project kind', () => {
    const projectUrl = 'xdt-maker://project/%2FUsers%2Fdash%2FCode%2FTools%2Fxdt-maker';
    expect(findLinkifyMatches(`项目在 ${projectUrl} 这里`)).toEqual([
      {
        kind: 'project',
        index: 4,
        length: projectUrl.length,
        text: projectUrl,
        href: projectUrl,
      },
    ]);
  });

  it('matches markdown-form project links with an explicit label', () => {
    const projectUrl = 'xdt-maker://project/%2FUsers%2Fdash%2FCode%2FTools%2Fxdt-maker';
    const md = `[主仓](${projectUrl})`;
    expect(findLinkifyMatches(md)).toEqual([
      {
        kind: 'project',
        index: 0,
        length: md.length,
        text: md,
        href: projectUrl,
        label: '主仓',
      },
    ]);
  });

  it('does not match unknown xdt-maker URL shapes', () => {
    expect(findLinkifyMatches('xdt-maker://other/foo')).toEqual([]);
    expect(findLinkifyMatches('xdt-maker://project/')).toEqual([]);
  });

  it('rejects legacy project links with raw delimiters instead of prefix-matching (review P2)', () => {
    // 旧编码放行 `'()`,历史链接可能含裸字符;白名单截断出的前缀会让 chip
    // 聚焦到错误项目——整段降级纯文本。
    expect(findLinkifyMatches('xdt-maker://project/%2Ftmp%2Ffoo(copy)')).toEqual([]);
    expect(findLinkifyMatches("xdt-maker://project/%2FJohn's%20Repo")).toEqual([]);
  });

  it('still matches a bare project link wrapped in prose parentheses', () => {
    const projectUrl = 'xdt-maker://project/%2Ftmp%2Ffoo';
    expect(findLinkifyMatches(`(${projectUrl})`)[0]).toMatchObject({
      kind: 'project',
      href: projectUrl,
    });
  });

  // 双 scheme 收敛:主 scheme cindy:// 与历史 xdt-maker://(上方全部用例)
  // 同一口径匹配;长度切片按实际命中的前缀(两 scheme 长度不同)。
  it('matches primary-scheme cindy:// session links (bare + markdown form)', () => {
    const sessionUrl = 'cindy://session/03e0c22d-19db-4ac5-814f-1ea04040b471';
    expect(findLinkifyMatches(`看这个 ${sessionUrl} 的会话`)).toEqual([
      {
        kind: 'session',
        index: 4,
        length: sessionUrl.length,
        text: sessionUrl,
        href: sessionUrl,
      },
    ]);
    const md = `[修复白屏](${sessionUrl}?message=m1)`;
    expect(findLinkifyMatches(md)).toEqual([
      {
        kind: 'session',
        index: 0,
        length: md.length,
        text: md,
        href: `${sessionUrl}?message=m1`,
        label: '修复白屏',
      },
    ]);
  });

  it('matches primary-scheme cindy:// project links and rejects empty ids per scheme', () => {
    const projectUrl = 'cindy://project/%2Ftmp%2Ffoo';
    expect(findLinkifyMatches(`项目在 ${projectUrl} 这里`)[0]).toMatchObject({
      kind: 'project',
      href: projectUrl,
    });
    expect(findLinkifyMatches('cindy://other/foo')).toEqual([]);
    expect(findLinkifyMatches('cindy://project/')).toEqual([]);
    expect(findLinkifyMatches('cindy://session/')).toEqual([]);
  });

  it('matches both schemes mixed in one message', () => {
    const legacy = 'xdt-maker://session/aaa-111';
    const primary = 'cindy://session/bbb-222';
    const matches = findLinkifyMatches(`${legacy} 与 ${primary}`);
    expect(matches.map((m) => (m.kind === 'session' ? m.href : null))).toEqual([
      legacy,
      primary,
    ]);
  });
});
