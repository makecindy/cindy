// @vitest-environment jsdom
/**
 * issue #12851 — 远程文件的「文件已变更」刷新要重新取回文件,不能只重读旧副本。
 *
 * 可观察行为:远程(device-link / SSH)会话里打开的文件预览,点右上角「文件已变更」后,
 * 面板里显示的是**重新取回**的新副本,不是上一次下载到本机的旧副本。
 *
 * 走的都是生产入口:真实的 FileLightbox(远程来源)→ 真实的 fetchChatFileToCache
 * (window.electronAPI.fileBrowser.chatFetch)→ 真实的 useFileContent 读取缓存副本。
 *
 * 测试价值
 * - 生产入口与可观察结果:渲染真实的 FileLightbox,给一个远程来源,点真实的
 *   「文件已变更」按钮。用户可观察到的是:面板里的内容是不是新副本。
 * - Bug／规则依据:issue #12851 的 PR review 意见 —— 刷新只重读已下载的副本,远程文件
 *   仍是旧版本,只能关掉重开。
 * - 现有覆盖缺口:没有覆盖 FileLightbox 远程刷新链路(取回 → 读副本)的测试。
 * - 最小失败输入:远程来源 + refreshToken 递增一次。
 * - tier:unit(jsdom + testing-library,走真实组件入口;正文渲染用的 FileBodyView 按
 *   仓库既有做法换成桩 —— 被测的是「取回 → 重读」这条链路,不是正文怎么排版)。
 * - 实测耗时:单文件 vitest run 用时 <1s(见 PR 正文的命令输出)。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ChatSessionFileProvider } from '@/components/chat/ChatSessionFileContext';
import { FileChangedBadge } from '@/components/chat/FilePreviewLightboxHost';
import { FileLightbox } from '@/components/chat/FileLightbox';
import '@/i18n';

vi.mock('@/features/cc-agent/workdir-browse/FileBodyView', () => ({
  FileBodyView: ({ content }: { content: { kind: string; content?: string } }) => (
    <pre data-testid="file-body">{content.kind === 'text' ? content.content : ''}</pre>
  ),
}));

const SESSION_ID = 'remote-session';
const WORKDIR = '/remote/workdir';
const REMOTE_FILE = '/remote/workdir/notes.txt';
// 取回后的本地副本路径:两次取回是同一个路径(内容不同),这样「有没有重读」
// 才测得到 —— 换了路径的话换路径本身就会触发重读。
const CACHE_PATH = '/tmp/cindy-cache/notes.txt';

const chatFetch = vi.fn();
const readFile = vi.fn();

let cachedContent = 'v1';

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

beforeEach(() => {
  cachedContent = 'v1';
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
});

afterEach(() => {
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
