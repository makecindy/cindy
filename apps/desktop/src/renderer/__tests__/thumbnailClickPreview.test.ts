// @vitest-environment jsdom
/**
 * attachment-thumb-click (2026-04-19), PR #6196 thread PRRT_kwDOTgdRUs6tKu23.
 * Production entry: mount ComposerAttachments.ThumbnailStrip and click its real
 * preview/remove buttons; observe the selected lightbox's source/path/name or
 * the removal callback without a preview or bubbled click.
 * The removed source guard and existing file-card/lightbox tests never exercised
 * this tray. Minimal inputs: one cached image, one .txt file and their remove
 * buttons. tier: unit (jsdom); no disk, Electron or editor runtime is needed.
 * Restore this module's original path because no existing component harness
 * mounts ThumbnailStrip; do not add these cases to the source-only guard files.
 * Standalone: pnpm exec vitest run src/renderer/__tests__/thumbnailClickPreview.test.ts
 * --maxWorkers=1: 3 passed, 2.04 s wall (Vitest 1.14 s; tests 122 ms), 2026-10-16.
 */
import { createElement } from 'react';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ThumbnailStrip } from '../components/new-chat/ComposerAttachments';
import type { AttachedFile } from '../lib/fileTypes';

// These adapters expose the lightbox boundary's actual props as DOM. Routing,
// preview state and click handling all remain in the real ThumbnailStrip.
vi.mock('@/components/chat/ImageLightbox', async () => {
  const { useContext, useEffect } = await import('react');
  const { AttachmentPreviewOwnerContext } = await import(
    '../components/chat/AttachmentCollectionContext'
  );
  return {
    ImageLightbox: ({ src, onClose, previewOwnerId }: {
      src: string; onClose: () => void; previewOwnerId?: string;
    }) => {
      const owner = useContext(AttachmentPreviewOwnerContext);
      const onActiveIdChange = owner?.onActiveIdChange;
      useEffect(() => {
        if (previewOwnerId) onActiveIdChange?.(previewOwnerId);
      }, [previewOwnerId, onActiveIdChange]);
      const activeOwnerId = owner?.activeId ?? previewOwnerId;
      return createElement(
        'div',
        {
          role: 'dialog',
          'aria-label': 'image preview',
          'data-lightbox-layer': '',
          'data-preview-owner-id': activeOwnerId,
          tabIndex: -1,
        },
        createElement('img', { src, alt: 'preview image' }),
        createElement(
          'button',
          { onClick: () => onActiveIdChange?.('second') },
          'Switch to second image',
        ),
        createElement('button', { onClick: onClose }, 'Close preview'),
      );
    },
  };
});
vi.mock('@/components/chat/TextLightbox', () => ({
  TextLightbox: ({ filePath, fileName, onClose }: {
    filePath: string; fileName: string; onClose: () => void;
  }) => createElement('div', { role: 'dialog', 'aria-label': fileName },
    createElement('output', null, filePath),
    createElement('button', { onClick: onClose }, 'Close preview')),
  // Size formatting is outside this preview-routing regression.
  formatBytes: vi.fn(() => 'fixture size'),
}));
vi.mock('@/components/chat/ImageHoverPreview', () => ({ ImageHoverPreview: () => null }));
vi.mock('../components/new-chat/AttachmentTypeThumb', () => ({ AttachmentTypeThumb: () => null }));
vi.mock('@/hooks/useStableTranslation', () => ({
  useStableTranslation: () => ({ t: (key: string) => key }),
}));
// Keep the real shouldOpenTextLightbox extension decision, replacing only its
// external error/remote-opening dependencies (unused for the .txt fixture).
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('@/lib/remoteFileOpen', () => ({ openRemoteChatFile: vi.fn() }));

