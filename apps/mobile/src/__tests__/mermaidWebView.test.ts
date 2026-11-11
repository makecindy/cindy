import { describe, expect, it } from 'vitest';
import {
  MOBILE_MERMAID_VERSION,
  buildMermaidLoaderJs,
  buildMermaidWebViewHtml,
} from '@/session/mermaidWebViewHtml';

describe('mermaidWebView', () => {
  it('builds a self-contained WebView document that loads Mermaid in strict mode', () => {
    const html = buildMermaidWebViewHtml('graph TD\nA --> B');

    expect(MOBILE_MERMAID_VERSION).toMatch(/^11\./);
    expect(html).toContain('script.textContent =');
    expect(html).not.toContain('cdn.jsdelivr.net');
    expect(html).not.toContain('registry.npmmirror.com');
    expect(html).toContain("securityLevel: 'strict'");
    // htmlLabels:false 是导出 PNG 的前提(foreignObject 在 WebKit canvas 里丢文字)
    expect(html).toContain(
      'flowchart: { useMaxWidth: false, htmlLabels: false }',
    );
    expect(html).toContain('graph TD\\nA --\\u003e B');
  });

  it('导出协议:SVG 光栅化函数就位(viewBox 固有尺寸 + canvas 上限收敛 + 实底)', () => {
    const html = buildMermaidWebViewHtml('graph TD\nA --> B');
    expect(html).toContain('window.__cindyMermaidExportPng = function');
    expect(html).toContain("post({ type: 'mermaid-export', id: id, ok: true");
    expect(html).toContain('4096 / Math.max(w, h)');
    expect(html).toContain("canvas.toDataURL('image/png')");
  });

  it('escapes source before injecting it into the script tag', () => {
    const html = buildMermaidWebViewHtml(
      'graph TD\nA["</script><img src=x>"] --> B',
    );

    expect(html).not.toContain('"</script><img src=x>"');
    expect(html).toContain('\\u003c/script\\u003e\\u003cimg src=x\\u003e');
  });

  it('离线加固:零外链 + 源码首屏 + 本地资源失败降级', () => {
    const html = buildMermaidWebViewHtml('graph TD\nA --> B');

    // 不允许出现阻塞式外链 <script src=...>:CDN 挂起会让页面停在 loading 几十秒
    expect(html).not.toMatch(/<script src=/);
    // 首屏内容是图表源码(而非 "Loading Mermaid..." 占位)
    expect(html).not.toContain('Loading Mermaid');
    expect(html).toContain('<div id="root" class="source"><pre>graph TD');
    // 动态注入固定版本的本地资源,执行失败仍停留在源码
    expect(html).toContain('script.textContent =');
    expect(html).not.toContain('cdn.jsdelivr.net');
    expect(html).not.toContain('registry.npmmirror.com');
    expect(html).toContain('setTimeout(fail, 1000)');
  });

  it('渲染回调异常时仍进入源码降级', () => {
    const js = buildMermaidLoaderJs('renderMermaid();', 'showSource();');

    expect(js).toContain(
      'try { renderMermaid(); } catch (error) { fail(); return; }',
    );
    expect(js).not.toContain('</script>');
  });

  it('parse 失败兜底:注入 mermaidAutofix 修复版;合法源码注入空串跳过重试', () => {
    const broken = buildMermaidWebViewHtml('flowchart TD\nA → B');
    expect(broken).toContain(
      'const repairedSource = "flowchart TD\\nA --\\u003e B"',
    );
    expect(broken).toContain('mobile-mermaid-diagram-fixed');

    const ok = buildMermaidWebViewHtml('graph TD\nA --> B');
    expect(ok).toContain('const repairedSource = ""');
  });

  it('首屏源码经 HTML 转义(escapeHtmlText),不给注入留口', () => {
    const html = buildMermaidWebViewHtml('graph TD\nA["<b>x</b>"] --> B');
    expect(html).toContain('A[&quot;'.replace('&quot;', '"')); // 引号不转义,尖括号必须转义
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('deferSource:首屏留空背景不闪源码,本地资源失败 / 空源码显式降级到源码', () => {
    const html = buildMermaidWebViewHtml('graph TD\nA --> B', {
      deferSource: true,
    });
    // 首屏无源码 pre(干净背景等 SVG 浮现,观感同图片加载)
    expect(html).toContain('<div id="root" class="source"></div>');
    // 「静默停留首屏」的两条路径必须显式 showSource,否则永远空白
    expect(html).toContain('{ showSource(); return; }');
    // 默认(内联)模式不受影响:源码仍是首屏
    const inlineHtml = buildMermaidWebViewHtml('graph TD\nA --> B');
    expect(inlineHtml).toContain('<div id="root" class="source"><pre>graph TD');
    expect(inlineHtml).not.toContain('{ showSource(); return; }');
  });

  it('zoomable:详情视口放开双指缩放,内联锁定', () => {
    expect(
      buildMermaidWebViewHtml('graph TD\nA --> B', { zoomable: true }),
    ).toContain('maximum-scale=5');
    expect(buildMermaidWebViewHtml('graph TD\nA --> B')).toContain(
      'maximum-scale=1',
    );
  });

  it('gantt 钉固定宽画布:布局与打开时的屏幕朝向解耦(竖屏打开不再挤叠日期轴)', () => {
    expect(buildMermaidWebViewHtml('gantt\ntitle x')).toContain(
      'useWidth: 760',
    );
  });
});
