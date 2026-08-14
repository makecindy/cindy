import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import {
  type AnthropicRequest,
  type CacheControl,
  type ResponsesRequest,
  type ToolCallKind,
  type ToolCallMapping,
  type ToolContext,
  InvalidResponsesRequestError,
  UnsupportedResponsesFeatureError,
} from './types.js';

const THINKING_PREFIX = 'cindy-anthropic-thinking-v1:';
const DEFAULT_MAX_TOKENS = 8192;
const MIN_THINKING_BUDGET = 1024;
const OUTPUT_HEADROOM = 4096;
const MAX_CACHE_BREAKPOINTS = 4;
const CONTINUE_TEXT = '(continue)';
const TOOL_NAME_MAX_LENGTH = 64;
const CLAUDE_CODE_SYSTEM_INSTRUCTION =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const CLAUDE_OAUTH_TOOL_PREFIX = 'custom_';
const ANTHROPIC_BUILTIN_TOOLS = new Set([
  'web_search',
  'code_execution',
  'text_editor',
  'computer',
]);
const ANTHROPIC_IMAGE_MEDIA_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);
const ANTHROPIC_BASE64_DOCUMENT_MEDIA_TYPES = new Set([
  'application/pdf',
]);
const ANTHROPIC_TEXT_DOCUMENT_MEDIA_TYPES = new Set([
  'text/plain',
]);

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function anthropicSamplingValue(
  field: 'temperature' | 'top_p',
  value: unknown,
): number | undefined {
  const sampling = numberValue(value);
  if (sampling === undefined) return undefined;
  if (sampling < 0 || sampling > 1) {
    throw new InvalidResponsesRequestError(
      `Responses ${field} must be between 0 and 1 for the Anthropic bridge`,
    );
  }
  return sampling;
}

function textPart(text: string): { type: 'text'; text: string } {
  return { type: 'text', text };
}

function isMeaningfulText(value: string): boolean {
  return value.trim().length > 0;
}

function instructionsText(value: ResponsesRequest['instructions']): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part, index) => {
    if (!isObject(part) || typeof part.type !== 'string') {
      throw new UnsupportedResponsesFeatureError(`instructions[${index}]`);
    }
    if (
      (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text')
      && typeof part.text === 'string'
    ) {
      return part.text;
    }
    if (part.type === 'refusal' && typeof part.refusal === 'string') {
      return part.refusal;
    }
    throw new UnsupportedResponsesFeatureError(`instructions[${index}].${part.type}`);
  }).join('');
}

function agentMessageText(item: JsonObject, itemIndex: number): string {
  const normalizedAuthor = typeof item.author === 'string'
    ? item.author.replace(/\s*[\r\n]+\s*/g, ' ').trim()
    : '';
  const author = normalizedAuthor || 'agent';
  let body = '';
  let omittedEncryptedContent = false;
  if (typeof item.content === 'string') {
    body = item.content;
  } else if (Array.isArray(item.content)) {
    const parts: string[] = [];
    for (const part of item.content) {
      if (!isObject(part) || typeof part.type !== 'string') {
        throw new UnsupportedResponsesFeatureError(`input[${itemIndex}].content`);
      }
      if (part.type === 'encrypted_content') {
        omittedEncryptedContent = true;
        continue;
      }
      if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
        if (typeof part.text !== 'string') {
          throw new UnsupportedResponsesFeatureError(`input[${itemIndex}].content.${part.type}`);
        }
        parts.push(part.text);
        continue;
      }
      throw new UnsupportedResponsesFeatureError(`input[${itemIndex}].content.${part.type}`);
    }
    body = parts.join('\n');
  } else {
    throw new UnsupportedResponsesFeatureError(`input[${itemIndex}].content`);
  }
  return body.trim()
    ? `[collab ${author}]\n${body}`
    : omittedEncryptedContent
      ? `[collab message from ${author}; encrypted payload omitted]`
      : `[collab message from ${author}; empty content]`;
}

function parseDataUrl(value: string): { mediaType: string; data: string } | null {
  const match = /^data:([^;,]+)(?:;[^,]*)*;base64,([\s\S]+)$/i.exec(value);
  if (!match) return null;
  const data = match[2].replace(/\s/g, '');
  if (
    data.length === 0
    || data.length % 4 === 1
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
  ) return null;
  return { mediaType: match[1].toLowerCase(), data };
}

function validatedHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:')
      && !url.username
      && !url.password
    ) ? url.toString() : null;
  } catch {
    return null;
  }
}

function imageUrlFromPart(part: JsonObject): string | undefined {
  if (typeof part.image_url === 'string') return part.image_url;
  if (isObject(part.image_url)) return stringValue(part.image_url.url);
  return undefined;
}

function imageBlockFromPart(part: JsonObject): JsonObject {
  const imageUrl = imageUrlFromPart(part);
  if (imageUrl?.trim()) {
    const data = parseDataUrl(imageUrl);
    if (data && !ANTHROPIC_IMAGE_MEDIA_TYPES.has(data.mediaType)) {
      throw new UnsupportedResponsesFeatureError(`input_image media type '${data.mediaType}'`);
    }
    const remoteUrl = data ? null : validatedHttpUrl(imageUrl);
    if (!data && !remoteUrl) {
      throw new UnsupportedResponsesFeatureError('input_image.image_url scheme');
    }
    return {
      type: 'image',
      source: data
        ? { type: 'base64', media_type: data.mediaType, data: data.data }
        : { type: 'url', url: remoteUrl },
    };
  }
  const fileId = stringValue(part.file_id);
  if (fileId) {
    throw new UnsupportedResponsesFeatureError('input_image.file_id');
  }
  throw new UnsupportedResponsesFeatureError('input_image.image_url');
}

