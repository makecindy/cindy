/**
 * composerTypingActivity — 会话 composer 的「正在打字」毫秒级信号。
 *
 * 用途：多会话同时流式输出时，store 的高频通知（32ms 合并批）会让 React 在
 * 用户敲键的间隙反复重渲染重子树（CCAgentSessionView / MessageStream / 侧栏），
 * 打字延迟直接被这些渲染吃掉。makerChatStore 读这个信号把通知节奏在打字窗口
 * 内拉稀（typing-first 调度），信号过期后下一个 tick 起恢复原节奏。
 *
 * 刷新点在 ChatInput：键盘字符输入走 editorProps.handleTextInput，IME 组合
 * 输入走 onUpdate 的 composition meta（两者之外的一切程序性写入——语音回填、
 * 草稿恢复、发送后清空、按钮插入——都不开窗）。
 */

const TYPING_ACTIVITY_WINDOW_MS = 800;

let typingActivityUntil = 0;

export function markComposerTypingActivity(): void {
  typingActivityUntil = Date.now() + TYPING_ACTIVITY_WINDOW_MS;
}

export function isComposerTypingRecently(): boolean {
  return Date.now() < typingActivityUntil;
}

/** 测试专用：清掉打字窗口，避免模块级状态跨用例泄漏。 */
export function __resetComposerTypingActivityForTest(): void {
  typingActivityUntil = 0;
}
