/**
 * 文件浏览的本机缓存层(v1.1,回应"每次进目录都重新读取"):
 *
 * 1. 目录列表:内存 Map + AsyncStorage 快照,进入目录先出缓存(零 loading 帧,
 *    规则 7),后台静默刷新后原位更新;跨启动仍有上次快照可秒开。
 * 2. 文本迷你缩略图片段:小文件(≤96KB)拉一次首块,渲染真实内容迷你页;
 *    片段(≤2KB)内存 + AsyncStorage 双层缓存,key 含 mtime 天然失效。
 * 3. 同账号预览正文:内存 LRU(账号/设备/路径),翻页/重进先展示旧内容再后台更新。
 *    共享访客不复用正文缓存,每次打开先由主机校验权限。
 *
 * AsyncStorage 侧统一带索引数组做 LRU 剪枝,防无限膨胀。
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { isSharedTaskPeer } from "@cindy/device-link";
import { useEffect, useState } from "react";

import type { MobileMakerTransport } from "@/device-link/mobileMakerTransport";
import { decodeGzipBase64Text } from "@/session/fileBrowserActions";
import type { FileBrowserRemoteOpEntry } from "@/session/fileBrowserGrid";

const LISTING_PREFIX = "xdt.fileBrowserListing.v2";
const LISTING_INDEX_KEY = `${LISTING_PREFIX}.index`;
const LISTING_MAX_PERSISTED = 150;

const SNIPPET_PREFIX = "xdt.fileBrowserSnippet.v2";
const SNIPPET_INDEX_KEY = `${SNIPPET_PREFIX}.index`;
const SNIPPET_MAX_PERSISTED = 240;
/** 超过该大小的文件不拉真实内容缩略图(流量/耗时不值得,回退抽象线条)。 */
export const DOC_SNIPPET_MAX_FILE_BYTES = 96 * 1024;
const DOC_SNIPPET_MAX_CHARS = 2000;
const DOC_SNIPPET_CONCURRENCY = 3;

const PREVIEW_TEXT_MAX_ENTRIES = 15;

/* ------------------------------ 目录列表 ------------------------------ */

const listingMemory = new Map<string, FileBrowserRemoteOpEntry[]>();

function listingKey(workdir: string, relPath: string): string {
  return `${workdir}\u0000${relPath}`;
}

function listingStorageKey(workdir: string, relPath: string): string {
  return `${LISTING_PREFIX}.${encodeURIComponent(workdir)}.${encodeURIComponent(relPath)}`;
}

export function getCachedListingSync(
  scope: string,
  workdir: string,
  relPath: string,
): FileBrowserRemoteOpEntry[] | null {
  workdir = JSON.stringify([scope, workdir]);
  return listingMemory.get(listingKey(workdir, relPath)) ?? null;
}

/** AsyncStorage 快照回灌(内存 miss 时;跨启动秒开靠这层)。 */
export async function readCachedListing(
  scope: string,
  workdir: string,
  relPath: string,
): Promise<FileBrowserRemoteOpEntry[] | null> {
  workdir = JSON.stringify([scope, workdir]);
  const memory = listingMemory.get(listingKey(workdir, relPath));
  if (memory) return memory;
  const raw = await AsyncStorage.getItem(
    listingStorageKey(workdir, relPath),
  ).catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { entries?: FileBrowserRemoteOpEntry[] };
    if (!Array.isArray(parsed.entries)) return null;
    listingMemory.set(listingKey(workdir, relPath), parsed.entries);
    return parsed.entries;
  } catch {
    return null;
  }
}

export function storeCachedListing(
  scope: string,
  workdir: string,
  relPath: string,
  entries: FileBrowserRemoteOpEntry[],
): void {
  workdir = JSON.stringify([scope, workdir]);
  listingMemory.set(listingKey(workdir, relPath), entries);
  // 目录内容已确认变化(含 fs-watch 触发的刷新)→ 全量文件索引可能陈旧,
  // 失效掉让下次搜索重拉,避免 60s TTL 窗口里搜不到新建/仍搜到已删文件。
  allFilesMemory.delete(workdir);
  const key = listingStorageKey(workdir, relPath);
  void AsyncStorage.setItem(
    key,
    JSON.stringify({ v: 1, at: Date.now(), entries }),
  )
    .then(() =>
      touchPersistIndex(LISTING_INDEX_KEY, key, LISTING_MAX_PERSISTED),
    )
    .catch(() => undefined);
}

/* --------------------------- 文本缩略图片段 --------------------------- */

/** value:片段文本;null = 已知不可用(过大/二进制/读失败),直到 mtime 变化。 */
const snippetMemory = new Map<string, string | null>();
const snippetInflight = new Map<string, Promise<string | null>>();
let snippetActive = 0;
const snippetQueue: Array<() => void> = [];

function snippetKey(workdir: string, relPath: string, mtimeMs: number): string {
  return `${workdir}\u0000${relPath}\u0000${mtimeMs}`;
}

