import { piEditReplacements } from './toolUseDescriptor.js';
import { presentationText, type PresentationLocalizer } from './presentationLocalization.js';

export type PayloadKind = 'text' | 'diff' | 'media' | 'mermaid' | 'file';

export interface PayloadToolDiffLike {
  filePath: string;
  segments: Array<{ key: string; oldString: string; newString: string; label?: string }>;
  insertions: number;
  deletions: number;
}

export interface PayloadMediaActionButtonLike {
  customId: string;
  label?: string;
  emoji?: string;
}

export interface PayloadMediaActionsLike {
  provider: string;
  jobId: string;
  buttons: PayloadMediaActionButtonLike[];
}

export interface ExtractedPayloadToolMediaActionsLike {
  provider: 'mivo';
  jobId: string;
  buttons: PayloadMediaActionButtonLike[];
}

export interface PayloadMediaLike {
  kind: 'image' | 'video' | 'audio';
  url: string;
  title?: string;
  previewable: boolean;
  actions?: PayloadMediaActionsLike;
}

export interface ExtractedPayloadToolMediaLike {
  kind: 'image' | 'video' | 'audio';
  url: string;
  title?: string;
  previewable: boolean;
  actions?: ExtractedPayloadToolMediaActionsLike;
}

export interface PayloadAttachmentLike {
  kind: 'image' | 'file';
  name: string;
  uri?: string;
  path?: string;
  mimeType?: string;
  previewable: boolean;
}

export interface PayloadAttachmentMediaLike {
  kind: 'image' | 'video' | 'audio';
  url: string;
  title: string;
  previewable: boolean;
}

export type SharedMessagePayload<
  Diff extends PayloadToolDiffLike = PayloadToolDiffLike,
  Media extends PayloadMediaLike = PayloadMediaLike,
> =
  | {
      kind: 'text';
      title: string;
      body: string;
    }
  | {
      kind: 'diff';
      title: string;
      diff: Diff;
      body: string;
    }
  | {
      kind: 'media';
      title: string;
      media: Media;
      body: string;
    }
  | {
      kind: 'mermaid';
      title: string;
      body: string;
    }
  | {
      kind: 'file';
      title: string;
      body: string;
      sourcePath?: string;
    };

export type AttachmentMessagePayload =
  | Extract<SharedMessagePayload<PayloadToolDiffLike, PayloadAttachmentMediaLike>, { kind: 'media' }>
  | Extract<SharedMessagePayload, { kind: 'file' }>;

export interface MessagePayloadSummary {
  kind: PayloadKind;
  kindLabel: string;
  title: string;
  subtitle?: string;
  copyableText?: string;
  sourcePath?: string;
  openTarget?: {
    kind: 'url' | 'file';
    value: string;
  };
}

export interface MessagePayloadBodyPresentation {
  bodyText: string;
  emptyText: string;
  kind: PayloadKind;
  textMonospace: boolean;
  diff?: {
    filePath: string;
    sectionCount: number;
    stats: string;
  };
  file?: {
    displayPath: string;
    sourcePath: string;
  };
  media?: {
    canDirectOpen: boolean;
    canInlineDirectImage: boolean;
    canInlineDirectPlayer: boolean;
    directPreviewable: boolean;
    kindLabel: string;
    needsRemoteFetch: boolean;
    placeholderText: string;
    remoteIdleText: string;
    unsupportedText: string;
  };
  mermaid?: {
    source: string;
  };
}

export type MessagePayloadPreviewSeverity = 'neutral' | 'info' | 'warning';

export type MessagePayloadPreviewActionKind =
  | 'view'
  | 'copy'
  | 'fetch-remote-media'
  | 'open-url'
  | 'preview-file';

export interface MessagePayloadPreviewOptions {
  maxPreviewChars?: number;
}

export interface MessagePayloadPreview {
  kind: PayloadKind;
  title: string;
  detail: string;
  previewText: string;
  severity: MessagePayloadPreviewSeverity;
  actionKind: MessagePayloadPreviewActionKind;
  actionLabel: string;
  meta: string[];
  canInlinePreview: boolean;
  needsRemoteFetch: boolean;
  shouldUseMonospacePreview: boolean;
}

export type FormattedDiffPayloadRowKind = 'header' | 'stats' | 'segment' | 'delete' | 'add';

export interface FormattedDiffPayloadRow {
  key: string;
  kind: FormattedDiffPayloadRowKind;
  text: string;
}

export interface FormattedDiffPayloadLine {
  key: string;
  lineNumber: number;
  text: string;
}

export interface FormattedDiffPayloadSection {
  key: string;
  label: string;
  oldLines: FormattedDiffPayloadLine[];
  newLines: FormattedDiffPayloadLine[];
}

export interface FormattedDiffPayloadView {
  filePath: string;
  stats: string;
  sections: FormattedDiffPayloadSection[];
}

export function buildTextPayload(title: string, body: string): Extract<SharedMessagePayload, { kind: 'text' }> {
  return { kind: 'text', title, body };
}

export function buildDiffPayload<Diff extends PayloadToolDiffLike>(
  diff: Diff,
  localizer?: PresentationLocalizer,
): Extract<SharedMessagePayload<Diff>, { kind: 'diff' }> {
  return {
    kind: 'diff',
    title: diff.filePath,
    diff,
    body: formatDiffPayload(diff, localizer),
  };
}

export function formatPayloadToolUseSummary(toolName: string, input: unknown): string {
  const inp = readPayloadRecord(input);
  if (!inp) return `${toolName}()`;
  const keyParamMap: Record<string, string[]> = {
    Read: ['file_path', 'path'],
    Edit: ['file_path'],
    Write: ['file_path'],
    Bash: ['command'],
    Glob: ['pattern'],
    Grep: ['pattern'],
    // pi 内置工具:名字全小写、文件参数为 path(见 toolUseDescriptor.ts 数据来源约定)。
    read: ['path'],
    edit: ['path'],
    write: ['path'],
    ls: ['path'],
    bash: ['command'],
    grep: ['pattern'],
    find: ['pattern'],
  };
  const keys = keyParamMap[toolName];
  if (!keys) return `${toolName}()`;
  for (const key of keys) {
    const value = inp[key];
    if (value == null || value === '') continue;
    const raw = String(value);
    const display = raw.length > 60 ? `${raw.slice(0, 57)}...` : raw;
    return `${toolName}(${display})`;
  }
  return `${toolName}()`;
}

