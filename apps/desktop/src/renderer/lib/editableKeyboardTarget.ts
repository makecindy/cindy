/**
 * 键盘快捷键的「让位」判据:焦点落在可编辑控件里时,全局快捷键不该抢走按键。
 *
 * 独立成模块而不是各处自己写一份:MessageStream(历史导航键)与
 * ShareSelectionBar(⌘A / Esc)共用同一判据,同一语义只留一个实现;也让
 * 依赖它的小组件不必为了一个工具函数 import 整个 MessageStream。
 */
export function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName;
  return (
    tagName === 'INPUT' ||
    tagName === 'TEXTAREA' ||
    tagName === 'SELECT' ||
    target.isContentEditable
  );
}

/** 自带键盘语义的控件：焦点在这里时，回车 / 空格由它自己激活。 */
const INTERACTIVE_SELECTOR = [
  'button',
  'a[href]',
  'select',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role^="menuitem"]',
  '[role="option"]',
  '[role="tab"]',
  '[role="radio"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="combobox"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="treeitem"]',
].join(',');

/** 自己处理 Esc / 方向键的浮层：菜单、下拉列表、弹层与对话框。 */
const LAYER_SELECTOR = [
  '[role="menu"]',
  '[role="listbox"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[data-radix-popper-content-wrapper]',
].join(',');

/**
 * 替代输入框的交互卡片（授权、计划审批、提问）在 window 上挂了回车 / Esc / 数字键
 * 快捷键。这些按键同时可能属于别处：焦点所在的按钮、刚被关闭的菜单、正在打字的
 * 输入框。快捷键只在按键确实「无人认领」时才替用户做决定，否则让位。
 *
 * - 已被别处处理（defaultPrevented）或处于输入法组字中：让位。
 * - 焦点在可编辑控件、或卡片外的菜单 / 弹层 / 对话框里：让位。
 * - 焦点在卡片外的按钮、链接等控件上：让位，按键属于那个控件所在的界面。
 * - 焦点在卡片自己的控件上：普通回车 / 空格让给控件原生激活（在「拒绝」上按回车就是拒绝）；
 *   Esc 与数字键没有原生含义，仍按卡片快捷键处理。带修饰键的卡片快捷键也保留自己的语义。
 */
export function shouldCardShortcutYield(
  event: KeyboardEvent,
  kind: 'activate' | 'modifiedActivate' | 'dismiss' | 'character',
  owner: Element | null,
): boolean {
  if (event.defaultPrevented || event.isComposing) return true;
  const target = event.target;
  if (isEditableKeyboardTarget(target)) return true;
  if (!(target instanceof Element)) return false;
  const insideOwner = owner?.contains(target) ?? false;
  if (!insideOwner && target.closest(LAYER_SELECTOR)) return true;
  if (!target.closest(INTERACTIVE_SELECTOR)) return false;
  return !insideOwner || kind === 'activate';
}
