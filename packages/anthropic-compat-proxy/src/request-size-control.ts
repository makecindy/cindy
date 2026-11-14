import { createHash } from 'node:crypto';

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
  modelFamily?: 'gpt' | 'claude' | 'other';
  route?: ImageRouteInfo;
  preprocessor?: InlineImagePreprocessor;
  singleImageMaxBytes?: number;
  signal?: AbortSignal;
  reason?: string;
}

export interface RequestSizeResult {
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
      return { start, end: this.offset, value: JSON.parse(raw), kind: 'string' };
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
    let escaped = false;
    while (this.offset < this.text.length) {
      const ch = this.text[this.offset++];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') return this.text.slice(start, this.offset);
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

function familyLimit(family: RequestSizePolicy['modelFamily']): { trigger: number; keep: number } | undefined {
  if (family === 'gpt') return { trigger: 50, keep: 22 };
  if (family === 'claude') return { trigger: 100, keep: 44 };
  return undefined;
}

function replacementText(path: string, seenAssistant: boolean): string {
  return `Media omitted from this request. ${seenAssistant ? 'An assistant response occurred before this media was removed.' : 'No assistant response occurred before this media was removed; it may be unseen.'} Preserved local file: ${JSON.stringify(path)}. Read that file with an image/file-reading tool when needed. Do not read all previously omitted media back into the request.`;
}

function decodeBase64(value: string): Buffer {
  if (!value || value.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('invalid image base64');
  const result = Buffer.from(value, 'base64');
  if (result.toString('base64') !== value) throw new Error('invalid image base64');
  return result;
}

/**
 * Apply the request budget while preserving every byte outside replaced image blocks.
 * The function intentionally returns null for a fast-path request.
 */
export async function controlRequestSize(body: Buffer, format: WireFormat, policy: RequestSizePolicy = {}, preserve: (bytes: Buffer, mimeType: string, occurrence: number) => Promise<string>): Promise<RequestSizeResult | null> {
  const trigger = policy.triggerBytes ?? DEFAULT_REQUEST_SIZE_TRIGGER;
  const target = policy.targetBytes ?? DEFAULT_REQUEST_SIZE_TARGET;
  const familyPolicy = familyLimit(policy.modelFamily);
  const quickLimit = Math.min(trigger, DEFAULT_QUICK_PATH_BYTES);
  if (body.length <= quickLimit) {
    const hint = (body.toString('utf8').match(/"type"\s*:\s*"(?:input_image|image|document|image_url)"/g) ?? []).length;
    if (hint === 0) return null;
  }
  const text = body.toString('utf8');
  const root = new JsonScanner(text).parse();
  const occurrences: ImageOccurrence[] = [];
  const assistantState = { count: 0 };
  for (const item of modelItems(root, format)) walkImages(item, format, occurrences, assistantState);
  if (body.length > trigger && occurrences.length === 0) throw new Error('REQUEST_TEXT_TOO_LARGE');

  const prepared = new Map<number, { bytes: Buffer; mimeType: string; changed: boolean }>();
  const preprocessor = policy.preprocessor ?? NOOP_IMAGE_PREPROCESSOR;
  for (const [index, occurrence] of occurrences.entries()) {
    policy.signal?.throwIfAborted();
    const original = decodeBase64(occurrence.raw);
    let next = { bytes: original, mimeType: occurrence.mimeType, changed: false };
    const route = policy.route ?? {};
    try {
      const output = await preprocessor.prepare({ bytes: original, mimeType: occurrence.mimeType, route, signal: policy.signal ?? new AbortController().signal });
      let tightened = output;
      if (policy.singleImageMaxBytes && original.length > policy.singleImageMaxBytes && preprocessor.tighten) {
        tightened = await preprocessor.tighten({ bytes: original, mimeType: occurrence.mimeType, route, maxBytes: policy.singleImageMaxBytes, signal: policy.signal ?? new AbortController().signal });
      }
      if (tightened?.bytes?.length && tightened.bytes.length < original.length) {
        next = { bytes: tightened.bytes, mimeType: tightened.mimeType, changed: true };
      }
    } catch { /* noop is deliberately fail-open */ }
    prepared.set(index, next);
  }

  let total = body.length;
  let count = occurrences.length;
  const remove = new Set<number>();
  const removalSeenAssistant = new Map<number, boolean>();
  const cap = familyPolicy?.keep;
  const countCapActive = familyPolicy !== undefined && occurrences.length > familyPolicy.trigger;
  let removedPrefixBytes = 0;
  // Re-run the historical crossings. This makes the same prefix produce the same removals.
  for (let index = 0; index < occurrences.length; index++) {
    const item = prepared.get(index)!;
    const originalLength = Buffer.byteLength(occurrences[index].raw);
    if (item.changed) total += Buffer.byteLength(item.bytes.toString('base64')) - originalLength;
    let prefixBytes = Buffer.byteLength(text.slice(0, occurrences[index].node.end)) - removedPrefixBytes;
    if (prefixBytes <= trigger) continue;
    while (prefixBytes > target && remove.size < occurrences.length) {
      const candidate = [...occurrences.keys()].find(i => !remove.has(i));
      if (candidate === undefined) break;
      const old = Buffer.byteLength(occurrences[candidate].raw);
      const replacement = replacementText('', occurrences[candidate].seenAssistant);
      const savings = old - Buffer.byteLength(JSON.stringify({ type: occurrences[candidate].textType, text: replacement }));
      total -= savings;
      removedPrefixBytes += savings;
      prefixBytes -= savings;
      count--;
      remove.add(candidate);
      removalSeenAssistant.set(candidate, occurrences[candidate].assistantCount < occurrences[index].assistantCount);
      if (total <= target && (cap === undefined || count <= cap)) break;
    }
  }
  // Text/tool fields after the last image still count toward the request budget. Replay the
  // final crossing at the end of the model-visible history so the oldest image is removed even
  // when the overflow comes from a trailing instruction or tool definition.
  let finalPrefixBytes = body.length - removedPrefixBytes;
  while ((finalPrefixBytes > trigger || (countCapActive && count > cap!)) && remove.size < occurrences.length) {
    const candidate = [...occurrences.keys()].find(i => !remove.has(i));
    if (candidate === undefined) break;
    const old = Buffer.byteLength(occurrences[candidate].raw);
    const replacement = replacementText('', occurrences[candidate].seenAssistant);
    const savings = old - Buffer.byteLength(JSON.stringify({ type: occurrences[candidate].textType, text: replacement }));
    finalPrefixBytes -= savings;
    total -= savings;
    removedPrefixBytes += savings;
    count--;
    remove.add(candidate);
    removalSeenAssistant.set(candidate, occurrences[candidate].assistantCount < assistantState.count);
    if (finalPrefixBytes <= target && (!countCapActive || count <= cap!)) break;
  }
  if (remove.size === 0 && !preparedHasChange(prepared)) return null;
  if (total > target && remove.size === occurrences.length) throw new Error('REQUEST_TEXT_TOO_LARGE');

  const replacements: Array<{ start: number; end: number; text: string }> = [];
  for (const index of occurrences.keys()) {
    const occurrence = occurrences[index];
    const preparedImage = prepared.get(index)!;
    if (remove.has(index)) {
      const localPath = await preserve(preparedImage.bytes, preparedImage.mimeType, index);
    const replacement = { type: occurrence.textType, text: replacementText(localPath, removalSeenAssistant.get(index) ?? false) };
      replacements.push({ start: occurrence.node.start, end: occurrence.node.end, text: JSON.stringify(replacement) });
    } else if (preparedImage.changed) {
      // The preprocessor result is represented in the original block with identical shape.
      const encoded = preparedImage.bytes.toString('base64');
      const block = JSON.parse(text.slice(occurrence.node.start, occurrence.node.end)) as Record<string, unknown>;
      if (format === 'anthropic' && record(block.source)) { block.source.data = encoded; block.source.media_type = preparedImage.mimeType; }
      else if (format === 'chat' && record(block.image_url)) block.image_url.url = `data:${preparedImage.mimeType};base64,${encoded}`;
      else if (format === 'responses') block[block.type === 'input_file' ? 'file_data' : 'image_url'] = `data:${preparedImage.mimeType};base64,${encoded}`;
      replacements.push({ start: occurrence.node.start, end: occurrence.node.end, text: JSON.stringify(block) });
    }
  }
  replacements.sort((a, b) => b.start - a.start);
  let output = text;
  for (const replacement of replacements) output = output.slice(0, replacement.start) + replacement.text + output.slice(replacement.end);
  const result = Buffer.from(output);
  if ((body.length > trigger || (familyPolicy !== undefined && occurrences.length > familyPolicy.trigger)) && result.length > target) {
    throw new Error('REQUEST_TEXT_TOO_LARGE');
  }
  return { body: result, changed: result.compare(body) !== 0, originalBytes: body.length, bytes: result.length, removedImages: remove.size, imageCount: occurrences.length, reason: policy.reason ?? (remove.size ? 'budget' : 'preprocessed') };
}

function preparedHasChange(prepared: Map<number, { changed: boolean }>): boolean {
  for (const item of prepared.values()) if (item.changed) return true;
  return false;
}

export function routeInfoFor(model: string, endpoint?: string): ImageRouteInfo {
  return { modelId: model, endpoint };
}

export function hashImageBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