export function buildPayloadToolDiff(toolName: string, input: unknown): PayloadToolDiffLike | undefined {
  const inp = readPayloadRecord(input);
  if (!inp) return undefined;
  const filePath = readPayloadString(inp.file_path) ?? readPayloadString(inp.path);
  if (!filePath) return undefined;

  if (toolName === 'Edit') {
    const oldString = typeof inp.old_string === 'string' ? inp.old_string : '';
    const newString = typeof inp.new_string === 'string' ? inp.new_string : '';
    return createPayloadToolDiff(filePath, [{ key: 'edit:0', oldString, newString }]);
  }
  if (toolName === 'Write' || toolName === 'write') {
    const newString = typeof inp.content === 'string' ? inp.content : '';
    return createPayloadToolDiff(filePath, [{ key: 'write:0', oldString: '', newString }]);
  }
  // pi edit:两种入参形态由 piEditReplacements 统一归一化(edits[] + legacy 顶层单段)。
  if (toolName === 'edit') {
    const replacements = piEditReplacements(inp);
    return createPayloadToolDiff(filePath, replacements.map((edit, index) => ({
      key: `edit:${index}`,
      oldString: edit.oldText,
      newString: edit.newText,
      // 单段时不标 1/1 —— 顶层 legacy 形态就是单段,标号只是噪音。
      ...(replacements.length > 1 ? { label: `Edit ${index + 1}/${replacements.length}` } : {}),
    })));
  }
  if (toolName === 'MultiEdit') {
    const edits = Array.isArray(inp.edits) ? inp.edits : [];
    return createPayloadToolDiff(filePath, edits.map((edit, index) => {
      const record = readPayloadRecord(edit);
      return {
        key: `edit:${index}`,
        oldString: typeof record?.old_string === 'string' ? record.old_string : '',
        newString: typeof record?.new_string === 'string' ? record.new_string : '',
        label: `Edit ${index + 1}/${edits.length}`,
      };
    }));
  }
  return undefined;
}

export function buildMediaPayload<Media extends PayloadMediaLike>(
  media: Media,
  label: string,
  localizer?: PresentationLocalizer,
): Extract<SharedMessagePayload<PayloadToolDiffLike, Media>, { kind: 'media' }> {
  const actionNotice = formatMediaActionNotice(media, localizer);
  return {
    kind: 'media',
    title: label,
    media,
    body: [
      media.previewable
        ? media.url
        : `${payloadPresentationText(localizer, 'remoteFetchBody', '移动端会尝试从远程电脑取回媒体。')}\n\n${media.url}`,
      actionNotice,
    ].filter(Boolean).join('\n\n'),
  };
}

export function buildFilePayload(
  title: string,
  sourcePath: string,
  localizer?: PresentationLocalizer,
): Extract<SharedMessagePayload, { kind: 'file' }> {
  return {
    kind: 'file',
    title,
    body: sourcePath || payloadPresentationText(localizer, 'missingRemotePath', '没有可展示的远程路径'),
    sourcePath: sourcePath || undefined,
  };
}

export function buildAttachmentPayload(
  attachment: PayloadAttachmentLike,
  localizer?: PresentationLocalizer,
): AttachmentMessagePayload {
  if (attachment.kind === 'image' && attachment.uri) {
    return buildMediaPayload({
      kind: 'image',
      previewable: attachment.previewable,
      title: attachment.name,
      url: attachment.uri,
    }, attachment.name, localizer);
  }

  const sourcePath = attachment.path || attachment.uri || '';
  const mimeType = attachment.mimeType?.trim().toLowerCase().split(';', 1)[0] ?? '';
  const mediaKind =
    mimeType.startsWith('video/') ? 'video' : mimeType.startsWith('audio/') ? 'audio' : null;
  // User-message persistence historically has only images[] and files[].
  // Audio/video therefore remain files on disk, but a managed-media URL plus
  // its MIME is enough to route mobile playback through remote-media fetch.
  if (mediaKind && isPayloadDesktopLocalMediaUrl(sourcePath)) {
    return buildMediaPayload(
      {
        kind: mediaKind,
        previewable: attachment.previewable,
        title: attachment.name,
        url: sourcePath,
      },
      attachment.name,
      localizer,
    );
  }
  return buildFilePayload(attachment.name, sourcePath, localizer);
}

