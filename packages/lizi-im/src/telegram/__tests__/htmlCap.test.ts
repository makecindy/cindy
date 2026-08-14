import { describe, expect, it } from 'vitest';

import { capRenderedText } from '../htmlCap.js';

describe('capRenderedText', () => {
  it('长度不超上限时原样返回', () => {
    expect(capRenderedText('<b>hi</b>', 100)).toBe('<b>hi</b>');
  });

  it('截点落在标签内部时回退到标签前, 不产生残缺 <', () => {
    const html = `${'x'.repeat(20)}<a href="https://example.com/very/long">link</a>`;
    const out = capRenderedText(html, 30);
    expect(out.lastIndexOf('<')).toBeLessThanOrEqual(out.lastIndexOf('>'));
  });

  it('未配对开标签在截断处补闭合(open/close 计数一致)', () => {
    const html = `<b>${'a'.repeat(50)}</b>`;
    const out = capRenderedText(html, 20);
    expect((out.match(/<b>/g) ?? []).length).toBe((out.match(/<\/b>/g) ?? []).length);
    expect(out).toContain('</b>');
    expect(out).toContain('…');
  });

  it('截点落在实体中间时回退到 & 前', () => {
    const html = `${'y'.repeat(18)}&amp;more`;
    const out = capRenderedText(html, 22);
    const amp = out.lastIndexOf('&');
    if (amp !== -1) expect(out.slice(amp)).toContain(';');
  });

  it('嵌套标签按栈序逆序闭合', () => {
    const html = `<b><i>${'z'.repeat(40)}</i></b>`;
    const out = capRenderedText(html, 15);
    // 先闭合内层 i 再闭合外层 b
    expect(out.endsWith('…</i></b>')).toBe(true);
  });
});
