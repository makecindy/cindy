/**
 * imageRef.ts (image-local-cache M7)
 * ---------------------------------------------------------------------------
 * Type definitions and JSON parse/stringify helpers for the new persisted
 * shape of `Message.content` (role=user).
 *
 * Old format: `content` was a plain string (just the user-typed text).
 * New format: `content` is the JSON-stringified shape:
 *     { text: string, images: ImageRef[], files: FileRef[] }
 *
 * Compatibility: the parse helper recognises both formats — pre-existing
 * messages whose content is a non-JSON string are returned as-is with empty
 * images / files lists, so no server-side migration is needed.
 */

import { isValidAttachmentIntegrity } from '@cindy/device-link';
import {
  parsePersistedSessionReferenceMetadata,
  type PersistedSessionReferenceMetadata,
} from '../../shared/sessionReferenceMetadata';
import {
  readAgentInputReferences,
  type AgentInputReference,
} from '@cindy/maker-shared/agent-input-projection';

export interface ImageRef {
  /** Custom-protocol URL: 'xdt-image://{sessionId}/{filename}'. */
  url: string;
  /** image/png | image/jpeg | image/gif | image/webp. */
  mimeType: string;
  /** Original filename — used as alt text and missing-image placeholder label. */
  originalName: string;
  /** 发送端声明的原始上传字节数；与 sha256 成对出现。 */
  size?: number;
  /** 发送端声明的上传字节 SHA-256。 */
  sha256?: string;
  /**
   * 非破坏性标注(可选,向后兼容):`url` 是烧录合成图(定格模型所见)时,
   * 这里指向未烧录**原图**的缓存 url。历史图"再编辑"用它 + strokes 还原
   * 可撤销的矢量标注;原图被清理(引用悬空)时降级为在烧录图上叠新标。
   */
  annotationSourceUrl?: string;
  /** 非破坏性标注:归一化矢量笔迹(0..1 相对原图自然尺寸)。 */
  annotationStrokes?: Array<{ points: Array<{ x: number; y: number }> }>;
}

/**
 * Persisted shape for a non-image user attachment.
 * Mirrors ImageRef's "store pointer only" philosophy — only what the renderer
 * needs to re-display the chip. Inline bytes (base64 / textContent) and
 * ext / size / category / mimeType are intentionally NOT persisted: the
 * TextLightbox re-reads from `path` on demand, just like the ImageRef url
 * flow. Shape is deliberately identical to UserMessage's file prop type
 * (Array<{ name: string; path: string }>) — zero adapter on the renderer side.
 */
export interface FileRef {
  name: string;
  path: string;
  size?: number;
  sha256?: string;
}

/** Local-only presentation metadata for a long-paste atom in user text. */
export interface PastedTextRange {
  start: number;
  end: number;
  display: string;
}

/** Local-only presentation metadata for a slash command confirmed by the composer roster. */
export interface SlashCommandRange {
  start: number;
  end: number;
}

export interface UserMessageContent {
  text: string;
  images: ImageRef[];
  files: FileRef[];
  /** Resolved range summaries for session links present in this user message. */
  sessionReferences?: PersistedSessionReferenceMetadata[];
  /**
   * chat-text-quote:本消息的开头 blockquote 是"选中文字引用"功能产出,
   * 渲染层据此(且仅据此)把引用块收敛为 "N 处引用" 胶囊。缺省 / 历史消息 /
   * 用户手打的 markdown 引用不带该标志 → 原样渲染,存量呈现不变。
   */
  quotesEncoded?: boolean;
  /** Long-paste ranges affect rendering only; `text` remains the Agent payload. */
  pastedTextRanges?: PastedTextRange[];
  /**
   * Exact slash-command ranges confirmed by the composer roster. An empty array
   * is meaningful: this is a new message with no confirmed slash commands, so
   * the history renderer must not fall back to its legacy line-start heuristic.
   */
  slashCommandRanges?: SlashCommandRange[];
  /** Hidden semantic projection metadata; message bubbles still render `text`. */
  agentReferences?: AgentInputReference[];
}

function basenameForAttachment(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  const name = normalized.slice(normalized.lastIndexOf('/') + 1);
  return name || 'attachment';
}

/**
 * Parse a `Message.content` value into { text, images, files }.
 *
 * Three input shapes are supported (type-dispatched), so historical messages
 * round-tripped through localDb's `messageToCamel` (which JSON.parses the
 * TEXT column back into objects/arrays) render correctly:
 *
 *   1. string  — legacy plain text OR JSON-stringified `{text, images, files}`
 *                OR JSON-stringified SDK content blocks `[{type,...}]`.
 *                Strings that look like JSON ('{' / '[' lead) are parsed
 *                and recursed into the relevant branch.
 *   2. array   — SDK-native content blocks: `[{type:'text',text},
 *                {type:'image',...}]`. Text blocks are concatenated and
 *                attachment blocks are projected into `{images, files}` so
 *                legacy IM messages remain renderable after a restart.
 *   3. object  — `{text, images, files}` shape produced by stringifyUserContent
 *                AFTER messageToCamel has parsed it back into an object.
 *
 * Anything else (null/undefined/number/unknown object shape) falls through
 * to a defensive stringify — preserving the original "don't crash" intent
 * but only firing on truly unknown shapes, not on legitimate parsed payloads.
 */
