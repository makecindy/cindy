// @vitest-environment jsdom
/**
 * #13676:远程任务交付的图片 / 文件在操作端取不到时,界面必须说明原因。
 * ---------------------------------------------------------------------------
 * 取件链路本身(device-link 经 OSS 中转、SSH 经 file-service)在改动前已经就位,
 * 但「取不到」这件事对用户是**无声**的:
 *   - SSH 远端工作目录之外的图片:渲染期就没有可用地址,`<img>` 拿不到 src,界面只留
 *     一个永远转圈的加载占位——既看不到图,也拿不到任何原因说明;
 *   - device-link 的远程图片取回失败:占位只说「图片暂时无法显示」,没说明字节在
 *     另一台机器上,用户会误以为文件损坏或链接写错;
 *   - SSH 工作目录之外的显式链接:点击只得到笼统的「文件不可用」,不说是工作目录
 *     之外,用户不知道文件在远端、更不知道该怎么拿到它。
 *
 * 最小失败输入:
 *   - `![截图](/remote/outside/design.png)`(ssh origin,workingDir=/remote/project);
 *   - `![preview](cindy-media://blobs/<64 hex>.png)`(device origin,远程取回失败);
 *   - `[查看报告](/remote/outside/report.md)`(ssh origin,stat 回 nonfile)。
 *
 * tier: DOM/单测(真实 MarkdownRenderer 入口 + 合成 IPC),不触网络与真实设备。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { Tooltip } from '@/components/ui/tooltip';
import { i18n } from '@/i18n';
import { toast } from '@/lib/toast';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { ChatSessionFileProvider } from '../ChatSessionFileContext';
import type { SessionFileOrigin } from '@/lib/sessionFileOrigin';

const label = (key: string) => i18n.t(key);
const chatStat = vi.fn();

function renderMarkdown(content: string, origin: SessionFileOrigin, workingDir: string) {
  return render(
    <MemoryRouter>
      <Tooltip.Provider>
        <ChatSessionFileProvider value={{ sessionId: 's1', workingDir, origin }}>
          <MarkdownRenderer content={content} workingDir={workingDir} currentSessionId="s1" />
        </ChatSessionFileProvider>
      </Tooltip.Provider>
    </MemoryRouter>,
  );
}

function renderStreamingMarkdown(content: string, origin: SessionFileOrigin, workingDir: string) {
  return render(
    <MemoryRouter>
      <Tooltip.Provider>
        <ChatSessionFileProvider value={{ sessionId: 's1', workingDir, origin }}>
          <MarkdownRenderer
            content={content}
            workingDir={workingDir}
            currentSessionId="s1"
            isStreaming
          />
        </ChatSessionFileProvider>
      </Tooltip.Provider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  chatStat.mockReset().mockResolvedValue({ verdict: 'nonfile' });
  vi.stubGlobal('electronAPI', {
    fileBrowser: { chatStat },
    readCachedImageAsBase64: vi.fn().mockResolvedValue({ base64: '', mimeType: 'image/png' }),
    readImageBytes: vi.fn().mockResolvedValue({ base64: '', mimeType: 'image/png' }),
    copyMediaToClipboard: vi.fn().mockResolvedValue({ success: true }),
    showItemInFolder: vi.fn().mockResolvedValue({ success: true }),
    saveMediaAs: vi.fn().mockResolvedValue({ canceled: false }),
    openMediaWithDefaultApp: vi.fn().mockResolvedValue(undefined),
  });
  vi.spyOn(toast, 'error').mockImplementation(() => 'error');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('remote references that cannot be fetched', () => {
  it('explains that an SSH image outside the workdir is not reachable here', async () => {
    renderMarkdown(
      '![截图](/remote/outside/design.png)',
      { kind: 'ssh', remoteHostId: 'host-1' },
      '/remote/project',
    );
    expect(await screen.findByText(label('chat.remoteFile.outsideWorkdir'))).toBeTruthy();
    // 不再留一个永远转圈的加载占位(用户既看不到图,也拿不到原因)。
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('explains that a device image lives on another device when the fetch fails', async () => {
    renderMarkdown(
      `![preview](cindy-media://blobs/${'a'.repeat(64)}.png)`,
      { kind: 'device', deviceId: 'dev-1' },
      '/work',
    );
    const img = await screen.findByAltText('preview');
    expect(img.getAttribute('src')).toMatch(/^cindy-remote-media:/);
    fireEvent.error(img);
    expect(await screen.findByText(label('chat.imageMissing.remote'))).toBeTruthy();
  });

  it('names the workdir boundary when an SSH file link outside it is clicked', async () => {
    renderMarkdown(
      '[查看报告](/remote/outside/report.md)',
      { kind: 'ssh', remoteHostId: 'host-1' },
      '/remote/project',
    );
    const link = await screen.findByText('查看报告');
    fireEvent.click(link);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(label('chat.remoteFile.outsideWorkdir')),
    );
    expect(toast.error).not.toHaveBeenCalledWith(label('chat.markdownRenderer.fileUnavailable'));
  });

  it('keeps the retrying state instead of declaring a remote image unavailable', async () => {
    // 回复还在输出时图片可能只是没写完:此时界面仍在自动重试,结论还没定,
    // 不能先说「在远程设备上,本端无法显示」。
    renderStreamingMarkdown(
      `![preview](cindy-media://blobs/${'b'.repeat(64)}.png)`,
      { kind: 'device', deviceId: 'dev-1' },
      '/work',
    );
    const img = await screen.findByAltText('preview');
    fireEvent.error(img);
    expect(await screen.findByText(label('chat.imageMissing.loading'))).toBeTruthy();
    expect(screen.queryByText(label('chat.imageMissing.remote'))).toBeNull();
  });
});
