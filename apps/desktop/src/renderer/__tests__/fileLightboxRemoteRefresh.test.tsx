// @vitest-environment jsdom
/**
 * issue #12851 — 远程文件的「文件已变更」刷新:要重新取回文件,并且取回不到最新时
 * 不能把提示吃掉。
 *
 * 四类用户可观察的行为:
 *   1. 点右上角「文件已变更」后,面板里显示的是**重新取回**的新副本,不是上一次下载
 *      到本机的旧副本。
 *   2. 远端不可达、只拿到历史副本(stale)时:面板上标出「历史副本」,「文件已变更」
 *      提示留着 —— 用户还能再点一次,不能被这次失败的刷新吃掉。
 *   3. 取回彻底失败时:提示同样留着(旧副本还在,但用户得知道它不是最新的)。
 *   4. 取回拿到最新副本时:提示才收起。
 *
 * 走的都是生产入口:真实的 FilePreviewLightboxHost(持有「文件已变更」提示的那一层)
 * → 真实的 TextLightbox → 真实的 FileLightbox → 真实的 fetchChatFileToCache
 * (window.electronAPI.fileBrowser.chatFetch)→ 真实的 useFileContent 读取缓存副本。
 *
 * 测试价值
 * - 生产入口与可观察结果:真实的宿主 + 真实的「文件已变更」按钮。用户可观察到的是:
 *   面板里的内容是不是新副本、刷新没拿到最新时提示还在不在。
 * - Bug／规则依据:issue #12851 的 PR review 意见 —— stale 副本被当成成功(提示被
 *   清掉)、取回失败被静默吞掉,用户只能看着旧字节且没有任何提示。
 * - 现有覆盖缺口:没有覆盖「刷新失败 / 拿到历史副本」时提示是否留着的用例。
 * - 最小失败输入:远程来源 + 点一次「文件已变更」+ chatFetch 返回 stale(或失败)。
 * - tier:unit(jsdom + testing-library,走真实组件入口;正文渲染用的 FileBodyView 按
 *   仓库既有做法换成桩 —— 被测的是「取回 → 重读 → 提示去留」这条链路,不是正文怎么排版)。
 * - 实测耗时:单文件 vitest run 用时 <1s(见 PR 正文的命令输出)。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ChatSessionFileProvider } from '@/components/chat/ChatSessionFileContext';
import {
  FileChangedBadge,
  FilePreviewLightboxProvider,
  useFilePreviewLightbox,
} from '@/components/chat/FilePreviewLightboxHost';
import { FileLightbox } from '@/components/chat/FileLightbox';
import { i18n } from '@/i18n';
import { makerChatStore, type ChatMessage } from '@/lib/makerChatStore';

vi.mock('@/features/cc-agent/workdir-browse/FileBodyView', () => ({
  FileBodyView: ({ content }: { content: { kind: string; content?: string } }) => (
    <pre data-testid="file-body">{content.kind === 'text' ? content.content : ''}</pre>
  ),
}));
// CodeMirror / Markdown 渲染引擎在 jsdom 里跑不动,按仓库既有做法换成只渲染内容的桩。
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

const SESSION_ID = 'remote-session';
const WORKDIR = '/remote/workdir';
const REMOTE_FILE = '/remote/workdir/notes.txt';
// 二进制文件走 FileLightbox(文稿预览那条链路的 stale 处理是另一处)。
const REMOTE_PDF = '/remote/workdir/report.pdf';
// 取回后的本地副本路径:两次取回是同一个路径(内容不同),这样「有没有重读」
// 才测得到 —— 换了路径的话换路径本身就会触发重读。
const CACHE_PATH = '/tmp/cindy-cache/notes.txt';

const chatFetch = vi.fn();
const readFile = vi.fn();

let cachedContent = 'v1';
let sessionMessages: ChatMessage[] = [];
let notifyStore: (() => void) | null = null;

function Harness() {
  const [refreshToken, setRefreshToken] = useState(0);
  return (
    <ChatSessionFileProvider
      value={{
        sessionId: SESSION_ID,
        workingDir: WORKDIR,
        origin: { kind: 'device', deviceId: 'device-1' },
      }}
    >
      <FileLightbox
        filePath={REMOTE_FILE}
        onClose={() => {}}
        refreshToken={refreshToken}
        changedBadge={<FileChangedBadge onClick={() => setRefreshToken((token) => token + 1)} />}
      />
    </ChatSessionFileProvider>
  );
}

/** 走宿主那一层:AgentActionRow 用的就是 open() 这个入口。 */
function OpenPreview({ filePath }: { filePath: string }) {
  const previewHost = useFilePreviewLightbox();
  useEffect(() => {
    previewHost?.open({ kind: 'document', sessionId: SESSION_ID, filePath });
  }, [previewHost, filePath]);
  return null;
}

function HostHarness() {
  return (
    <ChatSessionFileProvider
      value={{
        sessionId: SESSION_ID,
        workingDir: WORKDIR,
        origin: { kind: 'device', deviceId: 'device-1' },
      }}
    >
      <FilePreviewLightboxProvider>
        <OpenPreview filePath={REMOTE_PDF} />
      </FilePreviewLightboxProvider>
    </ChatSessionFileProvider>
  );
}

