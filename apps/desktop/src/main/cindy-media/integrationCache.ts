/**
 * integrationCache.ts — 集成下载缓存的媒体总仓存取口。
 * ---------------------------------------------------------------------------
 * 契约:docs/dev-rules/media-storage-and-protocols.md;缓存引用与逐出语义见本文件及 recycler.ts。
 *
 * 服务飞书 / Slack / Discord / Confluence / Jira 等集成的"按 token 缓存媒体"
 * 场景。历史缓存用 `<token>.<ext>` 文件名回答"下过没有";指纹制下文件名与
 * token 无关,改由账本的 integration-cache 引用行充当 token→指纹索引:
 *   - **cacheGet(key)**:查索引 → 指纹 → 仓内文件。命中即免重下;
 *     "有账无文件"(坏账)按对账原则只报不删,当 miss 处理让调用方重下自愈。
 *   - **cachePut(key, bytes, mime)**:字节入仓(isCache=true,吃回收器的
 *     总量上限 + LRU 策略)+ 登记索引行(同 key 同指纹幂等;token 复用换
 *     内容时追加新行,cacheGet 取最新)。
 *
 * 只收白名单媒体 mime(调用方先用 supportedMime 分流);非媒体文件不进
 * 字节仓,维持各集成的老目录 + xdt-file 直读(规则 25 边界)。
 * host 把这两个函数以回调注入 packages(规则 2:包只摸字节和字符串)。
 */

import fs from 'node:fs/promises';

import * as blobStore from './blobStore';
import * as ledger from './ledger';
import type { LedgerDb } from './ledger';
import { ingestMedia } from './ingest';
import { createLogger } from '../logger';

const log = createLogger('cindy-media/integration-cache');

/** 统一 cacheKey 形态:`<集成名>:<token>`(集成名小写,token 原样)。 */
export function integrationCacheKey(integration: string, token: string): string {
  return `${integration.toLowerCase()}:${token}`;
}

/**
 * 集成侧 mime 归一化:剥参数 + 小写 + 常见别名(`image/jpg` 是 Jira/Confluence
 * 真实会给的非标值,不归一会被 writeBlob 白名单硬拒、永远进不了媒体总仓还刷
 * warn,review P2)。
 */
const INTEGRATION_MIME_ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
};

export function normalizeIntegrationMime(raw: string): string {
  const m = raw.split(';')[0].trim().toLowerCase();
  return INTEGRATION_MIME_ALIASES[m] ?? m;
}

export interface IntegrationCacheHit {
  /** `cindy-media://blobs/<hash>.<ext>`(聊天渲染用)。 */
  url: string;
  /** 仓内绝对路径(喂 agent / 出站回传用)。 */
  absPath: string;
  mimeType: string;
  hash: string;
}

/** 查缓存:命中返回文件坐标并刷 LRU 时间;未登记 / 文件缺失(坏账)返回 null。 */
export async function integrationCacheGet(
  cacheKey: string,
  db?: LedgerDb,
): Promise<IntegrationCacheHit | null> {
  const hash = await ledger.getIntegrationCacheHash(cacheKey, db);
  if (!hash) return null;
  const info = await ledger.getBlobInfo(hash, db);
  if (!info) return null;
  const resolved = blobStore.resolveHashRef(hash, info.ext);
  try {
    await fs.access(resolved.absPath);
  } catch {
    // 有账无文件:对账原则只报不删,按 miss 让调用方重下(指纹制下重下
    // 同一内容自动复位,坏账行随之重新指向实体)。
    log.warn('integration cache hit in ledger but blob file missing', { cacheKey, hash });
    return null;
  }
  void ledger.touchBlob(hash, db);
  return {
    url: blobStore.blobUrl(hash, info.ext),
    absPath: resolved.absPath,
    mimeType: resolved.mimeType,
    hash,
  };
}

/** 写缓存:字节入仓(isCache=true)+ 登记 token→指纹索引(同指纹幂等)。 */
export async function integrationCachePut(
  params: {
    cacheKey: string;
    /** 集成名(出生信息 originId;从 cacheKey 冒号前段传或显式给)。 */
    integration: string;
    buffer: Uint8Array;
    mimeType: string;
    /**
     * 性质标记,默认 true(可再生缓存,吃回收器总量上限 + LRU)。IM 入站
     * **用户附件**必须传 false:它语义上是会话附件而非可再生缓存——discord
     * 的 CDN 地址是限时签名,被 LRU 逐出后无法重下,等于弄丢用户的图。
     */
    isCache?: boolean;
  },
  db?: LedgerDb,
): Promise<IntegrationCacheHit> {
  const written = await ingestMedia(
    {
      buffer: params.buffer,
      mimeType: normalizeIntegrationMime(params.mimeType),
      isCache: params.isCache ?? true,
      refs: [],
    },
    db,
  );
  const existing = await ledger.getIntegrationCacheHash(params.cacheKey, db);
  if (existing !== written.hash) {
    // 新登记 / token 复用换内容:追加索引行,cacheGet 取最新。
    await ledger.addRef(
      {
        hash: written.hash,
        refKind: 'integration-cache',
        refId: params.cacheKey,
        originKind: 'integration',
        originId: params.integration.toLowerCase(),
      },
      db,
    );
  }
  const resolved = blobStore.resolveHashRef(written.hash, written.ext);
  return {
    url: written.url,
    absPath: resolved.absPath,
    mimeType: written.mimeType,
    hash: written.hash,
  };
}

/** 调用方分流用:该 mime 的字节进不进仓(非媒体走各集成老目录 + xdt-file)。 */
export const supportedMime = blobStore.supportedMime;
