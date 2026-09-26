/**
 * feishu/attachmentDownloader.ts
 * ---------------------------------------------------------------------------
 * Take the AttachmentRef[] parsed by `incomingContent` → download via lark
 * `im.v1.messageResource.get` → save under `host.paths.feishuMediaDir/{kind}/`
 * → return standardised IMAttachment[] for emit upstream.
 *
 * Files larger than 30MB are dropped into `unsupported` (model + IPC can't
 * handle larger blobs sensibly). Per-attachment errors are isolated; a single
 * failed download does not block the rest.
 */

import path from 'node:path';
import type * as Lark from '@larksuiteoapi/node-sdk';
import type { Readable } from 'node:stream';

import type { IMAttachment } from '../types.js';
import { getLog } from './moduleScope.js';
import {
  ATTACHMENT_OVERSIZE_CODE,
  getOrDownload,
  mimeFromHeaders,
  streamToBuffer,
  type MediaResult,
} from './mediaStore.js';
import type {
  AttachmentRef,
  UnsupportedEntry,
} from './incomingContent.js';

/** Max bytes per attachment. Keeps parity with desktop's `MAX_FILE_SIZE`. */
export const MAX_FILE_SIZE = 30 * 1024 * 1024;

export interface DownloadResult {
  attachments: IMAttachment[];
  unsupported: UnsupportedEntry[];
}

export async function downloadAttachments(
  client: Lark.Client,
  messageId: string,
  refs: AttachmentRef[],
): Promise<DownloadResult> {
  const log = getLog();
  const attachments: IMAttachment[] = [];
  const unsupported: UnsupportedEntry[] = [];

  for (const ref of refs) {
    try {
      const one = await downloadOne(client, messageId, ref);
      if ('attachment' in one) attachments.push(one.attachment);
      else unsupported.push(one.unsupported);
    } catch (err) {
      // 下载中途触顶增量上限:归 oversize(与下载完成后才发现超限同一口径),
      // 而不是 download_failed —— 语义是"文件太大不受支持",重试无意义。
      if ((err as { code?: string })?.code === ATTACHMENT_OVERSIZE_CODE) {
        const name = ref.kind === 'file' ? ref.fileName : '图片';
        unsupported.push({
          type: 'oversize',
          label: `${name} 超过 30MB（已提前中断下载）`,
        });
        continue;
      }
      const msg = err instanceof Error ? err.message : String(err);
      const label =
        ref.kind === 'file'
          ? `下载失败 ${ref.fileName}（${msg}）`
          : `图片下载失败（${msg}）`;
      log.error('[feishu/attachmentDownloader] download failed:', err);
      unsupported.push({ type: `download_failed:${ref.kind}`, label });
    }
  }

  return { attachments, unsupported };
}

type SingleResult =
  | { attachment: IMAttachment }
  | { unsupported: UnsupportedEntry };

async function downloadOne(
  client: Lark.Client,
  messageId: string,
  ref: AttachmentRef,
): Promise<SingleResult> {
  const token = ref.kind === 'image' ? ref.imageKey : ref.fileKey;
  const sdkType: 'image' | 'file' = ref.kind;
  const givenExt =
    ref.kind === 'file' ? path.extname(ref.fileName).toLowerCase() : undefined;

  const result = await getOrDownload(
    token,
    ref.kind,
    async (key) => fetchMessageResource(client, messageId, key, sdkType),
    givenExt && givenExt.length > 0 ? givenExt : undefined,
  );

  if (result.bytes > MAX_FILE_SIZE) {
    const sizeMb = (result.bytes / 1024 / 1024).toFixed(1);
    const name = ref.kind === 'file' ? ref.fileName : '图片';
    return {
      unsupported: {
        type: 'oversize',
        label: `${name} 超过 30MB（实际 ${sizeMb}MB）`,
      },
    };
  }

  const originalName =
    ref.kind === 'file' ? ref.fileName : `${ref.imageKey}${path.extname(result.absPath)}`;

  return {
    attachment: deriveAttachment(ref.kind, result, originalName),
  };
}

function deriveAttachment(
  kind: 'image' | 'file',
  result: MediaResult,
  originalName: string,
): IMAttachment {
  return {
    kind,
    absPath: result.absPath,
    originalName,
    mimeType: result.mimeType,
    // 仅媒体总仓地址(cindy-media://)透传给 host 落库挂引用;老 xdt-image
    // 地址保持历史行为不进落库 content(避免改变既有渲染面)。
    ...(result.xdtImageUrl.startsWith('cindy-media://') ? { url: result.xdtImageUrl } : {}),
  };
}

async function fetchMessageResource(
  client: Lark.Client,
  messageId: string,
  fileKey: string,
  type: 'image' | 'file',
): Promise<{ buffer: Buffer; mimeType: string }> {
  const res = (await client.im.v1.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type },
  })) as unknown as {
    getReadableStream(): Readable;
    headers?: Record<string, unknown>;
  };

  // 增量上限:超限立刻断流,不让超大附件整只进内存/落盘后才被拒。
  const buffer = await streamToBuffer(res.getReadableStream(), MAX_FILE_SIZE);
  const mimeType = mimeFromHeaders(res.headers);
  return { buffer, mimeType };
}