export function parseUserContent(content: unknown): UserMessageContent {
  // ── Branch 1: string ─────────────────────────────────────────────────────
  if (typeof content === 'string') {
    if (content.length === 0) return { text: '', images: [], files: [] };
    const first = content[0];
    if (first === '{' || first === '[') {
      try {
        const parsed = JSON.parse(content) as unknown;
        return parseUserContent(parsed);
      } catch {
        return { text: content, images: [], files: [] };
      }
    }
    return { text: content, images: [], files: [] };
  }

  // ── Branch 2: array — SDK-native content blocks ──────────────────────────
  if (Array.isArray(content)) {
    const textParts: string[] = [];
    const images: ImageRef[] = [];
    const files: FileRef[] = [];
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') {
          textParts.push(b.text);
        }
        if (b.type === 'image') {
          const image = coerceImageRef({
            url: b.url,
            mimeType: b.mimeType,
            originalName:
              typeof b.originalName === 'string'
                ? b.originalName
                : typeof b.path === 'string'
                  ? basenameForAttachment(b.path)
                  : undefined,
          });
          if (image) images.push(image);
        }
        if (b.type === 'file' && typeof b.path === 'string') {
          files.push({
            name:
              typeof b.name === 'string'
                ? b.name
                : typeof b.originalName === 'string'
                  ? b.originalName
                  : basenameForAttachment(b.path),
            path: b.path,
          });
        }
        // Unknown block types remain intentionally ignored.
      }
    }
    return { text: textParts.join(''), images, files };
  }

  // ── Branch 3: object — already-parsed {text, images, files} shape ────────
  if (content && typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === 'string') {
      const rawImages = Array.isArray(obj.images) ? obj.images : [];
      const images = rawImages.map(coerceImageRef).filter((ref): ref is ImageRef => ref !== null);
      const rawFiles = Array.isArray(obj.files) ? obj.files : [];
      const files = rawFiles.filter(isValidFileRef);
      const sessionReferences = parsePersistedSessionReferenceMetadata(obj.sessionReferences);
      const pastedTextRanges = coercePastedTextRanges(obj.pastedTextRanges, obj.text);
      const slashCommandRanges = coerceSlashCommandRanges(obj.slashCommandRanges, obj.text);
      const agentReferences = readAgentInputReferences(obj.agentReferences, obj.text);
      return {
        text: obj.text,
        images,
        files,
        ...(sessionReferences.length > 0 ? { sessionReferences } : {}),
        ...(obj.quotesEncoded === true ? { quotesEncoded: true } : {}),
        ...(pastedTextRanges.length > 0 ? { pastedTextRanges } : {}),
        ...(slashCommandRanges !== null ? { slashCommandRanges } : {}),
        ...(agentReferences.length > 0 ? { agentReferences } : {}),
      };
    }
    // Truly unknown object shape — preserve old defensive stringify behaviour.
    return { text: JSON.stringify(content), images: [], files: [] };
  }

  // ── Branch 4: null / undefined / number / boolean / symbol ───────────────
  return { text: String(content ?? ''), images: [], files: [] };
}

/**
 * Coerce a persisted image entry into ImageRef, or null if invalid.
 *
 * Accepts both filename field spellings: desktop persists `originalName`,
 * while historical mobile clients persisted `name` (schema drift shipped in
 * apps/mobile buildAttachmentPersistImageRefs — since fixed to write
 * `originalName`, but messages already stored with `name` must keep
 * rendering). Output is always normalised to `originalName`.
 */
/** 可渲染的托管图片地址:历史 xdt-image:// 或媒体总仓 cindy-media://。 */
function isManagedImageUrl(url: string): boolean {
  return url.startsWith('xdt-image://') || url.startsWith('cindy-media://');
}

function coerceImageRef(x: unknown): ImageRef | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  if (typeof o.url !== 'string' || !isManagedImageUrl(o.url)) return null;
  if (typeof o.mimeType !== 'string') return null;
  const originalName =
    typeof o.originalName === 'string'
      ? o.originalName
      : typeof o.name === 'string'
        ? o.name
        : null;
  if (originalName === null) return null;
  const ref: ImageRef = { url: o.url, mimeType: o.mimeType, originalName };
  const integrity = { size: o.size, sha256: o.sha256 };
  if (isValidAttachmentIntegrity(integrity)) {
    ref.size = integrity.size;
    ref.sha256 = integrity.sha256;
  }
  // 非破坏性标注字段:形状校验通过才成对透传(review P2:此前 coerce 只取
  // 三字段,重载 / 从存储取回后历史图丢失可再编辑数据)。半份数据没有意义,
  // 任一不合法就整体丢弃,退化为普通烧录图展示。
  const strokes = coerceAnnotationStrokes(o.annotationStrokes);
  if (
    strokes &&
    typeof o.annotationSourceUrl === 'string' &&
    isManagedImageUrl(o.annotationSourceUrl)
  ) {
    ref.annotationSourceUrl = o.annotationSourceUrl;
    ref.annotationStrokes = strokes;
  }
  return ref;
}

