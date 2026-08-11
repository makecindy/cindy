/**
 * mathWebViewHtml.test.ts
 * ---------------------------------------------------------------------------
 * math WebView HTML 的结构性回归。核心约束(模拟器实测事故的教训):
 * 静态文档**零阻塞外链**——<head> 里的外链 CSS 是渲染阻塞、<script src> 是
 * 解析阻塞,CDN 挂起时页面永久白屏 + WKWebView 反复重排造成整屏闪动。
 * KaTeX 资源只允许由内联 loader 动态注入(固定本地资源 + 超时)。
 */

import { describe, expect, it } from 'vitest';
import {
  MOBILE_KATEX_VERSION,
  buildKatexLoaderJs,
  buildMathWebViewHtml,
} from '@/session/mathWebViewHtml';
import { buildSelectableMarkdownHtml } from '@/session/selectableMarkdownHtml';

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
    // fallback = lightColors.surface;随 CINDY 色板(U3+U8)同步为 #EDEDED。
    expect(html).toContain('background: #EDEDED');
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
});
