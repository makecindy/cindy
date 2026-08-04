/**
 * App-owned BrowserWindow context menu for text selections and editable
 * controls.
 *
 * Electron does not expose Chromium's full native menu as a safe reusable
 * default, so we intentionally build the small platform set Cindy needs:
 * read-only selections get macOS Copy / Look Up or Windows Copy / web search,
 * and editable controls get the standard edit commands (undo … select all).
 * Browser-only actions such as reload, view source, and inspect are never
 * included.
 */
import {
  app,
  Menu,
  shell,
  type BrowserWindow,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type WebFrameMain,
} from 'electron';

import { SELECTION_CONTEXT_MENU_ADD_TO_CHAT_CHANNEL } from '../shared/selectionContextMenu.js';
import {
  resolvePreferredSystemLocale,
  resolveSystemLocale,
  type SupportedLocale,
} from '../shared/locale.js';
import {
  EDITABLE_CONTEXT_MENU_LABELS,
  type EditableContextMenuLabels,
} from './editableContextMenuLabels.js';

const SEARCH_URL = 'https://www.bing.com/search?q=';
const LABEL_PREVIEW_CHARS = 48;
const SEARCH_QUERY_MAX_CHARS = 2000;

type SupportedPlatform = 'darwin' | 'win32';
let currentLocale: SupportedLocale | null = null;

interface SelectionMenuActions {
  addToChat: () => void;
  lookUp: () => void;
  searchWeb: () => void;
}

const QUOTE_CONTEXT_QUERY = `(() => {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) return false;
  const elementFor = (node) => node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  const anchorContext = elementFor(selection.anchorNode)?.closest('[data-selection-quote-context]');
  const focusContext = elementFor(selection.focusNode)?.closest('[data-selection-quote-context]');
  return Boolean(anchorContext && anchorContext === focusContext);
})()`;

function compactSelectionLabel(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > LABEL_PREVIEW_CHARS
    ? `${compact.slice(0, LABEL_PREVIEW_CHARS)}…`
    : compact;
}

/** 宽松 locale 串（'en-US'、'zh-TW' 等）落到 catalog 支持的四种语言。 */
function editableMenuLabels(locale: string): EditableContextMenuLabels {
  return EDITABLE_CONTEXT_MENU_LABELS[resolveSystemLocale(locale)];
}

function localizedActionLabel(
  action: 'addToChat' | 'copy' | 'lookUp' | 'searchWeb',
  locale: string,
  selectionText: string,
): string {
  const preview = compactSelectionLabel(selectionText);
  const language = locale.toLowerCase();
  if (action === 'addToChat') {
    if (language.startsWith('zh')) return '添加到对话';
    if (language.startsWith('ja')) return 'チャットに追加';
    if (language.startsWith('ko')) return '대화에 추가';
    return 'Add to chat';
  }
  // Copy 是两套菜单共用的同一条命令,标签只保留 catalog 一处正本。
  if (action === 'copy') return editableMenuLabels(locale).copy;
  if (action === 'lookUp') {
    if (language.startsWith('zh')) return `查询“${preview}”`;
    if (language.startsWith('ja')) return `「${preview}」を調べる`;
    if (language.startsWith('ko')) return `“${preview}” 찾아보기`;
    return `Look Up “${preview}”`;
  }
  if (language.startsWith('zh')) return `在网页中搜索“${preview}”`;
  if (language.startsWith('ja')) return `「${preview}」をウェブで検索`;
  if (language.startsWith('ko')) return `웹에서 “${preview}” 검색`;
  return `Search the web for “${preview}”`;
}

/** Bound explicit web-search navigation so a whole-page selection cannot create an oversized URL. */
export function buildSelectionSearchUrl(selectionText: string): string {
  const query = selectionText.trim().slice(0, SEARCH_QUERY_MAX_CHARS);
  return `${SEARCH_URL}${encodeURIComponent(query)}`;
}

/** Build the deterministic menu shape; exported for platform regression tests. */
export function buildSelectionContextMenuTemplate(
  platform: SupportedPlatform,
  locale: string,
  params: Pick<ContextMenuParams, 'editFlags' | 'selectionText'> & { canAddToChat: boolean },
  actions: SelectionMenuActions,
): MenuItemConstructorOptions[] {
  const copy: MenuItemConstructorOptions = {
    role: 'copy',
    label: localizedActionLabel('copy', locale, params.selectionText),
    enabled: params.editFlags.canCopy,
  };
  const productActions: MenuItemConstructorOptions[] = params.canAddToChat
    ? [
      {
        label: localizedActionLabel('addToChat', locale, params.selectionText),
        click: actions.addToChat,
      },
    ]
    : [];
  if (platform === 'darwin') {
    return [
      copy,
      ...productActions,
      { type: 'separator' },
      {
        label: localizedActionLabel('lookUp', locale, params.selectionText),
        click: actions.lookUp,
      },
    ];
  }
  return [
    copy,
    ...productActions,
    { type: 'separator' },
    {
      label: localizedActionLabel('searchWeb', locale, params.selectionText),
      click: actions.searchWeb,
    },
  ];
}

