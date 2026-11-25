// @vitest-environment jsdom
/**
 * issue #12851 — 文件预览浮层在工具行被重建后仍然留着,并且在 Agent 改动正在看的
 * 文件时给出「文件已变更」提示。
 *
 * 三类用户可观察的行为:
 *   1. 打开文稿预览的那一行工具被卸载(运行中实时预览区收起 / 「最近 5 条」把旧行挤出 /
 *      work group 换 key 重挂)后,文稿预览浮层仍在 —— 修复前预览挂在那一行的局部
 *      state 上,行没了浮层跟着没了,用户并没有点关闭。
 *   2. 同理,打开文件改动 diff 的那一行被卸载后,diff 浮层仍在。
 *   3. 预览期间 Agent 改完了正在看的文件 → 浮层右上角出现「文件已变更」,
 *      点一下才重新读内容(不自动替换用户正在读的内容)。
 *
 * 走的都是生产入口:真实的 AgentActionRow(点文件 chip)、真实的 FilePreviewLightboxHost、
 * 真实的 TextLightbox / ToolPayloadLightbox。CodeMirror / Markdown 渲染引擎是 jsdom 里
 * 跑不动的外部依赖,按仓库既有做法替换成只渲染内容的桩。
 *
 * 测试价值
 * - 生产入口与可观察结果:真实 AgentActionRow 的文件 chip 点击 → 真实
 *   FilePreviewLightboxHost → 真实 TextLightbox / ToolPayloadLightbox。用户可观察到的是:
 *   打开预览的那一行被卸载后浮层是否还在、浮层右上角有没有「文件已变更」、点一下内容
 *   是否换成最新的。
 * - Bug／规则依据:issue #12851(工具行被重建时,用户没点关闭,预览浮层凭空消失);
 *   PR review 的两条意见(编辑还没执行完就提示「文件已变更」、远程文件刷新后仍是旧副本)。
 * - 现有覆盖缺口:agentActionRowRendering.test.ts 把 TextLightbox 整个 mock 成 null、
 *   并把 shouldOpenTextLightbox 短路成 false,永远打不开预览;workGroupBlockLivePreview
 *   只断言实时预览区的行数裁剪,没有跨行卸载后浮层存活的断言。
 * - 最小失败输入:一个已打开文稿预览(或 diff 预览)的工具行被卸载(实时预览区收起 /
 *   「最近 5 条」把旧行挤出 / work group 换 key);预览期间新增一条 Edit 该文件的
 *   tool_use 消息(编辑进行中)与它的 tool_result(编辑完成)。
 * - tier:unit(jsdom + testing-library,走真实组件入口;CodeMirror / Markdown 渲染引擎
 *   按仓库既有做法换成桩)。另开一个文件而不是并入 agentActionRowRendering.test.ts,
 *   是因为那个文件把预览整族 mock 掉了,合进去就再也测不到真实浮层。
 * - 实测耗时:单文件 vitest run 用时 612ms(用例 526ms + 126ms)。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES } from '@/cindy-brain/PluginUiContributions';
import { AgentActionRow } from '@/components/chat/AgentActionRow';
import { ChatSessionFileProvider } from '@/components/chat/ChatSessionFileContext';
import { FilePreviewLightboxProvider } from '@/components/chat/FilePreviewLightboxHost';
import { i18n } from '@/i18n';
import { makerChatStore, type ChatMessage } from '@/lib/makerChatStore';
import { LOCAL_FILE_ORIGIN } from '@/lib/sessionFileOrigin';

vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), parse: vi.fn() } }));
vi.mock('@/components/markdown/PlaintextEditor', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  return {
    PlaintextEditor: forwardRef(({ initialValue }: { initialValue: string }, ref) => {
      useImperativeHandle(ref, () => ({ scrollToLine: vi.fn(), search: { clear: vi.fn() } }));
      return <pre>{initialValue}</pre>;
    }),
  };
});
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: () => <div /> }));
vi.mock('@/components/chat/ImageLightbox', () => ({ ImageLightbox: () => null }));
vi.mock('@/cindy-brain/useInstalledGhosts', () => ({ useInstalledGhosts: () => [] }));
vi.mock('@/components/chat/useFileChipContextMenu', () => ({
  useFileChipContextMenu: () => ({
    menu: null,
    onContextMenu: () => {},
    onActivate: (_event: unknown, openDefault: () => void) => openDefault(),
    openAt: vi.fn(),
  }),
}));

const SESSION_ID = 'preview-session';
const WORKDIR = '/repo';
const FILE_PATH = '/repo/notes.txt';

const mkTool = (id: string, toolName: string, toolInput: unknown): ChatMessage => ({
  clientId: id,
  role: 'tool_use',
  content: '',
  toolUseId: `tu-${id}`,
  toolName,
  toolInput,
});

const readMessage = mkTool('tool-read', 'Read', { file_path: FILE_PATH });

const fileChangeMessage = mkTool('tool-change', 'file_change', {
  changes: [
    {
      path: FILE_PATH,
      kind: { type: 'update' },
      diff: '--- a/notes.txt\n+++ b/notes.txt\n@@ -1 +1 @@\n-old\n+new',
    },
  ],
});

// 会话 store 里新增的编辑消息(与上面渲染用的行消息是两回事)。
const editMessage = mkTool('tool-edit', 'Edit', { file_path: FILE_PATH });

// 编辑执行完成的结果行:Claude / PI 都在工具执行结束时才发它,这时文件才真的写完。
const editResult: ChatMessage = {
  clientId: 'tool-edit-result',
  role: 'tool_result',
  content: '',
  toolUseId: editMessage.toolUseId,
  toolName: 'Edit',
};

let sessionMessages: ChatMessage[] = [];
let notifyStore: (() => void) | null = null;
const readTextFilePreview = vi.fn();

function Harness({ message }: { message?: ChatMessage }) {
  return (
    <ChatSessionFileProvider
      value={{ sessionId: SESSION_ID, workingDir: WORKDIR, origin: LOCAL_FILE_ORIGIN }}
    >
      <FilePreviewLightboxProvider>
        {message ? (
          <AgentActionRow pluginUi={EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES} message={message} />
        ) : null}
      </FilePreviewLightboxProvider>
    </ChatSessionFileProvider>
  );
}

beforeEach(() => {
  sessionMessages = [];
  notifyStore = null;
  readTextFilePreview.mockReset();
  readTextFilePreview.mockResolvedValue({ success: true, data: 'v1', size: 2 });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { readTextFilePreview },
  });
  const original = makerChatStore.getSnapshot(SESSION_ID);
  vi.spyOn(makerChatStore, 'getSnapshot').mockImplementation(
    () => ({ ...original, messages: sessionMessages }) as typeof original,
  );
  vi.spyOn(makerChatStore, 'subscribe').mockImplementation((_sessionId, cb) => {
    notifyStore = cb;
    return () => {
      notifyStore = null;
    };
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('keeps the file preview open after the tool row that opened it is gone', async () => {
  const view = render(<Harness message={readMessage} />);
  fireEvent.click(screen.getByRole('button'));
  await waitFor(() => expect(document.querySelector('[data-text-lightbox-overlay]')).toBeTruthy());

  // 那一行被重建(实时预览区收起 / 最近 5 条挤出 / work group 换 key)后浮层必须留着。
  view.rerender(<Harness />);
  expect(document.querySelector('[data-text-lightbox-overlay]')).toBeTruthy();
  expect(screen.getByText('v1')).toBeTruthy();
});

it('keeps the file diff preview open after the tool row that opened it is gone', async () => {
  const view = render(<Harness message={fileChangeMessage} />);
  fireEvent.click(screen.getByRole('button'));
  await waitFor(() =>
    expect(document.querySelector('[data-tool-payload-lightbox-overlay]')).toBeTruthy(),
  );

  view.rerender(<Harness />);
  expect(document.querySelector('[data-tool-payload-lightbox-overlay]')).toBeTruthy();
});

it('flags the preview as changed only after the edit finishes, and refreshes on click', async () => {
  render(<Harness message={readMessage} />);
  fireEvent.click(screen.getByRole('button'));
  await waitFor(() => expect(document.querySelector('[data-text-lightbox-overlay]')).toBeTruthy());
  expect(screen.queryByText(i18n.t('chat.filePreview.changed'))).toBeNull();

  // 编辑发起但还没执行完:文件没写,不能提示「文件已变更」——否则用户点一下读到旧内容,
  // 提示又消失,后面真正写完了也不会再提示。
  sessionMessages = [editMessage];
  act(() => notifyStore?.());
  expect(screen.queryByText(i18n.t('chat.filePreview.changed'))).toBeNull();

  // 编辑执行完:文件真的改了,这时才提示。
  sessionMessages = [editMessage, editResult];
  act(() => notifyStore?.());
  await waitFor(() => expect(screen.getByText(i18n.t('chat.filePreview.changed'))).toBeTruthy());
  // 只提示,不自动换内容。
  expect(screen.getByText('v1')).toBeTruthy();

  readTextFilePreview.mockResolvedValue({ success: true, data: 'v2', size: 2 });
  fireEvent.click(screen.getByText(i18n.t('chat.filePreview.changed')));
  await waitFor(() => expect(screen.getByText('v2')).toBeTruthy());
  expect(screen.queryByText(i18n.t('chat.filePreview.changed'))).toBeNull();
});

it('flags the preview when an edit that was already running finishes', async () => {
  // 用户在编辑执行期间打开预览:编辑调用已经在会话里,只有执行结果还没到。
  sessionMessages = [editMessage];
  render(<Harness message={readMessage} />);
  fireEvent.click(screen.getByRole('button'));
  await waitFor(() => expect(document.querySelector('[data-text-lightbox-overlay]')).toBeTruthy());
  expect(screen.queryByText(i18n.t('chat.filePreview.changed'))).toBeNull();

  sessionMessages = [editMessage, editResult];
  act(() => notifyStore?.());
  await waitFor(() => expect(screen.getByText(i18n.t('chat.filePreview.changed'))).toBeTruthy());
});