function snippetStorageKey(
  workdir: string,
  relPath: string,
  mtimeMs: number,
): string {
  return `${SNIPPET_PREFIX}.${encodeURIComponent(workdir)}.${encodeURIComponent(relPath)}.${mtimeMs}`;
}

export function getCachedDocSnippetSync(
  scope: string,
  workdir: string,
  relPath: string,
  mtimeMs: number,
): string | null | undefined {
  workdir = JSON.stringify([scope, workdir]);
  return snippetMemory.get(snippetKey(workdir, relPath, mtimeMs));
}

/** 并发闸门:大目录首屏一次性可见十几个 doc 缩略图,串成小队避免挤占正事请求。 */
function withSnippetSlot<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      snippetActive += 1;
      task()
        .then(resolve, reject)
        .finally(() => {
          snippetActive -= 1;
          snippetQueue.shift()?.();
        });
    };
    if (snippetActive < DOC_SNIPPET_CONCURRENCY) run();
    else snippetQueue.push(run);
  });
}

export function loadDocSnippet(
  maker: Pick<MobileMakerTransport, "fileBrowser">,
  workdir: string,
  relPath: string,
  mtimeMs: number,
  sizeBytes: number,
): Promise<string | null> {
  const cacheWorkdir = JSON.stringify([maker.fileBrowser.cacheScope, workdir]);
  const key = snippetKey(cacheWorkdir, relPath, mtimeMs);
  const cached = snippetMemory.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  const pending = snippetInflight.get(key);
  if (pending) return pending;

  const task = (async (): Promise<string | null> => {
    if (sizeBytes > DOC_SNIPPET_MAX_FILE_BYTES) {
      snippetMemory.set(key, null);
      return null;
    }
    // 先查落盘快照(跨启动)。
    const storageKey = snippetStorageKey(cacheWorkdir, relPath, mtimeMs);
    const persisted = await AsyncStorage.getItem(storageKey).catch(() => null);
    if (persisted !== null) {
      snippetMemory.set(key, persisted);
      return persisted;
    }
    const snippet = await withSnippetSlot(async () => {
      const res = await maker.fileBrowser.readFile(workdir, relPath, {
        acceptGzip: true,
      });
      if (!res.ok) return null;
      const content =
        res.data.contentEncoding === "gzip"
          ? decodeGzipBase64Text(res.data.content)
          : res.data.content;
      return content.slice(0, DOC_SNIPPET_MAX_CHARS);
    });
    snippetMemory.set(key, snippet);
    if (snippet !== null) {
      void AsyncStorage.setItem(storageKey, snippet)
        .then(() =>
          touchPersistIndex(
            SNIPPET_INDEX_KEY,
            storageKey,
            SNIPPET_MAX_PERSISTED,
          ),
        )
        .catch(() => undefined);
    }
    return snippet;
  })()
    .catch(() => null) // 传输层瞬断:不写失败缓存,允许下次重试
    .finally(() => {
      snippetInflight.delete(key);
    });
  snippetInflight.set(key, task);
  return task;
}