/**
 * Build the editable-control menu; exported for platform regression tests.
 *
 * Electron ships no default menu at all, so without this an input, textarea or
 * contenteditable right-click produced nothing — paste was keyboard-only. The
 * item set follows the platform edit menu users already know; enablement comes
 * from Chromium's editFlags, so read-only and password fields grey out on their
 * own instead of us re-deriving the rules.
 */
export function buildEditableContextMenuTemplate(
  platform: SupportedPlatform,
  locale: string,
  params: Pick<ContextMenuParams, 'editFlags' | 'selectionText'>,
  actions: Pick<SelectionMenuActions, 'lookUp' | 'searchWeb'>,
): MenuItemConstructorOptions[] {
  const labels = editableMenuLabels(locale);
  const { editFlags } = params;
  const template: MenuItemConstructorOptions[] = [
    { role: 'undo', label: labels.undo, enabled: editFlags.canUndo },
    { role: 'redo', label: labels.redo, enabled: editFlags.canRedo },
    { type: 'separator' },
    { role: 'cut', label: labels.cut, enabled: editFlags.canCut },
    { role: 'copy', label: labels.copy, enabled: editFlags.canCopy },
    { role: 'paste', label: labels.paste, enabled: editFlags.canPaste },
  ];
  // 只有富文本目标才给「粘贴为纯文本」:普通 input / textarea 里它和「粘贴」等效,
  // 多一条只会让菜单更长。
  if (editFlags.canEditRichly) {
    template.push({
      role: 'pasteAndMatchStyle',
      label: labels.pasteAsPlainText,
      enabled: editFlags.canPaste,
    });
  }
  template.push(
    { type: 'separator' },
    { role: 'selectAll', label: labels.selectAll, enabled: editFlags.canSelectAll },
  );
  const selectionText = params.selectionText.trim();
  if (selectionText) {
    template.push({ type: 'separator' });
    template.push(platform === 'darwin'
      ? {
        label: localizedActionLabel('lookUp', locale, selectionText),
        click: actions.lookUp,
      }
      : {
        label: localizedActionLabel('searchWeb', locale, selectionText),
        click: actions.searchWeb,
      });
  }
  return template;
}

/** Keep custom context-menu labels aligned with Cindy's effective UI locale. */
export function setSelectionContextMenuLocale(locale: SupportedLocale): void {
  currentLocale = locale;
}

function getSelectionContextMenuLocale(): SupportedLocale {
  if (currentLocale) return currentLocale;
  const preferred = app.getPreferredSystemLanguages();
  return resolvePreferredSystemLocale(preferred.length > 0 ? preferred : [app.getLocale()]);
}

/** Ask the invoking renderer frame whether its selection belongs to chat/file quote UI. */
export async function frameSelectionSupportsAddToChat(
  frame: Pick<WebFrameMain, 'executeJavaScript' | 'isDestroyed'> | null,
): Promise<boolean> {
  if (!frame || frame.isDestroyed()) return false;
  try {
    return await frame.executeJavaScript(QUOTE_CONTEXT_QUERY) === true;
  } catch {
    return false;
  }
}

/** Attach the native selection menu to one app-owned content window. */
export function installSelectionContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_event, params) => {
    void showSelectionContextMenu(win, params);
  });
}

async function showSelectionContextMenu(
  win: BrowserWindow,
  params: ContextMenuParams,
): Promise<void> {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return;
  if (params.isEditable) {
    // 可编辑目标不问 renderer:「添加到对话」只对只读引用区有意义,少一次
    // executeJavaScript 也让输入框右键即时弹出。
    showEditableContextMenu(win, params, process.platform);
    return;
  }
  const selectionText = params.selectionText.trim();
  if (!selectionText) return;
  const canAddToChat = await frameSelectionSupportsAddToChat(params.frame);
  if (win.isDestroyed()) return;
  const sourceFrame = params.frame;

  const template = buildSelectionContextMenuTemplate(
    process.platform,
    getSelectionContextMenuLocale(),
    { canAddToChat, editFlags: params.editFlags, selectionText },
    {
      addToChat: () => {
        if (sourceFrame && !sourceFrame.isDestroyed()) {
          sourceFrame.send(SELECTION_CONTEXT_MENU_ADD_TO_CHAT_CHANNEL);
        }
      },
      lookUp: () => {
        if (!win.isDestroyed()) win.webContents.showDefinitionForSelection();
      },
      searchWeb: () => {
        void shell.openExternal(buildSelectionSearchUrl(selectionText));
      },
    },
  );
  Menu.buildFromTemplate(template).popup({ window: win, x: params.x, y: params.y });
}

function showEditableContextMenu(
  win: BrowserWindow,
  params: ContextMenuParams,
  platform: SupportedPlatform,
): void {
  const selectionText = params.selectionText.trim();
  const template = buildEditableContextMenuTemplate(
    platform,
    getSelectionContextMenuLocale(),
    { editFlags: params.editFlags, selectionText },
    {
      lookUp: () => {
        if (!win.isDestroyed()) win.webContents.showDefinitionForSelection();
      },
      searchWeb: () => {
        void shell.openExternal(buildSelectionSearchUrl(selectionText));
      },
    },
  );
  Menu.buildFromTemplate(template).popup({ window: win, x: params.x, y: params.y });
}