export function extractPayloadToolResultMedia(toolResult: string): ExtractedPayloadToolMediaLike[] {
  if (!toolResult || typeof toolResult !== 'string') return [];
  if (!toolResult.includes("xdt_")) return [];
  const parsed = parseToolResultPayload(toolResult);
  if (!parsed || parsed._xdt_render_image === false) return [];

  const items: ExtractedPayloadToolMediaLike[] = [];
  const actions = parsePayloadToolMediaActions(parsed._xdt_actions);
  const push = (
    kind: ExtractedPayloadToolMediaLike['kind'],
    url: string,
    title?: string,
    mediaActions?: ExtractedPayloadToolMediaActionsLike,
  ) => {
    items.push({
      kind,
      url,
      title,
      previewable: isPayloadDirectPreviewableUrl(url),
      ...(mediaActions ? { actions: mediaActions } : {}),
    });
  };

  // 图片/视频双协议:老 xdt-image/xdt-video(历史消息)+ 新 cindy-media(媒体总仓
  // 迁移后 art/mivo/codex 生成产物的地址形态,字段名不变、值换协议)。
  const isManagedImageUrl = (url: string): boolean =>
    url.startsWith('xdt-image://') || url.startsWith('cindy-media://');
  const isManagedVideoUrl = (url: string): boolean =>
    url.startsWith('xdt-video://') || url.startsWith('cindy-media://');
  if (typeof parsed.xdt_image_url === 'string' && isManagedImageUrl(parsed.xdt_image_url)) {
    push('image', parsed.xdt_image_url, undefined, actions);
  }
  if (Array.isArray(parsed.xdt_image_urls)) {
    for (const url of parsed.xdt_image_urls) {
      if (typeof url === 'string' && isManagedImageUrl(url)) {
        push('image', url, undefined, actions);
      }
    }
  }
  if (typeof parsed.xdt_video_url === 'string' && isManagedVideoUrl(parsed.xdt_video_url)) {
    push('video', parsed.xdt_video_url, undefined, actions);
  }
  if (Array.isArray(parsed.xdt_video_urls)) {
    for (const url of parsed.xdt_video_urls) {
      if (typeof url === 'string' && isManagedVideoUrl(url)) {
        push('video', url, undefined, actions);
      }
    }
  }

  // 音频双世界:老 _xdt_audio_tracks + xdt-audio://(退役 lizi_mivo MCP 历史消息)
  // + 新 xdt_audio_tracks + cindy-media://(意识 xd-mivo 等,cindy-tools hoist 上提)。
  const isManagedAudioUrl = (url: string): boolean =>
    url.startsWith('xdt-audio://') || url.startsWith('cindy-media://');
  const rawAudioTracks = parsed.xdt_audio_tracks ?? parsed._xdt_audio_tracks;
  const audioTracks = Array.isArray(rawAudioTracks) ? rawAudioTracks : [];
  for (const raw of audioTracks) {
    const track = readPayloadRecord(raw);
    const audioUrl = readPayloadString(track?.xdt_audio_url) ?? readPayloadString(track?.audioUrl);
    if (audioUrl && isManagedAudioUrl(audioUrl)) {
      push('audio', audioUrl, readPayloadString(track?.title) ?? undefined);
    }
  }
  if (items.every((item) => item.kind !== 'audio') && Array.isArray(parsed.xdt_audio_urls)) {
    for (const url of parsed.xdt_audio_urls) {
      if (typeof url === 'string' && isManagedAudioUrl(url)) push('audio', url);
    }
  }

  // A host-recorded fallback is also a delivery channel on Mobile. Never guess
  // a local path or classify unknown blob extensions as pictures.
  if (Array.isArray(parsed.xdt_media_produced)) {
    for (const url of parsed.xdt_media_produced) {
      const kind = managedToolMediaKind(url);
      if (kind) push(kind, url as string);
    }
  }

  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

/** Only unwrap the documented ghost_call envelope, never arbitrary nested tool data. */
export function parseToolResultPayload(text: string): Record<string, unknown> | null {
  const outer = parsePayloadJsonObject(text);
  if (!outer) return null;
  const inner = outer.ok === true ? readPayloadRecord(outer.result) : null;
  return inner ? { ...inner, ...outer, ...(inner._xdt_render_image === false ? { _xdt_render_image: false } : {}) } : outer;
}

export function managedToolMediaKind(url: unknown): 'image' | 'video' | 'audio' | null {
  if (typeof url !== 'string') return null;
  if (url.startsWith('xdt-image://')) return 'image';
  if (url.startsWith('xdt-video://')) return 'video';
  if (url.startsWith('xdt-audio://')) return 'audio';
  const match = /^cindy-media:\/\/blobs\/[0-9a-f]{64}\.([a-z0-9]+)$/.exec(url);
  if (!match) return null;
  if (/^(png|jpe?g|gif|webp|avif|bmp|svg)$/.test(match[1])) return 'image';
  if (/^(mp4|webm|mov|m4v)$/.test(match[1])) return 'video';
  if (/^(mp3|wav|m4a|ogg|flac|aac|opus)$/.test(match[1])) return 'audio';
  return null;
}

/** Portable read-only card references; the Host resolves their content in the owning task. */
export function extractPayloadToolCardIds(text: string): string[] {
  const parsed = parseToolResultPayload(text);
  if (!parsed) return [];
  return [...new Set([parsed.xdt_card_id, parsed.xdt_anchor_card_id]
    .filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 128))];
}

export interface PayloadToolFile { url: string; title: string }

// Preserve the legacy URL alphabet. Source delimiters are contextual; adding
// filename punctuation here silently turns a valid reference into another path.
const TOOL_FILE_URL_RE = /xdt-file:\/\/[^\s"<>\\)]+/g;

function absoluteToolFilePath(url: string): string | null {
  try {
    // Keep both legacy direct-path links and the query-based local/open URLs.
    let path: string;
    if (url.startsWith('xdt-file:///')) {
      path = url.slice('xdt-file://'.length);
      // Legacy direct paths may contain a literal percent sign. Decode valid
      // escapes once, but retain the original path if it is not URI-encoded.
      try { path = decodeURIComponent(path); } catch { /* Keep the literal path. */ }
    } else {
      path = new URL(url).searchParams.get('path') ?? '';
    }
    return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) ? path : null;
  } catch {
    return null;
  }
}

function* sourceContextTokens(text: string): Generator<{
  start: number; end: number; comment: boolean; closed: boolean;
}> {
  // Always advance past a token, including unterminated strings/comments.
  // An unanchored regex can retry every escaped quote or /* in a long result.
  let index = 0;
  const filePattern = new RegExp(TOOL_FILE_URL_RE.source, 'y');
  while (index < text.length) {
    // Unquoted legacy paths may themselves contain // or /*. Consume the
    // existing URL alphabet atomically so later deliveries are not commented out.
    if (text.startsWith('xdt-file://', index)) {
      filePattern.lastIndex = index;
      if (filePattern.exec(text)) {
        index = filePattern.lastIndex;
        continue;
      }
    }
    const start = index;
    const quote = text[index];
    if (quote === '"' || quote === "'" || quote === '`') {
      // Python triple quotes delimit one literal, including internal single or
      // double quotes and newlines. Backticks retain their existing semantics.
      const delimiter = quote !== '`' && text.startsWith(quote.repeat(3), index) ? quote.repeat(3) : quote;
      index += delimiter.length;
      let closed = false;
      while (index < text.length) {
        if (text[index] === '\\') {
          index = Math.min(index + 2, text.length);
        } else if (text.startsWith(delimiter, index)) {
          index += delimiter.length;
          closed = true;
          break;
        } else {
          index++;
        }
      }
      yield { start, end: index, comment: false, closed };
    } else if (text.startsWith('/*', index)) {
      const closing = text.indexOf('*/', index + 2);
      index = closing < 0 ? text.length : closing + 2;
      yield { start, end: index, comment: true, closed: closing >= 0 };
    } else if (text.startsWith('//', index) && text[index - 1] !== ':' && text[index - 1] !== '/') {
      index += 2;
      while (index < text.length && text[index] !== '\r' && text[index] !== '\n') index++;
      yield { start, end: index, comment: true, closed: true };
    } else {
      index++;
    }
  }
}

