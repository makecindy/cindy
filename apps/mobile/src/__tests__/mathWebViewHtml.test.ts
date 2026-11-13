/**
 * mathWebViewHtml.test.ts
 * ---------------------------------------------------------------------------
 * math WebView HTML 的结构性回归与公式排版自适应纯函数单测。
 * 核心约束(模拟器实测事故的教训):
 * 静态文档**零阻塞外链**——<head> 里的外链 CSS 是渲染阻塞、<script src> 是
 * 解析阻塞,CDN 挂起时页面永久白屏 + WKWebView 反复重排造成整屏闪动。
 * KaTeX 资源只允许由内联 loader 动态注入(固定本地资源 + 超时)。
 */

import { describe, expect, it } from 'vitest';
import {
  MOBILE_KATEX_VERSION,
  buildKatexLoaderJs,
  buildMathWebViewHtml,
  computeDisplayMathScale,
  fitDisplayFormulaElement,
  measureDisplayFormulaWidth,
  shouldEnableDisplayMathOverflow,
} from '@/session/mathWebViewHtml';
import {
  buildSelectableMarkdownHtml,
  syncInlineMathOverflowElement,
} from '@/session/selectableMarkdownHtml';

function makeDisplayMathHarness(options: {
  rootWidth: number;
  centeredScrollWidth: number;
  intrinsicWidth: number;
}) {
  const classes = new Set<string>();
  const katexStyle = { fontSize: '' };
  const parseRatio = () => {
    if (!katexStyle.fontSize) return 1;
    const em = parseFloat(katexStyle.fontSize);
    return Number.isFinite(em) ? em / 1.08 : 1;
  };
  const currentWidth = () => Math.round(options.intrinsicWidth * parseRatio());
  const htmlEl = {
    get scrollWidth() {
      return currentWidth();
    },
    getBoundingClientRect: () => ({ width: currentWidth() }),
  };
  const katexEl = {
    style: katexStyle,
    get scrollWidth() {
      return classes.has('katex-overflow')
        ? currentWidth()
        : Math.round(options.centeredScrollWidth * parseRatio());
    },
    querySelector: (sel: string) => (sel === '.katex-html' ? htmlEl : null),
  };
  const displayEl = {
    classList: {
      add: (token: string) => classes.add(token),
      remove: (token: string) => classes.delete(token),
      contains: (token: string) => classes.has(token),
    },
  };
  const rootEl = { clientWidth: options.rootWidth };
  return { rootEl, displayEl, katexEl, katexStyle, classes };
}

describe('buildMathWebViewHtml — 零阻塞外链约束', () => {
  const html = buildMathWebViewHtml('E = mc^2');

  it('静态文档不含 <link rel="stylesheet"> 与 <script src>(只许动态注入)', () => {
    expect(html).not.toMatch(/<link\s/i);
    expect(html).not.toMatch(/<script\s+src=/i);
  });

  it('公式源码作为首屏内容直接绘制(资源挂起也不白屏)', () => {
    expect(html).toContain('<pre>E = mc^2</pre>');
  });

  it('loader 使用随包分发的固定 KaTeX 资源', () => {
    expect(MOBILE_KATEX_VERSION).toMatch(/^0\.16\./);
    expect(html).toContain('style.textContent =');
    expect(html).toContain('script.textContent =');
    expect(html).not.toContain('cdn.jsdelivr.net');
    expect(html).not.toContain('registry.npmmirror.com');
  });

  it('源码里的 HTML 特殊字符转义(首屏 pre 与注入脚本双路径)', () => {
    const evil = buildMathWebViewHtml('a < b </script> & c');
    expect(evil).not.toContain('</script> & c</pre>');
    expect(evil).toContain('&lt;/script&gt;');
    // JSON 注入路径:< > & 走 \uXXXX 转义
    expect(evil).toContain('\\u003c');
  });

  it('高度上报协议字段存在(宿主按 math-height 自适应,stage 区分过渡/最终态)', () => {
    expect(html).toContain("kind: 'math-height'");
    // 过渡态(源码占位)与最终态(KaTeX 成品)必须都有:宿主靠 stage 忽略
    // 重访时的过渡态上报,消掉高低跳动。
    expect(html).toContain("reportHeight('source')");
    expect(html).toContain("reportHeight('katex')");
  });

  it('captures unscaled KaTeX markup before fitFormula mutates viewport font-size', () => {
    const captureHtml = buildMathWebViewHtml('E = mc^2', {}, undefined, true);
    const renderPos = captureHtml.indexOf("kind: 'math-rendered'");
    const fitPos = captureHtml.indexOf('syncLayoutAndReport();', renderPos);
    expect(renderPos).toBeGreaterThan(-1);
    expect(fitPos).toBeGreaterThan(renderPos);
  });
});

