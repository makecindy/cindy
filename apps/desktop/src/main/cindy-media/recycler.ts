/**
 * recycler.ts — 媒体总仓回收器。
 * ---------------------------------------------------------------------------
 * 两条清理线,全部**手动触发、先报数后动手**(v1 无任何自动删除):
 *   - 零引用回收:账本无引用 + 缓冲期已过 + 不在活引用集 → 删账(条件 SQL
 *     复查)→ 复查无并发重录 → 删字节;
 *   - cache 瘦身:isCache=true 总量超上限时按 LRU 逐出(可再生,清错也会
 *     按 miss 重下自愈);isCache=false(用户附件 / 被聊天引用后 pinBlob
 *     钉死的)绝不碰。
 *
 * ⚠️ "零引用 ≠ 无主"(§4 钉死的不变量):粘贴=零引用草稿、生成=零引用入仓,
 * 四类暂存区里的 blob 可以长期合法零引用。本模块的对策:
 *   (1) 输入框草稿托盘 —— renderer 内存,main 读不到;清理请求由设置页发起,
 *       renderer 随参把全部草稿附件 URL 带上(collectLiveHashes.draftUrls);
 *   (2) busy 排队消息 —— main 内存,AgentInputCoordinator 注入序列化文本;
 *   (3) 崩溃恢复持久队列 —— localDb 快照表全量 payload 文本扫描;
 *   (4) 生成→落库在途窗口 —— 缓冲期(创建与最后访问都超过 BUFFER 才候选)
 *       兜底;崩溃永久遗留会在缓冲期后出现在候选清单,由"报数→人工确认"把关。
 *
 * 删除顺序(防坏账):先条件删账、后删字节。失败方向永远是"账没了文件还在"
 * (孤魂,无害,对账工具可见),绝不产生"账在文件没了"(聊天缺图)。删字节前
 * 再复查一次账——ingest 是"先字节后记账",并发 re-ingest 可能刚把账补回来;
 * 复查后仍存在纳秒级 unlink 竞态窗口,由缓冲期(72h 未动的内容恰在此刻重灌
 * 的概率趋零)+ 对账工具"只报"兜底。
 */

import { createLogger } from '../logger';
import * as blobStore from './blobStore';
import * as ledger from './ledger';
import type { LedgerDb } from './ledger';

const log = createLogger('cindy-media-recycler');

/** Called under the client wallpaper publication lock with re-read durable references.
 * This scope cannot contain chat/attachment bytes; never delete ordinary blobs.
 * A later successful operation also retries failed cleanup or interrupted imports.
 */
export async function recycleClientWallpapers(keepUrls: string[], ext: '.webp' | '.mp4'): Promise<void> {
  const keep = new Set(keepUrls.map((url) => blobStore.parseClientWallpaperUrl(url)?.hash).filter(Boolean));
  const { entries } = await blobStore.listBlobFiles('client-wallpaper');
  for (const entry of entries) {
    if (entry.ext === ext && !keep.has(entry.hash))
      await blobStore.deleteBlobFile(entry.hash, entry.ext, 'client-wallpaper');
  }
  await blobStore.cleanupTmpFiles(TMP_FILE_MAX_AGE_MS, 'client-wallpaper');
}

/** 零引用缓冲期(内部常量,规则 20 隐藏层):入库与最后访问都早于此才候选。 */
export const ZERO_REF_BUFFER_MS = 72 * 60 * 60 * 1000;
/** cache 总量上限(§4 默认 512MB 量级;内部常量,规则 20 隐藏层)。 */
export const CACHE_LIMIT_BYTES = 512 * 1024 * 1024;
/** `.tmp-*` 写入残留的年龄门槛(正常写入寿命毫秒级,24h 足够保守)。 */
export const TMP_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** 与 chatAttachments.ts 同形的 blob 地址正则,捕获组 = 指纹。 */
const CINDY_BLOB_HASH_RE = /\bcindy-media:\/\/blobs\/([0-9a-f]{64})\.[a-z0-9]+/g;

/** 从任意文本抽取 cindy-media 指纹(活引用取证共用)。 */
export function extractBlobHashes(text: string, into: Set<string> = new Set()): Set<string> {
  for (const m of text.matchAll(CINDY_BLOB_HASH_RE)) into.add(m[1]);
  return into;
}

