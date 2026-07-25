// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  isComposerBlankPointerTarget,
  isInteractiveFocusedElement,
  resolveComposerBlankFocusIntent,
  type ComposerFocusSnapshot,
} from '../composerBlankPointerFocus';

/**
 * 搭一个跟 ChatInput 输入卡片同形的最小 DOM:
 *
 *   card (min-h 撑高 + justify-between → 内部有空白),视口矩形 0,0 → 420,86
 *   ├── overlay                   absolute bottom-full 悬浮预览(视觉上在卡片上方)
 *   │   └── overlayText
 *   ├── thumbnails
 *   │   └── img[draggable]        附件缩略图,靠原生拖拽换位
 *   ├── editorHost
 *   │   └── editor (.ProseMirror) → 内含一行文字
 *   ├── blank                     文字行与工具栏之间的空隙
 *   └── toolbar                   两组按钮 + 中间空档
 *       ├── button > buttonIcon
 *       ├── roleButton
 *       ├── tabbable
 *       └── toolbarGap
 *
 * 注意两处 jsdom 限制,也正是被测函数收 editorDom / point 两个显式参数的原因:
 * - jsdom 不实现 contentEditable / isContentEditable,「编辑器内」只能靠显式传入
 *   的 editorDom 判定;
 * - jsdom 不做布局,getBoundingClientRect 恒为全 0,这里给 card 打桩成真实几何。
 */
function buildCard() {
  const outside = document.createElement('div');
  const card = document.createElement('div');

  const thumbnails = document.createElement('div');
  const thumbnail = document.createElement('img');
  thumbnail.draggable = true;
  thumbnails.append(thumbnail);

  const editorHost = document.createElement('div');
  const editor = document.createElement('div');
  editor.className = 'ProseMirror';
  const editorText = document.createElement('p');
  editorText.textContent = 'hello';
  editor.append(editorText);
  editorHost.append(editor);

  const blank = document.createElement('div');

  const toolbar = document.createElement('div');
  const button = document.createElement('button');
  const buttonIcon = document.createElement('span');
  button.append(buttonIcon);
  const roleButton = document.createElement('div');
  roleButton.setAttribute('role', 'button');
  const tabbable = document.createElement('div');
  tabbable.tabIndex = 0;
  const toolbarGap = document.createElement('div');
  toolbar.append(button, roleButton, tabbable, toolbarGap);

  const overlay = document.createElement('div');
  const overlayText = document.createElement('span');
  overlayText.textContent = 'comment preview';
  overlay.append(overlayText);

  card.append(overlay, thumbnails, editorHost, blank, toolbar);
  document.body.append(outside, card);

  // jsdom 不做布局:给卡片打桩成 420x86 的视口矩形(与真实 min-h-[86px] 一致)。
  card.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 420,
      bottom: 86,
      width: 420,
      height: 86,
      toJSON: () => ({}),
    }) as DOMRect;

  return {
    card,
    editor,
    editorText,
    editorHost,
    blank,
    toolbar,
    toolbarGap,
    button,
    buttonIcon,
    roleButton,
    tabbable,
    thumbnail,
    overlay,
    overlayText,
    outside,
  };
}

/** 卡片矩形内部的一点(默认落在文字行与工具栏之间那条空隙上)。 */
const INSIDE = { clientX: 210, clientY: 40 };
/** 卡片矩形上方的一点 —— 悬浮预览(absolute bottom-full)所在的视觉区域。 */
const ABOVE_CARD = { clientX: 210, clientY: -30 };

