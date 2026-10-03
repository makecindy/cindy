import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { ScreenCaptureOverlayPalette } from '../../../shared/screenCapture.js';
import { buildRegionCaptureOverlayHtml } from '../overlayHtml.js';

/** 形如主题 token 计算值的测试配色(与默认值不同, 便于断言真的被消费)。 */
const PALETTE: ScreenCaptureOverlayPalette = {
  scrim: 'rgba(0, 0, 0, 0.5)',
  selectionBorder: 'rgba(255, 255, 255, 0.8)',
  pillBg: '#262626',
  pillFg: '#fafafa',
};

describe('buildRegionCaptureOverlayHtml', () => {
  it('embeds the hint text and the overlay API contract', () => {
    const html = buildRegionCaptureOverlayHtml('拖动框选要截取的区域，按 Esc 取消', PALETTE);
    expect(html).toContain('拖动框选要截取的区域，按 Esc 取消');
    expect(html).toContain('regionCaptureOverlayAPI');
    expect(html).toContain('announceReady');
    expect(html).toContain('Content-Security-Policy');
  });

  // 双模式配色: renderer 解析主题 token 计算值传入, 样式按配色生成(review P1)。
  it('renders the theme palette into mask, selection and pill styles', () => {
    const html = buildRegionCaptureOverlayHtml('hint', PALETTE);
    expect(html).toContain(`background: ${PALETTE.scrim}`);
    expect(html).toContain(`border: 1px solid ${PALETTE.selectionBorder}`);
    expect(html).toContain(`background: ${PALETTE.pillBg}`);
    expect(html).toContain(`color: ${PALETTE.pillFg}`);
  });

  // CSP 用 sha256 hash 白名单内联样式/脚本, 不引入 'unsafe-inline'
  // (仓库安全约束, review P1): 样式虽按主题配色动态生成, hash 也按最终
  // 样式串运行时计算; 任一动态值转义/校验遗漏也无法注入可执行脚本。
  it('uses sha256-hash CSP without unsafe-inline', () => {
    const html = buildRegionCaptureOverlayHtml('hint', PALETTE);
    expect(html).not.toContain('unsafe-inline');
    expect(html).toContain("default-src 'none'");
    expect(html).toMatch(/style-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(html).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
    // hash 与实际内联块内容一致: 提取标签体重新计算应与 CSP 声明完全相同。
    for (const [tag, directive] of [
      ['style', 'style-src'],
      ['script', 'script-src'],
    ] as const) {
      const body = html.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1] ?? '';
      const hash = createHash('sha256').update(body, 'utf8').digest('base64');
      expect(html).toContain(`${directive} 'sha256-${hash}'`);
    }
  });

  it('escapes HTML in the hint so renderer-provided copy cannot inject markup', () => {
    const html = buildRegionCaptureOverlayHtml('<img src=x onerror=alert(1)> & "quotes"', PALETTE);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quotes&quot;');
  });
});
