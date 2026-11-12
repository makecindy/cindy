/**
 * feishu/mediaStore.ts
 * ---------------------------------------------------------------------------
 * 飞书资源下载的字节/头解析小工具。入站附件不再落 `host.paths.feishuMediaDir`
 * (`cc-agent/feishu-media` 是冻结的历史兼容层, 只读): 图片/音视频进 host 媒体
 * 总仓, 其余文件交 host 文件暂存, 路由见 attachmentDownloader.ts。历史
 * `xdt-image://feishu-media-*` 地址的读取仍由 mediaCache.ts 负责。
 */

/** Drain a Node `Readable` into a Buffer. */
export async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Pull a `content-type` header (case-insensitive) and strip parameters. */
export function mimeFromHeaders(
  headers: Record<string, unknown> | undefined,
): string {
  if (!headers) return 'application/octet-stream';
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'content-type') {
      const raw = Array.isArray(v) ? String(v[0]) : String(v);
      return raw.split(';')[0]!.trim() || 'application/octet-stream';
    }
  }
  return 'application/octet-stream';
}
