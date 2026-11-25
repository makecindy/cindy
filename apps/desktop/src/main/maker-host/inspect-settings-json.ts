import { readBoundedFileNoFollowSync } from '../utils/readBoundedFile.js';

/** 仅供内部判断持久化来源；原始内容不得越过公开数据边界。 */
export type SettingsJsonInspection<T> =
  | { status: 'ready'; value: T; raw: Record<string, unknown>; missing: boolean }
  | { status: 'unreadable' };

export function isSettingsRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 只读取一个已知文件；不修复、不改缓存、不建目录、不记录日志。 */
export function inspectSettingsJson<T>(
  filePath: string,
  normalize: (raw: Record<string, unknown>) => T,
  maxBytes = 1024 * 1024,
): SettingsJsonInspection<T> {
  try {
    let raw: Record<string, unknown> = {};
    let missing = false;
    try {
      const bytes = readBoundedFileNoFollowSync(filePath, maxBytes);
      if (bytes === null) return { status: 'unreadable' };
      const parsed: unknown = JSON.parse(bytes.toString('utf8'));
      if (!isSettingsRecord(parsed)) return { status: 'unreadable' };
      raw = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { status: 'unreadable' };
      missing = true;
    }
    return { status: 'ready', value: normalize(raw), raw, missing };
  } catch {
    return { status: 'unreadable' };
  }
}

/** 依据对象自有属性判断是否保存过，不用值相等推断来源。 */
export function settingsHasPath(raw: unknown, segments: readonly (string | number)[]): boolean {
  let current: unknown = raw;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, segment)) return false;
    current = (current as Record<string, unknown>)[segment];
  }
  return true;
}
