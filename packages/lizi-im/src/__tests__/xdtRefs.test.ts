/**
 * xdtRefs.test.ts — IM 正文托管图片引用双协议回归。
 * 钉死:cindy-media://(媒体总仓新地址)与老 xdt-image:// 在收集/占位/分类
 * 三个纯函数里同等对待——只认老协议会让 IM 卡片露裸 markdown(review P1)。
 */

import { describe, it, expect } from 'vitest';

import {
  classifyXdtOnly,
  collectXdtFileLinks,
  collectXdtFileRefs,
  collectXdtImageRefs,
  collectXdtImageUrls,
  markdownCodeRanges,
  normalizeXdtAbsPath,
  stripXdtFileLinks,
  stripXdtForStreaming,
  stripXdtImageLinks,
  transformXdtRefs,
  xdtFileUrlToAbsPath,
} from '../xdtRefs.js';

const LEGACY = 'xdt-image://feishu-media-images/tok.png';
const BLOB = `cindy-media://blobs/${'a'.repeat(64)}.png`;

describe('collectXdtImageUrls(双协议)', () => {
  it('同时收集老 xdt-image 与新 cindy-media,去重', () => {
    const text = `看图 ![a](${LEGACY}) 和 ![b](${BLOB}) 再来一遍 ![c](${BLOB})`;
    expect(collectXdtImageUrls(text)).toEqual([LEGACY, BLOB]);
  });
});

describe('stripXdtForStreaming(双协议)', () => {
  it('cindy-media 图片引用同样打占位,不露裸 URL', () => {
    const out = stripXdtForStreaming(`前文 ![猫](${BLOB}) 后文`);
    expect(out).not.toContain('cindy-media://');
    expect(out).toContain('🖼️ 猫');
  });
});

describe('classifyXdtOnly(双协议)', () => {
  it('纯 cindy-media 图片正文归类 image-only(流式期出友好占位)', () => {
    expect(classifyXdtOnly(`![x](${BLOB})`)).toBe('image-only');
    expect(classifyXdtOnly(`![x](${BLOB}) 还有文字`)).toBe('mixed-or-text');
  });
});

describe('xdtFileUrlToAbsPath(Windows 盘符,规则 15)', () => {
  it('剥掉盘符路径的多余前导斜杠,Unix 路径不受影响', () => {
    expect(xdtFileUrlToAbsPath('xdt-file:///C:\\Users\\x\\f.txt')).toBe('C:\\Users\\x\\f.txt');
    expect(xdtFileUrlToAbsPath('xdt-file:///C:/Users/x/f.txt')).toBe('C:/Users/x/f.txt');
    expect(xdtFileUrlToAbsPath('xdt-file:///home/u/f.txt')).toBe('/home/u/f.txt');
  });
});

