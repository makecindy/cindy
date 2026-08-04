import { beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

const storage = vi.hoisted(() => new Map<string, string>());

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      storage.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      storage.delete(key);
    }),
  },
}));

import {
  __testing,
  applySentAttachmentThumbOverlay,
  ensureSentAttachmentThumbsHydrated,
  getSentAttachmentThumbUri,
  getSentAttachmentThumbsVersion,
  registerSentAttachmentThumb,
  subscribeSentAttachmentThumbs,
  type SentAttachmentThumbFsDeps,
} from '@/session/sentAttachmentThumbStore';

const DOC_DIR = 'file:///doc/';
const THUMB_DIR = `${DOC_DIR}${__testing.thumbDirName}`;
const OSS_REF = 'cindy-oss-attach://m/abc123';
const OSS_REF_2 = 'cindy-oss-attach://m/def456';

function makeFsDeps(overrides: Partial<SentAttachmentThumbFsDeps> = {}) {
  const copies: Array<{ from: string; to: string }> = [];
  const removed: string[] = [];
  let dirFiles: string[] = [];
  const deps: SentAttachmentThumbFsDeps = {
    documentDirectory: async () => DOC_DIR,
    copy: async (from, to) => {
      copies.push({ from, to });
    },
    remove: async (uri) => {
      removed.push(uri);
    },
    readDirectory: async () => dirFiles,
    makeDirectory: async () => undefined,
    statSize: async () => 1000,
    ...overrides,
  };
  return {
    deps,
    copies,
    removed,
    setDirFiles(files: string[]) {
      dirFiles = files;
    },
  };
}

beforeEach(() => {
  __testing.reset();
  storage.clear();
});

