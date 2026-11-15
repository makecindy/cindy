import { createHash } from 'node:crypto';
import type { RequestSizeError } from './request-size-errors.js';

export type WireFormat = 'responses' | 'anthropic' | 'chat';
export type ImageRouteInfo = {
  providerId?: string;
  modelId?: string;
  endpoint?: string;
  deniedMimeTypes?: string[];
};

export interface PreparedImage {
  bytes: Buffer;
  mimeType: string;
  width: number;
  height: number;
  changed: boolean;
  cacheKey: string;
}

export interface InlineImagePreprocessor {
  prepare(input: { bytes: Buffer; mimeType: string; route: ImageRouteInfo; signal: AbortSignal }): Promise<PreparedImage | null>;
  tighten?(input: { bytes: Buffer; mimeType: string; route: ImageRouteInfo; maxBytes: number; signal: AbortSignal }): Promise<PreparedImage | null>;
}

export const NOOP_IMAGE_PREPROCESSOR: InlineImagePreprocessor = {
  async prepare() { return null; },
};

export interface RequestSizePolicy {
  triggerBytes?: number;
  targetBytes?: number;
  triggerImages?: number;
  targetImages?: number;
  modelFamily?: 'gpt' | 'claude' | 'other';
  route?: ImageRouteInfo;
  preprocessor?: InlineImagePreprocessor;
  singleImageMaxBytes?: number;
  signal?: AbortSignal;
  reason?: string;
  allowRemoval?: boolean;
}

export interface RequestSizeResult {
  /** Parsed projection of the returned bytes, for downstream routing/transforms. */
  parsedBody?: unknown;
  body: Buffer;
  changed: boolean;
  originalBytes: number;
  bytes: number;
  removedImages: number;
  imageCount: number;
  reason: string;
}

const MiB = 1024 * 1024;
export const DEFAULT_REQUEST_SIZE_TRIGGER = 32 * MiB;
export const DEFAULT_REQUEST_SIZE_TARGET = 14 * MiB;
export const DEFAULT_QUICK_PATH_BYTES = 4 * MiB;


type JsonNode = {
  start: number;
  end: number;
  value: unknown;
  kind: 'object' | 'array' | 'string' | 'primitive';
  fields?: Map<string, JsonNode>;
  items?: JsonNode[];
};

class JsonScanner {
  private offset = 0;
  constructor(private readonly text: string) {}

  parse(): JsonNode {
    const node = this.value();
    this.ws();
    if (this.offset !== this.text.length) throw new Error('invalid JSON tail');
    return node;
  }

