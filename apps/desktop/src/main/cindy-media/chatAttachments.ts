/**
 * chatAttachments.ts — 聊天图片附件的媒体总仓写入口。
 * ---------------------------------------------------------------------------
 * 契约:docs/dev-rules/media-storage-and-protocols.md;引用与回收语义见本文件注释及 recycler.ts。
 *
 * 历史缓存的 draft/committed 状态机(xdt-meta.json + markFilesCommitted +
 * 启动孤儿清扫)在引用计数模型下坍缩成两个动作:
 *   - **粘贴/拖拽 = 只写字节仓 + blob 行,不挂引用**:无引用 blob 天然就是
 *     "草稿"——回收器按引用归零回收,不需要 per-file meta;
 *   - **发送 = commitChatImageUrls 挂 session-attachment 引用**:消息真正
 *     入库时才建立归属,替代 markFilesCommitted 的晋升语义;删会话时由
 *     removeSessionRefs 连坐清理。
 * 移除输入框 chip 不删任何东西(内容寻址 blob 可能被其它引用共享,删字节
 * 必误伤;未发送的 blob 交回收器),对应历史 cleanup-files 的语义变更。
 *
 * 所有函数接受可注入 db(规则 14);字节路径走 blobStore(指纹/白名单校验)。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import * as blobStore from './blobStore';
import * as ledger from './ledger';
import type { LedgerDb } from './ledger';
import { createLogger } from '../logger';

const log = createLogger('cindy-media/chat');

/** 聊天附件支持的图片扩展名 → mime(与老 imageCacheStore / blobStore 图片集一致)。 */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export interface IngestedChatImage {
  /** `cindy-media://blobs/<hash>.<ext>`——renderer chip / 消息落库共用的永久地址。 */
  url: string;
  /** 展示用文件名(指纹 + 后缀;原始名由调用方自行保留在 originalName 字段)。 */
  filename: string;
}

/**
 * 粘贴/截图字节入仓(草稿语义:blob + 账本行,不挂引用)。
 * 白名单外 mime 抛错,renderer 侧有 base64 内存 fallback 兜底。
 */
export async function ingestChatImageBuffer(
  params: { buffer: Uint8Array; mimeType: string },
  db?: LedgerDb,
): Promise<IngestedChatImage> {
  const written = await blobStore.writeBlob({
    buffer: params.buffer,
    mimeType: params.mimeType,
  });
  await ledger.recordBlob(
    {
      hash: written.hash,
      ext: written.ext,
      mimeType: written.mimeType,
      bytes: written.bytes,
      isCache: false,
    },
    db,
  );
  return { url: written.url, filename: `${written.hash}${written.ext}` };
}

/**
 * 拖拽本地图片文件入仓(草稿语义同上)。mime 按原始文件名扩展名判定,
 * 图片白名单外直接抛错(老 copyFromPath 的 pdf/doc/.bin 落地面是遗留职责,
 * 非媒体文件按规则 25 边界不进字节仓,走 path 直传)。
 */
export async function ingestChatImageFromPath(
  params: { sourcePath: string; originalName?: string },
  db?: LedgerDb,
): Promise<IngestedChatImage> {
  const nameForExt = params.originalName || params.sourcePath;
  const ext = path.extname(nameForExt).toLowerCase();
  const mimeType = IMAGE_MIME_BY_EXT[ext];
  if (!mimeType) {
    throw new Error(`chat-attachments: unsupported image extension: ${ext || '(none)'}`);
  }
  const buffer = await fs.readFile(params.sourcePath);
  return ingestChatImageBuffer({ buffer, mimeType }, db);
}

/**
 * 从任意消息结构里收集 cindy-media blob 地址(发送时 commit 用)。
 * JSON.stringify 后整串正则:blob URL 字符集([0-9a-f].ext)不含任何会被
 * JSON 转义的字符,序列化后子串原样出现,天然穿透嵌套 JSON 字符串
 * (persistedContent 等二次编码场景),比递归遍历简单且无遗漏。
 */