function withoutSourceComments(text: string): string {
  // Skip string literals before recognizing comments, so URL schemes
  // and comment-like file names inside strings remain part of the context.
  const parts: string[] = [];
  let end = 0;
  for (const token of sourceContextTokens(text)) {
    if (!token.comment) continue;
    parts.push(text.slice(end, token.start), text.slice(token.start, token.end).replace(/[^\r\n]/g, ' '));
    end = token.end;
  }
  parts.push(text.slice(end));
  return parts.join('');
}

function sourceLiteralPrefix(text: string, quoteIndex: number): string {
  const rawPrefix = text.slice(0, quoteIndex);
  // Python/C# literal markers sit between the source operator and quote.
  // Only unwrap a recognized, adjacent marker; still require source syntax
  // before it, and never strip a suffix from an identifier such as "offer".
  const marker = text[quoteIndex] === '`' ? null : /(?:\b(?:br|rb|fr|rf|[rubf])|\$@|@\$|[$@])$/i.exec(rawPrefix);
  return (marker ? rawPrefix.slice(0, marker.index) : rawPrefix).trimEnd();
}

function looksLikeQuotedSourceLiteral(text: string, index: number, end: number): boolean {
  const before = text[index - 1];
  const after = text[end];
  if (before !== '`' && before !== '\'' && before !== '"') return false;
  // Quotes alone also occur in prose and inline Markdown. Require source syntax
  // around the literal (assignment, collection entry, argument or conditional).
  const prefix = sourceLiteralPrefix(text, index - 1);
  return /(?:[=\[(,?]|=>|&&|\|\||\breturn)$/.test(prefix)
    // A colon alone is also a prose label ("File:"). Require a preceding
    // conditional, allowing indented continuation lines but not new prose.
    || (prefix.endsWith(':') && /\?(?:[^;\r\n]|\r?\n[ \t])*:$/.test(prefix))
    || /[{,]\s*(?:[\w$]+|["'][^"']+["'])\s*:$/.test(prefix)
    || (after === before && /^\s*;/.test(text.slice(end + 1)));
}

function* quotedSourceRanges(text: string): Generator<{ start: number; end: number }> {
  // Classify the whole literal, not only URLs touching its opening quote.
  // Comments and escaped quotes use the same token boundaries as source context.
  let previous: { end: number; source: boolean } | undefined;
  for (const token of sourceContextTokens(text)) {
    if (token.comment) continue;
    const start = token.start;
    // Tool output may end mid-literal after the Host applies its byte budget.
    const end = token.end - (token.closed ? 1 : 0);
    // Comments are already masked. Carry the established context across a list
    // or concatenation, including prefixed literals, without treating prose +
    // as source syntax by itself.
    const separator = previous ? sourceLiteralPrefix(text, start).slice(previous.end + 1).trim() : '';
    const continuesExpression = separator === ',' || separator === '+';
    const source: boolean = previous && continuesExpression
      ? previous.source
      : looksLikeQuotedSourceLiteral(text, start + 1, end);
    if (source) yield { start, end };
    previous = { end, source };
  }
}

/** Existing 3D attachments and managed file references retain a usable file entry on Mobile. */
export function extractPayloadToolResultFiles(text: string): PayloadToolFile[] {
  const parsed = parseToolResultPayload(text);
  if (parsed?._xdt_render_image === false) return [];
  const files: PayloadToolFile[] = [];
  const add = (url: unknown, title?: unknown) => {
    if (typeof url !== 'string' || !/^(?:xdt-file:\/\/[^\s]+|cindy-media:\/\/blobs\/[0-9a-f]{64}\.glb)$/.test(url)) return;
    let name = url.split('/').pop()!;
    if (url.startsWith('xdt-file://')) {
      const path = absoluteToolFilePath(url);
      if (path === null) return;
      name = path.split(/[\\/]/).pop() || name;
    }
    if (!files.some((file) => file.url === url)) files.push({ url, title: typeof title === 'string' && title.trim() ? title : name });
  };
  if (Array.isArray(parsed?._xdt_model_files)) {
    for (const raw of parsed._xdt_model_files) { const file = readPayloadRecord(raw); add(file?.url, file?.name); }
  }
  if (Array.isArray(parsed?.xdt_media_produced)) for (const url of parsed.xdt_media_produced) add(url);
  // Decode arrays and scalar strings as well as the object/envelope above.
  // JSON delimiters must not be mistaken for source literals. Keep declaration
  // handling tied to the documented object envelope, as before.
  let content: unknown = parsed ?? text;
  if (!parsed) {
    try { content = JSON.parse(text); } catch { /* Plain-text tool output. */ }
  }
  // Use a stack so deeply nested tool output cannot overflow the call stack.
  const pending: unknown[] = [content];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string') {
      if (!value.includes('xdt-file://')) continue;
      const urlPattern = new RegExp(TOOL_FILE_URL_RE);
      // Strip comments once; repeatedly lexing the prefix of every literal is
      // quadratic for large source-file output. Offsets stay in the original text.
      const sourceContext = withoutSourceComments(value);
      const sourceRanges = quotedSourceRanges(sourceContext);
      let range = sourceRanges.next();
      let previous: { end: number; source: boolean } | undefined;
      for (let match; (match = urlPattern.exec(value));) {
        const start = match.index;
        // Comment masking preserves offsets; extract URLs only outside it.
        if (sourceContext[start] !== value[start]) continue;
        while (!range.done && range.value.end < start) range = sourceRanges.next();
        if (!range.done && range.value.start < start && start < range.value.end) continue;
        // Quotes/backticks may be filename characters. Treat one as a delimiter
        // only when it matches the opening wrapper around this reference.
        const quote = value[start - 1];
        const closingQuote = quote === "'" || quote === '`'
          ? new RegExp(quote + '(?=[,.;:!?\\]}]*(?:["\'`]xdt-file://|$))').exec(match[0])
          : null;
        const url = closingQuote ? match[0].slice(0, closingQuote.index) : match[0];
        urlPattern.lastIndex = start + url.length;
        const continuesList = previous && /^["'`]$/.test(value[previous.end])
          && /^["'`]$/.test(quote)
          && withoutSourceComments(value.slice(previous.end + 1, start - 1)).trim() === ',';
        const source = previous && continuesList
          ? previous.source
          : looksLikeQuotedSourceLiteral(sourceContext, start, start + url.length);
        if (!source) add(url);
        previous = { end: start + url.length, source };
      }
    } else if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) pending.push(value[i]);
    } else if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value);
      for (let i = entries.length - 1; i >= 0; i--) {
        const [key, child] = entries[i];
        // Explicit declarations above already retain full URLs and display names.
        if (key !== '_xdt_model_files' && key !== 'xdt_media_produced') pending.push(child);
      }
    }
  }
  return files;
}