describe('isComposerBlankPointerTarget', () => {
  it('把卡片空白、编辑器外壳与工具栏空档判为空白', () => {
    const dom = buildCard();

    // 文字行下方的空隙、工具栏两组按钮之间的空档、卡片自身(四周 padding)都是
    // 「点了就丢焦点」的死区,全部要判为空白。
    expect(isComposerBlankPointerTarget(dom.card, dom.card, dom.editor, INSIDE)).toBe(true);
    expect(isComposerBlankPointerTarget(dom.blank, dom.card, dom.editor, INSIDE)).toBe(true);
    expect(isComposerBlankPointerTarget(dom.toolbar, dom.card, dom.editor, INSIDE)).toBe(true);
    expect(isComposerBlankPointerTarget(dom.toolbarGap, dom.card, dom.editor, INSIDE)).toBe(true);
    // 编辑器外壳(EditorContent 的包装层,负 margin 破出的那一圈)也是空白。
    expect(isComposerBlankPointerTarget(dom.editorHost, dom.card, dom.editor, INSIDE)).toBe(true);
  });

  it('放过编辑器自身与其内部节点,让 ProseMirror 自己定位光标', () => {
    const dom = buildCard();

    expect(isComposerBlankPointerTarget(dom.editor, dom.card, dom.editor, INSIDE)).toBe(false);
    expect(isComposerBlankPointerTarget(dom.editorText, dom.card, dom.editor, INSIDE)).toBe(false);
  });

  it('放过交互控件及其内部图标,不夺按钮的 mousedown', () => {
    const dom = buildCard();

    expect(isComposerBlankPointerTarget(dom.button, dom.card, dom.editor, INSIDE)).toBe(false);
    expect(isComposerBlankPointerTarget(dom.buttonIcon, dom.card, dom.editor, INSIDE)).toBe(false);
    expect(isComposerBlankPointerTarget(dom.roleButton, dom.card, dom.editor, INSIDE)).toBe(false);
    expect(isComposerBlankPointerTarget(dom.tabbable, dom.card, dom.editor, INSIDE)).toBe(false);
  });

  it('放过可拖拽元素,附件缩略图仍能拖动换位', () => {
    const dom = buildCard();

    expect(isComposerBlankPointerTarget(dom.thumbnail, dom.card, dom.editor, INSIDE)).toBe(false);
  });

  it('放过卡片矩形之外的悬浮预览,那里的文字仍可拖选', () => {
    const dom = buildCard();

    // overlay 在 DOM 上是卡片后代,但 absolute bottom-full 让它飘在卡片上方;
    // 死区只在卡片矩形内,浮层上的 mousedown 必须原样交给浏览器。
    expect(isComposerBlankPointerTarget(dom.overlay, dom.card, dom.editor, ABOVE_CARD)).toBe(false);
    expect(isComposerBlankPointerTarget(dom.overlayText, dom.card, dom.editor, ABOVE_CARD)).toBe(
      false,
    );
    // 同一个 overlay 元素,落点回到卡片矩形内就仍按空白处理(纯几何判定,不看身份)。
    expect(isComposerBlankPointerTarget(dom.overlay, dom.card, dom.editor, INSIDE)).toBe(true);
  });

  it('卡片矩形四边之外的落点一律不算空白', () => {
    const dom = buildCard();

    expect(isComposerBlankPointerTarget(dom.blank, dom.card, dom.editor, ABOVE_CARD)).toBe(false);
    expect(
      isComposerBlankPointerTarget(dom.blank, dom.card, dom.editor, { clientX: 210, clientY: 120 }),
    ).toBe(false);
    expect(
      isComposerBlankPointerTarget(dom.blank, dom.card, dom.editor, { clientX: -5, clientY: 40 }),
    ).toBe(false);
    expect(
      isComposerBlankPointerTarget(dom.blank, dom.card, dom.editor, { clientX: 500, clientY: 40 }),
    ).toBe(false);
    // 边界(含边)算内部:卡片边缘那一像素也是死区。
    expect(
      isComposerBlankPointerTarget(dom.blank, dom.card, dom.editor, { clientX: 0, clientY: 86 }),
    ).toBe(true);
  });

  it('卡片外的落点与非 Element 目标一律不算空白', () => {
    const dom = buildCard();

    expect(isComposerBlankPointerTarget(dom.outside, dom.card, dom.editor, INSIDE)).toBe(false);
    expect(isComposerBlankPointerTarget(null, dom.card, dom.editor, INSIDE)).toBe(false);
    expect(isComposerBlankPointerTarget(document, dom.card, dom.editor, INSIDE)).toBe(false);
    expect(isComposerBlankPointerTarget(window, dom.card, dom.editor, INSIDE)).toBe(false);
  });

  it('编辑器还没挂载(editorDom 为 null)时,空白判定依旧生效', () => {
    const dom = buildCard();

    expect(isComposerBlankPointerTarget(dom.blank, dom.card, null, INSIDE)).toBe(true);
    expect(isComposerBlankPointerTarget(dom.button, dom.card, null, INSIDE)).toBe(false);
  });
});

