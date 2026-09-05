import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { buildComposerRichInputHtml } from '@/session/composerRichInputHtml';
import { parseComposerWebMessage } from '@/session/composerRichInputProtocol';

describe('mobile composer rich input HTML', () => {
  it('animates a native frame that fills the horizontal input row, preserving the WebView command ref', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/ComposerRichInput.tsx'), 'utf8');
    const frame = source.slice(source.indexOf('frame: {'), source.indexOf('webView: {'));
    expect(frame).toContain('flex: 1');
    expect(frame).toContain('minWidth: 0');
    expect(source).toContain('<Animated.View style={[styles.frame, heightStyle');
    expect(source).not.toContain('createAnimatedComponent(WebView)');
    expect(source).toContain('containerStyle={styles.webView}');
  });

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
    // The editor scrollport follows UI-driven WebView resizing without waiting
    // for a setConfig message, while scrollHeight still reports natural content.
    expect(html).toContain('max-height: min(var(--max-height), 100vh)');
    expect(html).toContain('overflow-y: auto');
    expect(html).toContain('root.scrollHeight');
    expect(html).not.toContain('height: 100vh;');
    expect(html).toContain('contentEditable');
    expect(html).toContain("event.key === 'Backspace'");
    expect(html).toContain('placeCaretAroundAtom(atom, event.clientX)');
    expect(html).toContain('placeCaretAroundAtom(atom, touch.clientX)');
    expect(html).not.toContain('drag-start');
    expect(html).not.toContain('touchmove');
    expect(html).toContain("compositionstart");
    expect(html).toContain("compositioncancel");
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

  it('initializes on the Android WebView 85 API baseline', () => {
    const legacyHtml = buildComposerRichInputHtml({
      accessibilityLabel: '输入消息',
      document: { version: 1, nodes: [{ type: 'text', text: 'hello' }] },
      editable: true,
      maxHeight: 264,
      platform: 'android',
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
    const script = legacyHtml.match(/<script>([\s\S]*?)<\/script>/i)?.[1];
    expect(script).toBeTruthy();

    const messages: unknown[] = [];
    const listeners = new Map<string, (...args: unknown[]) => void>();
    type StubNode = {
      classList?: { contains(value: string): boolean };
      className?: string;
      contentEditable?: string;
      dataset?: Record<string, string>;
      readonly nextSibling: StubNode | null;
      nodeType: number;
      nodeValue?: string;
      parentNode: StubParent | null;
      remove(): void;
      setAttribute?: () => void;
      tabIndex?: number;
      tagName?: string;
      textContent?: string;
    };
    type StubParent = {
      appendChild(node: StubNode | StubParent): StubNode | StubParent;
      childNodes: StubNode[];
      insertBefore(node: StubNode, reference: StubNode | null): StubNode;
    };
    type StubRange = {
      collapse(): void;
      deleteContents(): void;
      insertNode(node: StubNode | StubParent): void;
      selectNodeContents(): void;
      setStart(node: StubNode, offset: number): void;
      setStartAfter(node: StubNode): void;
      startNode: StubNode | null;
      startOffset: number;
    };
    const detach = (node: StubNode) => {
      const parent = node.parentNode;
      const index = parent?.childNodes.indexOf(node) ?? -1;
      if (parent && index >= 0) parent.childNodes.splice(index, 1);
      node.parentNode = null;
    };
    const insertBefore = (
      parent: StubParent,
      node: StubNode,
      reference: StubNode | null,
    ) => {
      detach(node);
      const index = reference ? parent.childNodes.indexOf(reference) : -1;
      if (index >= 0) parent.childNodes.splice(index, 0, node);
      else parent.childNodes.push(node);
      node.parentNode = parent;
      return node;
    };
    const createNode = (nodeType: number, nodeValue?: string): StubNode => {
      const node: StubNode = {
        get nextSibling() {
          const parent = node.parentNode;
          const index = parent?.childNodes.indexOf(node) ?? -1;
          return parent && index >= 0 ? parent.childNodes[index + 1] || null : null;
        },
        nodeType,
        nodeValue,
        parentNode: null,
        remove() {
          detach(node);
        },
      };
      return node;
    };
    const createFragment = (): StubParent => {
      const fragment: StubParent = {
        appendChild(node) {
          if (!('nodeType' in node)) throw new Error('Nested fragments are not supported');
          return insertBefore(fragment, node, null);
        },
        childNodes: [],
        insertBefore(node, reference) {
          return insertBefore(fragment, node, reference);
        },
      };
      return fragment;
    };
    const children: StubNode[] = [];
    const root = {
      addEventListener(type: string, listener: (...args: unknown[]) => void) {
        listeners.set(type, listener);
      },
      appendChild(node: StubNode | StubParent) {
        if ('nodeType' in node) return insertBefore(root, node, null);
        [...node.childNodes].forEach((child) => insertBefore(root, child, null));
        return node;
      },
      childNodes: children,
      contentEditable: 'false',
      contains(node: unknown) {
        return children.includes(node as StubNode);
      },
      dataset: {} as Record<string, string>,
      get firstChild() {
        return children[0] || null;
      },
      focus() {},
      insertBefore(node: StubNode, reference: StubNode | null) {
        return insertBefore(root, node, reference);
      },
      get lastChild() {
        return children[children.length - 1] || null;
      },
      removeChild(node: StubNode) {
        detach(node);
        return node;
      },
      scrollHeight: 0,
      setAttribute() {},
      style: {
        paddingBottom: '',
        paddingTop: '',
        setProperty() {},
      },
    };
    const staleNode = createNode(1);
    staleNode.parentNode = root;
    children.push(staleNode);
    let activeRange: StubRange | null = null;
    const createRange = (): StubRange => ({
      collapse() {},
      deleteContents() {},
      insertNode(node) {
        const reference = this.startNode?.nextSibling || null;
        if ('nodeType' in node) root.insertBefore(node, reference);
        else [...node.childNodes].forEach((child) => root.insertBefore(child, reference));
      },
      selectNodeContents() {},
      setStart(node, offset) {
        this.startNode = node;
        this.startOffset = offset;
      },
      setStartAfter(node) {
        this.startNode = node;
        this.startOffset = 1;
      },
      startNode: null,
      startOffset: 0,
    });
    const selection = {
      anchorNode: null as StubNode | null,
      anchorOffset: 0,
      addRange(range: StubRange) {
        activeRange = range;
        this.anchorNode = range.startNode;
        this.anchorOffset = range.startOffset;
      },
      getRangeAt() {
        if (!activeRange) throw new Error('No active range');
        return activeRange;
      },
      get rangeCount() {
        return activeRange ? 1 : 0;
      },
      removeAllRanges() {
        activeRange = null;
        this.anchorNode = null;
        this.anchorOffset = 0;
      },
    };
    const documentStub = {
      createComment(value: string) {
        return createNode(8, value);
      },
      createDocumentFragment() {
        return createFragment();
      },
      createElement(tagName: string) {
        const element = createNode(1);
        element.className = '';
        element.classList = {
          contains(value: string) {
            return element.className?.split(/\s+/).includes(value) === true;
          },
        };
        element.contentEditable = '';
        element.dataset = {};
        element.setAttribute = () => {};
        element.tabIndex = 0;
        element.tagName = tagName.toUpperCase();
        element.textContent = '';
        return element;
      },
      createRange,
      createTextNode(value: string) {
        return createNode(3, value);
      },
      documentElement: {
        style: {
          setProperty() {},
        },
      },
      getElementById() {
        return root;
      },
    };
    const windowStub: {
      ReactNativeWebView: { postMessage(payload: string): void };
      cindyComposer?: {
        applyDocument(value: unknown, focusAfter?: boolean): void;
        commitPaste(requestId: string, nodes: unknown[]): void;
        setConfig(value: { maxHeight: number }): void;
      };
      getSelection(): typeof selection;
    } = {
      ReactNativeWebView: {
        postMessage(payload: string) {
          messages.push(JSON.parse(payload));
        },
      },
      getSelection() {
        return selection;
      },
    };

    let onResize = () => {};
    runInNewContext(
      `Array.prototype.flatMap = undefined;\n${script}`,
      {
        document: documentStub,
        Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
        ResizeObserver: class {
          constructor(callback: () => void) { onResize = callback; }
          observe() {}
        },
        window: windowStub,
      },
    );
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ nodeType: 3, nodeValue: 'hello' });
    expect(messages).toContainEqual({ type: 'ready' });
    // A long draft's scrollport resizes on every drag frame; unchanged content
    // measurements must not cross the WebView bridge again on those frames.
    root.scrollHeight = 500;
    const beforeResize = messages.length;
    for (let frame = 0; frame < 100; frame += 1) onResize();
    expect(messages.slice(beforeResize)).toEqual([{ type: 'height', height: 264 }]);
    windowStub.cindyComposer?.setConfig({ maxHeight: 400 });
    expect(messages.at(-1)).toEqual({ type: 'height', height: 400 });
    root.scrollHeight = 80;
    const beforeContentShrink = messages.length;
    onResize();
    onResize();
    expect(messages.slice(beforeContentShrink)).toEqual([{ type: 'height', height: 80 }]);
    children[0].nodeValue = 'hello world';
    listeners.get('input')?.();
    expect(messages).toContainEqual({
      type: 'change',
      document: { version: 1, nodes: [{ type: 'text', text: 'hello world' }] },
    });

    listeners.get('compositionstart')?.();
    children[0].nodeValue = 'hello world composing';
    listeners.get('input')?.();
    expect(messages).not.toContainEqual({
      type: 'change',
      document: { version: 1, nodes: [{ type: 'text', text: 'hello world composing' }] },
    });
    windowStub.cindyComposer?.applyDocument({
      version: 1,
      nodes: [{ type: 'text', text: 'hello world' }],
    }, true);
    children[0].nodeValue = 'hello world after chip';
    listeners.get('input')?.();
    expect(messages).toContainEqual({
      type: 'change',
      document: { version: 1, nodes: [{ type: 'text', text: 'hello world after chip' }] },
    });
    windowStub.cindyComposer?.applyDocument({
      version: 1,
      nodes: [{ type: 'text', text: 'hello world' }],
    }, true);

    const pasteRange = createRange();
    pasteRange.setStart(children[0], String(children[0].nodeValue).length);
    selection.addRange(pasteRange);
    listeners.get('paste')?.({
      clipboardData: {
        getData: () => ' pasted',
        items: [],
      },
      preventDefault() {},
    });
    expect(messages).toContainEqual({
      type: 'paste-text-request',
      requestId: '1',
      text: ' pasted',
    });
    windowStub.cindyComposer?.commitPaste('1', [
      { type: 'text', text: ' pasted' },
      { type: 'pasted-text', text: 'full pasted text', display: 'Pasted text' },
    ]);
    expect(children).toHaveLength(4);
    expect(children[1]).toMatchObject({ nodeType: 3, nodeValue: ' pasted' });
    expect(children[2]).toMatchObject({ className: 'atom', nodeType: 1 });
    expect(children[3]).toMatchObject({ nodeType: 3, nodeValue: '\u200B' });
    expect(selection.anchorNode).toBe(children[3]);
    expect(selection.anchorOffset).toBe(1);
    expect(messages).toContainEqual({
      type: 'change',
      document: {
        version: 1,
        nodes: [
          { type: 'text', text: 'hello world pasted' },
          { type: 'pasted-text', text: 'full pasted text', display: 'Pasted text' },
        ],
      },
    });
    expect(legacyHtml).not.toContain('replaceChildren');
    expect(legacyHtml).not.toContain('.flatMap(');
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

  it('does not apply the iOS optical offset to Android rich input', () => {
    const androidHtml = buildComposerRichInputHtml({
      accessibilityLabel: '输入消息',
      document: { version: 1, nodes: [] },
      editable: true,
      maxHeight: 264,
      platform: 'android',
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
    expect(androidHtml).toContain('padding: 3px 4px 3px;');
    expect(androidHtml).not.toContain('padding: 6px 4px 0px;');
  });

  it('keeps the WebKit caret in an editable text anchor after every atom', () => {
    expect(html).toContain("const CARET_ANCHOR = '\\u200B'");
    expect(html).toContain('return node.type === \'text\' ? [element] : [element, makeCaretAnchor()]');
    expect(html).toContain("String(child.nodeValue || '').split(CARET_ANCHOR).join('')");
    expect(html).toContain('setCaretAfter(inserted[inserted.length - 1], current)');
    expect(html).toContain('if (isCaretAnchor(container))');
    expect(html).toContain('removeAtom(atom)');
    expect(html).toContain('composing = false;');
    expect(html).toContain("root.addEventListener('compositioncancel'");
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
    expect(screenSource.indexOf('// 听写期间只滚动覆盖层', overlayStart)).toBeGreaterThan(overlayStart);
    const overlaySource = screenSource.slice(
      overlayStart,
      screenSource.indexOf('// 听写期间只滚动覆盖层', overlayStart),
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