describe('display math adaptive fit helpers', () => {
  it('computes scale clamped at MIN_FIT_SCALE and skips non-overflowing widths', () => {
    expect(computeDisplayMathScale(120, 90)).toBeNull();
    expect(computeDisplayMathScale(0, 180)).toBeNull();
    expect(computeDisplayMathScale(120, 150)).toEqual({
      ratio: 0.8,
      fontSizeEm: '0.8640em',
    });
    expect(computeDisplayMathScale(120, 240)).toEqual({
      ratio: 0.76,
      fontSizeEm: '0.8208em',
    });
    expect(shouldEnableDisplayMathOverflow(120, 121)).toBe(false);
    expect(shouldEnableDisplayMathOverflow(120, 122)).toBe(true);
  });

  it('measures intrinsic formula width even when centered scrollWidth underreports negative left overflow', () => {
    const harness = makeDisplayMathHarness({
      rootWidth: 136,
      centeredScrollWidth: 140,
      intrinsicWidth: 180,
    });
    expect(measureDisplayFormulaWidth(harness.displayEl, harness.katexEl)).toBe(180);
    expect(harness.classes.has('katex-overflow')).toBe(false);
  });

  it('scales overflowing formulas and enables katex-overflow only when scaled output still exceeds available width', () => {
    // 1.5x intrinsic width (180px in 120px available) with centered underreporting at 150px:
    // ratio clamped to 0.76 -> 0.8208em, scaled width 137 > 120 -> katex-overflow enabled
    const clippedCenter = makeDisplayMathHarness({
      rootWidth: 136,
      centeredScrollWidth: 150,
      intrinsicWidth: 180,
    });
    fitDisplayFormulaElement(clippedCenter.rootEl, clippedCenter.displayEl, clippedCenter.katexEl, 16);
    expect(clippedCenter.katexStyle.fontSize).toBe('0.8208em');
    expect(clippedCenter.classes.has('katex-overflow')).toBe(true);

    // 1.25x intrinsic width (150px in 120px available): ratio = 0.8 -> 0.8640em, fits centered without katex-overflow
    const fitted = makeDisplayMathHarness({
      rootWidth: 136,
      centeredScrollWidth: 135,
      intrinsicWidth: 150,
    });
    fitDisplayFormulaElement(fitted.rootEl, fitted.displayEl, fitted.katexEl, 16);
    expect(fitted.katexStyle.fontSize).toBe('0.8640em');
    expect(fitted.classes.has('katex-overflow')).toBe(false);

    // Narrowing container to 100px (84px available) re-fits and activates katex-overflow
    fitted.rootEl.clientWidth = 100;
    fitDisplayFormulaElement(fitted.rootEl, fitted.displayEl, fitted.katexEl, 16);
    expect(fitted.katexStyle.fontSize).toBe('0.8208em');
    expect(fitted.classes.has('katex-overflow')).toBe(true);

    // Widening back to 200px restores unscaled centered layout
    fitted.rootEl.clientWidth = 200;
    fitDisplayFormulaElement(fitted.rootEl, fitted.displayEl, fitted.katexEl, 16);
    expect(fitted.katexStyle.fontSize).toBe('');
    expect(fitted.classes.has('katex-overflow')).toBe(false);
  });
});