describe('isInteractiveFocusedElement', () => {
  it('认按钮 / 表单控件 / 带 href 的链接 / 可聚焦项 / ARIA 控件', () => {
    const button = document.createElement('button');
    const input = document.createElement('input');
    const select = document.createElement('select');
    const textarea = document.createElement('textarea');
    const linkWithHref = document.createElement('a');
    linkWithHref.setAttribute('href', '#');
    const tabbable = document.createElement('div');
    tabbable.tabIndex = 0;
    const switchRole = document.createElement('div');
    switchRole.setAttribute('role', 'switch');

    for (const element of [button, input, select, textarea, linkWithHref, tabbable, switchRole]) {
      expect(isInteractiveFocusedElement(element)).toBe(true);
    }
  });

  // 无 href 的 <a> 不在这里断言:真实浏览器给它 tabIndex = -1(不可聚焦),jsdom
  // 却报 0,断言只会测出 jsdom 的偏差。composer 里也没有裸 <a>。
  it('不认纯装饰节点、负 tabIndex 与非元素', () => {
    const plain = document.createElement('div');
    const negativeTab = document.createElement('div');
    negativeTab.tabIndex = -1;

    expect(isInteractiveFocusedElement(plain)).toBe(false);
    expect(isInteractiveFocusedElement(negativeTab)).toBe(false);
    expect(isInteractiveFocusedElement(null)).toBe(false);
    expect(isInteractiveFocusedElement(document.createTextNode('x') as unknown as Element)).toBe(
      false,
    );
  });
});

describe('resolveComposerBlankFocusIntent', () => {
  const snapshot = (patch: Partial<ComposerFocusSnapshot> = {}): ComposerFocusSnapshot => ({
    isDestroyed: false,
    isEditable: true,
    isFocused: false,
    caretAtDocStart: false,
    ...patch,
  });

  it('没焦点且光标停过位置 → 补 focus 并保留光标', () => {
    expect(resolveComposerBlankFocusIntent(snapshot())).toBe('keep-caret');
  });

  it('没焦点且光标还在文档起点(没人动过)→ 补 focus 并落到文末', () => {
    expect(resolveComposerBlankFocusIntent(snapshot({ caretAtDocStart: true }))).toBe('doc-end');
  });

  it('已经有焦点 → 什么都不做(preventDefault 已经保住光标)', () => {
    expect(resolveComposerBlankFocusIntent(snapshot({ isFocused: true }))).toBe('none');
    expect(
      resolveComposerBlankFocusIntent(snapshot({ isFocused: true, caretAtDocStart: true })),
    ).toBe('none');
  });

  it('只读态(disabled / 语音听写占用)与已销毁、未挂载 → 不抢焦点', () => {
    expect(resolveComposerBlankFocusIntent(snapshot({ isEditable: false }))).toBe('none');
    expect(
      resolveComposerBlankFocusIntent(snapshot({ isEditable: false, caretAtDocStart: true })),
    ).toBe('none');
    expect(resolveComposerBlankFocusIntent(snapshot({ isDestroyed: true }))).toBe('none');
    expect(resolveComposerBlankFocusIntent(null)).toBe('none');
  });
});

describe('ChatInput 空白区守卫接线', () => {
  const chatInputSource = readFileSync(resolve(__dirname, '..', 'ChatInput.tsx'), 'utf8').replace(
    /\r\n?/g,
    '\n',
  );

  it('输入卡片用 isComposerBlankPointerTarget 守卫 mousedown 并按 intent 补 focus', () => {
    const start = chatInputSource.indexOf('onMouseDown={(event) => {');
    expect(start).toBeGreaterThan(0);
    const end = chatInputSource.indexOf('onDragEnter={(e) => {', start);
    expect(end).toBeGreaterThan(start);
    const guardBlock = chatInputSource.slice(start, end);

    expect(guardBlock).toContain('if (event.button !== 0) return;');
    expect(guardBlock).toContain('isComposerBlankPointerTarget(');
    expect(guardBlock).toContain('event.currentTarget');
    expect(guardBlock).toContain('editor && !editor.isDestroyed ? editor.view.dom : null,');
    expect(guardBlock).toContain('event.preventDefault();');
    expect(guardBlock).toContain('resolveComposerBlankFocusIntent({');
    expect(guardBlock).toContain('isEditable: editor.isEditable,');
    expect(guardBlock).toContain('isFocused: editor.isFocused,');
    expect(guardBlock).toContain(
      'selection.empty && selection.from === Selection.atStart(doc).from',
    );
    expect(guardBlock).toContain("if (intent === 'keep-caret') editor.commands.focus();");
    expect(guardBlock).toContain("else if (intent === 'doc-end') editor.commands.focus('end');");
    // 契约:补 focus 一律不带坐标 —— 插入点只由点击文字那一行决定,空白区不参与定位。
    expect(guardBlock).not.toContain('posAtCoords');
    expect(guardBlock).not.toContain('setTextSelection');
  });
});