function documentBlockFromPart(part: JsonObject): JsonObject {
  const filename = stringValue(part.filename)?.trim();
  const fileUrl = stringValue(part.file_url);
  const fileData = stringValue(part.file_data);
  const remoteUrl = fileUrl ? validatedHttpUrl(fileUrl) : null;
  const data = fileData ? parseDataUrl(fileData) : null;
  if (fileUrl && !remoteUrl) {
    throw new UnsupportedResponsesFeatureError('input_file.file_url scheme');
  }
  if (fileData && !data) {
    throw new UnsupportedResponsesFeatureError('input_file.file_data');
  }
  if (!remoteUrl && !data) {
    if (stringValue(part.file_id)) {
      throw new UnsupportedResponsesFeatureError('input_file.file_id');
    }
    throw new UnsupportedResponsesFeatureError('input_file.file_url/file_data');
  }
  if (data && ANTHROPIC_TEXT_DOCUMENT_MEDIA_TYPES.has(data.mediaType)) {
    return {
      type: 'document',
      source: {
        type: 'text',
        media_type: 'text/plain',
        data: Buffer.from(data.data, 'base64').toString('utf8'),
      },
      ...(filename ? { title: filename } : {}),
    };
  }
  if (data && !ANTHROPIC_BASE64_DOCUMENT_MEDIA_TYPES.has(data.mediaType)) {
    throw new UnsupportedResponsesFeatureError(
      `input_file media type '${data.mediaType}'`,
    );
  }
  return {
    type: 'document',
    source: remoteUrl
      ? { type: 'url', url: remoteUrl }
      : { type: 'base64', media_type: data!.mediaType, data: data!.data },
    ...(filename ? { title: filename } : {}),
  };
}

function mediaBlockFromToolPart(part: JsonObject): JsonObject | null {
  const type = stringValue(part.type);
  if (type === 'input_image' || type === 'output_image' || type === 'image_url') {
    return imageBlockFromPart(part);
  }
  if (type === 'image') {
    if (stringValue(part.data)) {
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: stringValue(part.mimeType) ?? stringValue(part.media_type) ?? 'image/png',
          data: part.data,
        },
      };
    }
    const source = isObject(part.source) ? part.source : null;
    if (source?.type === 'base64' && stringValue(source.data)) {
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: stringValue(source.media_type) ?? 'image/png',
          data: source.data,
        },
      };
    }
    const sourceUrl = stringValue(source?.url);
    if (source?.type === 'url' && sourceUrl) {
      const url = validatedHttpUrl(sourceUrl);
      if (!url) return null;
      return {
        type: 'image',
        source: { type: 'url', url },
      };
    }
  }
  if (type === 'document' && isObject(part.source)) {
    const source = part.source;
    if (source.type === 'base64' && stringValue(source.data) && stringValue(source.media_type)) {
      const mediaType = stringValue(source.media_type)!.toLowerCase();
      if (mediaType === 'text/plain') {
        return {
          type: 'document',
          source: {
            type: 'text',
            media_type: 'text/plain',
            data: Buffer.from(stringValue(source.data)!, 'base64').toString('utf8'),
          },
          ...(stringValue(part.title) ? { title: part.title } : {}),
        };
      }
      if (!ANTHROPIC_BASE64_DOCUMENT_MEDIA_TYPES.has(mediaType)) return null;
      return {
        type: 'document',
        source: {
          type: 'base64',
          media_type: mediaType,
          data: source.data,
        },
        ...(stringValue(part.title) ? { title: part.title } : {}),
      };
    }
    const sourceUrl = stringValue(source.url);
    if (source.type === 'url' && sourceUrl) {
      const url = validatedHttpUrl(sourceUrl);
      if (!url) return null;
      return {
        type: 'document',
        source: { type: 'url', url },
        ...(stringValue(part.title) ? { title: part.title } : {}),
      };
    }
  }
  if (type === 'input_file' || type === 'file') {
    return documentBlockFromPart(part);
  }
  return null;
}

const MAX_TOOL_OUTPUT_JSON_DEPTH = 8;
const MAX_TOOL_OUTPUT_JSON_CHARS = 2 * 1024 * 1024;

function hasMediaBlocks(value: unknown): boolean {
  return Array.isArray(value) && value.some((item) => (
    isObject(item) && (item.type === 'image' || item.type === 'document')
  ));
}

