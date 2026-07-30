/**
 * 浏览器评论气泡中尚未提交的 Host 编辑状态。
 *
 * 这份状态不能归 BrowserCommentPopover 本地所有：后台 tab 的 WebView 会被
 * Pool 按 LRU 自动淘汰并重建，Popover 随 pending target 卸载；若编辑内容只
 * 存在组件内部，生命周期换代就会直接丢失用户输入。由 useBrowserComment
 * 持有后，WebView 代际可以退出，用户重新点选目标时仍能恢复原草稿。
 */
export interface BrowserCommentEditorDraft {
  text: string;
  /** 只记录用户改过的 CSS 属性值；与 design baseline 的 diff 在 Popover 计算。 */
  styleEdits: Record<string, string>;
  /** 元素可编辑文本的候选值；null 表示仍使用 design baseline。 */
  textEdit: string | null;
}

export function createEmptyBrowserCommentEditorDraft(): BrowserCommentEditorDraft {
  return {
    text: '',
    styleEdits: {},
    textEdit: null,
  };
}