describe('linear managed-media parser', () => {
  it('preserves source offsets while parsing image and file refs', () => {
    const file = 'xdt-file:///tmp/report.txt';
    const text = `before ![chart](${BLOB}) [report](${file}) after`;

    expect(collectXdtImageRefs(text)).toEqual([
      {
        alt: 'chart',
        url: BLOB,
        start: text.indexOf('!['),
        end: text.indexOf(')') + 1,
      },
    ]);
    expect(collectXdtFileLinks(text)).toEqual([
      { alt: 'report', absPath: '/tmp/report.txt' },
    ]);
    expect(stripXdtFileLinks(stripXdtImageLinks(text))).toBe('before   after');
  });

  it('handles long near-matches without regex backtracking', () => {
    const nearImage = `![${'![\\\\'.repeat(20_000)}`;
    const nearUrl = `![](xdt-image://${'![](xdt-image://'.repeat(20_000)}`;

    expect(collectXdtImageUrls(nearImage)).toEqual([]);
    expect(collectXdtImageUrls(nearUrl)).toEqual([]);
    expect(stripXdtForStreaming(nearImage)).toBe(nearImage);
    expect(stripXdtForStreaming(nearUrl)).toBe(nearUrl);
  });

  it('大量嵌套未闭合候选 + 单个尾括号仍是线性(#1856 review 第三轮: 畸形恢复曾退化成 Θ(n²))', () => {
    // 每次恢复把 cursor 挪到下一个 '[', 无缓存实现让 N 个候选各自重扫同一个
    // 尾括号。实测(本机, N=200k / 3.2MB): 平方实现 ~4.8s, 线性实现 ~31ms ——
    // 靠本用例 2s 的超时预算把回归钉死, 而不是脆弱的墙钟断言。
    const nested = '[a](xdt-file://x'.repeat(200_000) + ')';

    expect(collectXdtFileRefs(nested)).toEqual([
      {
        alt: 'a',
        url: 'xdt-file://x',
        start: nested.lastIndexOf('['),
        end: nested.length,
      },
    ]);
    expect(stripXdtForStreaming(nested).endsWith('[📎 a · 准备发送...]')).toBe(true);
  }, 2_000);

  it('URL 段密集非起点方括号 + 单个尾括号: 照常收下, 不逐个重扫', () => {
    const url = `xdt-file://${'[x]'.repeat(30_000)}`;
    const dense = `[a](${url})`;

    expect(collectXdtFileRefs(dense)).toEqual([{ alt: 'a', url, start: 0, end: dense.length }]);
    expect(stripXdtForStreaming(dense)).toBe('[📎 a · 准备发送...]');
  });

  it('still finds a valid ref after malformed Markdown', () => {
    const text = `broken [ prefix ![chart](${BLOB})`;

    expect(collectXdtImageUrls(text)).toEqual([BLOB]);
    expect(stripXdtImageLinks(text)).toBe('broken [ prefix ');
  });

  it('未闭合 file 引用在前不吞后续合法 image(#1856 review P2 回归)', () => {
    // 畸形候选一路扫到 image 的右括号, 修复前 good 图整段被吞:
    // 收集为 0、transform 把含合法引用的整段错误改写。
    const text = `[bad](xdt-file://unterminated ![good](${BLOB}) 尾巴`;

    expect(collectXdtImageUrls(text)).toEqual([BLOB]);
    expect(collectXdtFileRefs(text)).toEqual([]);
    expect(stripXdtImageLinks(text)).toBe('[bad](xdt-file://unterminated  尾巴');
    expect(transformXdtRefs(text, { image: ({ alt }) => `<${alt}>` })).toBe(
      '[bad](xdt-file://unterminated <good> 尾巴',
    );
  });

  it('未闭合 image 引用在前不吞后续合法 file(同根因对称面)', () => {
    const file = 'xdt-file:///tmp/r.txt';
    const text = `![bad](xdt-image://unterminated [report](${file})`;

    expect(collectXdtImageUrls(text)).toEqual([]);
    expect(collectXdtFileLinks(text)).toEqual([{ alt: 'report', absPath: '/tmp/r.txt' }]);
    expect(stripXdtFileLinks(text)).toBe('![bad](xdt-image://unterminated ');
  });

  it('URL 里的方括号文件名保留(#1856 review P1: 畸形恢复判据收窄到"真引用起点")', () => {
    // 早先"URL 段出现任意 '[' 即放弃"过宽, 把这类合法文件名静默丢掉。
    expect(collectXdtFileLinks('[f](xdt-file:///tmp/a[1].txt)')).toEqual([
      { alt: 'f', absPath: '/tmp/a[1].txt' },
    ]);
    // %5B 编码写法继续可用。
    expect(collectXdtFileLinks('[f](xdt-file:///tmp/a%5B1%5D.txt)')).toEqual([
      { alt: 'f', absPath: '/tmp/a[1].txt' },
    ]);
  });

  it('方括号文件名的中文 alt 引用同样收集(Codex 原例)', () => {
    expect(collectXdtFileLinks('[报告](xdt-file:///tmp/report[final].pdf)')).toEqual([
      { alt: '报告', absPath: '/tmp/report[final].pdf' },
    ]);
  });

  it('image URL 含方括号也保留(两类引用同一判据)', () => {
    expect(collectXdtImageUrls('![a](xdt-image://x[1].png)')).toEqual(['xdt-image://x[1].png']);
  });

  it('URL 段先出现非起点方括号、后跟真引用: 仍在真起点处恢复', () => {
    // 两类边界不互相回归: 非起点的 '[note]' 不触发放弃, 真引用起点仍要救回来。
    const text = `[bad](xdt-file://unterminated [note] ![good](${BLOB})`;

    expect(collectXdtImageUrls(text)).toEqual([BLOB]);
    expect(collectXdtFileRefs(text)).toEqual([]);
    expect(stripXdtImageLinks(text)).toBe('[bad](xdt-file://unterminated [note] ');
  });
});