const image: AttachedFile = {
  id: 'first', name: 'shot.png', path: 'clipboard://shot.png', ext: '.png',
  size: 20, category: 'image', mimeType: 'image/png', url: 'cindy-media://blobs/shot.png',
};
const secondImage: AttachedFile = {
  ...image, id: 'second', name: 'second.png', path: 'clipboard://second.png',
  url: 'cindy-media://blobs/second.png',
};
const text: AttachedFile = {
  id: 'text', name: 'notes.txt', path: resolve('preview-fixture', 'notes.txt'), ext: '.txt',
  size: 10, category: 'text', mimeType: 'text/plain',
};

afterEach(cleanup);

it('opens the clicked image in ImageLightbox with its original source', () => {
  render(createElement(ThumbnailStrip, {
    attachments: [image, text], onRemove: vi.fn(), onUpdate: vi.fn(),
  }));
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Preview shot.png' }));
  const preview = screen.getByRole('dialog', { name: 'image preview' });
  expect(within(preview).getByAltText('preview image').getAttribute('src')).toBe(image.url);
  expect(screen.queryByRole('dialog', { name: text.name })).toBeNull();
  fireEvent.click(within(preview).getByRole('button', { name: 'Close preview' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('opens the clicked text file in TextLightbox with the matching path and name', async () => {
  render(createElement(ThumbnailStrip, {
    attachments: [image, text], onRemove: vi.fn(), onUpdate: vi.fn(),
  }));
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Preview notes.txt' }));
  const preview = await screen.findByRole('dialog', { name: text.name });
  expect(within(preview).getByRole('status').textContent).toBe(text.path);
  expect(screen.queryByRole('dialog', { name: 'image preview' })).toBeNull();
  fireEvent.click(within(preview).getByRole('button', { name: 'Close preview' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('removes image and text attachments without bubbling or opening a preview', async () => {
  const onRemove = vi.fn();
  const onTrayClick = vi.fn();
  render(createElement('div', { onClick: onTrayClick },
    createElement(ThumbnailStrip, { attachments: [image, text], onRemove, onUpdate: vi.fn() })));
  for (const file of [image, text]) {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: `Remove ${file.name}` }));
    });
    expect(onRemove).toHaveBeenLastCalledWith(file.id);
    expect(onTrayClick).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  }
  expect(onRemove).toHaveBeenCalledTimes(2);
});

// 测试价值
// - 生产入口与可观察结果：ThumbnailStrip 的缩略图点击与集合切换；同一附件只挂载一个
//   可写图片预览，点击已归属附件会聚焦并抬高现有浮窗。
// - Bug／规则依据：#11952 round 11 review PRRT_kwDOTgdRUs66qFSl；
//   docs/dev-rules/engineering-conventions.md §3.2。
// - 现有覆盖缺口：既有用例只验证单张缩略图打开/关闭，没有集合切到 B 再点击 B 的路径。
// - 最小失败输入：两张托盘图片，从 A 打开集合并切到 B，再点击 B 缩略图；修复前出现两个 B 编辑器。
// - tier：unit；复用现有 jsdom 文件，定向套件单独运行低于 5s。
it('keeps one writable preview when a collection switches to the clicked attachment', () => {
  render(createElement(ThumbnailStrip, {
    attachments: [image, secondImage], onRemove: vi.fn(), onUpdate: vi.fn(),
  }));
  fireEvent.click(screen.getByRole('button', { name: 'Preview shot.png' }));
  const preview = screen.getByRole('dialog', { name: 'image preview' });
  expect(preview.getAttribute('data-preview-owner-id')).toBe('first');

  fireEvent.click(within(preview).getByRole('button', { name: 'Switch to second image' }));
  const secondPreview = screen.getByRole('dialog', { name: 'image preview' });
  expect(secondPreview.getAttribute('data-preview-owner-id')).toBe('second');

  fireEvent.click(screen.getByRole('button', { name: 'Preview second.png' }));
  expect(screen.getAllByRole('dialog', { name: 'image preview' })).toHaveLength(1);
  expect(document.activeElement).toBe(secondPreview);
});