/** 网格 doc 缩略图用:真实内容片段(缓存命中同步出,miss 时懒加载)。 */
export function useDocSnippet(
  maker: Pick<MobileMakerTransport, "fileBrowser">,
  workdir: string,
  relPath: string,
  mtimeMs: number,
  sizeBytes: number,
  enabled: boolean,
): string | null {
  const key = snippetKey(
    JSON.stringify([maker.fileBrowser.cacheScope, workdir]),
    relPath,
    mtimeMs,
  );
  const [snippet, setSnippet] = useState<string | null>(() =>
    enabled ? (snippetMemory.get(key) ?? null) : null,
  );

  useEffect(() => {
    if (!enabled || !workdir || !relPath) return undefined;
    let cancelled = false;
    const cached = snippetMemory.get(key);
    if (cached !== undefined) {
      setSnippet(cached);
      return undefined;
    }
    // 200ms 驻留防抖:快速滚过的 cell 卸载即取消,不发 readFile。
    const timer = setTimeout(() => {
      void loadDocSnippet(maker, workdir, relPath, mtimeMs, sizeBytes).then(
        (value) => {
          if (!cancelled) setSnippet(value);
        },
      );
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, key, maker, mtimeMs, relPath, sizeBytes, workdir]);

  return snippet;
}

/* ------------------------------ 预览正文 ------------------------------ */

export interface CachedPreviewText {
  lines: string[];
  totalLines: number;
  truncated: boolean;
  /** 仅 markdown 文件保留原文(渲染态需要;普通代码文件不留,省内存)。 */
  content?: string;
}

const previewTextMemory = new Map<string, CachedPreviewText>();

export function getCachedPreviewText(
  scope: string,
  workdir: string,
  relPath: string,
  _mtimeMs: number,
  deviceId: string,
): CachedPreviewText | null {
  // Shared guests must pass a fresh host authorization check before showing text.
  if (isSharedTaskPeer(deviceId)) return null;
  workdir = JSON.stringify([scope, workdir]);
  const key = snippetKey(workdir, relPath, 0);
  const value = previewTextMemory.get(key);
  if (!value) return null;
  previewTextMemory.delete(key);
  previewTextMemory.set(key, value); // LRU touch
  return value;
}

export function storeCachedPreviewText(
  scope: string,
  workdir: string,
  relPath: string,
  _mtimeMs: number,
  value: CachedPreviewText | null,
  deviceId: string,
): void {
  if (isSharedTaskPeer(deviceId)) return;
  workdir = JSON.stringify([scope, workdir]);
  const key = snippetKey(workdir, relPath, 0);
  previewTextMemory.delete(key);
  if (value === null) return;
  previewTextMemory.set(key, value);
  while (previewTextMemory.size > PREVIEW_TEXT_MAX_ENTRIES) {
    const oldest = previewTextMemory.keys().next().value;
    if (oldest === undefined) break;
    previewTextMemory.delete(oldest);
  }
}

/* --------------------------- 导出下载地址 --------------------------- */

/**
 * export→presign 结果缓存(device+path+mtime → presigned URL):同一文件重看
 * 不再重跑 OSS 导出全流程(整条链路里最重的一步)。key 必须含 deviceId——
 * 同时远控两台电脑且 workdir/路径/mtime 恰好相同时,B 设备不能吃到 A 设备
 * 的导出结果。presign 有效期由服务端定,留 60s 余量提前视为过期。
 */
const exportUrlMemory = new Map<string, { url: string; expiresAtMs: number }>();
const EXPORT_URL_EXPIRY_MARGIN_MS = 60_000;

function exportUrlKey(
  deviceId: string,
  workdir: string,
  relPath: string,
  mtimeMs: number,
): string {
  return `${deviceId} ${workdir} ${relPath} ${mtimeMs}`;
}

export function getCachedExportUrl(
  deviceId: string,
  workdir: string,
  relPath: string,
  mtimeMs: number,
): string | null {
  const key = exportUrlKey(deviceId, workdir, relPath, mtimeMs);
  const cached = exportUrlMemory.get(key);
  if (!cached) return null;
  if (Date.now() > cached.expiresAtMs - EXPORT_URL_EXPIRY_MARGIN_MS) {
    exportUrlMemory.delete(key);
    return null;
  }
  return cached.url;
}

export function storeCachedExportUrl(
  deviceId: string,
  workdir: string,
  relPath: string,
  mtimeMs: number,
  url: string,
  expiresAt: string | undefined,
): void {
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : NaN;
  if (!Number.isFinite(expiresAtMs)) return; // 无有效期信息就不缓存,宁可重导出
  exportUrlMemory.set(exportUrlKey(deviceId, workdir, relPath, mtimeMs), {
    url,
    expiresAtMs,
  });
}

/* --------------------------- 全量文件索引 --------------------------- */

/** listAllFiles 结果按 workdir 缓存(搜索页每次进入不重拉),60s TTL + inflight 去重。 */
const allFilesMemory = new Map<string, { files: string[]; at: number }>();
const allFilesInflight = new Map<string, Promise<string[]>>();
const ALL_FILES_TTL_MS = 60_000;

export function loadAllFilesIndex(
  maker: Pick<MobileMakerTransport, "fileBrowser">,
  workdir: string,
  cap: number,
): Promise<string[]> {
  const key = JSON.stringify([maker.fileBrowser.cacheScope, workdir]);
  const cached = allFilesMemory.get(key);
  if (cached && Date.now() - cached.at < ALL_FILES_TTL_MS)
    return Promise.resolve(cached.files);
  const pending = allFilesInflight.get(key);
  if (pending) return pending;
  const task = maker.fileBrowser
    .listAllFiles(workdir, cap)
    .then((res) => {
      const files = res.files ?? [];
      allFilesMemory.set(key, { files, at: Date.now() });
      return files;
    })
    .finally(() => {
      allFilesInflight.delete(key);
    });
  allFilesInflight.set(key, task);
  return task;
}

/* ------------------------------ 索引剪枝 ------------------------------ */

/**
 * AsyncStorage 侧的简易 LRU:一个索引数组记录 key 触达顺序,超限删最旧的
 * 存储项。索引本身的读写失败只影响剪枝,不影响功能。
 */
async function touchPersistIndex(
  indexKey: string,
  storageKey: string,
  cap: number,
): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(indexKey);
    let index: string[] = [];
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed))
          index = parsed.filter(
            (item): item is string => typeof item === "string",
          );
      } catch {
        index = [];
      }
    }
    index = index.filter((item) => item !== storageKey);
    index.push(storageKey);
    const evicted =
      index.length > cap ? index.splice(0, index.length - cap) : [];
    await AsyncStorage.setItem(indexKey, JSON.stringify(index));
    if (evicted.length > 0) await AsyncStorage.multiRemove(evicted);
  } catch {
    // 剪枝失败可容忍
  }
}

export const __testing = {
  listingMemory,
  snippetMemory,
  previewTextMemory,
  touchPersistIndex,
};