  private ws(): void { while (/\s/.test(this.text[this.offset] ?? '')) this.offset++; }
  private value(): JsonNode {
    this.ws();
    const start = this.offset;
    const ch = this.text[this.offset];
    if (ch === '{') return this.object(start);
    if (ch === '[') return this.array(start);
    if (ch === '"') {
      const raw = this.stringRaw();
      return { start, end: this.offset, value: raw.includes('\\') ? JSON.parse(raw) : raw.slice(1, -1), kind: 'string' };
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(this.text.slice(this.offset));
    if (!match) throw new Error('invalid JSON value');
    this.offset += match[0].length;
    return { start, end: this.offset, value: JSON.parse(match[0]), kind: 'primitive' };
  }

  private object(start: number): JsonNode {
    this.offset++;
    const fields = new Map<string, JsonNode>();
    const value: Record<string, unknown> = {};
    this.ws();
    if (this.text[this.offset] === '}') { this.offset++; return { start, end: this.offset, value, kind: 'object', fields }; }
    while (this.offset < this.text.length) {
      this.ws();
      const key = JSON.parse(this.stringRaw()) as string;
      this.ws();
      if (this.text[this.offset++] !== ':') throw new Error('invalid JSON object');
      const child = this.value();
      fields.set(key, child);
      value[key] = child.value;
      this.ws();
      const delimiter = this.text[this.offset++];
      if (delimiter === '}') break;
      if (delimiter !== ',') throw new Error('invalid JSON object delimiter');
    }
    return { start, end: this.offset, value, kind: 'object', fields };
  }

  private array(start: number): JsonNode {
    this.offset++;
    const items: JsonNode[] = [];
    const value: unknown[] = [];
    this.ws();
    if (this.text[this.offset] === ']') { this.offset++; return { start, end: this.offset, value, kind: 'array', items }; }
    while (this.offset < this.text.length) {
      const child = this.value();
      items.push(child); value.push(child.value);
      this.ws();
      const delimiter = this.text[this.offset++];
      if (delimiter === ']') break;
      if (delimiter !== ',') throw new Error('invalid JSON array delimiter');
    }
    return { start, end: this.offset, value, kind: 'array', items };
  }

  private stringRaw(): string {
    const start = this.offset++;
    const delimiters = /["\\]/g;
    delimiters.lastIndex = this.offset;
    let match: RegExpExecArray | null;
    while ((match = delimiters.exec(this.text))) {
      if (match[0] === '\\') { delimiters.lastIndex++; continue; }
      this.offset = match.index + 1;
      return this.text.slice(start, this.offset);
    }
    throw new Error('unterminated JSON string');
  }
}

interface ImageOccurrence {
  node: JsonNode;
  raw: string;
  mimeType: string;
  textType: 'text' | 'input_text';
  roleIndex: number;
  seenAssistant: boolean;
  assistantCount: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function modelItems(root: JsonNode, format: WireFormat): JsonNode[] {
  if (!root.fields) return [];
  const value = root.fields.get(format === 'responses' ? 'input' : 'messages');
  return value?.items ?? [];
}

function imageFromNode(node: JsonNode, format: WireFormat): { raw: string; mimeType: string; textType: 'text' | 'input_text' } | null {
  if (!node.fields) return null;
  const type = node.fields.get('type')?.value;
  let source: JsonNode | undefined;
  let mimeType = 'application/octet-stream';
  const textType: 'text' | 'input_text' = format === 'responses' ? 'input_text' : 'text';
  if (format === 'responses' && type === 'input_image') source = node.fields.get('image_url');
  else if (format === 'responses' && type === 'input_file') source = node.fields.get('file_data');
  else if (format === 'chat' && type === 'image_url') {
    const imageUrl = node.fields.get('image_url');
    source = imageUrl?.fields?.get('url') ?? imageUrl;
  } else if (format === 'anthropic' && (type === 'image' || type === 'document')) {
    const sourceNode = node.fields.get('source');
    if (sourceNode?.fields?.get('type')?.value !== 'base64') return null;
    source = sourceNode.fields.get('data');
    const media = sourceNode.fields.get('media_type')?.value;
    if (typeof media === 'string') mimeType = media;
  }
  if (source?.kind !== 'string' || typeof source.value !== 'string') return null;
  const raw = source.value;
  if (/^https?:\/\//i.test(raw)) return null;
  const data = /^data:([\w.+/-]+);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(raw);
  if (data) { mimeType = data[1]; return { raw: data[2], mimeType, textType }; }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return null;
  return { raw, mimeType, textType };
}

function walkImages(node: JsonNode, format: WireFormat, out: ImageOccurrence[], assistants: { count: number }, roleIndex = 0): void {
  if (node.kind === 'array') {
    for (const child of node.items ?? []) walkImages(child, format, out, assistants, roleIndex);
    return;
  }
  if (node.kind !== 'object') return;
  const objectType = node.fields?.get('type')?.value;
  const role = node.fields?.get('role')?.value;
  const assistant = role === 'assistant' || (format === 'responses' && ['reasoning', 'function_call', 'custom_tool_call'].includes(String(objectType)));
  if (assistant) assistants.count++;
  const image = imageFromNode(node, format);
  if (image) out.push({ node, ...image, roleIndex, seenAssistant: false, assistantCount: assistants.count });
  for (const [key, child] of node.fields ?? []) {
    // Do not inspect arbitrary serialized JSON strings or tool definitions. Tool results are
    // explicit content arrays and are traversed by this normal schema walk.
    if (key === 'content' || key === 'output' || key === 'input') walkImages(child, format, out, assistants, roleIndex);
  }
}

/** Cheap conservative hint; positive matches still go through the schema-aware scanner.
 * Keep legacy inline documents/files eligible for recovery as well as images.
 */
export function hasRequestMediaMarkers(body: Buffer): boolean {
  return /"type"\s*:\s*"(?:input_image|input_file|image|document|image_url)"/.test(body.toString('utf8'));
}

function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

/** Count actual wire images (including translated protocols), without decoding their bytes. */
export function countInlineRequestImages(body: Buffer, format?: WireFormat): number {
  try {
    const root = new JsonScanner(body.toString('utf8')).parse();
    const formats: WireFormat[] = format ? [format] : ['responses', 'anthropic', 'chat'];
    let count = 0;
    for (const wire of formats) {
      const images: ImageOccurrence[] = [];
      for (const item of modelItems(root, wire)) walkImages(item, wire, images, { count: 0 });
      count += images.filter(image => isImageMimeType(image.mimeType)).length;
    }
    return count;
  } catch { return 0; } // A malformed body has no reliably identifiable image blocks.
}

function familyLimit(family: RequestSizePolicy['modelFamily']): { trigger: number; keep: number } | undefined {
  if (family === 'gpt') return { trigger: 50, keep: 22 };
  if (family === 'claude') return { trigger: 100, keep: 44 };
  return undefined;
}

export type RequestSizeBudget = Pick<RequestSizePolicy, 'triggerBytes' | 'targetBytes' | 'triggerImages' | 'targetImages' | 'singleImageMaxBytes'>;

export function requestSizeModelFamily(model = ''): NonNullable<RequestSizePolicy['modelFamily']> {
  const value = model.toLowerCase();
  return /(?:^|[/_-])(?:gpt|o[1-9]|codex)(?:[/_.-]|$)/.test(value)
    ? 'gpt' : value.includes('claude') ? 'claude' : 'other';
}

/** Merge at completion too: concurrent successful retries cannot loosen a rule. */
export function mergeRequestSizeBudgets(previous: RequestSizeBudget = {}, next: RequestSizeBudget): RequestSizeBudget {
  const merged = { ...previous };
  for (const key of ['triggerBytes', 'targetBytes', 'triggerImages', 'targetImages', 'singleImageMaxBytes'] as const) {
    if (next[key] !== undefined) merged[key] = Math.min(previous[key] ?? Infinity, next[key]);
  }
  return merged;
}

/** The retry and all later requests replay this same rule; there is no forced-cut mode. */
export function requestSizeBudgetAfterRejection(
  previous: RequestSizeBudget | undefined, error: RequestSizeError,
  actual: { bytes: number; images: number }, modelFamily: RequestSizePolicy['modelFamily'],
): RequestSizeBudget {
  const next: RequestSizeBudget = {};
  if (error.kind === 'single-image-too-large') {
    if (error.limitBytes !== undefined) next.singleImageMaxBytes = error.limitBytes;
  } else {
    if (error.kind === 'request-too-large' || error.limitBytes !== undefined) {
      // A gateway can advertise 100 MB while rejecting a 14 MiB request.
      // Only a limit below the rejected quantity explains this rejection;
      // otherwise derive the unknown-limit rule from the actual wire bytes.
      const limit = error.limitBytes !== undefined && error.limitBytes < actual.bytes
        ? error.limitBytes : Math.floor(actual.bytes * 0.44);
      next.triggerBytes = Math.max(1, Math.min(DEFAULT_REQUEST_SIZE_TRIGGER, previous?.triggerBytes ?? Infinity, limit));
      next.targetBytes = Math.max(1, Math.min(DEFAULT_REQUEST_SIZE_TARGET, previous?.targetBytes ?? Infinity, Math.floor(next.triggerBytes * 0.44)));
    }
    if (error.kind === 'image-count' || error.limitCount !== undefined) {
      const family = familyLimit(modelFamily);
      const limit = error.limitCount !== undefined && error.limitCount < actual.images
        ? error.limitCount : Math.floor(actual.images * 0.44);
      next.triggerImages = Math.min(family?.trigger ?? Infinity, previous?.triggerImages ?? Infinity, limit);
      next.targetImages = Math.min(family?.keep ?? Infinity, previous?.targetImages ?? Infinity, Math.floor(next.triggerImages * 0.44));
    }
  }
  return mergeRequestSizeBudgets(previous, next);
}

function replacementText(path: string, seenAssistant: boolean): string {
  return `Media omitted from this request. ${seenAssistant ? 'An assistant response occurred before this media was removed.' : 'No assistant response occurred before this media was removed; it may be unseen.'} Preserved local file: ${JSON.stringify(path)}. Read that file with an image/file-reading tool when needed. Do not read all previously omitted media back into the request.`;
}

function decodeBase64(value: string): Buffer {
  if (!value || value.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('invalid image base64');
  if (value.length % 4 !== 0) throw new Error('invalid image base64');
  return Buffer.from(value, 'base64');
}

/**
 * Apply the request budget while preserving every byte outside replaced image blocks.
 * The function intentionally returns null for a fast-path request.
 */
export async function controlRequestSize(body: Buffer, format: WireFormat, policy: RequestSizePolicy = {}, preserve: (bytes: Buffer, mimeType: string, occurrence: number) => Promise<string>): Promise<RequestSizeResult | null> {
  const disableRemoval = policy.allowRemoval === false;
  const trigger = disableRemoval ? Number.MAX_SAFE_INTEGER : policy.triggerBytes ?? DEFAULT_REQUEST_SIZE_TRIGGER;
  const target = disableRemoval ? Number.MAX_SAFE_INTEGER : policy.targetBytes ?? DEFAULT_REQUEST_SIZE_TARGET;
  const familyPolicy = disableRemoval ? undefined : policy.triggerImages === undefined ? familyLimit(policy.modelFamily)
    : { trigger: policy.triggerImages, keep: policy.targetImages ?? Math.floor(policy.triggerImages * 0.44) };
  const quickLimit = Math.min(trigger, DEFAULT_QUICK_PATH_BYTES);
  if (body.length <= quickLimit && !hasRequestMediaMarkers(body)) return null;
  const text = body.toString('utf8');
  const root = new JsonScanner(text).parse();
  const occurrences: ImageOccurrence[] = [];
  const assistantState = { count: 0 };
  for (const item of modelItems(root, format)) walkImages(item, format, occurrences, assistantState);
  if (body.length > trigger && occurrences.length === 0) throw new Error('REQUEST_TEXT_TOO_LARGE');

  const prepared = new Map<number, { bytes: Buffer; mimeType: string; changed: boolean }>();
  const preprocessor = policy.preprocessor ?? NOOP_IMAGE_PREPROCESSOR;
  const decoded = new Map<string, Buffer>();
  const readOriginal = (occurrence: ImageOccurrence): Buffer => {
    let original = decoded.get(occurrence.raw);
    if (!original) { original = decodeBase64(occurrence.raw); decoded.set(occurrence.raw, original); }
    return original;
  };
  for (const [index, occurrence] of occurrences.entries()) {
    policy.signal?.throwIfAborted();
    // Files still consume the wire budget, but only images may enter the image
    // preprocessor. Decode non-images lazily if the replay actually removes them.
    if (!isImageMimeType(occurrence.mimeType)) continue;
    const original = readOriginal(occurrence);
    let next = { bytes: original, mimeType: occurrence.mimeType, changed: false };
    const route = policy.route ?? {};
    try {
      const output = await preprocessor.prepare({ bytes: original, mimeType: occurrence.mimeType, route, signal: policy.signal ?? new AbortController().signal });
      if (output?.bytes?.length && output.bytes.length < original.length) {
        next = { bytes: output.bytes, mimeType: output.mimeType, changed: true };
      }
      if (policy.singleImageMaxBytes && next.bytes.length > policy.singleImageMaxBytes && preprocessor.tighten) {
        const tightened = await preprocessor.tighten({ bytes: original, mimeType: occurrence.mimeType, route, maxBytes: policy.singleImageMaxBytes, signal: policy.signal ?? new AbortController().signal });
        if (tightened?.bytes?.length && tightened.bytes.length < next.bytes.length) {
          next = { bytes: tightened.bytes, mimeType: tightened.mimeType, changed: true };
        }
      }
    } catch { /* noop is deliberately fail-open */ }
    prepared.set(index, next);
  }

  // Serialize only prepared image blocks. All byte ledgers use these exact wire
  // bytes (including MIME/JSON overhead), as if preprocessing ran before replay.
  const rewrites = new Map<number, { start: number; end: number; text: string }>();
  const inlineBytes: number[] = [];
  for (const [index, occurrence] of occurrences.entries()) {
    const item = prepared.get(index);
    const originalBytes = Buffer.byteLength(text.slice(occurrence.node.start, occurrence.node.end));
    let bytes = originalBytes;
    if (item?.changed) {
      const encoded = item.bytes.toString('base64');
      const block = occurrence.node.value as Record<string, unknown>;
      if (format === 'anthropic' && record(block.source)) { block.source.data = encoded; block.source.media_type = item.mimeType; }
      else if (format === 'chat') {
        if (record(block.image_url)) block.image_url.url = `data:${item.mimeType};base64,${encoded}`;
        else block.image_url = `data:${item.mimeType};base64,${encoded}`;
      } else if (format === 'responses') block[block.type === 'input_file' ? 'file_data' : 'image_url'] = `data:${item.mimeType};base64,${encoded}`;
      const replacement = JSON.stringify(block);
      bytes = Buffer.byteLength(replacement);
      rewrites.set(index, { start: occurrence.node.start, end: occurrence.node.end, text: replacement });
    }
    inlineBytes.push(bytes);
  }

  let prefixBytes = 0;
  let prefixEnd = 0;
  const retained: number[] = [];
  let oldest = 0;
  let oldestImage = 0;
  let retainedImageCount = 0;
  let removedImages = 0;
  const removed = new Set<number>();
  const omitImage = async (index: number, assistantCount: number) => {
    const occurrence = occurrences[index];
    const item = prepared.get(index) ?? { bytes: readOriginal(occurrence), mimeType: occurrence.mimeType };
    const localPath = await preserve(item.bytes, item.mimeType, index);
    const replacement = { type: occurrence.textType,
      text: replacementText(localPath, occurrence.assistantCount < assistantCount) };
    const replacementJson = JSON.stringify(replacement);
    prefixBytes += Buffer.byteLength(replacementJson) - inlineBytes[index];
    const block = occurrence.node.value as Record<string, unknown>;
    for (const key of Object.keys(block)) delete block[key];
    Object.assign(block, replacement);
    rewrites.set(index, { start: occurrence.node.start, end: occurrence.node.end, text: replacementJson });
    removed.add(index);
    if (isImageMimeType(occurrence.mimeType)) { retainedImageCount--; removedImages++; }
  };
  const compactPrefix = async (assistantCount: number) => {
    const byteCrossing = prefixBytes > trigger;
    const countCrossing = familyPolicy !== undefined && retainedImageCount > familyPolicy.trigger;
    while (
      (byteCrossing && prefixBytes > target) ||
      (countCrossing && retainedImageCount > familyPolicy!.keep)
    ) {
      let index: number;
      if (byteCrossing && prefixBytes > target) {
        while (oldest < retained.length && removed.has(retained[oldest])) oldest++;
        if (oldest === retained.length) break;
        index = retained[oldest++];
      } else {
        // A count-only crossing must not offload intervening PDFs/documents.
        while (oldestImage < retained.length && (removed.has(retained[oldestImage])
          || !isImageMimeType(occurrences[retained[oldestImage]].mimeType))) oldestImage++;
        if (oldestImage === retained.length) break;
        index = retained[oldestImage++];
      }
      await omitImage(index, assistantCount);
    }
  };
  // Both limits cross at their historical positions. Appending another image
  // consumes the remaining window; it does not reapply a final-request count cap.
  for (const [index, occurrence] of occurrences.entries()) {
    prefixBytes += Buffer.byteLength(text.slice(prefixEnd, occurrence.node.start)) + inlineBytes[index];
    prefixEnd = occurrence.node.end;
    const image = prepared.get(index);
    if (image) retainedImageCount++;
    if (!disableRemoval && policy.singleImageMaxBytes !== undefined && image && image.bytes.length > policy.singleImageMaxBytes) {
      await omitImage(index, occurrence.assistantCount);
    } else retained.push(index);
    await compactPrefix(occurrence.assistantCount);
  }
  prefixBytes += Buffer.byteLength(text.slice(prefixEnd));
  await compactPrefix(assistantState.count);
  if (prefixBytes > trigger) throw new Error('REQUEST_TEXT_TOO_LARGE');
  if (rewrites.size === 0) return null;

  const replacements = [...rewrites.values()].sort((a, b) => a.start - b.start);
  const segments: string[] = [];
  let cursor = 0;
  for (const replacement of replacements) {
    segments.push(text.slice(cursor, replacement.start), replacement.text);
    cursor = replacement.end;
  }
  segments.push(text.slice(cursor));
  const result = Buffer.from(segments.join(''));
  if (result.length > trigger) {
    throw new Error('REQUEST_TEXT_TOO_LARGE');
  }
  return { body: result, parsedBody: root.value, changed: result.compare(body) !== 0, originalBytes: body.length, bytes: result.length, removedImages, imageCount: prepared.size, reason: policy.reason ?? (removed.size ? 'budget' : 'preprocessed') };
}

export function routeInfoFor(model: string, endpoint?: string): ImageRouteInfo {
  return { modelId: model, endpoint };
}

export function hashImageBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