function toolOutputBlocks(output: unknown, depth = 0): unknown {
  if (depth > MAX_TOOL_OUTPUT_JSON_DEPTH) {
    try {
      return JSON.stringify(output) ?? '(empty tool output)';
    } catch {
      return String(output);
    }
  }
  if (typeof output === 'string') {
    // MCP servers commonly serialize an Anthropic/OpenAI content array into the
    // function output string. Parse only bounded, JSON-looking strings and keep the
    // original text when no media was found, preserving the legacy wire payload.
    if (
      depth < MAX_TOOL_OUTPUT_JSON_DEPTH
      && output.length <= MAX_TOOL_OUTPUT_JSON_CHARS
      && /^[\s]*(?:\{|\[)/.test(output)
    ) {
      try {
        const parsed = JSON.parse(output) as unknown;
        const parsedBlocks = toolOutputBlocks(parsed, depth + 1);
        if (hasMediaBlocks(parsedBlocks)) return parsedBlocks;
      } catch {
        // Not JSON (or too deeply nested): keep it as ordinary tool text.
      }
    }
    return isMeaningfulText(output) ? output : '(empty tool output)';
  }
  if (!Array.isArray(output)) {
    if (isObject(output)) {
      const directMedia = mediaBlockFromToolPart(output);
      if (directMedia) return [directMedia];
      const nested = Array.isArray(output.content)
        ? toolOutputBlocks(output.content, depth + 1)
        : Array.isArray(output.output)
          ? toolOutputBlocks(output.output, depth + 1)
          : null;
      if (nested && hasMediaBlocks(nested)) return nested;
    }
    try {
      return JSON.stringify(output) ?? '(empty tool output)';
    } catch {
      return String(output);
    }
  }
  const blocks: JsonObject[] = [];
  for (const raw of output) {
    if (typeof raw === 'string') {
      if (isMeaningfulText(raw)) blocks.push(textPart(raw));
      continue;
    }
    if (!isObject(raw)) {
      blocks.push(textPart(String(raw)));
      continue;
    }
    const media = mediaBlockFromToolPart(raw);
    if (media) {
      blocks.push(media);
      continue;
    }
    const nested = Array.isArray(raw.content)
      ? toolOutputBlocks(raw.content, depth + 1)
      : Array.isArray(raw.output)
        ? toolOutputBlocks(raw.output, depth + 1)
        : null;
    if (nested && hasMediaBlocks(nested)) {
      if (Array.isArray(nested)) blocks.push(...nested.filter(isObject));
      continue;
    }
    const type = stringValue(raw.type);
    if (type === 'input_text' || type === 'output_text' || type === 'text' || type === 'refusal') {
      const text = stringValue(raw.text) ?? stringValue(raw.refusal);
      if (text && isMeaningfulText(text)) blocks.push(textPart(text));
      continue;
    }
    if (type === 'input_file' || type === 'file') {
      blocks.push(documentBlockFromPart(raw));
      continue;
    }
    blocks.push(textPart(JSON.stringify(raw)));
  }
  return blocks.length > 0 ? blocks : '(empty tool output)';
}

function collectToolSearchTools(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  const output: unknown[] = [];
  for (const item of value) {
    if (
      isObject(item)
      && (item.type === 'tool_search_output' || item.type === 'tool_search_call_output')
      && Array.isArray(item.tools)
    ) {
      output.push(...item.tools);
    }
  }
  return output;
}

function containsTopLevelItemType(value: unknown, expected: string): boolean {
  return Array.isArray(value)
    && value.some((item) => isObject(item) && item.type === expected);
}

const SCHEMA_NAME_BAGS = new Set(['properties', 'patternProperties', '$defs', 'definitions']);
const SCHEMA_LITERAL_VALUE_KEYS = new Set(['const', 'default', 'enum', 'examples']);

function stripEncryptedSchemaMarker(
  value: unknown,
  inNameBag = false,
): unknown {
  if (Array.isArray(value)) return value.map((item) => stripEncryptedSchemaMarker(item));
  if (!isObject(value)) return value;
  const output: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (inNameBag) {
      output[key] = stripEncryptedSchemaMarker(child);
    } else if (key !== 'encrypted') {
      output[key] = SCHEMA_LITERAL_VALUE_KEYS.has(key)
        ? child
        : stripEncryptedSchemaMarker(child, SCHEMA_NAME_BAGS.has(key));
    }
  }
  return output;
}

function schemaForAnthropic(value: unknown): JsonObject {
  const stripped = stripEncryptedSchemaMarker(value);
  const source = isObject(stripped) ? stripped : {};
  // Anthropic requires a root object schema, but oneOf/anyOf/allOf remain valid
  // constraints on that object. Preserve them verbatim instead of merging variants,
  // which would weaken mutually exclusive required-property contracts.
  return {
    ...source,
    type: 'object',
    properties: isObject(source.properties) ? source.properties : {},
  };
}

function safeToolName(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function shortHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);
}

function clampToolName(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]/g, '_') || 'tool';
  const changed = normalized !== value;
  const suffix = changed ? `__${shortHash(value)}` : '';
  if (!changed && normalized.length <= TOOL_NAME_MAX_LENGTH) return normalized;
  const hashSuffix = suffix || `__${shortHash(value)}`;
  return `${normalized.slice(0, TOOL_NAME_MAX_LENGTH - hashSuffix.length)}${hashSuffix}`;
}

function wireToolName(
  responseName: string,
  namespace: string | undefined,
  oauth: boolean,
): string {
  const flat = namespace ? `${namespace}__${responseName}` : responseName;
  const prefixed = oauth
    && !ANTHROPIC_BUILTIN_TOOLS.has(responseName.toLowerCase())
    && !flat.toLowerCase().startsWith(CLAUDE_OAUTH_TOOL_PREFIX)
    ? `${CLAUDE_OAUTH_TOOL_PREFIX}${flat}`
    : flat;
  return clampToolName(prefixed);
}

function responseToolIdentity(
  kind: ToolCallKind,
  name: string,
  namespace?: string,
): string {
  const identityKind = kind === 'namespace' ? 'function' : kind;
  return `${identityKind}\0${namespace ?? ''}\0${name}`;
}

function sameResponseToolKind(left: ToolCallKind, right: ToolCallKind): boolean {
  const normalizedLeft = left === 'namespace' ? 'function' : left;
  const normalizedRight = right === 'namespace' ? 'function' : right;
  return normalizedLeft === normalizedRight;
}

