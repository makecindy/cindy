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
