/**
 * Bytes supplied by the plugin itself, never a Host path, URL or existing media URI.
 * The Host decides from the bytes whether it is an image, audio/video or another file;
 * the plugin never reports a MIME type.
 */
export interface PluginMessageAttachment {
  base64: string;
  name?: string;
}
/** Kinds the Host accepts, as reported by `tasks.capabilities().messageAttachments.kinds`. */
export const PLUGIN_ATTACHMENT_KINDS = ['image', 'video', 'audio', 'file'] as const;
/** One attachment: the same 30 MiB cap Cindy's own IM channels apply to inbound files. */
export const PLUGIN_ATTACHMENT_MAX_ITEM_BYTES = 30 * 1024 * 1024;
/** One send: shown attachments and model-only context attachments together. */
export const PLUGIN_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;
export const PLUGIN_ATTACHMENT_MAX_COUNT = 10;
/** Model-only reference attachments (group history, quoted messages); `tasks.send` only. */
export const PLUGIN_CONTEXT_ATTACHMENT_MAX_COUNT = 10;

export function pluginAttachmentDecodedBytes(base64: string): number {
  return base64.length / 4 * 3 - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
}
function validItem(item: unknown): item is PluginMessageAttachment {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  const value = item as Record<string, unknown>;
  return !Object.keys(value).some(key => !['base64', 'name'].includes(key))
    && typeof value.base64 === 'string' && value.base64.length > 0
    && value.base64.length <= Math.ceil(PLUGIN_ATTACHMENT_MAX_ITEM_BYTES / 3) * 4
    && value.base64.length % 4 === 0
    && /^[A-Za-z0-9+/]*={0,2}$/.test(value.base64)
    && pluginAttachmentDecodedBytes(value.base64) <= PLUGIN_ATTACHMENT_MAX_ITEM_BYTES
    && (value.name === undefined || (typeof value.name === 'string' && !!value.name.trim()
      && value.name.length <= 200 && !value.name.includes('/') && !value.name.includes('\\')
      && !Array.from(value.name).some(char => char.charCodeAt(0) < 32)));
}
function validList(value: unknown, maxCount: number): value is PluginMessageAttachment[] | undefined {
  if (value === undefined) return true;
  return Array.isArray(value) && value.length <= maxCount && value.every(validItem);
}
/** Total decoded bytes of one or more validated lists. */
export function pluginAttachmentBytes(...lists: Array<PluginMessageAttachment[] | undefined>): number {
  return lists.reduce((total, list) =>
    total + (list ?? []).reduce((sum, item) => sum + pluginAttachmentDecodedBytes(item.base64), 0), 0);
}
export function validPluginMessageAttachments(value: unknown): value is PluginMessageAttachment[] | undefined {
  return validList(value, PLUGIN_ATTACHMENT_MAX_COUNT) && pluginAttachmentBytes(value) <= PLUGIN_ATTACHMENT_MAX_BYTES;
}
/** `tasks.send`: both lists are valid and share one byte budget. */
export function validPluginMessageAttachmentSet(attachments: unknown, contextAttachments: unknown): boolean {
  return validList(attachments, PLUGIN_ATTACHMENT_MAX_COUNT)
    && validList(contextAttachments, PLUGIN_CONTEXT_ATTACHMENT_MAX_COUNT)
    && pluginAttachmentBytes(attachments, contextAttachments) <= PLUGIN_ATTACHMENT_MAX_BYTES;
}
