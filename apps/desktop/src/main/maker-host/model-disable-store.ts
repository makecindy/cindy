/**
 * model-disable-store —— 「模型 / 供应商停用」override 的持久化(main 侧唯一真源)。
 *
 * File: <userData>/model-disable-prefs.json
 *
 * 形态:{ disabledModels: { "<providerId>:<modelId>": true }, disabledProviders: { "<providerId>": true } }
 * - 只存「显式停用」的条目(值恒 true);缺席 = 启用 —— 系统默认全启用,规则 20:
 *   只记 override 不快照默认,新增模型 / 供应商天然跟随「默认启用」。
 * - 恢复启用 = 删除对应条目(不是写 false),与「恢复默认」语义一致。
 * - 为什么在 main 而不是 renderer localStorage(对比 modelVisibilityPrefs):停用是
 *   **准入**判定,MCP create_worker / IM hook / scheduler 都跑在 main、且可能在
 *   renderer 窗口不存在时执行,准入真源必须 main 可靠可读。renderer 经
 *   PROVIDER_LIST 的 ProviderView 标志位(suspended / model.disabled)消费,不另存副本。
 * - 与「显示 / 隐藏」(modelVisibilityPrefs)是两根正交的轴,语义见
 *   @cindy/model-providers 的 disableOverrides.ts 头注。
 */

import {
  isModelDisabled,
  modelDisableKey,
  type ModelDisableOverrides,
} from '@cindy/model-providers';

import { desktopMakerLogger } from './logger-adapter.js';
import { createOverrideSettingsFile } from './override-settings-file.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';

const log = desktopMakerLogger.child('model-disable-store');

interface ModelAccessPrefs {
  disabledModels: Record<string, true>;
  disabledProviders: Record<string, true>;
}

const DEFAULTS: ModelAccessPrefs = { disabledModels: {}, disabledProviders: {} };

/**
 * 单 section 条目总量硬上限(深防线,PR #744 review):正常路径已有 IPC 边界的尺寸 +
 * 目录成员双重校验,这里兜的是「绕过 IPC 直改文件 / 未来新增写入口漏校验」——超限的
 * 新增写入被丢弃并告警,防止这份同步读写的 JSON 无界膨胀拖死 main。上限取目录现实
 * 规模(数百)的一个数量级以上,正常用户永远碰不到。
 */
const MAX_ENTRIES_PER_SECTION = 4096;

/**
 * 只收 value === true 的字符串 key 条目;其它形态(false / 非布尔 / 空 key)一律丢弃 =
 * 启用。有效条目同样受 MAX_ENTRIES_PER_SECTION 截断:写入路径的上限挡不住「直接
 * 手改 / 恶意进程灌大文件」,读入不截断的话超大 map 会被完整持有并在下次 writePatch
 * 原样重写放大(PR #744 review 第八轮)。超限部分按遍历序丢弃(= 视为启用,恢复
 * 默认方向,无副作用)。
 */
function sanitizeSection(raw: unknown): Record<string, true> {
  const out: Record<string, true> = {};
  if (raw && typeof raw === 'object') {
    let kept = 0;
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!k || v !== true) continue;
      if (kept >= MAX_ENTRIES_PER_SECTION) {
        log.warn('model disable prefs section truncated at hard cap on read', {
          cap: MAX_ENTRIES_PER_SECTION,
        });
        break;
      }
      out[k] = true;
      kept += 1;
    }
  }
  return out;
}

function normalize(raw: unknown): ModelAccessPrefs {
  if (!raw || typeof raw !== 'object') return { disabledModels: {}, disabledProviders: {} };
  return {
    disabledModels: sanitizeSection((raw as { disabledModels?: unknown }).disabledModels),
    disabledProviders: sanitizeSection((raw as { disabledProviders?: unknown }).disabledProviders),
  };
}

const store = createOverrideSettingsFile<ModelAccessPrefs>({
  filePath: () => ownerScopedUserDataPath('model-disable-prefs.json'),
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'model-disable',
});

/** 当前停用 override 快照(注入 provider-service → buildRegistry)。 */
export function readModelDisableOverrides(): ModelDisableOverrides {
  // 隐藏配置层级的文件也是正式契约:mtime 守卫让「直接手改文件」在下一次读取生效。
  store.invalidateIfChanged();
  return store.read();
}

/** 写/清一批 (供应商, 模型) 的停用标记。disabled=false 即删除条目(恢复启用 = 删 override)。 */
export function setModelsDisabled(
  providerId: string,
  modelIds: readonly string[],
  disabled: boolean,
): void {
  if (!providerId || modelIds.length === 0) return;
  store.invalidateIfChanged();
  const disabledModels = { ...store.read().disabledModels };
  let entryCount = Object.keys(disabledModels).length;
  let changed = false;
  let dropped = 0;
  for (const modelId of modelIds) {
    if (!modelId) continue;
    const key = modelDisableKey(providerId, modelId);
    if (disabled && disabledModels[key] !== true) {
      if (entryCount >= MAX_ENTRIES_PER_SECTION) {
        dropped += 1;
        continue;
      }
      disabledModels[key] = true;
      entryCount += 1;
      changed = true;
    } else if (!disabled && key in disabledModels) {
      delete disabledModels[key];
      entryCount -= 1;
      changed = true;
    }
  }
  if (dropped > 0) {
    log.warn('model disable entries dropped: section at hard cap', {
      providerId,
      dropped,
      cap: MAX_ENTRIES_PER_SECTION,
    });
  }
  if (!changed) return;
  store.writePatch({ disabledModels });
  log.info('model access override written', { providerId, count: modelIds.length, disabled });
}

