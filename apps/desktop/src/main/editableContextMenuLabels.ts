/**
 * 可编辑控件（输入框、文本域、contenteditable）原生右键菜单的四语标签。
 *
 * 和 applicationMenuLabels.ts 同样是**影子 catalog**:属于用户可见文案,但不走
 * i18next,`check-i18n-glossary.mjs` 只读 renderer 的 locale JSON 扫不到它。覆盖它的
 * 是 __tests__/editableContextMenuLabels.test.ts,判定逻辑与根门禁同源。
 *
 * 措辞取各平台系统级编辑命令的既有译法(macOS 菜单栏 / Chromium 右键菜单),不自造:
 * 用户对这几个词的预期由操作系统而非 Cindy 建立。
 */
import type { SupportedLocale } from '../shared/locale.js';

export interface EditableContextMenuLabels {
  undo: string;
  redo: string;
  cut: string;
  copy: string;
  paste: string;
  pasteAsPlainText: string;
  selectAll: string;
}

export const EDITABLE_CONTEXT_MENU_LABELS: Record<SupportedLocale, EditableContextMenuLabels> = {
  'zh-CN': {
    undo: '撤销',
    redo: '重做',
    cut: '剪切',
    copy: '复制',
    paste: '粘贴',
    pasteAsPlainText: '粘贴为纯文本',
    selectAll: '全选',
  },
  'zh-TW': {
    undo: '復原',
    redo: '重做',
    cut: '剪下',
    copy: '拷貝',
    paste: '貼上',
    pasteAsPlainText: '貼上為純文字',
    selectAll: '全選',
  },
  en: {
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    pasteAsPlainText: 'Paste as Plain Text',
    selectAll: 'Select All',
  },
  ja: {
    undo: '元に戻す',
    redo: 'やり直す',
    cut: '切り取り',
    copy: 'コピー',
    paste: '貼り付け',
    pasteAsPlainText: 'テキストのみ貼り付け',
    selectAll: 'すべて選択',
  },
  ko: {
    undo: '실행 취소',
    redo: '다시 실행',
    cut: '잘라내기',
    copy: '복사',
    paste: '붙여넣기',
    pasteAsPlainText: '서식 없이 붙여넣기',
    selectAll: '모두 선택',
  },
};
