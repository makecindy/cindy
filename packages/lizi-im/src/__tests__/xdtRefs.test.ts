/**
 * xdtRefs.test.ts — IM 正文托管图片引用双协议回归。
 * 钉死:cindy-media://(媒体总仓新地址)与老 xdt-image:// 在收集/占位/分类
 * 三个纯函数里同等对待——只认老协议会让 IM 卡片露裸 markdown(review P1)。
 */

import { describe, it, expect } from 'vitest';

import {
  classifyXdtOnly,
  collectXdtFileLinks,
  collectXdtImageRefs,
  collectXdtImageUrls,
  stripXdtFileLinks,
  stripXdtForStreaming,
  stripXdtImageLinks,
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

  it('still finds a valid ref after malformed Markdown', () => {
    const text = `broken [ prefix ![chart](${BLOB})`;

    expect(collectXdtImageUrls(text)).toEqual([BLOB]);
    expect(stripXdtImageLinks(text)).toBe('broken [ prefix ');
  });
});
