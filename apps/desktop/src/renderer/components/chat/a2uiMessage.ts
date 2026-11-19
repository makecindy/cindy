import type { ProcessableMessage } from '@cindy/a2ui-renderer/core';
import { unified } from 'unified';
import remarkParse from 'remark-parse';

/** The wire version and the SDK release are deliberately separate identifiers. */
export const A2UI_SDK_VERSION = '0.15.0';
export const A2UI_PROTOCOL_VERSION = '1.0';
export const A2UI_BASIC_CATALOG = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json';

export interface A2uiMessagePart {
  kind: 'markdown' | 'a2ui';
  source: string;
  key: number;
  complete: boolean;
}

const markdownParser = unified().use(remarkParse);

/** Only root-level Markdown code nodes opt in; lists, quotes and HTML stay inert. */
export function splitA2uiMessage(source: string): A2uiMessagePart[] {
  // Ordinary chat messages do not need an additional Markdown parse.
  if (!/(?:^|\n) {0,3}(?:`{3,}|~{3,})[ \t]*a2ui[ \t]*(?:\r?\n|$)/.test(source)) {
    return source ? [{ kind: 'markdown', source, key: 0, complete: false }] : [];
  }
  const parts: A2uiMessagePart[] = [];
  let start = 0;
  for (const node of markdownParser.parse(source).children) {
    if (node.type !== 'code' || node.lang !== 'a2ui' || node.meta) continue;
    const offset = node.position?.start.offset;
    const to = node.position?.end.offset;
    if (offset === undefined || to === undefined) continue;
    // Include root-fence indentation, preserving the historical fragment key.
    const from = offset - (node.position!.start.column - 1);
    const raw = source.slice(from, to);
    const opening = /^ {0,3}(`{3,}|~{3,})[ \t]*a2ui[ \t]*\r?\n/.exec(raw);
    if (!opening) continue;
    // CommonMark also produces a code node for an unfinished streaming fence.
    const closing = raw.slice(raw.lastIndexOf('\n') + 1);
    if (!new RegExp(`^ {0,3}${opening[1][0]}{${opening[1].length},}[ \\t]*\\r?$`).test(closing)) continue;
    if (from > start) parts.push({ kind: 'markdown', source: source.slice(start, from), key: start, complete: true });
    parts.push({ kind: 'a2ui', source: node.value, key: from, complete: true });
    start = to;
  }
  // Do not enable controls from a partial stream, even if its prefix parses.
  if (start < source.length) parts.push({ kind: 'markdown', source: source.slice(start), key: start, complete: false });
  return parts;
}

/** Host admission policy, followed by the official processor's schema/graph validation.
 * This is NOT an alternate implementation of the official A2UI schema.
 * Functions/RPC are not part of the message-card contract: they must never execute
 * merely because a model described them. Media implementations must use host ports.
 */
export function readA2uiMessages(source: string): ProcessableMessage[] {
  if (new TextEncoder().encode(source).length > 128 * 1024) throw new Error('A2UI message exceeds 128 KiB');
  let parsed: unknown;
  try { parsed = JSON.parse(source); }
  catch { parsed = source.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)); }
  const messages: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  if (!messages.length || messages.length > 256) throw new Error('Invalid A2UI message count');
  let nodes = 0;
  const inspect = (value: unknown, depth = 0): void => {
    if (depth > 32 || ++nodes > 16000) throw new Error('A2UI message is too complex');
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (['@call', 'call', 'functionCall', '__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Unsupported A2UI executable expression');
      if (key === 'checks' || key === '@checks') throw new Error('Unsupported A2UI checks');
      inspect(child, depth + 1);
    }
  };
  let surfaceId: string | undefined;
  let count = 0;
  for (const value of messages) {
    inspect(value);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid A2UI envelope');
    const message = value as Record<string, unknown>;
    if (message.version !== A2UI_PROTOCOL_VERSION) throw new Error('Unsupported A2UI version');
    const keys = Object.keys(message).filter(key => key !== 'version');
    if (keys.length !== 1 || !['createSurface', 'updateComponents', 'updateDataModel', 'deleteSurface'].includes(keys[0])) throw new Error('Unsupported A2UI operation');
    const operation = message[keys[0]];
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) throw new Error('Invalid A2UI operation');
    const payload = operation as Record<string, unknown>;
    if (payload.theme !== undefined) throw new Error('A2UI uses the host theme');
    if (keys[0] === 'createSurface') {
      if (++count !== 1 || payload.catalogId !== A2UI_BASIC_CATALOG || payload.sendDataModel === true) throw new Error('Unsupported A2UI surface');
      if (typeof payload.surfaceId !== 'string' || !payload.surfaceId || payload.surfaceId.length > 128) throw new Error('Invalid A2UI surface id');
      surfaceId = payload.surfaceId;
    }
    if (!surfaceId || payload.surfaceId !== surfaceId) throw new Error('A2UI surface is outside this message');
  }
  if (!surfaceId) throw new Error('Missing A2UI surface');
  return messages as ProcessableMessage[];
}

/** Exact visible submission text; context is data, never a tool invocation. */
export function a2uiSubmissionText(action: { name: string; userMessage?: string; context: Record<string, unknown> }): string | undefined {
  if (action.name !== 'cindy.sendMessage' || !action.userMessage?.trim()) return undefined;
  const context = Object.keys(action.context).length ? `\n\n${JSON.stringify(action.context, null, 2)}` : '';
  const text = action.userMessage.trim() + context;
  return text.length <= 16000 ? text : undefined;
}
