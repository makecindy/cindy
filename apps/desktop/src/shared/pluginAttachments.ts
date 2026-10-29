/** Images supplied by the plugin itself, never a Host path or an existing media URL. */
export interface PluginMessageAttachment {
  base64: string;
  name?: string;
}
export const PLUGIN_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
export function validPluginMessageAttachments(value: unknown): value is PluginMessageAttachment[] | undefined {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > 4) return false;
  let bytes = 0;
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).some(key => !['base64', 'name'].includes(key))
      || typeof item.base64 !== 'string' || !item.base64.length
      || item.base64.length > Math.ceil(PLUGIN_ATTACHMENT_MAX_BYTES / 3) * 4
      || item.base64.length % 4 !== 0
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.base64)
      || (item.name !== undefined && (typeof item.name !== 'string' || !item.name.trim()
        || item.name.length > 200 || item.name.includes('/') || item.name.includes('\\')
        || Array.from(item.name as string).some(char => char.charCodeAt(0) < 32)))) return false;
    bytes += item.base64.length / 4 * 3 - (item.base64.endsWith('==') ? 2 : item.base64.endsWith('=') ? 1 : 0);
    if (bytes > PLUGIN_ATTACHMENT_MAX_BYTES) return false;
  }
  return true;
}
