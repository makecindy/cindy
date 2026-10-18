/**
 * pi-native-compat-overrides-store —— PI 原生 provider「学到的 per-model compat 修正」。
 *
 * File: <userData>/pi-native-compat-overrides.json
 *   { "models": { "<providerId>": { "<modelId>": { "supportsLongCacheRetention": false } } } }
 *
 * 写入时机：上游以 invalid_request_error 明确拒收某个可选请求字段（当前唯一已知形态是
 * `prompt_cache_retention`，Console Go / OpenCode Zen-Go 的 GLM 上游）后，desktop 的
 * PI compat 自愈把修正记到该 provider/model，关掉该字段后重放同一轮请求（见
 * `contextOverflowRollover.ts` 的 unsupported-option 分支）。下一次写 models.json 时由
 * `writeModelsJson` 合并进 compat，同一会话重建与后续会话都直接生效。
 *
 * 文件只存模型路由身份与布尔开关，不含凭证；跨进程写走 override 文件的标准锁与原子替换。
 * 重置：删掉该文件即可（读取侧带 mtime 失效，免重启生效）。
 */

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { desktopMakerLogger } from './logger-adapter.js';
import { createOverrideSettingsFile } from './override-settings-file.js';

const log = desktopMakerLogger.child('pi-native-compat-overrides-store');

export interface PiNativeCompatOverrides {
  /** providerId → modelId → PI models.json compat 补丁。 */
  models: Record<string, Record<string, Record<string, unknown>>>;
}

const DEFAULTS: PiNativeCompatOverrides = { models: {} };

function storeFilePath(): string {
  return path.join(app.getPath('userData'), 'pi-native-compat-overrides.json');
}

/**
 * 只接受「非空对象」作为 compat 补丁；键/值都限定为可 JSON 序列化的短字符串与
 * 布尔/数字/字符串。异常数据整条丢弃（宁可不生效，也不把垃圾写进 models.json）。
 */
function normalizeCompat(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([key, item]) =>
      /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key) &&
      (typeof item === 'boolean' || typeof item === 'number' || typeof item === 'string'),
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * provider/model 键只挡「会污染原型或无法安全序列化」的值；模型 id 可能含
 * `@cf/...`、`~z-ai/...`、`+` 等任意可见字符，不能用窄字符类误杀。
 */
const UNSAFE_IDENTITY_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isSafeIdentityKey(value: string): boolean {
  if (value.length === 0 || value.length > 160) return false;
  if (UNSAFE_IDENTITY_KEYS.has(value)) return false;
  // eslint-disable-next-line no-control-regex -- 只拒绝控制字符，其余可见字符全放行。
  return !/[\u0000-\u001f\u007f]/.test(value);
}

function normalize(raw: unknown): PiNativeCompatOverrides {
  if (!raw || typeof raw !== 'object') return { models: {} };
  const models = (raw as { models?: unknown }).models;
  if (!models || typeof models !== 'object' || Array.isArray(models)) return { models: {} };
  // 原型为 null：即使文件里混进 `__proto__`/`constructor` 也无法影响查询。
  const out: PiNativeCompatOverrides['models'] = Object.create(null);
  for (const [providerId, perModel] of Object.entries(models as Record<string, unknown>)) {
    if (!isSafeIdentityKey(providerId)) continue;
    if (!perModel || typeof perModel !== 'object' || Array.isArray(perModel)) continue;
    const modelsForProvider: Record<string, Record<string, unknown>> = Object.create(null);
    for (const [modelId, compat] of Object.entries(perModel as Record<string, unknown>)) {
      if (!isSafeIdentityKey(modelId)) continue;
      const normalized = normalizeCompat(compat);
      if (normalized) modelsForProvider[modelId] = normalized;
    }
    if (Object.keys(modelsForProvider).length > 0) out[providerId] = modelsForProvider;
  }
  return { models: out };
}

const MAX_BYTES = 256 * 1024;

const store = createOverrideSettingsFile<PiNativeCompatOverrides>({
  filePath: storeFilePath,
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'pi native compat overrides',
  maxBytes: MAX_BYTES,
  // 读取时保留用户手改坏的文件（不静默删除）；写入前由 quarantineUnreadableFile 备份挪走，
  // 保证「学不会」不会因一个坏文件而永久卡死。
  preserveUnreadableFile: true,
});

/**
 * 写入前把「解析不了/根不是对象/空/超限/不是普通文件」的 override 文件挪到
 * `.broken-<ts>` 备份：否则 `updateAtomic` 会一直抛错，自愈永远学不到、每个 400 都白关
 * 一次 runtime。与 `override-settings-file` 的 unreadable 判据同源（见 readState）。
 * 先 stat 再读，避免把超大文件整份读进主进程内存。
 */