/** 校验并复制持久化笔迹数组;任何一处形状不合法返回 null(整体丢弃)。 */
function coerceAnnotationStrokes(
  x: unknown,
): Array<{ points: Array<{ x: number; y: number }> }> | null {
  if (!Array.isArray(x) || x.length === 0) return null;
  const strokes: Array<{ points: Array<{ x: number; y: number }> }> = [];
  for (const raw of x) {
    if (!raw || typeof raw !== 'object') return null;
    const points = (raw as { points?: unknown }).points;
    if (!Array.isArray(points) || points.length === 0) return null;
    const copied: Array<{ x: number; y: number }> = [];
    for (const p of points) {
      // p 可能是 null / 原始值:先判对象再取值,否则解引用直接 throw,
      // 一条坏笔迹记录会炸掉整个会话的消息加载(review P2)。
      if (!p || typeof p !== 'object') return null;
      const px = (p as { x?: unknown }).x;
      const py = (p as { y?: unknown }).y;
      if (
        typeof px !== 'number' ||
        typeof py !== 'number' ||
        !Number.isFinite(px) ||
        !Number.isFinite(py)
      ) {
        return null;
      }
      copied.push({ x: px, y: py });
    }
    strokes.push({ points: copied });
  }
  return strokes;
}

function isValidFileRef(x: unknown): x is FileRef {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (typeof o.name !== 'string' || typeof o.path !== 'string') return false;
  const hasSize = o.size !== undefined;
  const hasSha256 = o.sha256 !== undefined;
  return (
    (!hasSize && !hasSha256) ||
    (hasSize && hasSha256 && isValidAttachmentIntegrity({ size: o.size, sha256: o.sha256 }))
  );
}

function coercePastedTextRanges(value: unknown, text: string): PastedTextRange[] {
  if (!Array.isArray(value)) return [];
  const ranges: PastedTextRange[] = [];
  let previousEnd = 0;
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') return [];
    const range = candidate as Record<string, unknown>;
    if (
      !Number.isInteger(range.start) ||
      !Number.isInteger(range.end) ||
      typeof range.display !== 'string'
    ) {
      return [];
    }
    const start = range.start as number;
    const end = range.end as number;
    if (start < previousEnd || start < 0 || end <= start || end > text.length) return [];
    ranges.push({ start, end, display: range.display });
    previousEnd = end;
  }
  return ranges;
}

function coerceSlashCommandRanges(value: unknown, text: string): SlashCommandRange[] | null {
  if (!Array.isArray(value)) return null;
  const ranges: SlashCommandRange[] = [];
  let previousEnd = 0;
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') return null;
    const range = candidate as Record<string, unknown>;
    if (!Number.isInteger(range.start) || !Number.isInteger(range.end)) return null;
    const start = range.start as number;
    const end = range.end as number;
    if (start < previousEnd || start < 0 || end <= start || end > text.length) return null;
    if (!/^\/\S+$/.test(text.slice(start, end))) return null;
    ranges.push({ start, end });
    previousEnd = end;
  }
  return ranges;
}

/**
 * Serialize a user message into the new content shape. Always emits the JSON
 * form (even for empty `images` / `files`) so future readers see a uniform schema.
 *
 * `files` defaults to `[]` so legacy callers that haven't been upgraded still
 * produce a well-formed payload (and we never accidentally emit `files: undefined`,
 * which JSON.stringify would silently drop).
 */
export function stringifyUserContent(
  text: string,
  images: ImageRef[],
  files: FileRef[] = [],
  quotesEncoded = false,
  pastedTextRangesOrSessionReferences: PastedTextRange[] | PersistedSessionReferenceMetadata[] = [],
  slashCommandRanges?: SlashCommandRange[],
  sessionReferences: PersistedSessionReferenceMetadata[] = [],
  agentReferences: AgentInputReference[] = [],
): string {
  const fifthArgIsSessionReferences =
    pastedTextRangesOrSessionReferences.length > 0 &&
    'sessionId' in pastedTextRangesOrSessionReferences[0];
  const pastedTextRanges = fifthArgIsSessionReferences
    ? []
    : (pastedTextRangesOrSessionReferences as PastedTextRange[]);
  const resolvedSessionReferences = fifthArgIsSessionReferences
    ? (pastedTextRangesOrSessionReferences as PersistedSessionReferenceMetadata[])
    : sessionReferences;
  // Long-paste metadata is omitted when empty. Slash metadata keeps an explicit
  // empty array so new messages never fall back to the historical line-start guess.
  return JSON.stringify({
    text,
    images,
    files,
    ...(quotesEncoded ? { quotesEncoded: true } : {}),
    ...(pastedTextRanges.length > 0 ? { pastedTextRanges } : {}),
    ...(slashCommandRanges !== undefined ? { slashCommandRanges } : {}),
    ...(resolvedSessionReferences.length > 0
      ? { sessionReferences: resolvedSessionReferences }
      : {}),
    ...(agentReferences.length > 0 ? { agentReferences } : {}),
  });
}