describe('buildMathWebViewHtml — 主题色净化', () => {
  it('合法 hex / rgba 原样使用', () => {
    const html = buildMathWebViewHtml('x', {
      background: '#1f1f1e',
      textPrimary: 'rgba(212, 212, 212, 0.9)',
    });
    expect(html).toContain('background: #1f1f1e');
    expect(html).toContain('rgba(212, 212, 212, 0.9)');
  });

  it('非法颜色值(注入尝试)回退默认,不进 CSS/JS', () => {
    const evil = "red'; } </style><script>alert(1)</script>";
    const html = buildMathWebViewHtml('x', {
      background: evil,
      errorColor: evil,
    });
    expect(html).not.toContain('alert(1)');
    // fallback = lightColors.surface;随 2026-09-26 移动端象牙白色板同步为 #F9F9F6。
    expect(html).toContain('background: #F9F9F6');
  });
});

describe('buildKatexLoaderJs', () => {
  it('包含超时降级与 window.katex 就绪检查', () => {
    const js = buildKatexLoaderJs('doRender();');
    expect(js).toContain('script.textContent =');
    expect(js).toContain('setTimeout(fail, 1000)');
    expect(js).toContain('if (!window.katex) { fail(); return; }');
    expect(js).toContain(
      'try { doRender(); } catch (error) { fail(); return; }',
    );
    expect(js).toContain('setTimeout');
    expect(js).toContain('window.katex');
    expect(js).toContain('doRender();');
    expect(js).not.toContain('</script>');
  });
});

describe('buildSelectableMarkdownHtml — math 文档同守零阻塞约束', () => {
  it('含公式文档:loader 注入、无静态外链、占位源码保留', () => {
    const html = buildSelectableMarkdownHtml(
      '段落 $E=mc^2$ 和\n\n$$\n\\frac{1}{2}\n$$',
    );
    expect(html).not.toMatch(/<link\s/i);
    expect(html).not.toMatch(/<script\s+src=/i);
    expect(html).toContain('data-latex');
    expect(html).toContain('data-katex-display');
    expect(html).toContain('script.textContent =');
    expect(html).not.toContain('cdn.jsdelivr.net');
  });

  it('不含公式文档:不注入 KaTeX loader', () => {
    const html = buildSelectableMarkdownHtml('普通文档,没有公式。');
    expect(html).not.toContain('katex');
  });

  it('enables true baseline alignment for fitting inline math while keeping overflow scrolling for wide inline math', () => {
    const html = buildSelectableMarkdownHtml('行内 $g_y$ 和 $a+b+c+d$ 公式');
    const ruleFit = html.match(/\.xdt-math-inline\.xdt-math-inline-fit\s*\{[^}]*\}/)?.[0] ?? '';
    expect(ruleFit).toContain('overflow-x: visible;');
    expect(ruleFit).toContain('vertical-align: baseline;');

    const fitClasses = new Set<string>(['xdt-math-inline']);
    const fitNode = {
      scrollWidth: 24,
      clientWidth: 24,
      parentElement: { clientWidth: 280 },
      classList: {
        add: (c: string) => fitClasses.add(c),
        remove: (c: string) => fitClasses.delete(c),
      },
    };
    const wideClasses = new Set<string>(['xdt-math-inline']);
    const wideNode = {
      scrollWidth: 420,
      clientWidth: 280,
      parentElement: { clientWidth: 280 },
      classList: {
        add: (c: string) => wideClasses.add(c),
        remove: (c: string) => wideClasses.delete(c),
      },
    };

    expect(syncInlineMathOverflowElement(fitNode)).toBe(true);
    expect(fitClasses.has('xdt-math-inline-fit')).toBe(true);

    expect(syncInlineMathOverflowElement(wideNode)).toBe(false);
    expect(wideClasses.has('xdt-math-inline-fit')).toBe(false);
  });
});
