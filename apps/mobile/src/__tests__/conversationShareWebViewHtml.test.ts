import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildConversationShareHtml,
  type ConversationShareWebViewColors,
} from '@/session/conversationShareWebViewHtml';
import { i18n } from '@/i18n';

const colors: ConversationShareWebViewColors = {
  background: '#ffffff',
  border: '#dddddd',
  codeSurface: '#f5f5f5',
  dark: true,
  inlineCode: '#333333',
  surfaceChip: '#f2f2f2',
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
  it('只按选中内容嵌入对应的富内容运行时', () => {
    const plainHtml = buildConversationShareHtml({
      allShareableIds: ['plain'],
      colors,
      contentWidth: 390,
      selectedMessages: [{ body: 'plain text', clientId: 'plain', kind: 'assistant' }],
    });
    const mathHtml = buildConversationShareHtml({
      allShareableIds: ['math'],
      colors,
      contentWidth: 390,
      selectedMessages: [{
        body: ['$$', 'x^2 + y^2', '$$'].join('\n'),
        clientId: 'math',
        kind: 'assistant',
      }],
    });
    const mermaidHtml = buildConversationShareHtml({
      allShareableIds: ['diagram'],
      colors,
      contentWidth: 390,
      selectedMessages: [{
        body: ['```mermaid', 'graph TD', 'A --> B', '```'].join('\n'),
        clientId: 'diagram',
        kind: 'assistant',
      }],
    });

    expect(plainHtml).not.toContain('window.katex.render');
    expect(plainHtml).not.toContain('window.mermaid.render');
    expect(mathHtml).toContain('window.katex.render');
    expect(mathHtml).not.toContain('window.mermaid.render');
    expect(mermaidHtml).not.toContain('window.katex.render');
    expect(mermaidHtml).toContain('window.mermaid.render');
  });

  it('把自动化来源放在对应用户消息上方', () => {
    const html = buildConversationShareHtml({
      allShareableIds: ['automation'],
      colors,
      contentWidth: 390,
      selectedMessages: [{
        automationOriginLabel: '由自动化「每日摘要」发送',
        body: '自动化消息',
        clientId: 'automation',
        kind: 'user',
      }],
    });

    expect(html).toContain('share-automation-origin');
    expect(html).toContain('由自动化「每日摘要」发送');
  });

  it('保留公式与 Mermaid 语义，并注入对应运行时升级脚本', () => {
    const html = buildRichConversationHtml();

    expect(html).toContain('data-latex="x^2 + y^2"');
    expect(html).toContain('data-mermaid-source="graph TD\nA --&gt; B"');
    expect(html).toContain('window.katex.render');
    expect(html).toContain('window.mermaid.render');
    expect(html).toContain("theme: 'dark'");
    expect(html).toContain(
      'window.__cindyConversationShareRichContentReady = true',
    );
  });

  it('只使用离线资源，并在导出前等待富内容和图片解码', () => {
    const html = buildRichConversationHtml();

    expect(html).toContain("default-src 'none';");
    expect(html).toContain('img-src data:;');
    expect(html).not.toContain('img-src data: https:');
    expect(html).toContain("script-src 'unsafe-inline';");
    expect(html).toContain(
      'waitForRichContent().then(waitForImages).then(waitForFonts)',
    );
    expect(html).toContain('image.decode().catch(function () {})');
    expect(html).toContain('document.fonts.ready');
    expect(html).toContain("document.querySelectorAll('style')");
    expect(html).toContain(
      "throw new Error('conversation-share-content-too-large')",
    );
  });

  it('外链图片无法离线带入时保留可见占位', () => {
    const html = buildConversationShareHtml({
      allShareableIds: ['image'],
      colors,
      contentWidth: 390,
      selectedMessages: [{
        body: '![](https://example.com/image.png)',
        clientId: 'image',
        kind: 'assistant',
      }],
    });

    expect(html).toContain(`alt="${i18n.t('message.renderer.imageFallbackTitle')}"`);
  });

  it('限制原生与降级 renderer 的完整源尺寸，并清理一次性 PNG', () => {
    const nativeSource = readFileSync(
      resolve(
        process.cwd(),
        'modules/xdt-screenshot-monitor/ios/XdtScreenshotMonitorModule.swift',
      ),
      'utf8',
    );
    const webViewSource = readFileSync(
      resolve(process.cwd(), 'src/session/ConversationShareWebView.tsx'),
      'utf8',
    );
    const sessionSource = readFileSync(
      resolve(process.cwd(), 'app/sessions/[sessionId].tsx'),
      'utf8',
    );

    expect(nativeSource).toContain('conversationShareMaxSourcePixels');
    expect(nativeSource).toContain(
      'captureWidth * captureHeight <= conversationShareMaxSourcePixels',
    );
    expect(nativeSource).toContain('return numericValue.isFinite ? numericValue : nil');
    expect(webViewSource).toContain(
      'await deleteConversationSharePngTemp(file.uri);',
    );
    expect(sessionSource).toContain("localUri && Platform.OS !== 'android'");
    expect(sessionSource).toContain('key={conversationShareHtml}');
  });

  it('使用 Mobile 获批的克制页脚尺寸', () => {
    const designSource = readFileSync(
      resolve(process.cwd(), '../../docs/design-rules/DESIGN.md'),
      'utf8',
    );
    const html = buildRichConversationHtml();

    expect(designSource).toContain('Mobile approved 2026-08-08');
    expect(designSource).toContain('22×22px (6px radius)');
    expect(designSource).toContain('18px-high wordmark with a 6px gap');
    expect(html).toContain('width: 22px;');
    expect(html).toContain('height: 18px;');
    expect(html).toContain('gap: 6px;');
  });

  it('分享导出保持消息间距，并为隐藏 WebView 复用安全边界', () => {
    const html = buildConversationShareHtml({
      allShareableIds: ['first', 'middle', 'third'],
      colors,
      contentWidth: 390,
      selectedMessages: [
        { body: 'first', clientId: 'first', kind: 'user' },
        { body: 'third', clientId: 'third', kind: 'assistant' },
      ],
    });
    const webViewSource = readFileSync(
      resolve(process.cwd(), 'src/session/ConversationShareWebView.tsx'),
      'utf8',
    );
    const shareBarSource = readFileSync(
      resolve(process.cwd(), 'src/session/ShareSelectionBar.tsx'),
      'utf8',
    );

    expect(html).toContain('<div class="share-gap" aria-hidden="true">⋯</div>');
    expect(html).toMatch(
      /#xdt-content\.share-stage\s*\{[\s\S]*?display: flex;[\s\S]*?flex-direction: column;[\s\S]*?gap: 16px;/,
    );
    expect(shareBarSource).toContain('height: 44,');
    expect(shareBarSource).toContain('minHeight: 44,');
    expect(shareBarSource).toContain(
      'shareableIds.filter((clientId) =>',
    );
    expect(shareBarSource).toContain(
      'selectionBeforeSelectAllRef.current?.includes(clientId)',
    );
    expect(webViewSource).toContain(
      'onShouldStartLoadWithRequest={interceptNavigation}',
    );
    expect(webViewSource).toContain(
      'interceptHtmlNavigation(request, documentSettledRef.current)',
    );
    expect(webViewSource).toContain('allowFileAccess={false}');
    expect(webViewSource).toContain('mediaCapturePermissionGrantType="deny"');
  });

  it('导出结构化正文和附件时保留可见投影，不泄露隐藏引用或外链', () => {
    const html = buildConversationShareHtml({
      allShareableIds: ['message'],
      colors,
      contentWidth: 390,
      selectedMessages: [
        {
          attachments: [
            { kind: 'image', name: 'preview.png' },
            { kind: 'image', name: 'remote.png' },
            { kind: 'file', name: 'notes.md' },
          ],
          body: 'visible fallback',
          bodyParts: [
            { kind: 'quote', label: 'quoted context' },
            { kind: 'pasted', label: 'Pasted text · 120 chars' },
            { kind: 'slash', label: '/review' },
            { kind: 'text', text: 'reply' },
          ],
          clientId: 'message',
          kind: 'user',
        },
      ],
    });

    expect(html).toContain('quoted context');
    expect(html).toContain('Pasted text · 120 chars');
    expect(html).toContain('/review');
    expect(html).not.toContain('share-inline-chip-icon" aria-hidden="true">/</span>');
    expect(html).toContain('preview.png');
    expect(html).not.toContain('share-attachment-image');
    expect(html).toContain('remote.png');
    expect(html).toContain('notes.md');
    expect(html).not.toContain('visible fallback');
    expect(html).not.toContain('https://example.com/private.png');
  });

  it('附件-only 消息不生成空白文字气泡', () => {
    const html = buildConversationShareHtml({
      allShareableIds: ['attachment'],
      colors,
      contentWidth: 390,
      selectedMessages: [
        {
          attachments: [{ kind: 'file', name: 'report.pdf' }],
          body: '',
          clientId: 'attachment',
          kind: 'user',
        },
      ],
    });

    expect(html).toContain('share-attachment-chip-file');
    expect(html).not.toContain('share-bubble-user">');
  });
});