const editMessage: ChatMessage = {
  clientId: 'tool-edit',
  role: 'tool_use',
  content: '',
  toolUseId: 'tu-edit',
  toolName: 'Edit',
  toolInput: { file_path: REMOTE_PDF },
};

// 编辑执行完成的结果行:文件真的写完了,这时才提示「文件已变更」。
const editResult: ChatMessage = {
  clientId: 'tool-edit-result',
  role: 'tool_result',
  content: '',
  toolUseId: 'tu-edit',
  toolName: 'Edit',
};

beforeEach(() => {
  cachedContent = 'v1';
  sessionMessages = [];
  notifyStore = null;
  chatFetch.mockReset();
  chatFetch.mockResolvedValue({ ok: true, cachePath: CACHE_PATH, size: 2, stale: false });
  readFile.mockReset();
  readFile.mockImplementation(async ({ relPath }: { relPath: string }) => ({
    ok: true,
    data: {
      content: cachedContent,
      relPath,
      size: cachedContent.length,
      mtimeMs: 1,
      truncated: false,
    },
  }));
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      platform: 'darwin',
      fileBrowser: {
        chatFetch,
        readFile,
        onEvent: () => () => {},
      },
    },
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

it('re-fetches the remote file when the preview is refreshed', async () => {
  render(<Harness />);
  await waitFor(() => expect(screen.getByTestId('file-body').textContent).toBe('v1'));
  expect(chatFetch).toHaveBeenCalledTimes(1);

  // 远端文件被改了。
  cachedContent = 'v2';
  fireEvent.click(screen.getByRole('button', { name: /文件已变更|File changed/ }));

  // 重新取回 + 重读副本之后,面板里是新内容。
  await waitFor(() => expect(screen.getByTestId('file-body').textContent).toBe('v2'));
  expect(chatFetch).toHaveBeenCalledTimes(2);
});

it('keeps the changed prompt and marks the copy as stale when the refetch only reaches a cached copy', async () => {
  render(<HostHarness />);
  await waitFor(() => expect(screen.getByTestId('file-body').textContent).toBe('v1'));

  // Agent 改完了正在看的文件 → 提示出现。
  sessionMessages = [editMessage, editResult];
  act(() => notifyStore?.());
  await waitFor(() => expect(screen.getByText(i18n.t('chat.filePreview.changed'))).toBeTruthy());

  // 远端不可达:只拿到历史副本。这次刷新不算成功 —— 提示留着,用户还能再点一次。
  // 缓存副本的内容换一下当探针:刷新要把副本重读一遍,「读过了」在 DOM 上看得见。
  cachedContent = 'v2';
  chatFetch.mockResolvedValue({ ok: true, cachePath: CACHE_PATH, size: 2, stale: true });
  fireEvent.click(screen.getByText(i18n.t('chat.filePreview.changed')));
  // 等副本重读完(刷新流程走完),这时才断言提示还在。
  await waitFor(() => expect(screen.getByTestId('file-body').textContent).toBe('v2'));

  expect(screen.getByText(i18n.t('chat.filePreview.changed'))).toBeTruthy();
  expect(screen.getByText(i18n.t('chat.remoteFile.staleBadge'))).toBeTruthy();
});

it('keeps the changed prompt when the refetch fails', async () => {
  render(<HostHarness />);
  await waitFor(() => expect(screen.getByTestId('file-body').textContent).toBe('v1'));

  sessionMessages = [editMessage, editResult];
  act(() => notifyStore?.());
  await waitFor(() => expect(screen.getByText(i18n.t('chat.filePreview.changed'))).toBeTruthy());

  // 取回失败:面板上还是旧副本,提示不能被吃掉(用户得知道没刷成功,还能再点一次)。
  chatFetch.mockResolvedValue({ ok: false, code: 'FETCH_FAILED' });
  fireEvent.click(screen.getByText(i18n.t('chat.filePreview.changed')));
  // 取回失败会被标成「历史副本」:等这个标记出现,说明这次刷新已经走完。
  await waitFor(() => expect(screen.getByText(i18n.t('chat.remoteFile.staleBadge'))).toBeTruthy());

  expect(screen.getByText(i18n.t('chat.filePreview.changed'))).toBeTruthy();
});

it('clears the changed prompt once a fresh copy is fetched', async () => {
  render(<HostHarness />);
  await waitFor(() => expect(screen.getByTestId('file-body').textContent).toBe('v1'));

  sessionMessages = [editMessage, editResult];
  act(() => notifyStore?.());
  await waitFor(() => expect(screen.getByText(i18n.t('chat.filePreview.changed'))).toBeTruthy());

  cachedContent = 'v2';
  fireEvent.click(screen.getByText(i18n.t('chat.filePreview.changed')));
  await waitFor(() => expect(chatFetch).toHaveBeenCalledTimes(2));

  await waitFor(() => expect(screen.queryByText(i18n.t('chat.filePreview.changed'))).toBeNull());
  expect(screen.getByTestId('file-body').textContent).toBe('v2');
});
