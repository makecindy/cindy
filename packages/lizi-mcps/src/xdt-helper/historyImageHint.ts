/** A single model-facing hint for managed image references returned by history tools. */
export const HISTORY_IMAGE_VIEW_HINT =
  '发现历史中的受管图片地址，请先用 media 工具的 resolve_local_path 查看，取不到再请用户重发。';

const MANAGED_IMAGE_URL = /cindy-media:\/\/[^\s"'<>`]+\.(?:png|jpe?g|gif|webp|bmp|avif)(?:[?#][^\s"'<>`]*)?/i;

/** Detect one or more managed image references without copying or rewriting history content. */
export function containsManagedImageReference(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === 'string') return MANAGED_IMAGE_URL.test(value);
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some(item => containsManagedImageReference(item, seen));
  return Object.values(value).some(item => containsManagedImageReference(item, seen));
}
