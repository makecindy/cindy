import { describe, expect, it, vi } from 'vitest';

import {
  buildEditableContextMenuTemplate,
  buildSelectionContextMenuTemplate,
  buildSelectionSearchUrl,
  frameSelectionSupportsAddToChat,
} from '../selection-context-menu';

const params = {
  canAddToChat: true,
  editFlags: { canCopy: true },
  selectionText: 'selected words',
} as Parameters<typeof buildSelectionContextMenuTemplate>[2];

describe('selection context menu platform shape', () => {
  it('uses macOS native semantics without browser developer actions', () => {
    const template = buildSelectionContextMenuTemplate('darwin', 'en-US', params, {
      addToChat: vi.fn(),
      lookUp: vi.fn(),
      searchWeb: vi.fn(),
    });

    expect(template.map((item) => item.role ?? item.label ?? item.type)).toEqual([
      'copy',
      'Add to chat',
      'separator',
      'Look Up “selected words”',
    ]);
    expect(template[0]?.label).toBe('Copy');
    expect(template).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'reload' }),
      expect.objectContaining({ role: 'toggleDevTools' }),
    ]));
  });

  it('uses Copy and web search on Windows', () => {
    const template = buildSelectionContextMenuTemplate('win32', 'zh-CN', params, {
      addToChat: vi.fn(),
      lookUp: vi.fn(),
      searchWeb: vi.fn(),
    });

    expect(template.map((item) => item.role ?? item.label ?? item.type)).toEqual([
      'copy',
      '添加到对话',
      'separator',
      '在网页中搜索“selected words”',
    ]);
    expect(template[0]?.label).toBe('复制');
  });

  it('uses Traditional Chinese labels for zh-TW', () => {
    const template = buildSelectionContextMenuTemplate('win32', 'zh-TW', params, {
      addToChat: vi.fn(),
      lookUp: vi.fn(),
      searchWeb: vi.fn(),
    });

    expect(template.map((item) => item.role ?? item.label ?? item.type)).toEqual([
      'copy',
      '新增到對話',
      'separator',
      '在網頁中搜尋「selected words」',
    ]);
    expect(template[0]?.label).toBe('拷貝');
  });

  it('truncates long single-line labels', () => {
    const template = buildSelectionContextMenuTemplate(
      'win32',
      'en-US',
      { ...params, selectionText: `first\n${'x'.repeat(80)}` },
      { addToChat: vi.fn(), lookUp: vi.fn(), searchWeb: vi.fn() },
    );

    expect(String(template[3]?.label)).toMatch(/^Search the web for “first x+…”$/);
    expect(String(template[3]?.label).length).toBeLessThan(80);
  });

  it('omits Add to chat outside chat/file selection contexts', () => {
    const template = buildSelectionContextMenuTemplate(
      'darwin',
      'en-US',
      { ...params, canAddToChat: false },
      { addToChat: vi.fn(), lookUp: vi.fn(), searchWeb: vi.fn() },
    );
    expect(template.map((item) => item.role ?? item.label ?? item.type)).toEqual([
      'copy',
      'separator',
      'Look Up “selected words”',
    ]);
  });

  it('fails closed when the renderer frame cannot confirm quote context', async () => {
    await expect(frameSelectionSupportsAddToChat(null)).resolves.toBe(false);
    await expect(frameSelectionSupportsAddToChat({
      isDestroyed: () => false,
      executeJavaScript: vi.fn(async () => true),
    })).resolves.toBe(true);
    await expect(frameSelectionSupportsAddToChat({
      isDestroyed: () => false,
      executeJavaScript: vi.fn(async () => Promise.reject(new Error('gone'))),
    })).resolves.toBe(false);
  });

  it('encodes and bounds the Windows web-search query', () => {
    expect(buildSelectionSearchUrl(' a & b ')).toBe('https://www.bing.com/search?q=a%20%26%20b');
    expect(decodeURIComponent(buildSelectionSearchUrl('x'.repeat(2500)).split('?q=')[1] ?? '')).toHaveLength(2000);
  });
});

type EditableParams = Parameters<typeof buildEditableContextMenuTemplate>[2];
type EditFlags = EditableParams['editFlags'];

const RICH_EDIT_FLAGS = {
  canUndo: true,
  canRedo: true,
  canCut: true,
  canCopy: true,
  canPaste: true,
  canSelectAll: true,
  canEditRichly: true,
} as EditFlags;