describe('collectXdtFileRefs(hook 出站收敛,#1855)', () => {
  it('按源顺序返回未解码 URL,不去重(URL 维度记账由调用方做)', () => {
    const file = 'xdt-file:///tmp/a%20b.txt';
    const text = `一份 [报告](${file}) 再引一次 [同一份](${file})`;
    const refs = collectXdtFileRefs(text);
    expect(refs.map((r) => r.url)).toEqual([file, file]);
    expect(refs.map((r) => r.alt)).toEqual(['报告', '同一份']);
    expect(refs[0].start).toBe(text.indexOf('[报告]'));
  });

  it('图片语法 + xdt-file 协议不算文件引用(与个人渠道收口同口径)', () => {
    expect(collectXdtFileRefs('![f](xdt-file:///tmp/x.txt)')).toEqual([]);
  });

  it('parses an angle-bracket destination with an optional Markdown title', () => {
    const text = '[报告](<xdt-file:///tmp/report.pdf> "下载")';
    expect(collectXdtFileRefs(text)).toEqual([
      {
        alt: '报告',
        url: 'xdt-file:///tmp/report.pdf',
        start: 0,
        end: text.length,
      },
    ]);
    expect(transformXdtRefs(text, { file: ({ alt }) => alt })).toBe('报告');
  });

  it('allows one line ending between an angle destination and its title', () => {
    for (const lineEnding of ['\n', '\r', '\r\n']) {
      const text = `[报告](<xdt-file:///tmp/report.pdf>${lineEnding}"说明")`;
      expect(collectXdtFileRefs(text)).toEqual([
        {
          alt: '报告',
          url: 'xdt-file:///tmp/report.pdf',
          start: 0,
          end: text.length,
        },
      ]);
    }

    expect(collectXdtFileRefs('[报告](<xdt-file:///tmp/report.pdf>\n\n"说明")')).toEqual([]);
  });

  it('continues after a malformed angle-bracket destination and finds the next ref', () => {
    const text =
      '[broken](<xdt-file:///tmp/broken.pdf "missing angle" [report](xdt-file:///tmp/report.pdf)';

    expect(collectXdtFileLinks(text)).toEqual([{ alt: 'report', absPath: '/tmp/report.pdf' }]);
  });

  it('scans repeated unclosed angle destinations in linear time', () => {
    const text = '[x](<xdt-file://missing'.repeat(20_000);
    const startedAt = performance.now();

    expect(collectXdtFileRefs(text)).toEqual([]);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it('parses a plain destination with an optional Markdown title', () => {
    const quoted = '[报告](xdt-file:///tmp/report.pdf "下载")';
    const quotedWithParen = '[报告](xdt-file:///tmp/report.pdf "第 1) 版")';
    const parenthesized = '[报告](xdt-file:///tmp/report.pdf (下载))';

    for (const text of [quoted, quotedWithParen, parenthesized]) {
      expect(collectXdtFileRefs(text)).toEqual([
        {
          alt: '报告',
          url: 'xdt-file:///tmp/report.pdf',
          start: 0,
          end: text.length,
        },
      ]);
    }
  });

  it('allows one line ending between a plain destination and its title', () => {
    const text = '[报告](xdt-file:///tmp/report.pdf\n"第 1) 版")';

    expect(collectXdtFileRefs(text)).toEqual([
      {
        alt: '报告',
        url: 'xdt-file:///tmp/report.pdf',
        start: 0,
        end: text.length,
      },
    ]);
    expect(collectXdtFileRefs('[报告](xdt-file:///tmp/report.pdf\n\n"说明")')).toEqual([]);
  });

  it('parses balanced parentheses in a plain file destination', () => {
    const text = '[报告](xdt-file:///work/a(b)c.pdf)';

    expect(collectXdtFileRefs(text)).toEqual([
      {
        alt: '报告',
        url: 'xdt-file:///work/a(b)c.pdf',
        start: 0,
        end: text.length,
      },
    ]);
    expect(transformXdtRefs(text, { file: ({ alt }) => alt })).toBe('报告');
  });

  it('limits balanced parentheses in a plain destination to CommonMark depth', () => {
    const destination = (depth: number): string =>
      `xdt-file:///work/${'('.repeat(depth)}secret.pdf${')'.repeat(depth)}`;
    const accepted = `[示例](${destination(32)})`;
    const rejected = `[示例](${destination(33)})`;

    expect(collectXdtFileRefs(accepted)).toHaveLength(1);
    expect(collectXdtFileRefs(rejected)).toEqual([]);
    expect(transformXdtRefs(rejected, { file: ({ alt }) => alt })).toBe(rejected);
  });

  it('parses nested brackets in an attachment label', () => {
    const text = '[报告 [最终版]](xdt-file:///work/report.pdf)';

    expect(collectXdtFileRefs(text)).toEqual([
      {
        alt: '报告 [最终版]',
        url: 'xdt-file:///work/report.pdf',
        start: 0,
        end: text.length,
      },
    ]);
    expect(transformXdtRefs(text, { file: ({ alt }) => alt })).toBe('报告 [最终版]');
  });

  it('rejects an outer file link whose label already contains a link', () => {
    const text = '[outer [inner](https://example.com)](xdt-file:///work/secret.pdf)';

    expect(collectXdtFileRefs(text)).toEqual([]);
    expect(collectXdtFileLinks(text)).toEqual([]);
    expect(transformXdtRefs(text, { file: ({ alt }) => alt })).toBe(text);
  });

  it('allows code-shaped links and images inside a file label', () => {
    const code = '[outer `[inner](https://example.com)`](xdt-file:///work/code.pdf)';
    const image = '[outer ![inner](https://example.com/a.png)](xdt-file:///work/image.pdf)';

    expect(collectXdtFileRefs(`${code}\n${image}`).map(({ alt, url }) => ({ alt, url }))).toEqual([
      { alt: 'outer `[inner](https://example.com)`', url: 'xdt-file:///work/code.pdf' },
      { alt: 'outer ![inner](https://example.com/a.png)', url: 'xdt-file:///work/image.pdf' },
    ]);
  });

  it('requires whitespace before an angle destination title', () => {
    const text = '[示例](<xdt-file:///work/secret.pdf>"title")';

    expect(collectXdtFileRefs(text)).toEqual([]);
    expect(collectXdtFileLinks(text)).toEqual([]);
    expect(transformXdtRefs(text, { file: ({ alt }) => alt })).toBe(text);
  });

  it('rejects invalid characters inside an angle file destination', () => {
    const texts = [
      '[示例](<xdt-file:///work/secret<draft.pdf>)',
      '[示例](<xdt-file:///work/secret\nreport.pdf>)',
    ];

    for (const text of texts) {
      expect(collectXdtFileRefs(text)).toEqual([]);
      expect(collectXdtFileLinks(text)).toEqual([]);
      expect(transformXdtRefs(text, { file: ({ alt }) => alt })).toBe(text);
    }
  });

  it('rejects a plain file destination with unescaped whitespace', () => {
    const texts = [
      '[示例](xdt-file:///work/secret report.pdf)',
      '[示例](xdt-file:///work/secret report.pdf "title")',
      '[示例](xdt-file:///work/secret report.pdf (title))',
      '[示例](xdt-file:///work/secret\\ report.pdf)',
    ];

    for (const text of texts) {
      expect(collectXdtFileRefs(text)).toEqual([]);
      expect(collectXdtFileLinks(text)).toEqual([]);
      expect(transformXdtRefs(text, { file: ({ alt }) => alt })).toBe(text);
    }
  });

  it('ignores file references inside inline code and fenced code blocks', () => {
    const inline = '`[报告](xdt-file:///tmp/inline.pdf)`';
    const fenced = '```md\n[报告](xdt-file:///tmp/fenced.pdf)\n```';
    const text = `${inline}\n${fenced}`;

    expect(collectXdtFileRefs(text)).toEqual([]);
    expect(transformXdtRefs(text, { file: () => '附件' })).toBe(text);
  });

  it('does not treat escaped backticks as an inline code range', () => {
    const text = '\\`[报告](xdt-file:///tmp/report.pdf)\\`';

    expect(collectXdtFileLinks(text)).toEqual([
      { alt: '报告', absPath: '/tmp/report.pdf' },
    ]);
    expect(transformXdtRefs(text, { file: ({ alt }) => alt })).toBe('\\`报告\\`');
  });

  it('redacts escaped file links without collecting them for upload', () => {
    const text =
      '\\[示例](xdt-file:///tmp/secret.pdf) and \\\\[报告](xdt-file:///tmp/report.pdf)';

    expect(collectXdtFileLinks(text)).toEqual([
      { alt: '报告', absPath: '/tmp/report.pdf' },
    ]);
    expect(collectXdtFileRefs(text).map(({ alt, url }) => ({ alt, url }))).toEqual([
      { alt: '报告', url: 'xdt-file:///tmp/report.pdf' },
    ]);
    expect(transformXdtRefs(text, { file: ({ alt }) => alt })).toBe(
      '\\示例 and \\\\报告',
    );
  });

  it('applies the same escaped-marker rule to managed images', () => {
    const escaped = `cindy-media://blobs/${'e'.repeat(64)}.png`;
    const deliverable = `cindy-media://blobs/${'d'.repeat(64)}.png`;
    const text = `\\![示例](${escaped}) and \\\\![图片](${deliverable})`;

    expect(collectXdtImageUrls(text)).toEqual([deliverable]);
    expect(transformXdtRefs(text, { image: ({ alt }) => alt })).toBe(
      '\\示例 and \\\\图片',
    );
  });

  it('ignores file references inside blockquote and list-container fences', () => {
    const quoted = '> ~~~md\n> [报告](xdt-file:///tmp/quoted.pdf)\n> ~~~';
    const listed = '- ```md\n  [报告](xdt-file:///tmp/listed.pdf)\n  ```';
    const nestedQuote = '> ```md\n> > [报告](xdt-file:///tmp/nested.pdf)\n> ```';
    const listShapedLiteral = '```md\n- ```\n[报告](xdt-file:///tmp/literal.pdf)\n```';

    expect(collectXdtFileRefs(`${quoted}\n${listed}\n${nestedQuote}\n${listShapedLiteral}`)).toEqual([]);
  });

  it('does not close a list fence on a new list marker inside the code block', () => {
    const text =
      '- ```md\n  - ```\n  [secret](xdt-file:///tmp/secret.pdf)\n  ```';

    expect(collectXdtFileRefs(text)).toEqual([]);
    expect(transformXdtRefs(text, { file: () => '附件' })).toBe(text);
  });

  it('keeps four-column list continuation fences inside their container', () => {
    const text =
      '1.  ```md\n    [secret](xdt-file:///tmp/secret.pdf)\n    ```';

    expect(collectXdtFileRefs(text)).toEqual([]);
    expect(transformXdtRefs(text, { file: () => '附件' })).toBe(text);
  });

  it('rejects a backtick fence opener whose info string contains a backtick', () => {
    const text =
      '```lang`\n[报告](xdt-file:///tmp/report.pdf)\n```';

    expect(collectXdtFileRefs(text).map(({ alt, url }) => ({ alt, url }))).toEqual([
      { alt: '报告', url: 'xdt-file:///tmp/report.pdf' },
    ]);
    expect(transformXdtRefs(text, { file: ({ alt }) => alt })).toBe(
      '```lang`\n报告\n```',
    );
  });

  it('ends an unclosed container fence when the container ends', () => {
    const text = '> ```md\n> example\n\n[报告](xdt-file:///tmp/outside.pdf)';

    expect(collectXdtFileRefs(text).map(({ alt, url }) => ({ alt, url }))).toEqual([
      { alt: '报告', url: 'xdt-file:///tmp/outside.pdf' },
    ]);
  });

  it('ignores file references inside four-space indented code blocks', () => {
    const text = '正文\n\n    [报告](xdt-file:///tmp/indented.pdf)\n\n结尾';

    expect(collectXdtFileRefs(text)).toEqual([]);
    expect(transformXdtRefs(text, { file: () => '附件' })).toBe(text);
  });

  it('starts indented code immediately after an ATX heading', () => {
    const text = '# 标题\n    [示例](xdt-file:///tmp/heading-code.pdf)';

    expect(collectXdtFileRefs(text)).toEqual([]);
    expect(transformXdtRefs(text, { file: () => '附件' })).toBe(text);
  });

  it('starts indented code after an ATX heading inside a list item', () => {
    const text = '- # 标题\n      [示例](xdt-file:///tmp/list-heading-code.pdf)';

    expect(collectXdtFileRefs(text)).toEqual([]);
    expect(transformXdtRefs(text, { file: () => '附件' })).toBe(text);
  });

  it('does not let an indented line interrupt an open paragraph', () => {
    const text = '正文\n    [报告](xdt-file:///tmp/paragraph-continuation.pdf)';

    expect(collectXdtFileRefs(text).map(({ alt, url }) => ({ alt, url }))).toEqual([
      { alt: '报告', url: 'xdt-file:///tmp/paragraph-continuation.pdf' },
    ]);
  });

  it('ignores managed media references inside tab-indented code blocks', () => {
    const text = `\t[报告](xdt-file:///tmp/tabbed.pdf)\n\t![图片](${BLOB})`;

    expect(collectXdtFileRefs(text)).toEqual([]);
    expect(collectXdtImageRefs(text)).toEqual([]);
    expect(transformXdtRefs(text, { file: () => '附件', image: () => '图片' })).toBe(text);
  });

  it('ignores file references inside blockquote indented code', () => {
    const text = '>     [报告](xdt-file:///tmp/private.pdf)';

    expect(collectXdtFileRefs(text)).toEqual([]);
    expect(transformXdtRefs(text, { file: () => 'sent' })).toBe(text);
  });

  it('ignores managed media references inside raw HTML blocks and comments', () => {
    const text = [
      '<pre>',
      '[报告](xdt-file:///tmp/private.pdf)',
      `![图片](${BLOB})`,
      '</pre>',
      '',
      '<!--',
      '[注释](xdt-file:///tmp/comment.pdf)',
      '-->',
    ].join('\n');

    expect(collectXdtFileRefs(text)).toEqual([]);
    expect(collectXdtImageRefs(text)).toEqual([]);
  });

  it('ignores managed media references inside generic type-7 HTML blocks', () => {
    const text = [
      '<span class="example">',
      '[报告](xdt-file:///tmp/generic-html.pdf)',
      `![图片](${BLOB})`,
      '</span>',
    ].join('\n');

    expect(collectXdtFileRefs(text)).toEqual([]);
    expect(collectXdtImageRefs(text)).toEqual([]);
  });

  it('does not let a type-7 HTML tag interrupt an open paragraph', () => {
    const text = [
      '说明',
      '<span>',
      '[报告](xdt-file:///tmp/paragraph.pdf)',
      '</span>',
    ].join('\n');

    expect(collectXdtFileRefs(text).map(({ alt, url }) => ({ alt, url }))).toEqual([
      { alt: '报告', url: 'xdt-file:///tmp/paragraph.pdf' },
    ]);
    expect(transformXdtRefs(text, { file: ({ alt }) => alt })).toContain('\n报告\n');
  });

  it('allows a type-7 HTML block after an ATX heading', () => {
    const text = [
      '# 标题',
      '<span>',
      '[示例](xdt-file:///tmp/heading-html.pdf)',
      '</span>',
    ].join('\n');

    expect(collectXdtFileRefs(text)).toEqual([]);
  });

  it('ends an unclosed HTML comment when its blockquote container ends', () => {
    const text = [
      '> <!--',
      '> 示例',
      '',
      '[报告](xdt-file:///tmp/outside.pdf)',
    ].join('\n');

    expect(collectXdtFileRefs(text).map(({ alt, url }) => ({ alt, url }))).toEqual([
      { alt: '报告', url: 'xdt-file:///tmp/outside.pdf' },
    ]);
    expect(transformXdtRefs(text, { file: ({ alt }) => alt })).toBe(
      ['> <!--', '> 示例', '', '报告'].join('\n'),
    );
  });

  it('ends an unclosed HTML comment when its list container ends', () => {
    const text = [
      '- <!--',
      '  示例',
      '',
      '[报告](xdt-file:///tmp/outside-list.pdf)',
    ].join('\n');

    expect(collectXdtFileRefs(text).map(({ alt, url }) => ({ alt, url }))).toEqual([
      { alt: '报告', url: 'xdt-file:///tmp/outside-list.pdf' },
    ]);
  });

  it('keeps a four-space list continuation eligible for attachment delivery', () => {
    const text = '- 输出：\n    [报告](xdt-file:///tmp/list-report.pdf)';
    const afterBlank = '- 输出：\n\n    [报告](xdt-file:///tmp/list-report.pdf)';

    expect(collectXdtFileRefs(text).map(({ alt, url }) => ({ alt, url }))).toEqual([
      { alt: '报告', url: 'xdt-file:///tmp/list-report.pdf' },
    ]);
    expect(transformXdtRefs(text, { file: ({ alt }) => alt })).toBe('- 输出：\n    报告');
    expect(collectXdtFileRefs(afterBlank)).toHaveLength(1);
  });

  it('classifies long list continuations in linear time', () => {
    const text = `- output\n${'    continuation\n'.repeat(20_000)}`;

    expect(markdownCodeRanges(text)).toEqual([]);
  }, 2_000);

  it('parses attachment labels with escaped closing brackets', () => {
    const text = String.raw`[a\](b](xdt-file:///tmp/report.pdf)`;

    expect(collectXdtFileRefs(text).map(({ alt, url }) => ({ alt, url }))).toEqual([
      { alt: String.raw`a\](b`, url: 'xdt-file:///tmp/report.pdf' },
    ]);
  });
});

describe('transformXdtRefs(收口正文改写共享原语)', () => {
  it('图片/文件各自按引用逐个替换,缺省的类别原样保留', () => {
    const file = 'xdt-file:///tmp/r.txt';
    const text = `头 ![猫](${BLOB}) 中 [报告](${file}) 尾`;
    expect(
      transformXdtRefs(text, {
        image: ({ alt }) => `<img:${alt}>`,
        file: ({ alt }) => `<file:${alt}>`,
      }),
    ).toBe('头 <img:猫> 中 <file:报告> 尾');
    expect(transformXdtRefs(text, { image: () => '' })).toBe(`头  中 [报告](${file}) 尾`);
    expect(transformXdtRefs(text, {})).toBe(text);
  });
});

describe('normalizeXdtAbsPath(Windows 前缀归一化唯一实现)', () => {
  it('剥掉盘符路径前导斜杠,Unix 绝对路径不动', () => {
    expect(normalizeXdtAbsPath('/C:\\Users\\x\\f.txt')).toBe('C:\\Users\\x\\f.txt');
    expect(normalizeXdtAbsPath('//C:/Users/x/f.txt')).toBe('C:/Users/x/f.txt');
    expect(normalizeXdtAbsPath('/home/u/f.txt')).toBe('/home/u/f.txt');
  });
});
