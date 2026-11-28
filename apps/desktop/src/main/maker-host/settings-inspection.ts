import type { ReadonlySettingSource, ReadonlySettingUnavailableStatus } from '../host-settings/readTypes.js';
import { inspectSettingsJson } from './inspect-settings-json.js';

/** 本地有类型的存储观察结果；禁止原样序列化为公开设置报告。 */
export type SettingsFileInspection<T extends object> =
  | { status: 'ready'; value: T; sources: Record<keyof T, ReadonlySettingSource> }
  | { status: ReadonlySettingUnavailableStatus };

export type SettingsValueValidator = (value: unknown) => boolean;

/** 只校验已知持久叶子；旧版或未来版本的键留在原文件中，不顺带清理。 */
export function validateOptionalSettingsFields(
  raw: Record<string, unknown>,
  validators: Record<string, SettingsValueValidator>,
): void {
  for (const [key, validate] of Object.entries(validators)) {
    if (Object.hasOwn(raw, key) && !validate(raw[key])) throw new Error('Invalid setting');
  }
}

export const isSettingBoolean: SettingsValueValidator = (value) => typeof value === 'boolean';
export const isSettingNumber: SettingsValueValidator = (value) => typeof value === 'number' && Number.isFinite(value);
export const isSettingString: SettingsValueValidator = (value) => typeof value === 'string';
export const isSettingStringList: SettingsValueValidator = (value) => Array.isArray(value) && value.every(isSettingString);
export function isSettingsObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 独立旁路校验保留旧 writer 的宽松 normalize 策略，同时不改变运行时 store 缓存。
 * 回调必须纯净，尤其不得调用 ensureLoaded、owner 认领或动态默认模型解析。
 */
export function inspectSettingsFile<T extends object>(options: {
  filePath: () => string;
  defaults: T;
  normalize: (raw: unknown) => T;
  validate: (raw: Record<string, unknown>) => void;
  maxBytes?: number;
  /** 旧版全量 writer 无法证明保存的默认值是用户显式自定义，因此来源保留 unknown。 */
  savedSource?: 'override' | 'unknown';
}): SettingsFileInspection<T> {
  try {
    const result = inspectSettingsJson(options.filePath(), (raw) => raw, options.maxBytes ?? 64 * 1024);
    if (result.status !== 'ready') return { status: 'unreadable' };
    if (!result.missing) options.validate(result.raw);
    const value = options.normalize({ ...options.defaults, ...result.raw });
    const sources = {} as Record<keyof T, ReadonlySettingSource>;
    for (const key of Object.keys(options.defaults) as Array<keyof T>) {
      sources[key] = Object.hasOwn(result.raw, key)
        ? options.savedSource ?? 'override'
        : 'default';
    }
    return { status: 'ready', value, sources };
  } catch {
    return { status: 'unreadable' };
  }
}