describe('sentAttachmentThumbStore', () => {
  it('register 拷贝文件进自有目录并可同步查询;版本号通知订阅者', async () => {
    const { deps, copies } = makeFsDeps();
    const versions: number[] = [];
    const unsubscribe = subscribeSentAttachmentThumbs(() => versions.push(getSentAttachmentThumbsVersion()));

    await registerSentAttachmentThumb(OSS_REF, 'file:///cache/upload-a.jpg', deps);

    expect(copies).toHaveLength(1);
    expect(copies[0]?.from).toBe('file:///cache/upload-a.jpg');
    expect(copies[0]?.to.startsWith(`${THUMB_DIR}/thumb-`)).toBe(true);
    expect(copies[0]?.to.endsWith('.jpg')).toBe(true);

    const uri = getSentAttachmentThumbUri(OSS_REF);
    expect(uri).toBe(copies[0]?.to);
    // hydrate + register 各 bump 一次,末次版本与当前一致即可。
    expect(versions.length).toBeGreaterThan(0);
    expect(versions.at(-1)).toBe(getSentAttachmentThumbsVersion());
    unsubscribe();
  });

  it('register 持久化映射(相对文件名,不含容器绝对路径)', async () => {
    const { deps } = makeFsDeps();
    await registerSentAttachmentThumb(OSS_REF, 'file:///cache/upload-a.png', deps);
    await __testing.flushPersist();

    const raw = storage.get(__testing.storageKey);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as Array<{ ossRef: string; file: string; at: number }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.ossRef).toBe(OSS_REF);
    expect(parsed[0]?.file.startsWith('thumb-')).toBe(true);
    expect(parsed[0]?.file.endsWith('.png')).toBe(true);
    // iOS 容器路径会随更新变化,持久化的必须是相对文件名。
    expect(parsed[0]?.file.includes('/')).toBe(false);
  });

  it('桌面本地媒体引用(粘贴先进媒体总仓)同样留底,不必等远端取件', async () => {
    // 粘贴图片的字节会先进媒体总仓,附件 url 是 cindy-media://blobs/<指纹>,手机本地没有
    // 对应文件。原先只认 xdt-oss-attach://,这类图一律不留底 → 发出后气泡只能画空占位格。
    const mediaRef = 'cindy-media://blobs/8ae715a364e0f5ab.png';
    const { deps, copies } = makeFsDeps();
    await registerSentAttachmentThumb(mediaRef, 'file:///cache/pasted.png', deps);
    expect(copies).toHaveLength(1);
    expect(getSentAttachmentThumbUri(mediaRef)).toContain('sent-attachment-thumbs/');
  });

  it('非兜底引用 / 空 sourceUri / 重复引用 / 超大文件不注册', async () => {
    const { deps, copies } = makeFsDeps();
    await registerSentAttachmentThumb('https://example.com/a.jpg', 'file:///cache/a.jpg', deps);
    await registerSentAttachmentThumb(undefined, 'file:///cache/a.jpg', deps);
    await registerSentAttachmentThumb(OSS_REF, '', deps);
    expect(copies).toHaveLength(0);

    await registerSentAttachmentThumb(OSS_REF, 'file:///cache/a.jpg', deps);
    expect(copies).toHaveLength(1);
    // 同一引用重复注册 no-op(不重复拷贝)。
    await registerSentAttachmentThumb(OSS_REF, 'file:///cache/other.jpg', deps);
    expect(copies).toHaveLength(1);

    // 超过单文件上限的不做兜底(gif / 原样直传的大文件)。
    const big = makeFsDeps({ statSize: async () => __testing.maxSourceBytes + 1 });
    await registerSentAttachmentThumb(OSS_REF_2, 'file:///cache/huge.gif', big.deps);
    expect(big.copies).toHaveLength(0);
    expect(getSentAttachmentThumbUri(OSS_REF_2)).toBeNull();
  });

  it('拷贝失败静默:不写映射、不抛错', async () => {
    const { deps } = makeFsDeps({
      copy: async () => {
        throw new Error('disk full');
      },
    });
    await expect(registerSentAttachmentThumb(OSS_REF, 'file:///cache/a.jpg', deps)).resolves.toBeUndefined();
    expect(getSentAttachmentThumbUri(OSS_REF)).toBeNull();
  });

  it('超过条目上限时 LRU 淘汰最老条目并删除其文件', async () => {
    const { deps, removed } = makeFsDeps();
    for (let index = 0; index < __testing.maxEntries + 1; index += 1) {
      await registerSentAttachmentThumb(`cindy-oss-attach://m/ref-${index}`, `file:///cache/${index}.jpg`, deps);
    }
    expect(getSentAttachmentThumbUri('cindy-oss-attach://m/ref-0')).toBeNull();
    expect(getSentAttachmentThumbUri(`cindy-oss-attach://m/ref-${__testing.maxEntries}`)).not.toBeNull();
    expect(removed).toHaveLength(1);
    expect(removed[0]?.startsWith(`${THUMB_DIR}/thumb-`)).toBe(true);
  });

  it('hydrate 回填持久化映射,清过期条目与目录孤儿文件', async () => {
    const now = Date.now();
    storage.set(__testing.storageKey, JSON.stringify([
      { ossRef: OSS_REF, file: 'thumb-fresh.jpg', at: now - 1000 },
      { ossRef: OSS_REF_2, file: 'thumb-stale.jpg', at: now - __testing.maxAgeMs - 1000 },
    ]));
    const { deps, removed, setDirFiles } = makeFsDeps();
    setDirFiles(['thumb-fresh.jpg', 'thumb-stale.jpg', 'thumb-orphan.jpg']);

    await ensureSentAttachmentThumbsHydrated(deps);

    expect(getSentAttachmentThumbUri(OSS_REF)).toBe(`${THUMB_DIR}/thumb-fresh.jpg`);
    expect(getSentAttachmentThumbUri(OSS_REF_2)).toBeNull();
    // 过期条目的文件与目录孤儿统一清理。
    expect(removed.sort()).toEqual([
      `${THUMB_DIR}/thumb-orphan.jpg`,
      `${THUMB_DIR}/thumb-stale.jpg`,
    ]);
    // 过期裁剪后的映射写回持久层。
    await __testing.flushPersist();
    const parsed = JSON.parse(storage.get(__testing.storageKey)!) as Array<{ ossRef: string }>;
    expect(parsed.map((entry) => entry.ossRef)).toEqual([OSS_REF]);
  });

  it('损坏的持久化内容按空映射处理', async () => {
    storage.set(__testing.storageKey, 'not-json{');
    const { deps } = makeFsDeps();
    await ensureSentAttachmentThumbsHydrated(deps);
    expect(getSentAttachmentThumbUri(OSS_REF)).toBeNull();
  });

  it('applySentAttachmentThumbOverlay 只替换命中的 cindy-oss-attach:// 图片附件', async () => {
    const { deps } = makeFsDeps();
    await registerSentAttachmentThumb(OSS_REF, 'file:///cache/a.jpg', deps);
    const localUri = getSentAttachmentThumbUri(OSS_REF)!;

    const hit = applySentAttachmentThumbOverlay({
      kind: 'image', name: 'a.jpg', uri: OSS_REF, previewable: false,
    });
    expect(hit.uri).toBe(localUri);
    expect(hit.previewable).toBe(true);
    expect(hit.name).toBe('a.jpg');

    // 未命中 / 已可预览 / 非图片 / 非 oss 引用:原样返回(同一引用)。
    const miss = { kind: 'image', name: 'b.jpg', uri: OSS_REF_2, previewable: false };
    expect(applySentAttachmentThumbOverlay(miss)).toBe(miss);
    const already = { kind: 'image', name: 'c.jpg', uri: 'https://x/c.jpg', previewable: true };
    expect(applySentAttachmentThumbOverlay(already)).toBe(already);
    const file = { kind: 'file', name: 'd.pdf', uri: OSS_REF, previewable: false };
    expect(applySentAttachmentThumbOverlay(file)).toBe(file);
    const desktop = { kind: 'image', name: 'e.jpg', uri: 'xdt-image://s/e.jpg', previewable: false };
    expect(applySentAttachmentThumbOverlay(desktop)).toBe(desktop);
  });

  it('扩展名白名单外的来源文件回落 .jpg 文件名', async () => {
    const { deps, copies } = makeFsDeps();
    await registerSentAttachmentThumb(OSS_REF, 'file:///cache/upload.heic', deps);
    expect(copies[0]?.to.endsWith('.jpg')).toBe(true);
  });
});
