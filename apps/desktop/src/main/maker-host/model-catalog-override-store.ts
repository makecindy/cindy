/**
 * model-catalog-override-store —— 用户本地模型目录 override 的持久化(main 侧唯一真源)。
 *
 * File: <ownerScopedUserDataPath>/model-catalog-overrides.json
 *
 * 语义与合并逻辑见 model-plane/localCatalogOverrides.ts(本文件只管 IO):
 *  - additions/patches 两段,key=`${providerId}:${modelId}`;
 *  - local 永远最高:远端刷新只换 remote 层,读取路径按 mtime 守卫支持「直接手改
 *    文件即生效」;
 *  - 单条 invalid 隔离(warn 留痕),整文件其余条目继续;
 *  - owner 维度:路径随 ownerScopedUserDataPath 走,账号切换由
 *    createOverrideSettingsFile 的 path 失效自动换文件,旧 owner 数据绝不泄漏。
 *
 * 为什么在 main 而不是 renderer(对比 modelVisibilityPrefs):override 参与
 * active-catalog 合并,是路由/能力派生的输入,MCP create_worker / scheduler 等
 * 无窗口路径也要一致生效,真源必须 main 可靠可读。
 *
 * 本轮(PR-C)刻意**不加 IPC**:设置 UI 是后续 PR,现在没有 renderer 消费者,
 * 提前开 channel 只会扩大 attack surface;店内 typed API 已够 main 侧与测试用。
 */

import { desktopMakerLogger } from './logger-adapter.js';
import { createOverrideSettingsFile } from './override-settings-file.js';
import {
  EMPTY_MODEL_CATALOG_OVERRIDES,
  sanitizeModelCatalogOverrides,
  type ModelCatalogOverrideEntry,
  type ModelCatalogOverrides,
} from './model-plane/localCatalogOverrides.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';

const log = desktopMakerLogger.child('model-catalog-overrides');

function normalize(raw: unknown): ModelCatalogOverrides {
  const { overrides, invalid } = sanitizeModelCatalogOverrides(raw);
  if (invalid.length > 0) {
    log.warn('model catalog override entries quarantined', {
      invalid: invalid.slice(0, 20),
      count: invalid.length,
    });
  }
  return overrides;
}

const store = createOverrideSettingsFile<ModelCatalogOverrides>({
  filePath: () => ownerScopedUserDataPath('model-catalog-overrides.json'),
  defaults: EMPTY_MODEL_CATALOG_OVERRIDES,
  normalize,
  log,
  label: 'model-catalog-overrides',
});

/** 当前 override 快照(注入 active-catalog 合并;mtime 守卫让手改文件下次读取生效)。 */
export function readModelCatalogOverrides(): ModelCatalogOverrides {
  store.invalidateIfChanged();
  return store.read();
}

/**
 * 写/删一条 override(entry=null 即删除)。未来设置 UI(独立 PR)与测试的
 * 唯一写入口;写完由调用方触发 active-catalog 重同步。
 */
export function writeModelCatalogOverrideEntry(
  section: 'additions' | 'patches',
  key: string,
  entry: ModelCatalogOverrideEntry | null,
): void {
  store.invalidateIfChanged();
  const current = store.read();
  const nextSection = { ...current[section] };
  if (entry === null) delete nextSection[key];
  else nextSection[key] = entry;
  store.writePatch({ [section]: nextSection } as Partial<ModelCatalogOverrides>);
}