const CINDY_BLOB_URL_RE = /\bcindy-media:\/\/blobs\/[0-9a-f]{64}\.[a-z0-9]+/g;

export function collectCindyMediaUrls(value: unknown): string[] {
  let serialized = '';
  try {
    serialized = JSON.stringify(value) ?? '';
  } catch (err) {
    // 不可序列化(BigInt/循环引用等):附件将失去晋升,留痕便于排查(review P2)。
    log.warn('collectCindyMediaUrls: message not serializable, refs will not be committed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
  return [...new Set(serialized.match(CINDY_BLOB_URL_RE) ?? [])];
}

/** Return validated blob hashes referenced by a message payload. */
export function collectCindyMediaHashes(value: unknown): string[] {
  return [...new Set(
    collectCindyMediaUrls(value)
      .map((url) => blobStore.parseBlobUrl(url)?.hash)
      .filter((hash): hash is string => typeof hash === 'string'),
  )];
}

/**
 * 发送时提交:给消息里的每个 blob 挂 session-attachment 引用(幂等——同
 * 会话同指纹已有引用则跳过,重发/插话不刷重复行)。形状不合法的 URL 跳过。
 * **per-URL 故障隔离**(review P1):单条失败(典型:消息文本里出现本机无账
 * 的外来 blob 地址,addRef 被 FK 拒)只计入 failed,绝不连坐同消息里真实
 * 附件的晋升。
 */
/**
 * 消息落库挂账钩子的业务体(createMessage / updateMessageContent 调用,
 * 规则 14:抽出来内存直测)。content 传**已序列化的行内容字符串**即可——
 * collectCindyMediaUrls 对字符串同样生效,避免对大 tool_result 二次
 * JSON.stringify(review P2)。无 blob 地址时零 DB 访问返回 null。
 */
export async function commitMessageMediaRefs(
  params: { sessionId: string; role: string; content: unknown },
  db?: LedgerDb,
): Promise<{ committed: number; skipped: number; failed: number } | null> {
  const urls = collectCindyMediaUrls(params.content);
  if (urls.length === 0) return null;
  return commitChatImageUrls(
    {
      sessionId: params.sessionId,
      urls,
      originKind: params.role === 'user' ? 'user' : 'tool',
    },
    db,
  );
}

export async function commitChatImageUrls(
  params: {
    sessionId: string;
    urls: string[];
    /** 出生来源:用户消息附件 'user'(默认);assistant/tool 消息里的生成产物 'tool'。 */
    originKind?: 'user' | 'tool';
  },
  db?: LedgerDb,
): Promise<{ committed: number; skipped: number; failed: number }> {
  let committed = 0;
  let skipped = 0;
  let failed = 0;
  for (const url of params.urls) {
    const parsed = blobStore.parseBlobUrl(url);
    if (!parsed) {
      skipped += 1;
      continue;
    }
    try {
      // 非 cache 粘性降级(review P1):blob 可能以集成缓存(isCache=true)先入仓,
      // 此刻被聊天消息引用即成为用户可见附件——聊天渲染端没有重下通道,cache
      // 回收器清掉它 = 聊天历史永久缺图。放在 hasRef 之前:幂等且给"首次 commit
      // 时降级失败"留自愈口(同 blob 再次入消息时补降);查无此账 no-op,
      // 外来 blob 地址不受影响。
      await ledger.pinBlob(parsed.hash, db);
      if (await ledger.hasRef({ hash: parsed.hash, refKind: 'session-attachment', refId: params.sessionId }, db)) {
        skipped += 1;
        continue;
      }
      await ledger.addRef(
        {
          hash: parsed.hash,
          refKind: 'session-attachment',
          refId: params.sessionId,
          originSessionId: params.sessionId,
          originKind: params.originKind ?? 'user',
        },
        db,
      );
      committed += 1;
    } catch (err) {
      failed += 1;
      log.warn('commitChatImageUrls: ref commit failed for url', {
        sessionId: params.sessionId,
        hash: parsed.hash,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { committed, skipped, failed };
}