export function buildMermaidPayload(
  source: string,
  localizer?: PresentationLocalizer,
): Extract<SharedMessagePayload, { kind: 'mermaid' }> {
  return {
    kind: 'mermaid',
    title: payloadPresentationText(localizer, 'mermaidSourceTitle', 'Mermaid 图表源码'),
    body: source,
  };
}

export function summarizeMessagePayload(
  payload: SharedMessagePayload,
  localizer?: PresentationLocalizer,
): MessagePayloadSummary {
  switch (payload.kind) {
    case 'diff':
      return {
        kind: 'diff',
        kindLabel: 'DIFF',
        title: payload.title,
        subtitle: formatDiffStats(payload.diff, localizer),
        copyableText: formatDiffPayload(payload.diff, localizer),
        sourcePath: payload.diff.filePath,
        openTarget: { kind: 'file', value: payload.diff.filePath },
      };
    case 'file': {
      const sourcePath = payload.sourcePath ?? '';
      return {
        kind: 'file',
        kindLabel: 'FILE',
        title: payload.title,
        subtitle: sourcePath || undefined,
        copyableText: sourcePath || payload.body,
        sourcePath: sourcePath || undefined,
        openTarget: sourcePath ? { kind: 'file', value: sourcePath } : undefined,
      };
    }
    case 'media':
      return {
        kind: 'media',
        kindLabel: payload.media.kind.toUpperCase(),
        title: payload.title,
        subtitle: payload.media.previewable
          ? payloadPresentationText(localizer, 'directPreview', '可直接预览')
          : payloadPresentationText(localizer, 'remoteFetchRequired', '需要远程取件'),
        copyableText: payload.media.url,
        openTarget: payload.media.previewable ? { kind: 'url', value: payload.media.url } : undefined,
      };
    case 'mermaid':
      return {
        kind: 'mermaid',
        kindLabel: 'MERMAID',
        title: payload.title,
        subtitle: payloadPresentationText(localizer, 'chartSource', '图表源码'),
        copyableText: payload.body,
      };
    case 'text':
      return {
        kind: 'text',
        kindLabel: 'TEXT',
        title: payload.title,
        copyableText: payload.body,
      };
  }
}

export function summarizeMessagePayloadBody(
  payload: SharedMessagePayload,
  localizer?: PresentationLocalizer,
): MessagePayloadBodyPresentation {
  switch (payload.kind) {
    case 'diff': {
      const view = formatDiffPayloadView(payload.diff, localizer);
      return {
        bodyText: payload.body,
        diff: {
          filePath: view.filePath,
          sectionCount: view.sections.length,
          stats: view.stats,
        },
        emptyText: payloadPresentationText(localizer, 'noDiffContent', '没有 diff 内容。'),
        kind: 'diff',
        textMonospace: true,
      };
    }
    case 'file': {
      const sourcePath = payload.sourcePath ?? '';
      return {
        bodyText: payload.body || sourcePath,
        emptyText: payloadPresentationText(localizer, 'missingRemotePathSentence', '没有可展示的远程路径。'),
        file: {
          displayPath: sourcePath || payload.body || payloadPresentationText(localizer, 'missingRemotePath', '没有可展示的远程路径'),
          sourcePath,
        },
        kind: 'file',
        textMonospace: true,
      };
    }
    case 'media': {
      const directPreviewable = payload.media.previewable && isPayloadDirectPreviewableUrl(payload.media.url);
      const needsRemoteFetch = !payload.media.previewable && isPayloadDesktopLocalMediaUrl(payload.media.url);
      const canInlineDirectImage = payload.media.kind === 'image' && directPreviewable;
      const canInlineDirectPlayer = (payload.media.kind === 'video' || payload.media.kind === 'audio') && directPreviewable;
      const bodyText = formatMediaPayloadDisplayText(payload, localizer);
      return {
        bodyText,
        emptyText: payloadPresentationText(localizer, 'noMediaAddress', '没有媒体地址。'),
        kind: 'media',
        media: {
          canDirectOpen: isPayloadDirectPreviewableUrl(payload.media.url),
          canInlineDirectImage,
          canInlineDirectPlayer,
          directPreviewable,
          kindLabel: payloadMediaKindLabel(payload.media.kind, localizer),
          needsRemoteFetch,
          placeholderText: needsRemoteFetch
            ? payloadPresentationText(localizer, 'remoteMediaPreparing', '正在准备远程媒体取件')
            : payload.media.previewable
              ? payloadPresentationText(localizer, 'mediaAddressOnlySentence', '当前媒体类型暂以地址形式展示。')
              : payloadPresentationText(localizer, 'mediaCannotPreviewSentence', '当前媒体暂不能直接预览。'),
          remoteIdleText: payloadPresentationText(localizer, 'remoteMediaPreparing', '正在准备远程媒体取件'),
          unsupportedText: payload.media.previewable
            ? payloadPresentationText(localizer, 'mediaAddressOnlySentence', '当前媒体类型暂以地址形式展示。')
            : payloadPresentationText(localizer, 'mediaCannotPreviewSentence', '当前媒体暂不能直接预览。'),
        },
        textMonospace: false,
      };
    }
    case 'mermaid':
      return {
        bodyText: payload.body,
        emptyText: payloadPresentationText(localizer, 'emptyMermaid', '空 Mermaid 图表。'),
        kind: 'mermaid',
        mermaid: { source: payload.body },
        textMonospace: true,
      };
    case 'text':
      return {
        bodyText: payload.body,
        emptyText: payloadPresentationText(localizer, 'noTextContent', '没有可展示的文本内容。'),
        kind: 'text',
        textMonospace: false,
      };
  }
}

