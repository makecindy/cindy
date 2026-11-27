import { describe, expect, it, vi } from 'vitest';

vi.mock('@/i18n', () => ({
  i18n: {
    resolvedLanguage: 'en',
    language: 'en',
    t: (key: string) => key,
  },
}));

import { buildFileBrowserGridItems } from '@/session/fileBrowserGrid';

const entry = (size: number) => [{
  name: 'archive.zip',
  relPath: 'archive.zip',
  type: 'file' as const,
  size,
  mtimeMs: 0,
}];

describe('mobile file browser grid meta label', () => {
  it('uses the shared byte formatter so the list matches the preview', () => {
    // 1048575 B 属于 MB 档:列表里若自己按原始字节数分档,会显示 "1024.0 KB",
    // 而点进预览走共享 formatter 显示 "1.0 MB",两处对不上。
    expect(buildFileBrowserGridItems(entry(1024 * 1024 - 1), 'name', 0)[0].metaLabel).toBe('1.0 MB');
    expect(buildFileBrowserGridItems(entry(18700), 'name', 0)[0].metaLabel).toBe('18.3 KB');
    expect(buildFileBrowserGridItems(entry(1024), 'name', 0)[0].metaLabel).toBe('1.0 KB');
  });
});
