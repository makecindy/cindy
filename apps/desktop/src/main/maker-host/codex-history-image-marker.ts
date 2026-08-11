import type { RequestTransform } from '@cindy/anthropic-compat-proxy';

import { buildUnavailableImageDataBlock } from '../../shared/agentInputQueue.js';

const IMAGE_PART_TYPES = new Set(['input_image', 'image_url', 'image']);

type RecordValue = Record<string, unknown>;
type TextPartType = 'input_text' | 'text';

export interface CodexHistoryImageMarkerDeps {
  shouldStripImages: (body: RecordValue, sessionId: string | undefined) => boolean;
  sessionIdFromHeaders: (headers: Readonly<Record<string, string>>) => string | undefined;
}

function isRecord(value: unknown): value is RecordValue {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isImagePart(value: unknown): value is RecordValue {
  return isRecord(value) && typeof value.type === 'string' && IMAGE_PART_TYPES.has(value.type);
}

function imageFileName(part: RecordValue, fallback: string): string {
  if (typeof part.filename === 'string' && part.filename.trim()) return part.filename;
  if (typeof part.name === 'string' && part.name.trim()) return part.name;
  if (isRecord(part.source) && typeof part.source.filename === 'string' && part.source.filename.trim()) {
    return part.source.filename;
  }
  return fallback;
}

function markerPart(part: RecordValue, id: string, textPartType: TextPartType): RecordValue {
  return {
    type: textPartType,
    text: buildUnavailableImageDataBlock({
      id,
      name: imageFileName(part, `${id}.image`),
    }),
  };
}

function stripMessageImages(
  items: unknown[],
  textPartType: TextPartType,
  prefix: string,
): { items: unknown[]; changed: boolean } {
  const nextItems: unknown[] = [];
  let imageIndex = 0;
  let changed = false;

  for (const item of items) {
    if (isImagePart(item)) {
      const id = `${prefix}-root-${imageIndex++}`;
      const marker = markerPart(item, id, textPartType);
      nextItems.push(
        textPartType === 'input_text'
          ? { type: 'message', role: 'user', content: [marker] }
          : { role: 'user', content: [marker] },
      );
      changed = true;
      continue;
    }
    if (!isRecord(item) || !Array.isArray(item.content)) {
      nextItems.push(item);
      continue;
    }
    const content: unknown[] = [];
    let itemChanged = false;
    for (const part of item.content) {
      if (!isImagePart(part)) {
        content.push(part);
        continue;
      }
      const id = `${prefix}-${imageIndex++}`;
      content.push(markerPart(part, id, textPartType));
      itemChanged = true;
      changed = true;
    }
    nextItems.push(itemChanged ? { ...item, content } : item);
  }

  return { items: nextItems, changed };
}

/** Text-only Codex route projection for current and historical image parts. */
export function createCodexHistoryImageMarkerTransform(
  deps: CodexHistoryImageMarkerDeps,
): RequestTransform {
  return (body, ctx) => {
    if (!isRecord(body) || ctx.method !== 'POST') return null;
    const sessionId = deps.sessionIdFromHeaders(ctx.headers);
    if (!deps.shouldStripImages(body, sessionId)) return null;

    let nextBody: RecordValue = body;
    let changed = false;
    if (Array.isArray(body.input)) {
      const result = stripMessageImages(body.input, 'input_text', 'responses-image');
      if (result.changed) {
        nextBody = { ...nextBody, input: result.items };
        changed = true;
      }
    }
    if (Array.isArray(body.messages)) {
      const result = stripMessageImages(body.messages, 'text', 'message-image');
      if (result.changed) {
        nextBody = { ...nextBody, messages: result.items };
        changed = true;
      }
    }
    return changed ? nextBody : null;
  };
}
