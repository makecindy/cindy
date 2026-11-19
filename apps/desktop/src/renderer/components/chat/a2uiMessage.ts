import type { ProcessableMessage } from '@cindy/a2ui-renderer/core';

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

/** Only top-level fenced blocks opt in; code quoted inside other fences stays code. */
export function splitA2uiMessage(source: string): A2uiMessagePart[] {
  const parts: A2uiMessagePart[] = [];
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let offset = 0, start = 0;
  let fence: { char: string; length: number; a2ui: boolean; start: number; body: number } | undefined;
  for (const line of lines) {
    const match = /^( {0,3})(`{3,}|~{3,})([^\r\n]*)\r?\n?$/.exec(line);
    if (match) {
      if (!fence) {
        fence = { char: match[2][0], length: match[2].length, a2ui: match[3].trim() === 'a2ui', start: offset, body: offset + line.length };
      } else if (match[2][0] === fence.char && match[2].length >= fence.length && !match[3].trim()) {
        if (fence.a2ui) {
          if (fence.start > start) parts.push({ kind: 'markdown', source: source.slice(start, fence.start), key: start, complete: true });
          parts.push({ kind: 'a2ui', source: source.slice(fence.body, offset), key: fence.start, complete: true });
          start = offset + line.length;
        }
        fence = undefined;
      }
    }
    offset += line.length;
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