/** 活引用来源(§4 暂存区 (1)(2)(3);(4) 由缓冲期兜底)。 */
export interface LiveHashSources {
  /** renderer 随清理请求带上的草稿附件地址。 */
  draftUrls?: string[];
  /** main 内存排队/在途消息的序列化文本(AgentInputCoordinator 注入)。 */
  inMemoryQueueTexts?: () => string[];
  /** 崩溃恢复快照表全量 payload(agent_input_queue_snapshots)。 */
  snapshotPayloads?: () => Promise<string[]>;
}

/** 汇总三个暂存区里的全部活指纹。 */
export async function collectLiveHashes(sources: LiveHashSources): Promise<Set<string>> {
  const live = new Set<string>();
  for (const url of sources.draftUrls ?? []) extractBlobHashes(url, live);
  for (const text of sources.inMemoryQueueTexts?.() ?? []) extractBlobHashes(text, live);
  for (const payload of (await sources.snapshotPayloads?.()) ?? []) extractBlobHashes(payload, live);
  return live;
}

export interface ZeroRefScan {
  count: number;
  bytes: number;
  /** 候选指纹(execute 直接回传,与用户确认时看到的清单一致)。 */
  hashes: string[];
  /** 因活引用被保护跳过的数量(展示"草稿里的图不动"用)。 */
  protectedCount: number;
}

/** 扫描零引用候选:账本查询(零引用+缓冲期)后再剔除活引用集。 */
export async function scanZeroRef(
  params: { live: Set<string>; bufferMs?: number },
  db?: LedgerDb,
): Promise<ZeroRefScan> {
  const cutoff = Date.now() - (params.bufferMs ?? ZERO_REF_BUFFER_MS);
  const rows = await ledger.listZeroRefBlobs(cutoff, db);
  const scan: ZeroRefScan = { count: 0, bytes: 0, hashes: [], protectedCount: 0 };
  for (const row of rows) {
    if (params.live.has(row.hash)) {
      scan.protectedCount++;
      continue;
    }
    scan.count++;
    scan.bytes += row.bytes;
    scan.hashes.push(row.hash);
  }
  return scan;
}

export interface DeleteResult {
  deleted: number;
  freedBytes: number;
  /** 条件复查没过(期间被挂引用/刷新访问/并发重录)而跳过的数量。 */
  skipped: number;
}

/**
 * 执行零引用删除。每个指纹独立走"条件删账 → 复查 → 删字节",单个失败不
 * 影响其余;活引用集在执行时重新生效(扫描与确认之间用户可能又粘了图)。
 */
