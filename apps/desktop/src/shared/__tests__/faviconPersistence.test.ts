import { describe, expect, it } from 'vitest';

import {
  normalizePersistableFavicon,
  selectPersistableFavicon,
} from '../faviconPersistence';

describe('normalizePersistableFavicon', () => {
  it('keeps http(s) favicons and normalizes them', () => {
    expect(normalizePersistableFavicon('https://www.taptap.cn/favicon.ico')).toBe(
      'https://www.taptap.cn/favicon.ico',
    );
    expect(normalizePersistableFavicon('http://example.com/a.png')).toBe(
      'http://example.com/a.png',
    );
    // 前后空白 / 裸域名补斜杠 / 控制字符前缀都被 URL 解析器归一化。
    expect(normalizePersistableFavicon('  https://example.com/f.ico  ')).toBe(
      'https://example.com/f.ico',
    );
    expect(normalizePersistableFavicon('https://example.com')).toBe('https://example.com/');
    expect(normalizePersistableFavicon('\x01https://example.com/favicon')).toBe(
      'https://example.com/favicon',
    );
  });

  it('keeps small data: favicons (SPA dev-server case)', () => {
    const svg = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>';
    expect(normalizePersistableFavicon(svg)).toBe(svg);
    expect(normalizePersistableFavicon('data:image/png;base64,eA==')).toBe(
      'data:image/png;base64,eA==',
    );
  });

  it('rejects oversized data: favicons', () => {
    const large = `data:image/png;base64,${'x'.repeat(3 * 1024)}`;
    expect(normalizePersistableFavicon(large)).toBeNull();
  });

  it('rejects blob: favicons (session-local, cannot survive restart)', () => {
    expect(normalizePersistableFavicon('blob:https://example.com/favicon')).toBeNull();
  });

  it('rejects non-http(s) schemes (file / javascript / chrome-extension / custom app)', () => {
    expect(normalizePersistableFavicon('file:///etc/passwd')).toBeNull();
    expect(normalizePersistableFavicon('javascript:alert(1)')).toBeNull();
    expect(normalizePersistableFavicon('chrome-extension://abc/favicon.png')).toBeNull();
    expect(normalizePersistableFavicon('myapp://favicon.png')).toBeNull();
    expect(normalizePersistableFavicon('about:blank')).toBeNull();
  });

  it('rejects empty / unparsable candidates', () => {
    expect(normalizePersistableFavicon('')).toBeNull();
    expect(normalizePersistableFavicon('   ')).toBeNull();
    // 相对路径没有 base,URL 解析直接失败。
    expect(normalizePersistableFavicon('favicon.ico')).toBeNull();
  });

  it('rejects over-budget http(s) URLs', () => {
    const long = `https://example.com/${'x'.repeat(3 * 1024)}`;
    expect(normalizePersistableFavicon(long)).toBeNull();
  });
});

describe('selectPersistableFavicon', () => {
  it('returns "" for an explicitly empty candidate list (page has no icon)', () => {
    expect(selectPersistableFavicon([])).toBe('');
    // 全空白候选等同无图标 → 清掉旧图标。
    expect(selectPersistableFavicon(['', '   '])).toBe('');
  });

  it('returns the first persistable candidate', () => {
    expect(
      selectPersistableFavicon([
        'blob:https://example.com/favicon',
        'data:image/svg+xml,<svg/>',
        'https://example.com/favicon.ico',
      ]),
    ).toBe('data:image/svg+xml,<svg/>');
  });

  it('returns null when every candidate is non-persistable (keep existing icon)', () => {
    expect(selectPersistableFavicon(['blob:https://example.com/favicon'])).toBeNull();
    expect(selectPersistableFavicon(['file:///etc/passwd', 'javascript:alert(1)'])).toBeNull();
    expect(selectPersistableFavicon([`data:image/png;base64,${'x'.repeat(3 * 1024)}`])).toBeNull();
  });
});