export function summarizeMessagePayloadPreview(
  payload: SharedMessagePayload,
  options: MessagePayloadPreviewOptions = {},
  localizer?: PresentationLocalizer,
): MessagePayloadPreview {
  const maxPreviewChars = Math.max(24, options.maxPreviewChars ?? 220);

  switch (payload.kind) {
    case 'diff': {
      const stats = formatDiffStats(payload.diff, localizer);
      const editCount = payload.diff.segments.length;
      return {
        actionKind: 'view',
        actionLabel: payloadPresentationText(localizer, 'viewDiff', '查看 diff'),
        canInlinePreview: false,
        detail: `${payload.diff.filePath} · ${stats}`,
        kind: 'diff',
        meta: [stats, payloadPresentationText(localizer, 'editCount', `${editCount} 处编辑`, { count: editCount })],
        needsRemoteFetch: false,
        previewText: trimPayloadPreviewText(formatDiffPreviewText(payload.diff, localizer), maxPreviewChars)
          || payloadPresentationText(localizer, 'noDiffContent', '没有 diff 内容。'),
        severity: payload.diff.insertions > 0 || payload.diff.deletions > 0 ? 'info' : 'neutral',
        shouldUseMonospacePreview: true,
        title: payload.title,
      };
    }
    case 'file': {
      const sourcePath = payload.sourcePath ?? '';
      const hasSourcePath = !!sourcePath.trim();
      return {
        actionKind: hasSourcePath ? 'preview-file' : 'view',
        actionLabel: hasSourcePath
          ? payloadPresentationText(localizer, 'previewFile', '预览文件')
          : payloadPresentationText(localizer, 'viewDetails', '查看详情'),
        canInlinePreview: false,
        detail: hasSourcePath ? sourcePath : payloadPresentationText(localizer, 'noRemotePath', '没有远程路径'),
        kind: 'file',
        meta: [hasSourcePath ? sourcePath : payloadPresentationText(localizer, 'remotePathMissing', '缺少远程路径')],
        needsRemoteFetch: false,
        previewText: trimPayloadPreviewText(
          payload.body || sourcePath || payloadPresentationText(localizer, 'missingRemotePathSentence', '没有可展示的远程路径。'),
          maxPreviewChars,
        ),
        severity: hasSourcePath ? 'neutral' : 'warning',
        shouldUseMonospacePreview: true,
        title: payload.title,
      };
    }
    case 'media': {
      const directPreviewable = payload.media.previewable && isPayloadDirectPreviewableUrl(payload.media.url);
      const needsRemoteFetch = !payload.media.previewable && isPayloadDesktopLocalMediaUrl(payload.media.url);
      const canInlinePreview = directPreviewable
        && (payload.media.kind === 'image' || payload.media.kind === 'video' || payload.media.kind === 'audio');
      const kindLabel = payloadMediaKindLabel(payload.media.kind, localizer);
      const actionNotice = formatMediaActionNotice(payload.media, localizer);
      if (needsRemoteFetch) {
        return {
          actionKind: 'fetch-remote-media',
          actionLabel: payloadPresentationText(localizer, 'fetchMedia', '取回媒体'),
          canInlinePreview: false,
          detail: payloadPresentationText(localizer, 'fetchMediaFromDesktop', '需要从电脑端取回媒体'),
          kind: 'media',
          meta: [kindLabel, payloadPresentationText(localizer, 'pendingFetch', '待取件')],
          needsRemoteFetch: true,
          previewText: trimPayloadPreviewText([payload.media.url, actionNotice].filter(Boolean).join('\n'), maxPreviewChars),
          severity: 'info',
          shouldUseMonospacePreview: false,
          title: payload.title,
        };
      }
      if (directPreviewable) {
        const displayText = formatMediaPayloadDisplayText(payload, localizer);
        return {
          actionKind: 'open-url',
          actionLabel: payloadPresentationText(localizer, 'previewMedia', '预览媒体'),
          canInlinePreview,
          detail: payloadPresentationText(localizer, 'directPreview', '可直接预览'),
          kind: 'media',
          meta: [kindLabel, payloadPresentationText(localizer, 'previewable', '可预览')],
          needsRemoteFetch: false,
          previewText: trimPayloadPreviewText(displayText, maxPreviewChars),
          severity: 'neutral',
          shouldUseMonospacePreview: false,
          title: payload.title,
        };
      }
      return {
        actionKind: payload.media.previewable ? 'open-url' : 'view',
        actionLabel: payload.media.previewable
          ? payloadPresentationText(localizer, 'openMedia', '打开媒体')
          : payloadPresentationText(localizer, 'viewDetails', '查看详情'),
        canInlinePreview: false,
        detail: payload.media.previewable
          ? payloadPresentationText(localizer, 'mediaAddressOnly', '当前媒体以地址形式展示')
          : payloadPresentationText(localizer, 'mediaCannotPreview', '当前媒体暂不能直接预览'),
        kind: 'media',
        meta: [
          kindLabel,
          payload.media.previewable
            ? payloadPresentationText(localizer, 'addressDisplay', '地址展示')
            : payloadPresentationText(localizer, 'notPreviewable', '不可预览'),
        ],
        needsRemoteFetch: false,
        previewText: trimPayloadPreviewText([payload.media.url, actionNotice].filter(Boolean).join('\n'), maxPreviewChars),
        severity: payload.media.previewable ? 'info' : 'warning',
        shouldUseMonospacePreview: false,
        title: payload.title,
      };
    }
    case 'mermaid':
      return {
        actionKind: 'view',
        actionLabel: payloadPresentationText(localizer, 'viewChart', '查看图表'),
        canInlinePreview: true,
        detail: payloadPresentationText(localizer, 'mermaidSourceTitle', 'Mermaid 图表源码'),
        kind: 'mermaid',
        meta: [payloadPresentationText(localizer, 'chartSource', '图表源码')],
        needsRemoteFetch: false,
        previewText: trimPayloadPreviewText(
          payload.body || payloadPresentationText(localizer, 'emptyMermaid', '空 Mermaid 图表。'),
          maxPreviewChars,
        ),
        severity: 'neutral',
        shouldUseMonospacePreview: true,
        title: payload.title,
      };
    case 'text':
      return {
        actionKind: 'view',
        actionLabel: payloadPresentationText(localizer, 'viewContent', '查看内容'),
        canInlinePreview: false,
        detail: payloadPresentationText(localizer, 'textOutput', '文本输出'),
        kind: 'text',
        meta: [payloadPresentationText(localizer, 'text', '文本')],
        needsRemoteFetch: false,
        previewText: trimPayloadPreviewText(
          payload.body || payloadPresentationText(localizer, 'noTextContent', '没有可展示的文本内容。'),
          maxPreviewChars,
        ),
        severity: 'neutral',
        shouldUseMonospacePreview: false,
        title: payload.title,
      };
  }
}