function editableParams(
  overrides: Partial<EditFlags> = {},
  selectionText = '',
): EditableParams {
  return {
    editFlags: { ...RICH_EDIT_FLAGS, ...overrides } as EditFlags,
    selectionText,
  } as EditableParams;
}

const editableActions = () => ({ lookUp: vi.fn(), searchWeb: vi.fn() });

describe('editable context menu shape', () => {
  it('offers the standard edit commands in the user locale', () => {
    const template = buildEditableContextMenuTemplate(
      'darwin',
      'zh-CN',
      editableParams(),
      editableActions(),
    );

    expect(template.map((item) => item.role ?? item.type)).toEqual([
      'undo',
      'redo',
      'separator',
      'cut',
      'copy',
      'paste',
      'pasteAndMatchStyle',
      'separator',
      'selectAll',
    ]);
    expect(template.map((item) => item.label).filter(Boolean)).toEqual([
      '撤销',
      '重做',
      '剪切',
      '复制',
      '粘贴',
      '粘贴为纯文本',
      '全选',
    ]);
    expect(template.every((item) => item.enabled !== false)).toBe(true);
  });

  it('never exposes browser developer actions', () => {
    const template = buildEditableContextMenuTemplate(
      'win32',
      'en-US',
      editableParams({}, 'word'),
      editableActions(),
    );

    for (const role of ['reload', 'toggleDevTools', 'forceReload'] as const) {
      expect(template.some((item) => item.role === role)).toBe(false);
    }
  });

  it('mirrors Chromium editFlags instead of re-deriving enablement', () => {
    const template = buildEditableContextMenuTemplate(
      'win32',
      'en',
      editableParams({ canUndo: false, canRedo: false, canPaste: false, canCopy: false }),
      editableActions(),
    );
    const enabledByRole = new Map(template.map((item) => [item.role, item.enabled]));

    expect(enabledByRole.get('undo')).toBe(false);
    expect(enabledByRole.get('redo')).toBe(false);
    expect(enabledByRole.get('paste')).toBe(false);
    expect(enabledByRole.get('pasteAndMatchStyle')).toBe(false);
    expect(enabledByRole.get('copy')).toBe(false);
    expect(enabledByRole.get('cut')).toBe(true);
    expect(enabledByRole.get('selectAll')).toBe(true);
  });

  it('drops paste-as-plain-text for plain inputs where it duplicates paste', () => {
    const template = buildEditableContextMenuTemplate(
      'darwin',
      'en',
      editableParams({ canEditRichly: false }),
      editableActions(),
    );

    expect(template.some((item) => item.role === 'pasteAndMatchStyle')).toBe(false);
    expect(template.some((item) => item.role === 'paste')).toBe(true);
  });

  it('adds the platform lookup action only when text is selected', () => {
    const withoutSelection = buildEditableContextMenuTemplate(
      'darwin',
      'en',
      editableParams(),
      editableActions(),
    );
    expect(withoutSelection.at(-1)?.role).toBe('selectAll');

    const macActions = editableActions();
    const mac = buildEditableContextMenuTemplate(
      'darwin',
      'en',
      editableParams({}, ' typo '),
      macActions,
    );
    expect(mac.at(-1)?.label).toBe('Look Up “typo”');
    (mac.at(-1)?.click as () => void)();
    expect(macActions.lookUp).toHaveBeenCalledTimes(1);

    const winActions = editableActions();
    const win = buildEditableContextMenuTemplate(
      'win32',
      'zh-CN',
      editableParams({}, 'typo'),
      winActions,
    );
    expect(win.at(-1)?.label).toBe('在网页中搜索“typo”');
    (win.at(-1)?.click as () => void)();
    expect(winActions.searchWeb).toHaveBeenCalledTimes(1);
  });

  it('keeps the read-only selection menu label in sync with the edit catalog', () => {
    const selection = buildSelectionContextMenuTemplate('darwin', 'ja', params, {
      addToChat: vi.fn(),
      lookUp: vi.fn(),
      searchWeb: vi.fn(),
    });
    const editable = buildEditableContextMenuTemplate(
      'darwin',
      'ja',
      editableParams(),
      editableActions(),
    );

    expect(selection[0]?.label).toBe('コピー');
    expect(editable.find((item) => item.role === 'copy')?.label).toBe('コピー');
  });
});