/**
 * 将旧版媒体裸 ID 的停用项迁移到当前唯一的 namespaced modelId。迁移幂等且只在
 * 唯一匹配时落盘，避免同 basename 多模型时把用户选择错误套到另一条路由。
 */
export function migrateLegacyNamespacedModelDisableOverrides(
  providerId: string,
  modelIds: readonly string[],
): void {
  if (!providerId || modelIds.length === 0) return;
  store.invalidateIfChanged();
  const current = store.read();
  const disabledModels = { ...current.disabledModels };
  let migrated = 0;
  const uniqueModelIds = [...new Set(modelIds)];
  for (const modelId of uniqueModelIds) {
    const slash = modelId.lastIndexOf('/');
    if (slash < 0 || slash === modelId.length - 1) continue;
    const basename = modelId.slice(slash + 1);
    if (!isModelDisabled(current, providerId, basename)) continue;
    const basenameMatches = uniqueModelIds.filter(
      (candidate) => candidate.slice(candidate.lastIndexOf('/') + 1) === basename,
    );
    if (basenameMatches.length !== 1 || basenameMatches[0] !== modelId) continue;
    disabledModels[modelDisableKey(providerId, modelId)] = true;
    delete disabledModels[modelDisableKey(providerId, basename)];
    migrated += 1;
  }
  if (migrated === 0) return;
  store.writePatch({ disabledModels });
  log.info('legacy namespaced model disable overrides migrated', { providerId, migrated });
}

/** 测试专用:纯函数导出(normalize 坏形态清洗;读写链路由 providerHandlers 测试覆盖)。 */
export const __testing = { normalize };

/** 写/清供应商级停用标记。disabled=false 即删除条目。 */
export function setProviderDisabled(providerId: string, disabled: boolean): void {
  if (!providerId) return;
  store.invalidateIfChanged();
  const disabledProviders = { ...store.read().disabledProviders };
  if (disabled && disabledProviders[providerId] !== true) {
    if (Object.keys(disabledProviders).length >= MAX_ENTRIES_PER_SECTION) {
      log.warn('provider disable entry dropped: section at hard cap', {
        providerId,
        cap: MAX_ENTRIES_PER_SECTION,
      });
      return;
    }
    disabledProviders[providerId] = true;
  } else if (!disabled && providerId in disabledProviders) {
    delete disabledProviders[providerId];
  } else {
    return;
  }
  store.writePatch({ disabledProviders });
  log.info('provider access override written', { providerId, disabled });
}

/**
 * 事务式清理:同步清掉该供应商全部 override 并返回恢复函数(把清理前的条目原样
 * 写回)。自定义供应商删除事务用 —— 清理进事务、失败可恢复,而不是删除成功后的
 * best-effort(清理失败会让同 id 重建复活旧停用状态,PR #744 review 第二十轮)。
 * 清理自身抛错 = 事务未产生破坏,由调用方中止删除。
 */
export function stageProviderDisableOverridesClear(providerId: string): () => boolean {
  if (!providerId) return () => true;
  store.invalidateIfChanged();
  const current = store.read();
  const hadProviderEntry = current.disabledProviders[providerId] === true;
  const prefix = `${providerId}:`;
  const modelIds = Object.keys(current.disabledModels)
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length));
  if (!hadProviderEntry && modelIds.length === 0) return () => true;
  clearProviderDisableOverrides(providerId);
  return () => {
    try {
      if (hadProviderEntry) setProviderDisabled(providerId, true);
      if (modelIds.length > 0) setModelsDisabled(providerId, modelIds, true);
      return true;
    } catch (err) {
      log.warn('restore provider disable overrides failed', {
        providerId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  };
}

/**
 * 清掉某供应商名下的**全部** override(供应商级 + 该来源全部逐模型条目)。
 * 幂等;无条目即 no-op。事务式消费方走 stageProviderDisableOverridesClear。
 */
export function clearProviderDisableOverrides(providerId: string): void {
  if (!providerId) return;
  store.invalidateIfChanged();
  const current = store.read();
  const disabledProviders = { ...current.disabledProviders };
  const disabledModels = { ...current.disabledModels };
  let changed = false;
  if (providerId in disabledProviders) {
    delete disabledProviders[providerId];
    changed = true;
  }
  const prefix = `${providerId}:`;
  for (const key of Object.keys(disabledModels)) {
    if (key.startsWith(prefix)) {
      delete disabledModels[key];
      changed = true;
    }
  }
  if (!changed) return;
  store.writePatch({ disabledProviders, disabledModels });
  log.info('provider disable overrides cleared on delete', { providerId });
}
