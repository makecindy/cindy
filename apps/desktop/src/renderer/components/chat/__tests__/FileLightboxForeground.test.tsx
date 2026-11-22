// @vitest-environment jsdom
/**
 * FileLightbox 前景层登记。
 *
 * - 生产入口与可观察结果：真实 `FileLightbox` / `PreviewHeader` 挂载后，根节点注册
 *   `data-lightbox-layer` 并被标记为当前激活层，Esc 与快捷键归属与图片预览一致。
 * - Bug／规则依据：#11952 review 指出文件类模态预览（ZIP 等）缺少 layer 标记，
 *   打开图片浮窗后再开文件预览会误把旧图片判为前景。
 * - 现有覆盖缺口：VideoLightbox 已有 layer 测试，FileLightbox 的无渲染文件路径没有覆盖。
 * - 最小失败输入：本地 `.zip` 文件路径 + 二进制内容替身；只 stub 文件读取与正文组件。
 * - tier：unit（进程内 DOM，无真实 I/O）。
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | { defaultValue?: string }) =>
      typeof fallback === 'string' ? fallback : (fallback?.defaultValue ?? key),
  }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));
vi.mock('@/features/cc-agent/workdir-browse/hooks/useFileContent', () => ({
  useFileContent: () => ({
    content: { kind: 'binary', stat: { relPath: 'archive.zip' } },
  }),
}));
vi.mock('@/features/cc-agent/workdir-browse/FileBodyView', () => ({
  FileBodyView: () => null,
}));

import { ChatSessionFileProvider } from '../ChatSessionFileContext';
import { FileLightbox } from '../FileLightbox';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('registers an unrenderable file preview as the active foreground layer', () => {
  render(
    <ChatSessionFileProvider
      value={{ sessionId: 'task', workingDir: '/repo', origin: { kind: 'local' } }}
    >
      <FileLightbox filePath="/repo/archive.zip" onClose={vi.fn()} />
    </ChatSessionFileProvider>,
  );
  const foreground = document.querySelector<HTMLElement>(
    '[data-lightbox-layer][data-preview-active]',
  );
  expect(foreground).not.toBeNull();
  expect(foreground?.getAttribute('role')).toBe('dialog');
});
