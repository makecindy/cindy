// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果：`useBotGroupRemoteMedia`(群聊时间线取图入口)。离开群聊再进入时，
 *   同一张缩略图直接用手机本地文件显示，不再向电脑取件；换账号不命中上一账号的本地副本。
 * - Bug／规则依据：用户 2026-11-28 反馈群聊图片慢；群聊队列只有内存缓存，离开即清空，
 *   每次进群都让电脑重新压图并经中转回传（docs/product-rules/bot-group-chat.md §8）。
 * - 现有覆盖缺口：会话页的磁盘缓存没有单测入口；群聊相关测试都把本 hook 整个 mock 掉。
 * - 最小失败输入：同一电脑、同一 `xdt-image://` 地址，挂载→取件→卸载→重新挂载→再取件；
 *   修复前第二次仍调用电脑取件（fetch 计数 2）。
 * - tier：unit（内存版磁盘 IO 与假传输，进程内依赖注入）。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { RemoteMediaDiskCacheIO } from '@/session/remoteMediaDiskCache';

const h = vi.hoisted(() => {
  const files = new Map<string, number>();
  let indexText: string | null = null;
  const io: RemoteMediaDiskCacheIO = {
    ensureDir: () => undefined,
    readIndexText: async () => indexText,
    writeIndexText: (text: string) => { indexText = text; },
    fileExists: (name) => files.has(name),
    fileUri: (name) => `file:///cache/remote-media/${name}`,
    deleteFile: (name) => { files.delete(name); },
    download: async (_url, name) => { files.set(name, 1000); return 1000; },
    writeFileBase64: (name, base64) => { const size = Math.floor(base64.length * 3 / 4); files.set(name, size); return size; },
    listFiles: () => [...files.keys()],
  };
  return {
    io,
    userId: 'owner-a',
    fetch: vi.fn(async () => ({ ossKey: '', mimeType: 'image/webp', size: 3, inlineBase64: 'AAAA' })),
  };
});

vi.mock('expo-file-system', () => ({ Paths: { availableDiskSpace: 1e12 } }));
vi.mock('@/session/remoteMediaDiskCacheExpo', () => ({ createExpoRemoteMediaDiskCacheIO: () => h.io }));
vi.mock('@/session/sentAttachmentThumbStore', () => ({ resolveSentAttachmentThumb: async () => null }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: h.userId }, apiFetch: vi.fn(async () => ({})) }) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ invoke: vi.fn() }) }));
vi.mock('@/device-link/mobileMakerTransport', () => ({ createMobileMakerTransport: () => ({ fetchRemoteMedia: h.fetch }) }));

import { useBotGroupRemoteMedia } from '@/session/useBotGroupRemoteMedia';
import type { ResolveRemoteMediaFn } from '@/session/remoteMedia';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; });

async function enterGroup(): Promise<ResolveRemoteMediaFn> {
  let resolve: ResolveRemoteMediaFn | null = null;
  function Probe() { resolve = useBotGroupRemoteMedia('computer-1'); return null; }
  act(() => { (root ??= createRoot(document.createElement('div'))).render(createElement(Probe)); });
  return resolve!;
}
function leaveGroup() { act(() => root?.unmount()); root = null; }

const thumb = { kind: 'image' as const, url: 'xdt-image://group/photo.png', previewable: false, thumbnail: true };

it('shows a group thumbnail from the phone after leaving and re-entering, scoped to the account', async () => {
  const first = await (await enterGroup())(thumb);
  expect(h.fetch).toHaveBeenCalledTimes(1);
  expect(first.url.startsWith('file:///cache/remote-media/')).toBe(true);
  leaveGroup();

  const again = await (await enterGroup())(thumb);
  expect(h.fetch).toHaveBeenCalledTimes(1);
  expect(again.url).toBe(first.url);
  leaveGroup();

  h.userId = 'owner-b';
  await (await enterGroup())(thumb);
  expect(h.fetch).toHaveBeenCalledTimes(2);
});