export function payloadMediaKindLabel(
  kind: PayloadMediaLike['kind'],
  localizer?: PresentationLocalizer,
): string {
  if (kind === 'image') return payloadPresentationText(localizer, 'image', '图片');
  if (kind === 'video') return payloadPresentationText(localizer, 'video', '视频');
  return payloadPresentationText(localizer, 'audio', '音频');
}

function formatMediaPayloadDisplayText(
  payload: Extract<SharedMessagePayload, { kind: 'media' }>,
  localizer?: PresentationLocalizer,
): string {
  const dataImage = describeDataImageUrl(payload.media.url);
  if (!dataImage) return payload.body || payload.media.url;
  return [
    payloadPresentationText(localizer, 'inlineMediaData', `内联${payloadMediaKindLabel(payload.media.kind, localizer)}数据`, {
      kind: payloadMediaKindLabel(payload.media.kind, localizer),
    }),
    dataImage.mimeLabel,
    dataImage.sizeLabel,
    formatMediaActionNotice(payload.media, localizer),
  ].filter(Boolean).join(' · ');
}

function describeDataImageUrl(url: string): { mimeLabel: string; sizeLabel: string } | null {
  const match = /^data:image\/([^;,]+)(?:;[^,]*)?,([a-zA-Z0-9+/=\s]+)$/.exec(url);
  if (!match) return null;
  const subtype = match[1]?.trim().toUpperCase() || 'IMAGE';
  const encoded = (match[2] ?? '').replace(/\s/g, '');
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const bytes = Math.max(0, Math.floor((encoded.length * 3) / 4) - padding);
  return {
    mimeLabel: subtype,
    sizeLabel: formatPayloadByteSize(bytes),
  };
}

function formatPayloadByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(kib >= 10 ? 0 : 1)} KB`;
  const mib = kib / 1024;
  return `${mib.toFixed(mib >= 10 ? 0 : 1)} MB`;
}

export function isPayloadDesktopLocalMediaUrl(url: unknown): url is string {
  return (
    typeof url === 'string'
    && (
      url.startsWith('xdt-image://')
      || url.startsWith('xdt-video://')
      || url.startsWith('xdt-file://')
      || url.startsWith('xdt-audio://')
      // 媒体总仓内容寻址 blob(cindy-media://blobs/<指纹>.<ext>):desktop 的
      // device-link mediaFetch 已支持按此协议解析取件,手机端同样走 resolver。
      || url.startsWith('cindy-media://')
    )
  );
}

export function isPayloadDirectPreviewableUrl(url: unknown): url is string {
  return (
    typeof url === 'string'
    && (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:image/'))
  );
}

export function formatDiffPayload(
  diff: PayloadToolDiffLike,
  localizer?: PresentationLocalizer,
): string {
  const head = [
    diff.filePath,
    formatDiffStats(diff, localizer),
  ];
  const segments = diff.segments.map((segment, index) => {
    const label = segment.label ?? `Edit ${index + 1}/${diff.segments.length}`;
    const oldBlock = formatChangedBlock('-', segment.oldString);
    const newBlock = formatChangedBlock('+', segment.newString);
    return [label, oldBlock, newBlock].filter(Boolean).join('\n');
  });
  return [...head, ...segments].join('\n\n');
}

export function formatDiffPayloadRows(
  diff: PayloadToolDiffLike,
  localizer?: PresentationLocalizer,
): FormattedDiffPayloadRow[] {
  const rows: FormattedDiffPayloadRow[] = [
    { key: 'header', kind: 'header', text: diff.filePath },
    { key: 'stats', kind: 'stats', text: formatDiffStats(diff, localizer) },
  ];
  diff.segments.forEach((segment, index) => {
    const label = segment.label ?? `Edit ${index + 1}/${diff.segments.length}`;
    rows.push({ key: `${segment.key}:label`, kind: 'segment', text: label });
    for (const [lineIndex, line] of splitChangedLines(segment.oldString).entries()) {
      rows.push({
        key: `${segment.key}:old:${lineIndex}`,
        kind: 'delete',
        text: `- ${line}`,
      });
    }
    for (const [lineIndex, line] of splitChangedLines(segment.newString).entries()) {
      rows.push({
        key: `${segment.key}:new:${lineIndex}`,
        kind: 'add',
        text: `+ ${line}`,
      });
    }
  });
  return rows;
}

export function formatDiffPayloadView(
  diff: PayloadToolDiffLike,
  localizer?: PresentationLocalizer,
): FormattedDiffPayloadView {
  return {
    filePath: diff.filePath,
    stats: formatDiffStats(diff, localizer),
    sections: diff.segments.map((segment, index) => ({
      key: segment.key,
      label: segment.label ?? `Edit ${index + 1}/${diff.segments.length}`,
      oldLines: splitChangedLines(segment.oldString).map((line, lineIndex) => ({
        key: `${segment.key}:old:${lineIndex}`,
        lineNumber: lineIndex + 1,
        text: line,
      })),
      newLines: splitChangedLines(segment.newString).map((line, lineIndex) => ({
        key: `${segment.key}:new:${lineIndex}`,
        lineNumber: lineIndex + 1,
        text: line,
      })),
    })),
  };
}

export function formatMediaActionNotice(
  media: PayloadMediaLike,
  localizer?: PresentationLocalizer,
): string {
  const actions = media.actions;
  if (!actions?.buttons.length) return '';
  const labels = actions.buttons.map(formatMediaActionButtonLabel).join(' / ');
  return [
    payloadPresentationText(localizer, 'mediaActionsAvailable', '桌面端为这个媒体提供了后续操作。'),
    payloadPresentationText(localizer, 'availableActions', `可用操作：${labels}`, { actions: labels }),
    payloadPresentationText(
      localizer,
      'mediaActionsDesktopOnly',
      '手机版 V1 只安全展示这些操作，暂不远程触发。请回到电脑端点击。',
    ),
  ].join('\n');
}

function formatChangedBlock(prefix: '-' | '+', value: string): string {
  if (!value) return '';
  return splitChangedLines(value).map((line) => `${prefix} ${line}`).join('\n');
}

function splitChangedLines(value: string): string[] {
  if (!value) return [];
  return value.split('\n');
}

function formatDiffPreviewText(
  diff: PayloadToolDiffLike,
  localizer?: PresentationLocalizer,
): string {
  const firstSegment = diff.segments[0];
  if (!firstSegment) return '';
  const label = firstSegment.label ?? `Edit 1/${diff.segments.length}`;
  const oldLines = splitChangedLines(firstSegment.oldString).slice(0, 2).map((line) => `- ${line}`);
  const newLines = splitChangedLines(firstSegment.newString).slice(0, 2).map((line) => `+ ${line}`);
  const more = diff.segments.length > 1
    ? [payloadPresentationText(localizer, 'moreEdits', `…还有 ${diff.segments.length - 1} 处编辑`, {
        count: diff.segments.length - 1,
      })]
    : [];
  return [label, ...oldLines, ...newLines, ...more].filter(Boolean).join('\n');
}

function formatDiffStats(
  diff: Pick<PayloadToolDiffLike, 'insertions' | 'deletions'>,
  localizer?: PresentationLocalizer,
): string {
  return payloadPresentationText(
    localizer,
    'diffStats',
    `+${diff.insertions} / -${diff.deletions} 行`,
    { insertions: diff.insertions, deletions: diff.deletions },
  );
}

function payloadPresentationText(
  localizer: PresentationLocalizer | undefined,
  key: string,
  fallback: string,
  values?: Readonly<Record<string, string | number | boolean | null | undefined>>,
): string {
  return presentationText(localizer, `message.payloadPresentation.${key}`, fallback, values);
}

function trimPayloadPreviewText(value: string, maxChars: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function formatMediaActionButtonLabel(button: PayloadMediaActionButtonLike): string {
  if (button.label?.trim()) return button.label;
  if (button.emoji?.trim()) return button.emoji;
  const parts = button.customId.split('::');
  if (parts.length >= 4 && parts[1] === 'JOB') {
    if (parts[2] === 'upsample') return `U${parts[3]}`;
    if (parts[2] === 'variation') return `V${parts[3]}`;
    if (parts[2] === 'reroll') return 'Reroll';
    return parts[2].slice(0, 12);
  }
  return button.customId.slice(0, 16);
}

function parsePayloadToolMediaActions(raw: unknown): ExtractedPayloadToolMediaActionsLike | undefined {
  const record = readPayloadRecord(raw);
  if (!record || record.provider !== 'mivo') return undefined;
  const jobId = readPayloadString(record.jobId);
  if (!jobId || !Array.isArray(record.buttons)) return undefined;

  const buttons = record.buttons.flatMap((rawButton): PayloadMediaActionButtonLike[] => {
    const button = readPayloadRecord(rawButton);
    const customId = readPayloadString(button?.customId);
    if (!customId) return [];
    return [{
      customId,
      label: readPayloadString(button?.label) ?? undefined,
      emoji: readPayloadString(button?.emoji) ?? undefined,
    }];
  });
  return buttons.length > 0 ? { provider: 'mivo', jobId, buttons } : undefined;
}

function parsePayloadJsonObject(value: string): Record<string, unknown> | null {
  try {
    return readPayloadRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function readPayloadRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readPayloadString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function createPayloadToolDiff(
  filePath: string,
  segments: Array<{ key: string; oldString: string; newString: string; label?: string }>,
): PayloadToolDiffLike {
  return {
    filePath,
    segments,
    insertions: segments.reduce((sum, segment) => sum + countPayloadChangedLines(segment.newString), 0),
    deletions: segments.reduce((sum, segment) => sum + countPayloadChangedLines(segment.oldString), 0),
  };
}

function countPayloadChangedLines(value: string): number {
  if (!value) return 0;
  return value.split('\n').filter((line) => line.length > 0).length || 1;
}
