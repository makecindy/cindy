import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import ts from 'typescript';
import { detectComposerTrigger } from '@/session/composerPalette';
import { replaceComposerTextRange, slashCommandTextNode, textComposerDocument } from '@/session/composerDocument';
import { buildComposerRichInputHtml } from '@/session/composerRichInputHtml';
import { parseComposerWebMessage } from '@/session/composerRichInputProtocol';

const pageTree = ts.createSourceFile('session.tsx', readFileSync(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function pageCallback(name: string, bindings: Record<string, unknown>) {
  let initializer: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(pageTree) === name) initializer = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(pageTree);
  if (!initializer) throw new Error('Missing production composer callback ' + name);
  const expression = ts.isCallExpression(initializer) ? initializer.arguments[0] : initializer;
  const code = ts.transpileModule('const callback = ' + expression.getText(pageTree), { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(bindings), code + '\nreturn callback;')(...Object.values(bindings));
}

it.each([false, true])('atomically applies a selected slash command while queue editing=%s', (editing) => {
  const apply = vi.fn(); const placeCaret = vi.fn(); const focus = vi.fn();
  const bindings = { pendingSkillSelectionRef: { current: null }, sessionId: 's1', draftRef: { current: '/he' },
    composerDocumentRef: { current: textComposerDocument('/he') }, queueEditingRef: { current: editing },
    composerInputRef: { current: { applyDocumentAndSetSelectionToEnd: placeCaret, focus } },
    applyComposerDocument: apply, detectComposerTrigger, replaceComposerTextRange, slashCommandTextNode };
  pageCallback('selectSlashCommand', bindings)({ name: 'help', kind: 'agent-skill' });
  const document = apply.mock.calls[0][0];
  expect(document.nodes).toEqual([{ type: 'text', text: '/help', slashCommand: '/help' }, { type: 'text', text: ' ' }]);
  expect(apply.mock.calls[0][1]).toEqual(editing ? { persist: false } : undefined);
  expect(placeCaret).toHaveBeenCalledExactlyOnceWith(document);
  expect(focus).not.toHaveBeenCalled();
  expect(bindings.pendingSkillSelectionRef.current).toEqual({ name: 'help', sid: 's1' });
});

it.each([false, true])('routes touch and accessibility activation through the actual dictation overlay (native=%s)', (nativeComposerAvailable) => {
  const finish = vi.fn();
  const press = pageCallback('handleComposerInputPressIn', { voiceRecordingActiveRef: { current: true }, voiceState: 'listening', finishVoiceRecordingRef: { current: finish } });
  const bindings = { React, voiceIsListening: true, nativeComposerAvailable, Pressable: 'Pressable', ScrollView: 'ScrollView', View: 'View', Text: 'Text', VoiceMicWaveCaret: 'Caret',
    t: (key: string) => key, styles: {}, handleComposerInputPressIn: press, voiceDraftScrollRef: {}, voiceDraftCaretFrame: { top: 0 },
    composerCardActive: true, composerInputScrollEnabled: false, voiceDraftShowsListeningPrompt: true, colors: { textPrimary: '#000' }, composerLayout: { input: { placeholder: 'Listening' } } };
  const overlay = pageCallback('renderComposerInputOverlay', bindings)();
  expect(overlay.props.accessibilityRole).toBe('button');
  overlay.props.onPress(); overlay.props.onPressIn();
  expect(finish).toHaveBeenNthCalledWith(1, { focusInput: true });
  expect(finish).toHaveBeenNthCalledWith(2, { focusInput: true });
  expect(pageCallback('renderComposerInputOverlay', { ...bindings, voiceIsListening: false })()).toBeNull();
});

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

  it('counts selection prefixes without cloning or reading atom payloads', () => {
    const text = (nodeValue: string) => ({ nodeType: 3, nodeValue });
    const element = (tagName: string, childNodes: unknown[], atom = false) => ({
      nodeType: 1, tagName, childNodes, classList: { contains: (name: string) => atom && name === 'atom' },
      get dataset() { throw new Error('selection must not read semantic payloads'); },
    });
    const suffix = text('\u200B🙂尾');
    const root = element('DIV', [element('DIV', [text('前')]), element('SPAN', [], true), suffix]);
    const source = html.slice(html.indexOf('const prefixAt ='), html.indexOf('const reportSelection ='));
    const measure = (container: unknown, offset: number) => runInNewContext(
      source + '; prefixAt(container, offset);',
      { root, container, offset, CARET_ANCHOR: '\u200B', Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 } },
    );
    expect(measure(root, 1)).toEqual({ textLength: 2, atomCount: 0 });
    expect(measure(suffix, 3)).toEqual({ textLength: 4, atomCount: 1 });
    expect(source).not.toContain('cloneContents');
    const message = { type: 'selection', documentId: 7, before: measure(root, 1), through: measure(suffix, 3) };
    expect(JSON.stringify(message).length).toBeLessThan(160);
    expect(parseComposerWebMessage(JSON.stringify(message))).toEqual(message);
    expect(parseComposerWebMessage(JSON.stringify({ ...message, documentId: -1 }))).toBeNull();
    expect(parseComposerWebMessage(JSON.stringify({ ...message, before: { textLength: -1, atomCount: 0 } }))).toBeNull();
    const slashTail = text('b\u200B');
    const slash = element('SPAN', [text('/a'), element('BR', []), slashTail]);
    slash.classList.contains = (name) => name === 'slash';
    root.childNodes = [slash, text('尾')];
    expect(measure(slashTail, 0)).toEqual({ textLength: 2, atomCount: 0 });
    expect(measure(root, 1)).toEqual({ textLength: 4, atomCount: 0 });
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
      addEventListener() {},
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
        applyDocument(value: unknown, focusAfter?: boolean, caret?: { nodeIndex: number; offset: number }): void;
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

    // Blur can happen before WebView delivers a final input event (for
    // example when the resize handle collapses the composer). The blur hook
    // must flush that DOM value before native receives the blur message.
    children[0].nodeValue = 'draft flushed on blur';
    const beforeBlur = messages.length;
    listeners.get('blur')?.();
    expect(messages.slice(beforeBlur)).toEqual([
      {
        type: 'change',
        document: { version: 1, nodes: [{ type: 'text', text: 'draft flushed on blur' }] },
      },
      { type: 'blur' },
    ]);

    // IME completion may arrive on either side of blur. Keep preedit text
    // private until completion/cancellation, then publish the final DOM once.
    for (const completion of ['compositionend', 'compositioncancel']) {
      for (const blurFirst of [false, true]) {
        windowStub.cindyComposer?.applyDocument({
          version: 1,
          nodes: [{ type: 'text', text: '草稿' }],
        }, true);
        const beforeComposition = messages.length;
        listeners.get('compositionstart')?.();
        children[0].nodeValue = '草稿候选';
        listeners.get('input')?.();
        expect(messages.slice(beforeComposition)).toEqual([]);
        if (blurFirst) {
          listeners.get('blur')?.();
          expect(messages.slice(beforeComposition)).toEqual([{ type: 'blur' }]);
          expect(children[0].nodeValue).toBe('草稿候选');
        }

        const finalText = completion === 'compositionend' ? '草稿完成' : '草稿';
        children[0].nodeValue = finalText;
        listeners.get(completion)?.();
        listeners.get('input')?.();
        if (!blurFirst) listeners.get('blur')?.();
        const changes = completion === 'compositionend' ? [{
          type: 'change',
          document: { version: 1, nodes: [{ type: 'text', text: finalText }] },
        }] : [];
        expect(messages.slice(beforeComposition)).toEqual(blurFirst
          ? [{ type: 'blur' }, ...changes]
          : [...changes, { type: 'blur' }]);

        // Completion must also unlock ordinary editing after refocusing.
        listeners.get('focus')?.();
        children[0].nodeValue = `${finalText}继续编辑`;
        listeners.get('input')?.();
        expect(messages.at(-1)).toEqual({
          type: 'change',
          document: { version: 1, nodes: [{ type: 'text', text: `${finalText}继续编辑` }] },
        });
      }
    }
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
    for (const finish of ['commit', 'replace-document']) {
      windowStub.cindyComposer?.applyDocument({
        version: 1,
        nodes: [{ type: 'text', text: 'hello world' }],
      }, true);
      const selectedPasteRange = createRange();
      selectedPasteRange.setStart(children[0], 5);
      // Model replacing the selected suffix: Range.deleteContents mutates
      // the DOM before native returns the asynchronously processed paste.
      selectedPasteRange.deleteContents = () => { children[0].nodeValue = 'hello'; };
      selection.addRange(selectedPasteRange);
      const beforePaste = messages.length;
      listeners.get('paste')?.({
        clipboardData: { getData: () => ' replacement', items: [] },
        preventDefault() {},
      });
      const requestId = finish === 'commit' ? '2' : '3';
      const pasteRequest = { type: 'paste-text-request', requestId, text: ' replacement' };
      expect(children[0].nodeValue).toBe('hello');
      listeners.get('blur')?.();
      expect(messages.slice(beforePaste)).toEqual([pasteRequest, { type: 'blur' }]);

      if (finish === 'commit') {
        windowStub.cindyComposer?.commitPaste(requestId, [{ type: 'text', text: ' replacement' }]);
        expect(messages.slice(beforePaste)).toEqual([
          pasteRequest,
          { type: 'blur' },
          {
            type: 'change',
            document: { version: 1, nodes: [{ type: 'text', text: 'hello replacement' }] },
          },
        ]);
      } else {
        // Replacing the document detaches the pending marker. Its late reply
        // must neither overwrite the new draft nor block a later blur flush.
        windowStub.cindyComposer?.applyDocument({
          version: 1,
          nodes: [{ type: 'text', text: 'new draft' }],
        }, true);
        children[0].nodeValue = 'new draft edited';
        const beforeNewBlur = messages.length;
        listeners.get('blur')?.();
        expect(messages.slice(beforeNewBlur)).toEqual([
          {
            type: 'change',
            document: { version: 1, nodes: [{ type: 'text', text: 'new draft edited' }] },
          },
          { type: 'blur' },
        ]);
        const beforeLatePaste = messages.length;
        windowStub.cindyComposer?.commitPaste(requestId, [{ type: 'text', text: ' replacement' }]);
        expect(messages).toHaveLength(beforeLatePaste);
        expect(children[0].nodeValue).toBe('new draft edited');
      }
    }
    windowStub.cindyComposer?.applyDocument({
      version: 1,
      nodes: [
        { type: 'pasted-text', text: 'long raw text', display: 'chip' },
        { type: 'text', text: 'dictated suffix' },
      ],
    }, true, { nodeIndex: 1, offset: 8 });
    expect(selection.anchorNode).toBe(children[2]);
    expect(selection.anchorOffset).toBe(8);
    // Without focusAfter the caret is restored only while the editor already has focus.
    let focusCalls = 0;
    root.focus = () => { focusCalls += 1; };
    const dictated = {
      version: 1,
      nodes: [{ type: 'text', text: 'dictated text' }],
    };
    // Replacing the DOM drops the live selection, as a real contenteditable does.
    selection.removeAllRanges();
    windowStub.cindyComposer?.applyDocument(dictated, false, { nodeIndex: 0, offset: 4 });
    expect(selection.anchorNode).toBeNull();
    Object.assign(documentStub, { activeElement: root });
    windowStub.cindyComposer?.applyDocument(dictated, false, { nodeIndex: 0, offset: 4 });
    expect(selection.anchorNode).toBe(children[0]);
    expect(selection.anchorOffset).toBe(4);
    expect(focusCalls).toBe(0);
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
});
