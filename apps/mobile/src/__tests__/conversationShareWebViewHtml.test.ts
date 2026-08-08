import { describe, expect, it } from 'vitest';

import {
  buildConversationShareHtml,
  type ConversationShareWebViewColors,
} from '@/session/conversationShareWebViewHtml';

const colors: ConversationShareWebViewColors = {
  background: '#ffffff',
  border: '#dddddd',
  codeSurface: '#f5f5f5',
  dark: true,
  inlineCode: '#333333',
  surfaceElevated: '#fafafa',
  syntax: {
    comment: '#777777',
    function: '#0055aa',
    keyword: '#aa0055',
    number: '#995500',
    property: '#006655',
    string: '#885500',
  },
  textPrimary: '#111111',
  textSecondary: '#555555',
  textTertiary: '#888888',
};

function buildRichConversationHtml(): string {
  return buildConversationShareHtml({
    allShareableIds: ['math', 'diagram'],
    colors,
    contentWidth: 390,
    selectedMessages: [
      {
        body: ['$$', 'x^2 + y^2', '$$'].join('\n'),
        clientId: 'math',
        kind: 'assistant',
      },
      {
        body: ['```mermaid', 'graph TD', 'A --> B', '```'].join('\n'),
        clientId: 'diagram',
        kind: 'assistant',
      },
    ],
  });
}

describe('buildConversationShareHtml 富内容导出', () => {
  it('保留公式与 Mermaid 语义，并注入对应运行时升级脚本', () => {
    const html = buildRichConversationHtml();

    expect(html).toContain('data-latex="x^2 + y^2"');
    expect(html).toContain('data-mermaid-source="graph TD\nA --&gt; B"');
    expect(html).toContain('window.katex.render');
    expect(html).toContain('window.mermaid.render');
    expect(html).toContain("theme: 'dark'");
    expect(html).toContain('window.__cindyConversationShareRichContentReady = true');
  });

  it('仅放行既有 CDN，并在导出前等待富内容和图片解码', () => {
    const html = buildRichConversationHtml();

    expect(html).toContain("img-src data:;");
    expect(html).not.toContain('img-src data: https:');
    expect(html).toContain(
      "script-src 'unsafe-inline' https://cdn.jsdelivr.net https://registry.npmmirror.com",
    );
    expect(html).toContain('waitForRichContent().then(waitForImages)');
    expect(html).toContain('image.decode().catch(function () {})');
  });
});
