/**
 * mathWebViewHtml.test.ts
 * ---------------------------------------------------------------------------
 * math WebView HTML 的结构性回归。核心约束(模拟器实测事故的教训):
 * 静态文档**零阻塞外链**——<head> 里的外链 CSS 是渲染阻塞、<script src> 是
 * 解析阻塞,CDN 挂起时页面永久白屏 + WKWebView 反复重排造成整屏闪动。
 * KaTeX 资源只允许由内联 loader 动态注入(固定本地资源 + 超时)。
 */

import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  MOBILE_KATEX_VERSION,
  buildKatexLoaderJs,
  buildMathWebViewHtml,
} from '@/session/mathWebViewHtml';
import { buildSelectableMarkdownHtml } from '@/session/selectableMarkdownHtml';

function extractLastInlineScript(html: string): string {
  const matches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  const last = matches[matches.length - 1]?.[1];
  if (!last) throw new Error('missing inline <script>');
  return last;
}

function runMathWebViewScript(options: {
  latex?: string;
  captureMarkup?: boolean;
  rootWidth: number;
  centeredScrollWidth: number;
  intrinsicWidth: number;
  scaledWidth?: (ratio: number) => number;
}) {
  const html = buildMathWebViewHtml(options.latex ?? 'E = mc^2', {}, undefined, options.captureMarkup ?? false);
  const scriptSource = extractLastInlineScript(html);

  const classes = new Set<string>();
  const messages: Array<Record<string, unknown>> = [];
  const listeners = new Map<string, Array<() => void>>();

  const katexStyle: { fontSize: string } = { fontSize: '' };
  const parseRatio = () => {
    if (!katexStyle.fontSize) return 1;
    const em = parseFloat(katexStyle.fontSize);
    return Number.isFinite(em) ? em / 1.08 : 1;
  };
  const currentWidth = () => {
    const ratio = parseRatio();
    if (options.scaledWidth) return options.scaledWidth(ratio);
    return Math.round(options.intrinsicWidth * ratio);
  };

  const katexHtmlEl = {
    get scrollWidth() {
      return currentWidth();
    },
    getBoundingClientRect: () => ({ width: currentWidth() }),
  };

  const katexEl = {
    style: katexStyle,
    get scrollWidth() {
      return classes.has('katex-overflow') ? currentWidth() : Math.round(options.centeredScrollWidth * parseRatio());
    },
    querySelector: (sel: string) => (sel === '.katex-html' ? katexHtmlEl : null),
  };

  const displayEl = {
    classList: {
      add: (c: string) => classes.add(c),
      remove: (c: string) => classes.delete(c),
      contains: (c: string) => classes.has(c),
    },
    querySelector: (sel: string) => (sel === '.katex' ? katexEl : null),
  };

  let rendered = false;
  let rootWidth = options.rootWidth;
  const rootEl = {
    innerHTML: '<pre>source</pre>',
    get clientWidth() {
      return rootWidth;
    },
    get scrollHeight() {
      return rendered ? 44 : 22;
    },
    getBoundingClientRect: () => ({ height: rendered ? 44 : 22 }),
    querySelector: (sel: string) => {
      if (!rendered) return null;
      if (sel === '.katex-display') return displayEl;
      if (sel === '.katex') return katexEl;
      return null;
    },
  };

  const windowObj: Record<string, unknown> = {
    getComputedStyle: () => ({ paddingLeft: '8px', paddingRight: '8px' }),
    ReactNativeWebView: {
      postMessage: (raw: string) => messages.push(JSON.parse(raw)),
    },
    addEventListener: (event: string, fn: () => void) => {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
    },
  };

  const documentObj = {
    head: {
      appendChild: (node: { textContent?: string }) => {
        if (node.textContent && node.textContent.includes('katex')) {
          windowObj.katex = {
            render: () => {
              rendered = true;
              rootEl.innerHTML = '<span class="katex-display"><span class="katex"><span class="katex-html">x</span></span></span>';
            },
          };
        }
      },
    },
    createElement: () => ({ textContent: '' }),
    getElementById: (id: string) => (id === 'root' ? rootEl : null),
    fonts: { ready: { then: () => undefined } },
  };

  vm.runInNewContext(scriptSource, {
    window: windowObj,
    document: documentObj,
    setTimeout: () => 1,
    clearTimeout: () => undefined,
  });

  return {
    katexStyle,
    classes,
    messages,
    resize: (nextWidth: number) => {
      rootWidth = nextWidth;
      for (const fn of listeners.get('resize') ?? []) fn();
    },
  };
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

  it('scales moderately overflowing centered formulas using intrinsic width and activates katex-overflow only when still wider than viewport', () => {
    // 1.5x intrinsic width (180px in 120px available) even when centered scrollWidth underreports at 150px:
    // ratio = 120 / 180 = 0.6667 < 0.76 -> clamped to 0.76 * 1.08 = 0.8208em, scaled width 137 > 120 -> katex-overflow enabled
    const clippedCenter = runMathWebViewScript({
      rootWidth: 136, // available = 136 - 16 = 120
      centeredScrollWidth: 150,
      intrinsicWidth: 180,
    });
    expect(clippedCenter.katexStyle.fontSize).toBe('0.8208em');
    expect(clippedCenter.classes.has('katex-overflow')).toBe(true);
    expect(clippedCenter.messages.some((m) => m.kind === 'math-height' && m.stage === 'katex')).toBe(true);

    // 1.25x intrinsic width (150px in 120px available): ratio = 0.8 >= 0.76 -> scaled to 0.8640em, fits cleanly without katex-overflow
    const fitted = runMathWebViewScript({
      rootWidth: 136,
      centeredScrollWidth: 135,
      intrinsicWidth: 150,
    });
    expect(fitted.katexStyle.fontSize).toBe('0.8640em');
    expect(fitted.classes.has('katex-overflow')).toBe(false);

    // Resizing narrower to 100px (available = 84px) re-fits and activates katex-overflow
    fitted.resize(100);
    expect(fitted.katexStyle.fontSize).toBe('0.8208em');
    expect(fitted.classes.has('katex-overflow')).toBe(true);
  });

  it('captures unscaled KaTeX markup before fitFormula mutates viewport font-size', () => {
    let capturedBeforeScale = '';
    const html = buildMathWebViewHtml('E = mc^2', {}, undefined, true);
    const scriptSource = extractLastInlineScript(html);
    const katexStyle = { fontSize: '' };
    const katexEl = {
      style: katexStyle,
      scrollWidth: 300,
      querySelector: () => ({ scrollWidth: 300, getBoundingClientRect: () => ({ width: 300 }) }),
    };
    const rootEl = {
      innerHTML: '<pre>E = mc^2</pre>',
      clientWidth: 136,
      scrollHeight: 40,
      getBoundingClientRect: () => ({ height: 40 }),
      querySelector: () => ({
        classList: { add: () => undefined, remove: () => undefined, contains: () => false },
        querySelector: () => katexEl,
      }),
    };
    const windowObj: Record<string, unknown> = {
      getComputedStyle: () => ({ paddingLeft: '8px', paddingRight: '8px' }),
      addEventListener: () => undefined,
      ReactNativeWebView: {
        postMessage: (raw: string) => {
          const msg = JSON.parse(raw) as { kind: string };
          if (msg.kind === 'math-rendered') capturedBeforeScale = katexStyle.fontSize;
        },
      },
    };
    const documentObj = {
      head: {
        appendChild: (node: { textContent?: string }) => {
          if (node.textContent && node.textContent.includes('katex')) {
            windowObj.katex = { render: () => { rootEl.innerHTML = '<span class="katex">x</span>'; } };
          }
        },
      },
      createElement: () => ({ textContent: '' }),
      getElementById: () => rootEl,
      fonts: { ready: { then: () => undefined } },
    };
    vm.runInNewContext(scriptSource, {
      window: windowObj,
      document: documentObj,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
    });
    expect(capturedBeforeScale).toBe('');
    expect(katexStyle.fontSize).toBe('0.8208em');
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

    const scriptSource = extractLastInlineScript(html);
    const makeInlineNode = (scrollWidth: number, clientWidth: number, latex: string) => {
      const classes = new Set<string>(['xdt-math-inline']);
      return {
        classes,
        scrollWidth,
        clientWidth,
        parentElement: { clientWidth },
        getAttribute: (name: string) => (name === 'data-latex' ? latex : null),
        hasAttribute: () => false,
        classList: {
          add: (c: string) => classes.add(c),
          remove: (c: string) => classes.delete(c),
          contains: (c: string) => classes.has(c),
        },
      };
    };
    const fitNode = makeInlineNode(24, 24, 'g_y');
    const wideNode = makeInlineNode(420, 280, 'a+b+c+d');
    const windowObj: Record<string, unknown> = { addEventListener: () => undefined };
    const documentObj = {
      head: {
        appendChild: (node: { textContent?: string }) => {
          if (node.textContent && node.textContent.includes('katex')) {
            windowObj.katex = { render: () => undefined };
          }
        },
      },
      createElement: () => ({ textContent: '' }),
      querySelectorAll: (sel: string) => {
        if (sel === '[data-latex]' || sel === '.xdt-math-inline') return [fitNode, wideNode];
        return [];
      },
      fonts: { ready: { then: () => undefined } },
    };
    vm.runInNewContext(scriptSource, {
      window: windowObj,
      document: documentObj,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
    });
    expect(fitNode.classes.has('xdt-math-inline-fit')).toBe(true);
    expect(wideNode.classes.has('xdt-math-inline-fit')).toBe(false);
  });
});
