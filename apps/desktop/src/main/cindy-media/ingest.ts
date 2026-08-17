/**
 * ingest.ts — cindy-media 统一入库助手(媒体总仓的唯一推荐写入口)。
 * ---------------------------------------------------------------------------
 * 契约:docs/dev-rules/media-storage-and-protocols.md。
 *
 * 把「writeBlob 指纹落盘 → recordBlob 入账 → addRef 挂引用」三件套封成一把梭,
 * 后续所有媒体写入方(聊天附件、生成产物、集成缓存、分享导入)一律走这里,
 * 不再各自手拼三步(意识供图等已上线的存量调用可渐进收编)。
 *
 * 崩溃语义(定死,调用方与对账工具都依赖):**先字节后记账**。
 *   - 写盘成功、记账失败 → 磁盘上多一个"无账 blob":无害(内容寻址,重试
 *     同内容自动命中),由未来对账工具"只报不删"兜底;
 *   - 绝不反向(先记账后写盘会产生"有账无文件"的坏账,读路径直接 404,
 *     且回收器无从判断该行是垃圾还是丢文件)。
 *   - 去重命中(deduplicated=true)仍照常记账:recordBlob 幂等只刷 lastAccess,
 *     addRef 是新引用行——"同内容再次被引用"正是账本要记的事实。
 *
 * 所有函数接受可注入 db(规则 14),生产默认走 DbClient 的 drizzle 代理。
 */

import { randomUUID } from 'node:crypto';

import * as blobStore from './blobStore';
import * as ledger from './ledger';
import type { LedgerDb, MediaRefKind, MediaOriginKind } from './ledger';
import { withMediaRefCompensation, type MediaRefCompensationScope } from './refCompensationJournal';
import { createLogger } from '../logger';

const log = createLogger('cindy-media-ingest');

/** 一条待挂的引用(字段语义见 ledger.AddRefParams / schema.ts mediaRefs)。 */
export interface IngestRef {
  refKind: MediaRefKind;
  refId: string;
  originSessionId?: string;
  originKind?: MediaOriginKind;
  originId?: string;
  label?: string;
}

export interface IngestMediaParams {
  buffer: Uint8Array;
  /** 真实 mime(由主机侧判定,不信调用方之外的自报);白名单外直接拒。 */
  mimeType: string;
  /** 性质=可再生缓存(吃 cache 上限可清);附件/作品传 false(默认)。 */
  isCache?: boolean;
  /**
   * 入库同时挂上的引用。可为空数组——但无引用的非 cache blob 会立刻成为
   * 回收候选,正常业务都应该至少带一条(先入库后补 ref 的调用方自己负责
   * 在同一逻辑事务内尽快 addRef)。
   */
  refs: IngestRef[];
  /**
   * 跨账号/会话写入的失效闸。调用方可注入同步断言；入库助手会在第一个
   * 副作用前及每个 await 后调用，失效即停止后续记账/挂引用并向上抛错。
   * 启用时必须同时显式传入在稳定作用域下捕获的 db，禁止每次记账现取新作用域。
   */
  assertStillValid?: () => void;
  /**
   * Stable owner-scoped durable journal captured with the explicit db. Guarded
   * ingests that create refs require it so a committed INSERT can still be
   * compensated after the DbClient worker disappears before its ACK.
   */
  refCompensationScope?: MediaRefCompensationScope;
}

export interface IngestedMedia {
  /** SHA-256 指纹(64 位小写十六进制)。 */
  hash: string;
  /** 落盘扩展名(含点)。 */
  ext: string;
  mimeType: string;
  bytes: number;
  /** `cindy-media://blobs/<hash><ext>`——消息/渲染端持有的永久地址。 */
  url: string;
  /** 命中既有内容(全局去重)时为 true。 */
  deduplicated: boolean;
  /** 本次新挂的引用行 id(与 refs 一一对应)。 */
  refIds: string[];
}

/**
 * 一段媒体字节入总仓:指纹落盘 → blob 入账 → 挂引用,返回指纹与永久地址。
 * 任一步失败即抛(已落盘的字节不回滚,见文件头崩溃语义)。
 */
export async function ingestMedia(
  params: IngestMediaParams,
  db?: LedgerDb,
): Promise<IngestedMedia> {
  if (params.assertStillValid && !db) {
    throw new Error('cindy-media: guarded ingest requires an explicit database');
  }
  if (params.assertStillValid && params.refs.length > 0 && !params.refCompensationScope) {
    throw new Error('cindy-media: guarded ingest requires a reference compensation scope');
  }
  params.assertStillValid?.();
  const written = await blobStore.writeBlob({
    buffer: params.buffer,
    mimeType: params.mimeType,
  });
  params.assertStillValid?.();
  await ledger.recordBlob(
    {
      hash: written.hash,
      ext: written.ext,
      mimeType: written.mimeType,
      bytes: written.bytes,
      isCache: params.isCache ?? false,
    },
    db,
  );
  params.assertStillValid?.();
  // Reserve every id before the first INSERT. A committed INSERT whose worker
  // acknowledgement is lost can then be deleted by exact id without touching
  // refs from another concurrent ingest.
  const refIds = params.refs.map(() => randomUUID());
  const addRefs = async (): Promise<void> => {
    for (const [index, ref] of params.refs.entries()) {
      await ledger.addRef({ id: refIds[index], hash: written.hash, ...ref }, db);
      params.assertStillValid?.();
    }
  };

  if (refIds.length > 0 && params.refCompensationScope) {
    await withMediaRefCompensation({
      scope: params.refCompensationScope,
      refIds,
      perform: addRefs,
      compensate: (id) => ledger.removeRefById(id, db),
    });
  } else {
    try {
      await addRefs();
    } catch (error) {
      // Unguarded legacy callers still get best-effort in-process rollback.
      // Guarded owner/session writers take the durable journal path above.
      const rollbackResults = await Promise.allSettled(
        refIds.map((id) => ledger.removeRefById(id, db)),
      );
      rollbackResults.forEach((result, index) => {
        if (result.status === 'rejected') {
          log.warn('Failed to roll back a staged media reference', {
            refId: refIds[index],
            error: String(result.reason),
          });
        }
      });
      throw error;
    }
  }
  return { ...written, refIds };
}

/** 调用方可先判"这类字节进不进仓"(白名单外走 xdt-file 等直读通道,规则 25 边界)。 */
export const supportedMime = blobStore.supportedMime;
