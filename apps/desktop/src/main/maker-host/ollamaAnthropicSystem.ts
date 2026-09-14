import type { RequestTransform } from '@cindy/anthropic-compat-proxy';

import {
  isCuratedQwen38Tag,
  MANAGED_OLLAMA_PROVIDER_ID,
} from '../../shared/localModelRuntime.js';
import { getSessionProvider } from './session-provider-store.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (isPlainObject(part) && typeof part.text === 'string') return part.text;
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function toSystemBlocks(system: unknown): Array<Record<string, unknown>> {
  if (typeof system === 'string' && system.trim()) {
    return [{ type: 'text', text: system.trim() }];
  }
  if (!Array.isArray(system)) return [];
  return system.filter(isPlainObject);
}

/**
 * Ollama / qwen3.8：最终消息列表只允许 index 0 一条 system。
 * 把 messages[].role=system 全部移出，文本并进顶层 system；空的 late system 也要删掉。
 * 顶层已是 Anthropic text-block 数组时原样保留（含 cache_control）。
 */
export function coalesceAnthropicMessagesForOllama(body: unknown): Record<string, unknown> | null {
  if (!isPlainObject(body) || !Array.isArray(body.messages)) return null;
  const extras: string[] = [];
  const messages: unknown[] = [];
  let stripped = 0;
  for (const item of body.messages) {
    if (isPlainObject(item) && item.role === 'system') {
      stripped += 1;
      const text = extractText(item.content);
      if (text) extras.push(text);
      continue;
    }
    messages.push(item);
  }
  if (stripped === 0) return null;
  const system = [
    ...toSystemBlocks(body.system),
    ...extras.map((text) => ({ type: 'text', text })),
  ];
  return {
    ...body,
    ...(system.length > 0 ? { system } : { system: undefined }),
    messages,
  };
}

export function createOllamaAnthropicSystemTransform(
  resolveSessionId: (headers: Readonly<Record<string, string>>) => string | null,
): RequestTransform {
  return (body, ctx) => {
    const sessionId = resolveSessionId(ctx.headers);
    if (!sessionId || getSessionProvider(sessionId) !== MANAGED_OLLAMA_PROVIDER_ID) {
      return null;
    }
    const model = isPlainObject(body) && typeof body.model === 'string' ? body.model : '';
    if (!isCuratedQwen38Tag(model)) return null;
    return coalesceAnthropicMessagesForOllama(body);
  };
}
