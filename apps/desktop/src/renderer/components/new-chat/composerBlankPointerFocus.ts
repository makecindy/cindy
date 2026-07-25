/**
 * Composer 空白区指针守卫 —— 修掉「只有点中文字那一行才能进输入」。
 *
 * composer 的输入体是 Tiptap 的 contenteditable,高度只跟内容走
 * (`.ProseMirror` 是 `min-h-[22px]`);外层输入卡片却撑着 `min-h-[86px]`
 * (create-agent 变体 140px)并用 `justify-between` 把工具栏压到底边,于是
 * 文字行下方的空隙、工具栏两组按钮之间的空档、卡片四周的 padding 全是
 * 「没有元素承接点击」的空白。原生 `<textarea>` 时代整块卡片就是输入体,
 * 点哪都落在输入里;换成 contenteditable 之后,点这些空白会让浏览器把焦点
 * 从 contenteditable 撤到 `<body>`,正在输入的光标凭空消失。
 *
 * 本模块回答两个问题:
 * 1. 这次 mousedown 是否落在 composer 的空白区(`isComposerBlankPointerTarget`)。
 *    调用方据此 `preventDefault()`,把浏览器默认的焦点转移吃掉。
 * 2. 吃掉之后该不该补一次 focus、补到哪(`resolveComposerBlankFocusIntent`)。
 *
 * 关键是「进入输入态」与「定位插入点」两件事分开:点空白要能开始打字,但插入点
 * 不由空白区决定 —— 那只归「点击文字那一行」。所以补 focus 时不带坐标,光标沿用
 * 编辑器自己的 selection。
 */

/**
 * 元素本身是否是「会自己吃焦点」的交互控件。空白区判定要放过这些目标,
 * 否则 `preventDefault()` 会连按钮聚焦、文本框选字一起废掉。
 */
export function isInteractiveFocusedElement(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable) return true;
  const tagName = element.tagName.toLowerCase();
  if (['button', 'input', 'select', 'textarea'].includes(tagName)) return true;
  if (tagName === 'a' && element.hasAttribute('href')) return true;
  if (element.tabIndex >= 0) return true;
  const role = element.getAttribute('role');
  return (
    role === 'button' ||
    role === 'textbox' ||
    role === 'searchbox' ||
    role === 'combobox' ||
    role === 'menuitem' ||
    role === 'tab' ||
    role === 'checkbox' ||
    role === 'radio' ||
    role === 'switch' ||
    role === 'option'
  );
}

/** 指针落点(视口坐标),对齐 MouseEvent 的字段名。 */
export interface ComposerPointerPoint {
  clientX: number;
  clientY: number;
}

/**
 * 这次指针事件的落点是否是 composer 卡片里的「空白」。
 *
 * @param target    事件的 `event.target`
 * @param container composer 输入卡片(事件绑定所在的那层)
 * @param editorDom 编辑器根节点(`editor.view.dom`);为 null 时按「编辑器未就绪」处理
 * @param point     事件的视口坐标(`event.clientX` / `clientY`)
 *
 * 判 false(即放过默认行为)的情形:
 * - 落点不是 Element,或不在卡片内(理论上不会,冒泡边界兜一层);
 * - 落点在卡片矩形之外 —— 卡片里挂着 `absolute bottom-full` 的悬浮预览(页面评论
 *   /引用),它们 DOM 上是卡片后代、视觉上却飘在卡片外。死区问题只存在于卡片
 *   矩形内部,浮层上的 mousedown 必须原样放过,否则那里的文字连拖选都做不了;
 * - 落在编辑器内 —— 那正是要走 ProseMirror 自己的光标定位;
 * - 落点到卡片之间的任一祖先是交互控件(按钮 / 输入框 / role 控件 / 可聚焦项),
 *   或是可拖拽元素(附件缩略图靠原生拖拽换位,吃掉 mousedown 会拖不动)。
 */
export function isComposerBlankPointerTarget(
  target: EventTarget | null,
  container: Element,
  editorDom: Element | null,
  point: ComposerPointerPoint,
): boolean {
  if (!(target instanceof Element)) return false;
  if (!container.contains(target)) return false;
  const box = container.getBoundingClientRect();
  if (
    point.clientX < box.left ||
    point.clientX > box.right ||
    point.clientY < box.top ||
    point.clientY > box.bottom
  ) {
    return false;
  }
  if (editorDom && (editorDom === target || editorDom.contains(target))) return false;
  for (let node: Element | null = target; node && node !== container; node = node.parentElement) {
    if (isInteractiveFocusedElement(node)) return false;
    if (node instanceof HTMLElement && node.draggable) return false;
  }
  return true;
}

/** 判定补 focus 需要的编辑器状态快照(只取布尔量,便于单测覆盖决策矩阵)。 */
export interface ComposerFocusSnapshot {
  isDestroyed: boolean;
  /** `disabled` 与语音听写 busy 都会把编辑器置为不可编辑。 */
  isEditable: boolean;
  isFocused: boolean;
  /** 光标是否还停在文档起点这个「没人动过」的默认位置。 */
  caretAtDocStart: boolean;
}

/**
 * 点空白之后要对焦点做什么:
 * - `none`      什么都不做。编辑器已经有焦点(光标本来就在,`preventDefault()` 已经
 *               替它保住了),或编辑器不可用/只读(disabled、语音听写占用)—— 只读态
 *               下抢焦点没有意义,也会把语音输入的 caret 装饰搅乱。
 * - `keep-caret` 补 focus,光标沿用编辑器当前的 selection(上次停在哪就还在哪)。
 * - `doc-end`   补 focus 并落到文末。只在光标还停在文档起点这个默认位置时用:那说明
 *               这个编辑器还没被人动过(例如刚恢复草稿、autofocus 关着),此时把光标
 *               放到草稿末尾才是「接着写」。代价是用户真把光标停在文首、离开、再点
 *               空白时光标会跳到文末 —— 这个边角情形不值得为它引入额外状态。
 */
export type ComposerBlankFocusIntent = 'none' | 'keep-caret' | 'doc-end';

export function resolveComposerBlankFocusIntent(
  snapshot: ComposerFocusSnapshot | null,
): ComposerBlankFocusIntent {
  if (!snapshot) return 'none';
  if (snapshot.isDestroyed || !snapshot.isEditable) return 'none';
  if (snapshot.isFocused) return 'none';
  return snapshot.caretAtDocStart ? 'doc-end' : 'keep-caret';
}
