import type { RemoteActionDescriptor, RemoteActionField, RemoteResourceBlock, RemoteText } from '@cindy/device-link';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function string(value: unknown, max: number): value is string { return typeof value === 'string' && value.length <= max; }
function text(value: unknown): RemoteText | null {
  if (string(value, 20_000)) return value;
  const object = record(value);
  if (!object || !string(object.fallback, 20_000)) return null;
  const translations = record(object.translations);
  if (!translations) return { fallback: object.fallback };
  if (Object.keys(translations).length > 32 || Object.entries(translations).some(([locale, value]) => locale.length > 64 || !string(value, 20_000))) return null;
  return { fallback: object.fallback, translations: translations as Record<string, string> };
}
function field(value: unknown): RemoteActionField | null {
  const object = record(value);
  const label = text(object?.label);
  if (!object || !string(object.id, 160) || !object.id || label === null || !['text', 'multiline', 'toggle', 'select'].includes(String(object.kind))) return null;
  const result: RemoteActionField = { id: object.id, label, kind: String(object.kind) };
  if (typeof object.required === 'boolean') result.required = object.required;
  if (object.placeholder !== undefined) { const placeholder = text(object.placeholder); if (placeholder === null) return null; result.placeholder = placeholder; }
  if (object.options !== undefined) {
    if (!Array.isArray(object.options) || object.options.length > 1_000) return null;
    result.options = [];
    for (const raw of object.options) {
      const option = record(raw), optionLabel = text(option?.label);
      if (!option || !string(option.value, 1_024) || optionLabel === null) return null;
      result.options.push({ value: option.value, label: optionLabel });
    }
  }
  return result;
}
/** Invalid or oversized forms lose their whole action, never just some editable fields. */
export function normalizeRemoteActions(raw: unknown): RemoteActionDescriptor[] {
  if (!Array.isArray(raw) || raw.length > 256 || JSON.stringify(raw).length > 5_000_000) return [];
  return raw.flatMap((value) => {
    const object = record(value), label = text(object?.label);
    if (!object || !string(object.id, 512) || !object.id || label === null) return [];
    const action: RemoteActionDescriptor = { id: object.id, label, ...(object.disabled !== undefined ? { disabled: object.disabled !== false } : {}) };
    if (string(object.tone, 64)) action.tone = object.tone;
    if (object.confirmation !== undefined) {
      const confirmation = record(object.confirmation), title = text(confirmation?.title);
      if (!confirmation || title === null) return [];
      const body = confirmation.body === undefined ? undefined : text(confirmation.body);
      const confirmLabel = confirmation.confirmLabel === undefined ? undefined : text(confirmation.confirmLabel);
      if (body === null || confirmLabel === null) return [];
      action.confirmation = { title, ...(body !== undefined ? { body } : {}), ...(confirmLabel !== undefined ? { confirmLabel } : {}) };
    }
    if (object.fields !== undefined) {
      if (!Array.isArray(object.fields) || object.fields.length > 64) return [];
      const fields = object.fields.map(field);
      if (fields.some((value) => value === null) || new Set(fields.map((value) => value?.id)).size !== fields.length) return [];
      action.fields = fields as RemoteActionField[];
    }
    return [action];
  });
}
function boundedData(data: unknown): boolean {
  let budget = 50_000;
  const visit = (value: unknown, depth: number): boolean => {
    if (--budget < 0 || depth > 12) return false;
    if (value === null || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value === 'string') return value.length <= 1_000_000;
    if (Array.isArray(value)) return value.length <= 1_000 && value.every((item) => visit(item, depth + 1));
    const object = record(value);
    if (!object) return false;
    return Object.entries(object).every(([key, item]) => key.length <= 512 && !['__proto__', 'prototype', 'constructor'].includes(key) && visit(item, depth + 1));
  };
  return visit(data, 0) && JSON.stringify(data).length <= 5_000_000;
}
export function normalizeRemoteBlocks(raw: unknown): RemoteResourceBlock[] {
  if (!Array.isArray(raw) || raw.length > 256) return [];
  return raw.flatMap((value) => {
    const object = record(value);
    if (!object || !string(object.id, 160) || !object.id || !string(object.primitive, 160) || !object.primitive || !string(object.fallbackMarkdown, 100_000)) return [];
    // Keep the entire definition (including opaque operation capabilities) or none.
    // A clipped definition must never be mistaken for an editable complete record.
    if (object.data !== undefined && !boundedData(object.data)) return [];
    const title = object.title === undefined ? undefined : text(object.title);
    if (title === null) return [];
    return [{ id: object.id, primitive: object.primitive, fallbackMarkdown: object.fallbackMarkdown,
      ...(title !== undefined ? { title } : {}),
      ...(object.data !== undefined ? { data: object.data } : {}) }];
  });
}
