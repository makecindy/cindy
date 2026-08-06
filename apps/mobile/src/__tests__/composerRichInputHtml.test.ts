import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildComposerRichInputHtml } from '@/session/composerRichInputHtml';
import { parseComposerWebMessage } from '@/session/composerRichInputProtocol';

describe('mobile composer rich input HTML', () => {
  const html = buildComposerRichInputHtml({
    accessibilityLabel: '输入消息',
    document: { version: 1, nodes: [{ type: 'quote', quote: { text: '<quoted>' } }] },
    editable: true,
    maxHeight: 264,
    placeholder: '发送消息',
    theme: {
      background: '#eee',
      border: '#aaa',
      chip: '#ddd',
      focus: '#555',
      placeholder: '#777',
      text: '#111',
      textSecondary: '#333',
    },
  });

  it('ships an offline contenteditable protocol with atom deletion and caret placement', () => {
    expect(html).toContain('contentEditable');
    expect(html).toContain("event.key === 'Backspace'");
    expect(html).toContain('placeCaretAroundAtom(atom, event.clientX)');
    expect(html).toContain('placeCaretAroundAtom(atom, touch.clientX)');
    expect(html).not.toContain('drag-start');
    expect(html).not.toContain('touchmove');
    expect(html).toContain("compositionstart");
    expect(html).toContain("paste-images-start");
    expect(html).toContain('.slice(0, MAX_PASTED_IMAGE_COUNT)');
    expect(html).toContain('SUPPORTED_PASTED_IMAGE_MIME_TYPES.has(mimeType)');
    expect(html).toContain("post({ type: 'paste-image-failed', requestId, index })");
    expect(html).toContain("type: 'paste-text-request'");
    expect(html).toContain("document.createComment('cindy-paste:' + requestId)");
    expect(html).toContain('commitPaste(requestId, nodes)');
    expect(html).toContain('resolveSessionLink(href, label)');
    expect(html).toContain('setConfig(value)');
    expect(html).toContain("style.setProperty('--chip', config.theme.chip)");
    expect(html).not.toContain('https://');
  });

  it('uses the shared compact pill geometry for atoms and slash decorations', () => {
    expect(html).toContain('padding: 2px 8px');
    expect(html).toContain('margin-right: 6px');
    expect(html).toContain('border-radius: 9999px');
    expect(html).toContain('font-size: 12px');
    expect(html).toContain('line-height: 20px');
    expect(html).toContain('position: relative; top: -1px');
    expect(html).toContain('vertical-align: middle');
    expect(html).not.toContain('vertical-align: -7px');
    expect(html).not.toContain('border-radius: 4px');
  });

  it('keeps the WebKit caret in an editable text anchor after every atom', () => {
    expect(html).toContain("const CARET_ANCHOR = '\\u200B'");
    expect(html).toContain('return node.type === \'text\' ? [element] : [element, makeCaretAnchor()]');
    expect(html).toContain("String(child.nodeValue || '').split(CARET_ANCHOR).join('')");
    expect(html).toContain('setCaretAfter(inserted[inserted.length - 1], current)');
    expect(html).toContain('if (isCaretAnchor(container))');
    expect(html).toContain('removeAtom(atom)');
  });

  it('escapes bootstrap markup instead of injecting it into the page', () => {
    expect(html).toContain('\\u003cquoted>');
    expect(html).not.toContain('"text":"<quoted>"');
  });

  it('applies a selected slash command and its end-caret placement atomically', () => {
    const inputSource = readFileSync(
      resolve(process.cwd(), 'src/session/ComposerRichInput.tsx'),
      'utf8',
    ).replace(/\r\n/g, '\n');
    const screenSource = readFileSync(
      resolve(process.cwd(), 'app/sessions/[sessionId].tsx'),
      'utf8',
    ).replace(/\r\n/g, '\n');
    const selectStart = screenSource.indexOf('const selectSlashCommand = useCallback');
    const selectEnd = screenSource.indexOf('const selectAtResource = useCallback', selectStart);
    const selectSource = screenSource.slice(selectStart, selectEnd);

    expect(inputSource).toContain('applyDocumentAndSetSelectionToEnd(document: ComposerDocument): void;');
    expect(inputSource).toContain('applyDocumentAndSetSelectionToEnd: (value) => {');
    expect(inputSource).toContain('applyDocument(value, true);');
    expect(inputSource).toContain('if (pending) applyDocument(pending.document, pending.focusAfter);');
    expect(inputSource).toContain('pendingNodeInsertionsRef.current.push(node);');
    expect(inputSource).toContain('for (const node of pendingNodeInsertions)');
    expect(selectSource).toContain('queueEditingRef.current ? { persist: false } : undefined');
    expect(selectSource).toContain('composerInputRef.current?.applyDocumentAndSetSelectionToEnd(nextDocument);');
    expect(selectSource).not.toContain('composerInputRef.current?.focus();');
  });

  /**
   * 「点输入区 = 想打字 → 停止听写」必须由听写期间盖在输入区上的 RN 覆盖层承接:
   * - 挂 WebView 的 focus 不行:WKWebView 在输入区展开、拿到 native 焦点后会自己恢复
   *   DOM 焦点并派发 focus,收起态点语音、输入框展开的那一拍就把刚开始的听写掐断;
   * - 挂 WebView 内的触摸也不行:听写期间富文本编辑器是 hidden(opacity 0),iOS hitTest
   *   跳过 alpha≈0 的 view,它根本收不到触摸。
   * 两条都由 2026-07 的实机日志确认。
   */
  it('stops dictation from the RN draft overlay instead of WebView focus', () => {
    const screenSource = readFileSync(
      resolve(process.cwd(), 'app/sessions/[sessionId].tsx'),
      'utf8',
    ).replace(/\r\n/g, '\n');
    const overlayStart = screenSource.indexOf('const renderComposerInputOverlay = ');
    const overlaySource = screenSource.slice(
      overlayStart,
      screenSource.indexOf('const measureSendButtonTarget', overlayStart),
    );

    expect(overlaySource).toContain('onPressIn={handleComposerInputPressIn}');
    // 无障碍激活(VoiceOver / TalkBack)只走 onPress,不会派发 onPressIn:两者都必须挂,
    // 否则读屏用户按下这个「停止录音」按钮不会有任何反应。
    expect(overlaySource).toContain('onPress={handleComposerInputPressIn}');
    // 单行听写时 inputFrame 只有 28pt,命中层必须靠父容器撑到 44pt 触控目标——
    // hitSlop 无效(RN 的命中区不会越过父视图边界),所以不许再用它顶替。
    expect(overlaySource).not.toContain('hitSlop');
    expect(screenSource).toContain('inputFrameMinHeight={voiceIsListening ? MOBILE_COMPOSER_MIN_TOUCH_TARGET : undefined}');

    // hidden 的富文本编辑器必须同时从两端的无障碍树里摘掉:opacity: 0 不隐藏读屏焦点,
    // 而它的 focus 已不再停听写,焦点留在那里会让读屏用户卡在「按了没反应」的输入框上。
    const inputSource = readFileSync(
      resolve(process.cwd(), 'src/session/ComposerRichInput.tsx'),
      'utf8',
    ).replace(/\r\n/g, '\n');
    expect(inputSource).toContain('accessibilityElementsHidden={hidden}');
    expect(inputSource).toContain("importantForAccessibility={hidden ? 'no-hide-descendants' : 'auto'}");
    expect(overlaySource).toContain('testID="session.voiceDraftOverlay"');
    // 草稿滚动层本身不吃触摸,交给外层覆盖层。
    expect(overlaySource).toContain('pointerEvents="none"');
    expect(screenSource).toContain('onFocus={() => setComposerFocused(true)}');
  });

  it('rejects malformed image messages at the WebView boundary', () => {
    expect(parseComposerWebMessage(JSON.stringify({ type: 'paste-images-start', count: '2' }))).toBeNull();
    expect(parseComposerWebMessage(JSON.stringify({
      type: 'paste-images-start',
      requestId: 'images-1',
      count: 2,
    }))).toEqual({
      type: 'paste-images-start',
      requestId: 'images-1',
      count: 2,
    });
    expect(parseComposerWebMessage(JSON.stringify({
      type: 'paste-image-failed',
      requestId: 'images-1',
      index: 1,
    }))).toEqual({
      type: 'paste-image-failed',
      requestId: 'images-1',
      index: 1,
    });
    expect(parseComposerWebMessage(JSON.stringify({
      type: 'paste-image',
      requestId: 'images-1',
      base64: '',
      mimeType: 'image/png',
      name: 'paste.png',
      index: 0,
    }))).toBeNull();
    expect(parseComposerWebMessage(JSON.stringify({
      type: 'paste-image',
      requestId: 'images-1',
      base64: 'PHN2Zz4=',
      mimeType: 'image/svg+xml',
      name: 'paste.svg',
      index: 0,
    }))).toBeNull();
    expect(parseComposerWebMessage(JSON.stringify({
      type: 'paste-image',
      requestId: 'images-1',
      base64: 'aGVsbG8=',
      mimeType: 'image/png',
      name: 'paste.png',
      index: 0,
    }))).toEqual({
      type: 'paste-image',
      requestId: 'images-1',
      base64: 'aGVsbG8=',
      mimeType: 'image/png',
      name: 'paste.png',
      index: 0,
    });
  });

  it('accepts bounded native text-paste requests and rejects malformed ones', () => {
    expect(parseComposerWebMessage(JSON.stringify({
      type: 'paste-text-request',
      requestId: '12',
    }))).toEqual({
      type: 'paste-text-request',
      requestId: '12',
    });
    expect(parseComposerWebMessage(JSON.stringify({
      type: 'paste-text-request',
      requestId: '13',
      text: 'cindy://session/a',
    }))).toEqual({
      type: 'paste-text-request',
      requestId: '13',
      text: 'cindy://session/a',
    });
    expect(parseComposerWebMessage(JSON.stringify({
      type: 'paste-text-request',
      requestId: 14,
      text: 'plain',
    }))).toBeNull();
    expect(parseComposerWebMessage(JSON.stringify({
      type: 'paste-text-request',
      requestId: '15',
      text: 42,
    }))).toBeNull();
  });

  it('falls back to the native clipboard when iOS omits paste clipboardData', () => {
    const inputSource = readFileSync(
      resolve(process.cwd(), 'src/session/ComposerRichInput.tsx'),
      'utf8',
    ).replace(/\r\n/g, '\n');

    expect(inputSource).toContain("import * as Clipboard from 'expo-clipboard';");
    expect(inputSource).toContain('text = await Clipboard.getStringAsync();');
    expect(inputSource).toContain('composerNodesForBoundedPlainTextPaste(text)');
    expect(inputSource).toContain('window.cindyComposer.commitPaste(${JSON.stringify(message.requestId)}, []);');
    expect(inputSource).toContain('window.cindyComposer.commitPaste(');
  });
});