export async function deleteZeroRefBlobs(
  params: { hashes: string[]; live: Set<string>; bufferMs?: number },
  db?: LedgerDb,
): Promise<DeleteResult> {
  const cutoff = Date.now() - (params.bufferMs ?? ZERO_REF_BUFFER_MS);
  const result: DeleteResult = { deleted: 0, freedBytes: 0, skipped: 0 };
  for (const hash of params.hashes) {
    try {
      if (params.live.has(hash)) {
        result.skipped++;
        continue;
      }
      const info = await ledger.getBlobInfo(hash, db);
      if (!info) {
        result.skipped++;
        continue;
      }
      const removed = await ledger.deleteZeroRefBlobRecord(hash, cutoff, db);
      if (!removed) {
        result.skipped++;
        continue;
      }
      // 复查:并发 re-ingest(先字节后记账)可能刚把账补回来——那字节归新账管。
      if (await ledger.getBlobInfo(hash, db)) {
        result.skipped++;
        continue;
      }
      await blobStore.deleteBlobFile(hash, info.ext);
      result.deleted++;
      result.freedBytes += info.bytes;
    } catch (err) {
      result.skipped++;
      log.warn('zero-ref delete failed for one blob', {
        hash,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

export interface CacheScan {
  totalBytes: number;
  count: number;
  limitBytes: number;
  /** 超限字节(<=0 表示无需瘦身)。 */
  excessBytes: number;
  /** 按 LRU 选出的逐出候选(刚好凑够 excessBytes 即止)。 */
  evictable: Array<{ hash: string; ext: string; bytes: number }>;
}

/** 扫描 cache 用量与逐出候选(LRU 头部起,凑够超限量为止;活引用集剔除)。 */
export async function scanCache(
  params: { live: Set<string>; limitBytes?: number },
  db?: LedgerDb,
): Promise<CacheScan> {
  const limitBytes = params.limitBytes ?? CACHE_LIMIT_BYTES;
  const rows = await ledger.listCacheBlobsByLru(db);
  const totalBytes = rows.reduce((sum, r) => sum + r.bytes, 0);
  const scan: CacheScan = {
    totalBytes,
    count: rows.length,
    limitBytes,
    excessBytes: totalBytes - limitBytes,
    evictable: [],
  };
  if (scan.excessBytes <= 0) return scan;
  let planned = 0;
  for (const row of rows) {
    if (planned >= scan.excessBytes) break;
    if (params.live.has(row.hash)) continue;
    scan.evictable.push({ hash: row.hash, ext: row.ext, bytes: row.bytes });
    planned += row.bytes;
  }
  return scan;
}

/** 执行 cache 逐出(条件删账 deleteCacheBlobRecord 复查 pin 与引用,同款安全顺序)。 */
export async function evictCacheBlobs(
  params: { hashes: string[]; live: Set<string> },
  db?: LedgerDb,
): Promise<DeleteResult> {
  const result: DeleteResult = { deleted: 0, freedBytes: 0, skipped: 0 };
  for (const hash of params.hashes) {
    try {
      if (params.live.has(hash)) {
        result.skipped++;
        continue;
      }
      const info = await ledger.getBlobInfo(hash, db);
      if (!info) {
        result.skipped++;
        continue;
      }
      const removed = await ledger.deleteCacheBlobRecord(hash, db);
      if (!removed) {
        result.skipped++;
        continue;
      }
      if (await ledger.getBlobInfo(hash, db)) {
        result.skipped++;
        continue;
      }
      await blobStore.deleteBlobFile(hash, info.ext);
      result.deleted++;
      result.freedBytes += info.bytes;
    } catch (err) {
      result.skipped++;
      log.warn('cache evict failed for one blob', {
        hash,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

// ── 对账(§4:只报不删)────────────────────────────────────────────────────

export interface ReconcileReport {
  /** 盘上有、账上无(孤魂文件)。刚写入未记账的在途件按 mtime 1h 内豁免。 */
  orphanFiles: Array<{ absPath: string; bytes: number }>;
  /** 账上有、盘上无(坏账:引用它的消息会缺图)。 */
  missingFiles: Array<{ hash: string; ext: string; bytes: number }>;
  /** 命名不合内容寻址形状的文件/目录。 */
  strayPaths: string[];
  /** 写入崩溃残留的 .tmp-* 文件数。 */
  tmpFileCount: number;
}

/** 在途写入豁免窗口:writeBlob 与 recordBlob 之间的新文件不算孤魂。 */
const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;

/** 字节仓 × 账本全量互 diff。任何结论都不动数据(账本是命脉,回收必须保守)。 */
export async function reconcile(db?: LedgerDb): Promise<ReconcileReport> {
  const [listing, records] = await Promise.all([
    blobStore.listBlobFiles(),
    ledger.listAllBlobRecords(db),
  ]);
  const onDisk = new Map(listing.entries.map((e) => [`${e.hash}${e.ext}`, e]));
  const inLedger = new Map(records.map((r) => [`${r.hash}${r.ext}`, r]));
  const now = Date.now();
  const report: ReconcileReport = {
    orphanFiles: [],
    missingFiles: [],
    strayPaths: listing.strayPaths,
    tmpFileCount: listing.tmpFiles.length,
  };
  for (const [key, entry] of onDisk) {
    if (inLedger.has(key)) continue;
    if (now - entry.mtimeMs < ORPHAN_MIN_AGE_MS) continue;
    report.orphanFiles.push({ absPath: entry.absPath, bytes: entry.bytes });
  }
  for (const [key, record] of inLedger) {
    if (onDisk.has(key)) continue;
    report.missingFiles.push(record);
  }
  return report;
}
