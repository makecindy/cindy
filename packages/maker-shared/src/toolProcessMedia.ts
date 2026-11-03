/** Native tool media stays with its tool step; explicit delivered media is unchanged. */
export interface NativeToolMedia {
  kind: "image" | "video";
  data?: string;
  mimeType?: string;
  url?: string;
  path?: string;
}
export interface ProcessMediaRef {
  kind: "image" | "video";
  url: string;
}

const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

/** MCP, Anthropic and Pi content blocks. Never infer media from prose or commands. */
export function collectNativeToolMedia(content: unknown): NativeToolMedia[] {
  if (!Array.isArray(content)) return [];
  const result: NativeToolMedia[] = [];
  for (const value of content) {
    const block = record(value);
    if (!block) continue;
    const source = record(block.source);
    const resource = record(block.resource);
    const mime = source?.media_type ?? block.mimeType ?? resource?.mimeType;
    const kind =
      block.type === "video" ||
      (typeof mime === "string" && mime.startsWith("video/"))
        ? "video"
        : block.type === "image" ||
            block.type === "inputImage" ||
            (typeof mime === "string" && mime.startsWith("image/"))
          ? "image"
          : null;
    if (!kind) continue;
    const data = source?.data ?? block.data ?? resource?.blob;
    const url = source?.url ?? block.imageUrl ?? resource?.uri ?? block.uri;
    if (typeof data === "string" && typeof mime === "string") {
      result.push({ kind, data, mimeType: mime });
    } else if (typeof url === "string") result.push({ kind, url });
  }
  return result;
}

export function isProcessMediaUrl(url: string): boolean {
  return (
    /^cindy-media:\/\/blobs\/[a-f0-9]{64}\.(?:png|jpg|jpeg|gif|webp|mp4|webm|mov)$/.test(
      url,
    ) ||
    /^xdt-(?:image|video):\/\//.test(url) ||
    /^https?:\/\//.test(url)
  );
}

export function readToolProcessMedia(
  text: string | undefined,
): ProcessMediaRef[] {
  if (!text?.includes("cindy_process_media")) return [];
  try {
    const parsed = record(JSON.parse(text));
    if (!Array.isArray(parsed?.cindy_process_media)) return [];
    return parsed.cindy_process_media.flatMap((value): ProcessMediaRef[] => {
      const item = record(value);
      return item &&
        (item.kind === "image" || item.kind === "video") &&
        typeof item.url === "string" &&
        isProcessMediaUrl(item.url)
        ? [{ kind: item.kind, url: item.url }]
        : [];
    });
  } catch {
    return [];
  }
}

/** Strip only our presentation envelope; keep ordinary JSON tool output intact. */
export function readToolProcessText(text: string | undefined): string | undefined {
  if (!text?.includes("cindy_process_media")) return text;
  try {
    const value = record(JSON.parse(text));
    if (!Array.isArray(value?.cindy_process_media)) return text;
    const { cindy_process_media: _media, cindy_process_media_omitted: _omitted, ...body } = value;
    return Object.keys(body).length === 1 && typeof body.text === "string"
      ? body.text : JSON.stringify(body, null, 2);
  } catch { return text; }
}

export function withToolProcessMedia(
  text: string,
  media: ProcessMediaRef[],
): string {
  let payload: Record<string, unknown> = { text };
  try {
    payload = record(JSON.parse(text)) ?? payload;
  } catch {
    /* ordinary tool text */
  }
  const bytes = new TextEncoder();
  const kept: ProcessMediaRef[] = [];
  // Reserve the complete envelope and an omitted-count field before adding references.
  // A single oversized signed URL must not prevent later small references from fitting.
  let remaining = 8192 - bytes.encode(JSON.stringify({
    text: "", cindy_process_media: [], cindy_process_media_omitted: media.length,
  })).length;
  for (const item of media) {
    const cost = bytes.encode(JSON.stringify(item)).length + (kept.length ? 1 : 0);
    if (cost > remaining) continue;
    kept.push(item);
    remaining -= cost;
  }
  const omitted = media.length - kept.length;
  const encode = (value: Record<string, unknown>) => {
    const { cindy_process_media: _media, cindy_process_media_omitted: _omitted, ...body } = value;
    return JSON.stringify({ ...body, cindy_process_media: kept,
      ...(omitted ? { cindy_process_media_omitted: omitted } : {}) });
  };
  const encoded = encode(payload);
  // Remote history has an 8KB byte budget. Truncate prose, never cut JSON or a URL.
  if (bytes.encode(encoded).length <= 8192) return encoded;
  const originalText = typeof payload.text === 'string' ? payload.text : text;
  const truncatedPayload = (value: string) =>
    typeof payload.text === 'string' ? { ...payload, text: value } : { text: value };
  // 同级字段本身已超限时无法全部保留，退回有界的纯文本 envelope，仍不能超出预算。
  if (bytes.encode(encode(truncatedPayload(''))).length > 8192) {
    return encode({ text: '' });
  }
  let low = 0;
  let high = originalText.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (bytes.encode(encode(truncatedPayload(originalText.slice(0, mid)))).length <= 8192)
      low = mid;
    else high = mid - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/.test(originalText[low - 1])) low--;
  return encode(truncatedPayload(originalText.slice(0, low)));
}

export function nativeToolMediaFields(content: unknown): {
  processMedia?: NativeToolMedia[];
} {
  const processMedia = collectNativeToolMedia(content);
  return processMedia.length ? { processMedia } : {};
}

/** Only the Host-issued delivery record enables retry; arbitrary paths/URLs never do. */
export function readFailedImageDelivery(text: string | undefined): string | null {
  if (!text?.includes('native_image_delivery')) return null;
  try {
    const value = record(JSON.parse(text));
    const delivery = record(value?.native_image_delivery);
    return value?.kind === 'generation' && delivery?.state === 'failed'
      && typeof delivery.id === 'string' && /^[a-f0-9]{64}$/.test(delivery.id)
      ? delivery.id : null;
  } catch { return null; }
}
