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