function reserveWireToolName(
  preferred: string,
  mapping: ToolCallMapping,
  existingByWireName: ReadonlyMap<string, ToolCallMapping>,
): string {
  const identity = responseToolIdentity(mapping.kind, mapping.name, mapping.namespace);
  const existing = existingByWireName.get(preferred);
  if (!existing || responseToolIdentity(existing.kind, existing.name, existing.namespace) === identity) {
    return preferred;
  }
  for (let attempt = 0; ; attempt += 1) {
    const suffix = `__${shortHash(attempt === 0 ? identity : `${identity}\0${attempt}`)}`;
    const candidate = `${preferred.slice(0, TOOL_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
    const occupant = existingByWireName.get(candidate);
    if (
      !occupant
      || responseToolIdentity(occupant.kind, occupant.name, occupant.namespace) === identity
    ) {
      return candidate;
    }
  }
}

function flattenTools(
  tools: unknown[] | undefined,
  oauth: boolean,
  strictTools: boolean,
): { tools?: unknown[]; context: ToolContext } {
  if (!tools?.length) {
    return { context: { byWireName: new Map(), byResponseName: new Map() } };
  }
  const converted: unknown[] = [];
  const byWireName = new Map<string, ToolCallMapping>();
  const byResponseName = new Map<string, ToolCallMapping>();

  const add = (
    name: string,
    description: string | undefined,
    parameters: unknown,
    kind: ToolCallKind,
    namespace?: string,
    strict?: boolean,
  ): void => {
    const responseName = safeToolName(name, 'tool');
    const baseMapping = {
      wireName: '',
      name: responseName,
      ...(namespace ? { namespace } : {}),
      kind,
    } satisfies ToolCallMapping;
    const wireName = reserveWireToolName(
      wireToolName(responseName, namespace, oauth),
      baseMapping,
      byWireName,
    );
    const mapping: ToolCallMapping = { ...baseMapping, wireName };
    if (byWireName.has(wireName)) return;
    byWireName.set(wireName, mapping);
    byResponseName.set(responseToolIdentity(kind, responseName, namespace), mapping);
    const inputSchema = kind === 'custom'
      ? {
          type: 'object',
          properties: {
            input: {
              type: 'string',
              description: 'The free-form input for this custom tool.',
            },
          },
          required: ['input'],
        }
      : schemaForAnthropic(parameters);
    converted.push({
      name: wireName,
      ...(description ? { description } : {}),
      input_schema: inputSchema,
      ...(strictTools && strict !== undefined ? { strict } : {}),
    });
  };

  for (const raw of tools) {
    if (!isObject(raw)) continue;
    const type = stringValue(raw.type);
    if (type === 'function' || type === 'custom') {
      add(
        stringValue(raw.name) ?? (isObject(raw.function) ? stringValue(raw.function.name) : undefined) ?? 'tool',
        stringValue(raw.description) ?? (isObject(raw.function) ? stringValue(raw.function.description) : undefined),
        raw.parameters ?? (isObject(raw.function) ? raw.function.parameters : undefined),
        type === 'custom' ? 'custom' : 'function',
        undefined,
        typeof raw.strict === 'boolean'
          ? raw.strict
          : isObject(raw.function) && typeof raw.function.strict === 'boolean'
            ? raw.function.strict
            : undefined,
      );
      continue;
    }
    if (type === 'namespace') {
      const namespace = safeToolName(stringValue(raw.name) ?? 'namespace', 'namespace');
      const members = Array.isArray(raw.tools)
        ? raw.tools
        : Array.isArray(raw.functions)
          ? raw.functions
          : [];
      for (const member of members) {
        if (!isObject(member)) continue;
        const memberType = stringValue(member.type);
        if (memberType !== 'function' && memberType !== 'custom') continue;
        add(
          stringValue(member.name) ?? (isObject(member.function) ? stringValue(member.function.name) : undefined) ?? 'tool',
          stringValue(member.description) ?? (isObject(member.function) ? stringValue(member.function.description) : undefined),
          member.parameters ?? (isObject(member.function) ? member.function.parameters : undefined),
          memberType === 'custom' ? 'custom' : 'namespace',
          namespace,
          typeof member.strict === 'boolean'
            ? member.strict
            : isObject(member.function) && typeof member.function.strict === 'boolean'
              ? member.function.strict
              : undefined,
        );
      }
      continue;
    }
    if (type === 'tool_search' || type === 'tool_search_call') {
      add('tool_search', stringValue(raw.description), raw.parameters, 'tool_search');
      continue;
    }
    // Hosted tools such as web_search are not executable by Cindy's local tool loop. They
    // must not make the whole bridge fail; the model can still use regular function tools.
  }
  return {
    tools: converted.length > 0 ? converted : undefined,
    context: { byWireName, byResponseName },
  };
}

function decodeBase64Url(value: string): string | null {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(normalized, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

export function encodeThinkingBlock(block: JsonObject): string | null {
  const type = stringValue(block.type);
  const valid = (type === 'thinking' && typeof block.signature === 'string' && block.signature.length > 0)
    || (type === 'redacted_thinking' && typeof block.data === 'string' && block.data.length > 0);
  if (!valid) return null;
  return `${THINKING_PREFIX}${Buffer.from(JSON.stringify(block), 'utf8').toString('base64url')}`;
}

export function decodeThinkingBlock(value: string): JsonObject | null {
  if (!value.startsWith(THINKING_PREFIX)) return null;
  const decoded = decodeBase64Url(value.slice(THINKING_PREFIX.length));
  if (!decoded) return null;
  try {
    const block = JSON.parse(decoded) as unknown;
    return isObject(block) && encodeThinkingBlock(block) !== null ? block : null;
  } catch {
    return null;
  }
}

function responseNameForMapping(
  context: ToolContext,
  name: string,
  namespace?: string,
  kind: ToolCallKind = 'function',
  oauth = false,
): ToolCallMapping {
  const normalizedNamespace = namespace?.trim();
  const byIdentity = context.byResponseName.get(
    responseToolIdentity(kind, name, normalizedNamespace),
  );
  const byWireName = context.byWireName.get(
    normalizedNamespace ? `${normalizedNamespace}__${name}` : name,
  );
  const exact = byIdentity ?? (
    byWireName && sameResponseToolKind(byWireName.kind, kind)
      ? byWireName
      : undefined
  );
  return exact ?? {
    wireName: wireToolName(name, normalizedNamespace, oauth),
    name,
    ...(normalizedNamespace ? { namespace: normalizedNamespace } : {}),
    kind: kind === 'function' && normalizedNamespace ? 'namespace' : kind,
  };
}

function reasoningBlock(item: JsonObject): JsonObject | null {
  const encrypted = stringValue(item.encrypted_content);
  return encrypted ? decodeThinkingBlock(encrypted) : null;
}

function inputContentToAnthropic(
  content: unknown,
  role: 'user' | 'assistant',
): JsonObject[] {
  if (typeof content === 'string') return isMeaningfulText(content) ? [textPart(content)] : [];
  if (!Array.isArray(content)) throw new UnsupportedResponsesFeatureError('message.content');
  const blocks: JsonObject[] = [];
  for (const raw of content) {
    if (!isObject(raw)) throw new UnsupportedResponsesFeatureError('message.content');
    const type = stringValue(raw.type);
    if (type === 'input_text' || type === 'output_text' || type === 'text') {
      const text = stringValue(raw.text);
      if (text && isMeaningfulText(text)) blocks.push(textPart(text));
      continue;
    }
    if (type === 'refusal') {
      const refusal = stringValue(raw.refusal);
      if (refusal && isMeaningfulText(refusal)) blocks.push(textPart(refusal));
      continue;
    }
    if (type === 'input_image') {
      const image = imageBlockFromPart(raw);
      blocks.push(image);
      continue;
    }
    if (type === 'image_url') {
      blocks.push(imageBlockFromPart(raw));
      continue;
    }
    if (type === 'input_file' || type === 'file') {
      blocks.push(documentBlockFromPart(raw));
      continue;
    }
    throw new UnsupportedResponsesFeatureError(`message.content.${type ?? 'unknown'}`);
  }
  // Anthropic assistant messages cannot contain input_image blocks. Avoid a silent
  // role change: fail clearly so a caller can remove the invalid history item.
  if (
    role === 'assistant'
    && blocks.some((block) => block.type === 'image' || block.type === 'document')
  ) {
    throw new UnsupportedResponsesFeatureError('assistant image content');
  }
  return blocks;
}

function appendMessage(
  messages: Array<{ role: 'user' | 'assistant'; content: JsonObject[] }>,
  role: 'user' | 'assistant',
  content: JsonObject[],
): void {
  if (content.length === 0) return;
  const last = messages[messages.length - 1];
  if (last?.role === role) last.content.push(...content);
  else messages.push({ role, content });
}

function orphanToolResultBlock(block: JsonObject): JsonObject {
  const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : 'unknown';
  return textPart(`[orphan tool_result ${id} omitted from replay]`);
}

function repairToolHistory(
  messages: Array<{ role: 'user' | 'assistant'; content: JsonObject[] }>,
): void {
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.role === 'user') {
      const previous = messages[i - 1];
      const followsToolUse = previous?.role === 'assistant'
        && previous.content.some((block) => block.type === 'tool_use');
      if (!followsToolUse) {
        message.content = message.content.map((block) => (
          block.type === 'tool_result' ? orphanToolResultBlock(block) : block
        ));
      }
      continue;
    }

    const thinking = message.content.filter((block) => (
      block.type === 'thinking' || block.type === 'redacted_thinking'
    ));
    const nonThinking = message.content.filter((block) => (
      block.type !== 'thinking' && block.type !== 'redacted_thinking'
    ));
    message.content = [...thinking, ...nonThinking];
    const calls = message.content.filter((block) => (
      block.type === 'tool_use' && typeof block.id === 'string'
    ));
    if (calls.length === 0) continue;

    const next = messages[i + 1];
    if (!next || next.role !== 'user') {
      messages.splice(i + 1, 0, {
        role: 'user',
        content: calls.map((call) => ({
          type: 'tool_result',
          tool_use_id: String(call.id),
          content: '[missing tool_result in history]',
          is_error: true,
        })),
      });
      i += 1;
      continue;
    }

    const resultBlocks = next.content.filter((block) => block.type === 'tool_result');
    const otherBlocks = next.content.filter((block) => block.type !== 'tool_result');
    const consumed = new Set<number>();
    const ordered: JsonObject[] = [];
    for (const call of calls) {
      const id = String(call.id);
      const resultIndex = resultBlocks.findIndex((block, index) => (
        !consumed.has(index) && block.tool_use_id === id
      ));
      if (resultIndex >= 0) {
        consumed.add(resultIndex);
        ordered.push(resultBlocks[resultIndex]);
      } else {
        ordered.push({
          type: 'tool_result',
          tool_use_id: id,
          content: '[missing tool_result in history]',
          is_error: true,
        });
      }
    }
    const orphans = resultBlocks
      .filter((_, index) => !consumed.has(index))
      .map(orphanToolResultBlock);
    next.content = [...ordered, ...orphans, ...otherBlocks];
    i += 1;
  }
}

function normalizeMessages(
  messages: Array<{ role: 'user' | 'assistant'; content: JsonObject[] }>,
): Array<{ role: 'user' | 'assistant'; content: JsonObject[] }> {
  const compacted: Array<{ role: 'user' | 'assistant'; content: JsonObject[] }> = [];
  for (const message of messages) appendMessage(compacted, message.role, message.content);
  if (compacted.length === 0) {
    compacted.push({ role: 'user', content: [textPart(CONTINUE_TEXT)] });
  } else if (compacted[0].role !== 'user') {
    // Anthropic history must begin with user, but dropping an assistant/tool turn would
    // lose the exact call ids Codex replays. Keep the history and add a deterministic
    // resume marker before it.
    compacted.unshift({ role: 'user', content: [textPart(CONTINUE_TEXT)] });
  }
  repairToolHistory(compacted);
  const last = compacted[compacted.length - 1];
  if (last.role === 'assistant') compacted.push({ role: 'user', content: [textPart(CONTINUE_TEXT)] });
  return compacted;
}

/**
 * Anthropic requires a tool-result continuation to replay the signed thinking block
 * from the immediately preceding assistant tool turn. A fresh user turn is always safe.
 */
function trailingTurnSupportsThinking(
  messages: Array<{ role: 'user' | 'assistant'; content: JsonObject[] }>,
): boolean {
  const userIndex = messages.findLastIndex((message) => message.role === 'user');
  if (userIndex < 0) return true;
  const results = messages[userIndex].content.filter((block) => block.type === 'tool_result');
  if (results.length === 0) return true;
  const assistant = messages[userIndex - 1];
  if (!assistant || assistant.role !== 'assistant') return false;
  const signedThinking = assistant.content.some((block) => (
    (block.type === 'thinking' && typeof block.signature === 'string' && block.signature.length > 0)
    || (block.type === 'redacted_thinking' && typeof block.data === 'string' && block.data.length > 0)
  ));
  if (!signedThinking) return false;
  const callIds = new Set(
    assistant.content
      .filter((block) => block.type === 'tool_use' && typeof block.id === 'string')
      .map((block) => String(block.id)),
  );
  return results.every((block) => (
    typeof block.tool_use_id === 'string' && callIds.has(block.tool_use_id)
  ));
}

function effortBudget(effort: string | undefined): number | null {
  switch ((effort ?? '').trim().toLowerCase()) {
    case 'minimal': return 2048;
    case 'low': return 4096;
    case 'medium': return 8192;
    case 'high': return 16384;
    case 'xhigh':
    case 'max':
    case 'ultra': return 24576;
    default: return null;
  }
}

function normalizedEffort(effort: string | undefined): string | null {
  switch ((effort ?? '').trim().toLowerCase()) {
    case 'minimal':
    case 'low': return 'low';
    case 'medium': return 'medium';
    case 'high': return 'high';
    case 'xhigh':
    case 'max':
    case 'ultra': return 'max';
    default: return null;
  }
}

function supportsAdaptiveThinkingByModel(model: string): boolean {
  const normalized = model.trim().toLowerCase().replace(/[._]/g, '-');
  return ['fable-5', 'mythos-5', 'mythos-preview', 'sonnet-5']
    .some((needle) => normalized.includes(needle))
    || /claude-opus-4-(?:7|8)(?:-|$)/.test(normalized)
    || /claude-sonnet-5(?:-|$)/.test(normalized);
}

function adaptiveThinkingByDefault(model: string): boolean {
  const normalized = model.trim().toLowerCase().replace(/[._]/g, '-');
  return ['fable-5', 'mythos-5', 'mythos-preview', 'sonnet-5']
    .some((needle) => normalized.includes(needle));
}

function thinkingCannotBeDisabled(model: string): boolean {
  const normalized = model.trim().toLowerCase().replace(/[._]/g, '-');
  return normalized.includes('fable-5') || normalized.includes('mythos-5');
}

function mapToolChoice(value: unknown, context: ToolContext, oauth: boolean): unknown {
  if (typeof value === 'string') {
    if (value === 'required') return { type: 'any' };
    if (value === 'none') return { type: 'none' };
    return { type: 'auto' };
  }
  if (!isObject(value)) return { type: 'auto' };
  if (value.type === 'function' || value.type === 'custom') {
    const nestedFunction = isObject(value.function) ? value.function : undefined;
    const name = stringValue(value.name) ?? stringValue(nestedFunction?.name) ?? '';
    const mapping = responseNameForMapping(
      context,
      name,
      stringValue(value.namespace),
      value.type === 'custom' ? 'custom' : 'function',
      oauth,
    );
    return { type: 'tool', name: mapping.wireName };
  }
  if (value.type === 'tool_search') {
    const mapping = responseNameForMapping(context, 'tool_search', undefined, 'tool_search', oauth);
    return { type: 'tool', name: mapping.wireName };
  }
  if (value.type === 'allowed_tools') {
    return { type: value.mode === 'required' ? 'any' : 'auto' };
  }
  return { type: 'auto' };
}

function assertSupportedToolChoice(value: unknown): void {
  if (!isObject(value)) return;
  const type = stringValue(value.type);
  if (
    type === 'function'
    || type === 'custom'
    || type === 'tool_search'
    || type === 'allowed_tools'
    || type === 'auto'
    || type === 'none'
  ) {
    return;
  }
  throw new UnsupportedResponsesFeatureError(`tool_choice type '${type ?? 'unknown'}'`);
}

function filterToolsForChoice(
  tools: unknown[] | undefined,
  choice: unknown,
  context: ToolContext,
  oauth: boolean,
): unknown[] | undefined {
  if (!tools?.length || !isObject(choice) || choice.type !== 'allowed_tools' || !Array.isArray(choice.tools)) {
    return tools;
  }
  const allowed = new Set<string>();
  for (const raw of choice.tools) {
    if (typeof raw === 'string' && raw.trim()) {
      const name = raw.trim();
      const mapping = responseNameForMapping(context, name, undefined, 'function', oauth);
      allowed.add(mapping.wireName);
      continue;
    }
    if (!isObject(raw)) continue;
    const name = stringValue(raw.name)
      ?? (isObject(raw.function) ? stringValue(raw.function.name) : undefined);
    const namespace = stringValue(raw.namespace);
    if (name) {
      const kind = raw.type === 'custom'
        ? 'custom'
        : raw.type === 'tool_search'
          ? 'tool_search'
          : 'function';
      const mapping = responseNameForMapping(context, name, namespace, kind, oauth);
      allowed.add(mapping.wireName);
    }
  }
  if (allowed.size === 0) return [];
  return tools.filter((tool) => (
    isObject(tool) && typeof tool.name === 'string' && allowed.has(tool.name)
  ));
}

function requiresToolCall(value: unknown): boolean {
  if (value === 'required') return true;
  if (!isObject(value)) return false;
  if (value.type === 'allowed_tools') return value.mode === 'required';
  if (value.type === 'auto' || value.type === 'none') return false;
  return true;
}

function forcedToolChoice(value: unknown): boolean {
  if (!isObject(value)) return false;
  return value.type === 'any' || value.type === 'tool' || (
    value.type === 'allowed_tools' && value.mode === 'required'
  );
}

function stopSequences(value: ResponsesRequest['stop']): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const values = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(values) || values.some((entry) => typeof entry !== 'string')) {
    throw new InvalidResponsesRequestError('Responses stop must be a string or an array of strings');
  }
  const nonEmpty = values.filter((entry) => entry.length > 0);
  return nonEmpty.length > 0 ? nonEmpty : undefined;
}

function assertSupportedResponseFormat(raw: ResponsesRequest): void {
  const formats: Array<[string, unknown]> = [
    ['response_format', raw.response_format],
    ['text.format', isObject(raw.text) ? raw.text.format : undefined],
  ];
  for (const [field, value] of formats) {
    if (value === undefined) continue;
    if (isObject(value) && value.type === 'text') continue;
    throw new UnsupportedResponsesFeatureError(field);
  }
}

function applyPromptCaching(
  body: AnthropicRequest,
  enabled: boolean,
  automatic = false,
): void {
  if (!enabled) return;
  const cc: CacheControl = { type: 'ephemeral' };
  if (automatic) body.cache_control = cc;
  const explicitLimit = automatic ? MAX_CACHE_BREAKPOINTS - 1 : MAX_CACHE_BREAKPOINTS;
  let used = 0;
  const tools = body.tools as JsonObject[] | undefined;
  if (tools?.length) {
    tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: cc };
    used += 1;
  }
  if (used < explicitLimit && body.system?.length) {
    const last = body.system.length - 1;
    body.system[last] = { ...body.system[last], cache_control: cc };
    used += 1;
  }
  const userIndexes = body.messages
    .map((message, index) => message.role === 'user' ? index : -1)
    .filter((index) => index >= 0);
  // Native automatic caching already follows the moving final block. Explicitly
  // marking that same last user block wastes a breakpoint; retain only the stable
  // penultimate user turn in automatic mode.
  const cacheableUserIndexes = automatic
    ? userIndexes.slice(-2, -1)
    : userIndexes.slice(-2);
  for (const index of cacheableUserIndexes) {
    if (used >= explicitLimit) break;
    const message = body.messages[index];
    if (!Array.isArray(message.content) || message.content.length === 0) continue;
    const textIndex = [...message.content].map((block, i) => block.type === 'text' ? i : -1)
      .filter((i) => i >= 0).pop();
    const target = textIndex ?? message.content.length - 1;
    message.content[target] = { ...message.content[target], cache_control: cc };
    used += 1;
  }
}

export interface TranslateResponsesRequestOptions {
  model?: string;
  defaultMaxTokens?: number;
  supportsAdaptiveThinking?: (model: string) => boolean;
  supportsThinking?: (model: string) => boolean;
  promptCaching?: boolean;
  automaticPromptCaching?: boolean;
  strictTools?: boolean;
  authMode?: 'api-key' | 'oauth';
}

export interface TranslatedResponsesRequest {
  request: AnthropicRequest;
  toolContext: ToolContext;
}

export function translateResponsesRequest(
  raw: ResponsesRequest,
  options: TranslateResponsesRequestOptions = {},
): TranslatedResponsesRequest {
  if (!isObject(raw) || typeof raw.model !== 'string' || raw.model.length === 0) {
    throw new UnsupportedResponsesFeatureError('model');
  }
  assertSupportedResponseFormat(raw);
  const model = options.model ?? raw.model;
  const systemParts: string[] = [];
  const instructions = instructionsText(raw.instructions);
  if (isMeaningfulText(instructions)) systemParts.push(instructions);
  const oauth = options.authMode === 'oauth';
  if (oauth) systemParts.unshift(CLAUDE_CODE_SYSTEM_INSTRUCTION);
  const messages: Array<{ role: 'user' | 'assistant'; content: JsonObject[] }> = [];
  const dynamicTools = collectToolSearchTools(raw.input);
  const needsToolSearch = containsTopLevelItemType(raw.input, 'tool_search_call')
    || (isObject(raw.tool_choice) && raw.tool_choice.type === 'tool_search');
  const declaredTools = raw.tools?.length || dynamicTools.length || needsToolSearch
    ? [
        ...(raw.tools ?? []),
        ...dynamicTools,
        ...(needsToolSearch ? [{ type: 'tool_search', name: 'tool_search' }] : []),
      ]
    : undefined;
  const context = flattenTools(declaredTools, oauth, options.strictTools === true);
  assertSupportedToolChoice(raw.tool_choice);
  const input = raw.input;
  const items = typeof input === 'string'
    ? [{ role: 'user', content: input }]
    : Array.isArray(input) ? input : [];
  let assistant: { role: 'assistant'; content: JsonObject[] } | null = null;
  const incompleteCallIds = new Set<string>();
  const flushAssistant = (): void => {
    if (!assistant || assistant.content.length === 0) {
      assistant = null;
      return;
    }
    appendMessage(messages, 'assistant', assistant.content);
    assistant = null;
  };

  for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
    const rawItem = items[itemIndex];
    if (!isObject(rawItem)) throw new UnsupportedResponsesFeatureError('input item');
    const type = stringValue(rawItem.type);
    if (type === 'reasoning') {
      const block = reasoningBlock(rawItem);
      if (block) {
        assistant ??= { role: 'assistant', content: [] };
        assistant.content.push(block);
      }
      continue;
    }
    if (type === 'function_call' || type === 'custom_tool_call' || type === 'tool_search_call') {
      const callId = stringValue(rawItem.call_id) ?? stringValue(rawItem.id);
      const rawName = stringValue(rawItem.name) ?? (type === 'tool_search_call' ? 'tool_search' : '');
      if (!callId || !rawName) throw new UnsupportedResponsesFeatureError(`${type}.call_id/name`);
      if (rawItem.status === 'incomplete') {
        incompleteCallIds.add(callId);
        continue;
      }
      const mapping = responseNameForMapping(
        context.context,
        rawName,
        stringValue(rawItem.namespace),
        type === 'custom_tool_call'
          ? 'custom'
          : type === 'tool_search_call'
            ? 'tool_search'
            : 'function',
        oauth,
      );
      assistant ??= { role: 'assistant', content: [] };
      let inputValue: JsonObject = {};
      if (type === 'custom_tool_call') {
        const customInput = rawItem.input;
        inputValue = isObject(customInput)
          && typeof customInput.input === 'string'
          ? customInput
          : { input: typeof customInput === 'string' ? customInput : JSON.stringify(customInput ?? '') };
      } else if (isObject(rawItem.arguments)) {
        inputValue = rawItem.arguments;
      } else if (typeof rawItem.arguments === 'string' && rawItem.arguments.trim()) {
        try {
          const parsed = JSON.parse(rawItem.arguments) as unknown;
          if (isObject(parsed)) inputValue = parsed;
        } catch {
          // A poisoned historical call must not invent a provider-specific input field.
        }
      }
      assistant.content.push({
        type: 'tool_use',
        id: callId,
        name: mapping.wireName,
        input: inputValue,
      });
      continue;
    }
    if (type === 'agent_message') {
      assistant ??= { role: 'assistant', content: [] };
      assistant.content.push(textPart(agentMessageText(rawItem, itemIndex)));
      continue;
    }
    if (type === 'input_text' || type === 'input_image' || type === 'input_file') {
      flushAssistant();
      appendMessage(messages, 'user', inputContentToAnthropic([rawItem], 'user'));
      continue;
    }
    // A tool_search_output carrying discovered definitions is a control/history item,
    // not a tool result. Only the call-correlated form becomes tool_result content.
    if (
      type === 'tool_search_output'
      && !stringValue(rawItem.call_id)
      && !stringValue(rawItem.id)
      && Array.isArray(rawItem.tools)
    ) {
      continue;
    }
    if (
      type === 'function_call_output'
      || type === 'custom_tool_call_output'
      || type === 'tool_search_output'
      || type === 'tool_search_call_output'
    ) {
      flushAssistant();
      const callId = stringValue(rawItem.call_id) ?? stringValue(rawItem.id);
      if (!callId) throw new UnsupportedResponsesFeatureError(`${type}.call_id`);
      if (incompleteCallIds.has(callId)) continue;
      const output = rawItem.output
        ?? rawItem.content
        ?? (
          (type === 'tool_search_output' || type === 'tool_search_call_output')
          && Array.isArray(rawItem.tools)
            ? JSON.stringify(rawItem.tools)
            : ''
        );
      appendMessage(messages, 'user', [{
        type: 'tool_result',
        tool_use_id: callId,
        content: toolOutputBlocks(output),
        ...(rawItem.is_error === true ? { is_error: true } : {}),
      }]);
      continue;
    }
    if (typeof rawItem.role === 'string') {
      const role = rawItem.role;
      if (role === 'system' || role === 'developer') {
        const parts = inputContentToAnthropic(rawItem.content, 'user');
        for (const part of parts) if (part.type === 'text') systemParts.push(String(part.text));
        continue;
      }
      if (role !== 'user' && role !== 'assistant') throw new UnsupportedResponsesFeatureError(`input role '${role}'`);
      const parts = inputContentToAnthropic(rawItem.content, role);
      if (role === 'assistant') {
        assistant ??= { role: 'assistant', content: [] };
        assistant.content.push(...parts);
      } else {
        flushAssistant();
        appendMessage(messages, 'user', parts);
      }
      continue;
    }
    throw new UnsupportedResponsesFeatureError(`input item '${type ?? 'unknown'}'`);
  }
  flushAssistant();
  const normalizedMessages = normalizeMessages(messages);
  const maxTokens = Math.max(
    1,
    Math.floor(numberValue(raw.max_output_tokens) ?? options.defaultMaxTokens ?? DEFAULT_MAX_TOKENS),
  );
  const effort = stringValue(raw.reasoning?.effort);
  const explicitlyDisabled = ['none', 'off', 'disabled'].includes((effort ?? '').toLowerCase());
  const budget = effortBudget(effort);
  const thinkingSupported = options.supportsThinking?.(model) ?? true;
  const adaptiveSupported =
    options.supportsAdaptiveThinking?.(model) ?? supportsAdaptiveThinkingByModel(model);
  const adaptive = adaptiveSupported
    && (adaptiveThinkingByDefault(model) || budget !== null);
  const cannotDisableThinking = thinkingSupported && thinkingCannotBeDisabled(model);
  const anth: AnthropicRequest = {
    model,
    messages: normalizedMessages,
    max_tokens: maxTokens,
    stream: raw.stream !== false,
  };
  if (systemParts.length > 0) {
    anth.system = oauth
      ? systemParts.map((text) => ({ type: 'text', text }))
      : [{ type: 'text', text: systemParts.join('\n\n') }];
  }
  const selectedTools = filterToolsForChoice(context.tools, raw.tool_choice, context.context, oauth);
  if ((!selectedTools || selectedTools.length === 0) && requiresToolCall(raw.tool_choice)) {
    throw new UnsupportedResponsesFeatureError(
      'tool_choice requires a bridge-compatible tool',
    );
  }
  if (selectedTools && selectedTools.length > 0) anth.tools = selectedTools;
  if (anth.tools && raw.tool_choice !== undefined && raw.tool_choice !== 'none') {
    anth.tool_choice = mapToolChoice(raw.tool_choice, context.context, oauth);
  } else if (raw.tool_choice === 'none' && anth.tools) {
    anth.tool_choice = { type: 'none' };
  }
  if (raw.parallel_tool_calls === false && anth.tools) {
    const choice = isObject(anth.tool_choice) ? anth.tool_choice : { type: 'auto' };
    anth.tool_choice = { ...choice, disable_parallel_tool_use: true };
  }
  if (thinkingSupported) {
    if (explicitlyDisabled && cannotDisableThinking) {
      anth.thinking = { type: 'adaptive' };
      anth.output_config = { effort: 'low' };
    } else if (explicitlyDisabled) {
      anth.thinking = { type: 'disabled' };
    } else if (adaptive) {
      anth.thinking = { type: 'adaptive' };
      const normalized = normalizedEffort(effort);
      if (normalized) anth.output_config = { effort: normalized };
      if (numberValue(raw.max_output_tokens) === undefined) {
        anth.max_tokens = Math.max(anth.max_tokens, (budget ?? 8192) + OUTPUT_HEADROOM);
      }
    } else if (budget !== null) {
      const thinkingBudget = Math.max(MIN_THINKING_BUDGET, Math.min(budget, Math.max(MIN_THINKING_BUDGET, anth.max_tokens - OUTPUT_HEADROOM)));
      if (thinkingBudget >= MIN_THINKING_BUDGET && anth.max_tokens > thinkingBudget) {
        anth.thinking = { type: 'enabled', budget_tokens: thinkingBudget };
      }
    }
  }
  if (thinkingSupported && budget !== null && !explicitlyDisabled && !anth.thinking) {
    throw new InvalidResponsesRequestError(
      'Responses reasoning effort cannot fit within max_output_tokens for the Anthropic bridge',
    );
  }
  if (
    anth.thinking
    && anth.thinking.type !== 'disabled'
    && (
      !trailingTurnSupportsThinking(normalizedMessages)
      || forcedToolChoice(anth.tool_choice)
    )
  ) {
    // Forced tool choice is incompatible with extended thinking. An unsigned
    // tool-result continuation is also rejected because its previous thinking block
    // cannot be replayed. Preserve tool/history correctness and disable thinking.
    if (cannotDisableThinking) {
      throw new InvalidResponsesRequestError(
        'This Anthropic model requires signed thinking history for tool continuation or forced tool choice',
      );
    }
    anth.thinking = { type: 'disabled' };
    delete anth.output_config;
  }
  if (!anth.thinking || anth.thinking.type === 'disabled') {
    const temperature = anthropicSamplingValue('temperature', raw.temperature);
    const topP = anthropicSamplingValue('top_p', raw.top_p);
    if (temperature !== undefined) anth.temperature = temperature;
    if (topP !== undefined) anth.top_p = topP;
  }
  const mappedStopSequences = stopSequences(raw.stop);
  if (mappedStopSequences) anth.stop_sequences = mappedStopSequences;
  applyPromptCaching(
    anth,
    options.promptCaching !== false
      && (Boolean(raw.prompt_cache_key) || options.automaticPromptCaching === true),
    options.automaticPromptCaching === true,
  );
  return { request: anth, toolContext: context.context };
}