function quarantineUnreadableFile(): void {
  const file = storeFilePath();
  let stats: fs.Stats;
  try {
    stats = fs.statSync(file);
  } catch {
    return; // 不存在：交给 store 走 defaults。
  }
  if (!stats.isFile()) {
    quarantineFile(file, stats, { notRegularFile: true });
    return;
  }
  if (stats.size > MAX_BYTES) {
    quarantineFile(file, stats, { tooLarge: true, size: stats.size });
    return;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    log.warn('pi native compat overrides file unreadable', {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (raw.trim().length === 0) {
    quarantineFile(file, stats, { empty: true });
    return;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    // 合法 JSON 但根不是普通对象（数组/null/数字/字符串）同样属于 unreadable。
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return;
    quarantineFile(file, stats, { rootNotObject: true });
  } catch {
    quarantineFile(file, stats, { malformed: true });
  }
}

function quarantineFile(file: string, observed: fs.Stats, reason: Record<string, unknown>): void {
  // 锁外操作：重命名前复核文件身份（mtime + size）没变 —— 并发进程可能刚原子写入
  // 一份有效学习结果，直接移走会丢掉它。变了就让本次写入自己走正常路径。
  try {
    const current = fs.statSync(file);
    if (current.mtimeMs !== observed.mtimeMs || current.size !== observed.size) {
      log.warn('pi native compat overrides quarantine skipped: file changed', { ...reason });
      return;
    }
  } catch {
    return;
  }
  const backup = `${file}.broken-${Date.now()}`;
  try {
    fs.renameSync(file, backup);
    log.warn('pi native compat overrides file quarantined', { backup, ...reason });
  } catch (error) {
    log.warn('pi native compat overrides quarantine failed', {
      error: error instanceof Error ? error.message : String(error),
      ...reason,
    });
  }
}

/** 已学到的该 provider/model compat 补丁；undefined = 没有。 */
export function readPiNativeCompatOverride(
  providerId: string,
  modelId: string,
): Record<string, unknown> | undefined {
  if (!isSafeIdentityKey(providerId) || !isSafeIdentityKey(modelId)) return undefined;
  // 允许用户直接删/改文件后免重启生效（mtime 变了就重读）。
  store.invalidateIfChanged();
  const perProvider = store.read().models[providerId];
  if (!perProvider || !Object.hasOwn(perProvider, modelId)) return undefined;
  const value = perProvider[modelId];
  return value ? { ...value } : undefined;
}

/**
 * 记录一条学习结果。已存在同名条目时保持原值（第一次写入即事实）。
 * 返回 true = 调用后该条目确实在盘上（含并发进程已先写入的情形）；调用方据此决定能不能
 * 关会话重放 —— 否则会出现「报告学到了、实际什么都没写 → 无限重放同一个 400」。
 */
export async function recordPiNativeCompatOverride(
  providerId: string,
  modelId: string,
  compat: Record<string, unknown>,
): Promise<boolean> {
  if (!isSafeIdentityKey(providerId) || !isSafeIdentityKey(modelId)) {
    log.warn('pi native compat override identity rejected', { providerId, modelId });
    return false;
  }
  const normalized = normalizeCompat(compat);
  if (!normalized) return false;
  let recorded = false;
  const writeEntry = async (): Promise<void> => {
    await store.updateAtomic((current) => {
      const perProvider = current.value.models[providerId] ?? {};
      if (Object.hasOwn(perProvider, modelId)) return {};
      recorded = true;
      return {
        models: {
          ...current.value.models,
          [providerId]: { ...perProvider, [modelId]: normalized },
        },
      };
    });
  };
  quarantineUnreadableFile();
  try {
    await writeEntry();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/unreadable; refusing to overwrite/.test(message)) throw error;
    // 快路径没识别出的 unreadable 形态（目录/权限等）：隔离后重试一次。
    quarantineUnreadableFile();
    await writeEntry();
  }
  // 回读校验：normalize 可能丢弃条目（键不合规等），此时必须当作没学到。
  const persisted = readPiNativeCompatOverride(providerId, modelId) !== undefined;
  if (persisted) {
    log.info('pi native compat override learned', {
      providerId,
      modelId,
      compat: normalized,
      ...(recorded ? {} : { alreadyPresent: true }),
    });
  } else {
    log.warn('pi native compat override did not persist', { providerId, modelId });
  }
  // 只有确实落盘才算学到（并发进程先写入也算）：调用方据此决定能不能重放。
  return persisted;
}

export const __testing = { normalize, normalizeCompat, isSafeIdentityKey, quarantineUnreadableFile };
