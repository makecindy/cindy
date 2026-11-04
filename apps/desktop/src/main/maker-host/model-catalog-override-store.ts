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
 * 设置页只写明确选择的能力字段；其它覆盖与隔离中的条目原样保留。
 */

import { desktopMakerLogger } from './logger-adapter.js';
import { createOverrideSettingsFile } from './override-settings-file.js';
import {
  EMPTY_MODEL_CATALOG_OVERRIDES,
  sanitizeModelCatalogOverrides,
  type ModelCatalogOverrides,
} from './model-plane/localCatalogOverrides.js';
import { getActiveAppSession, ownerScopedUserDataPath } from '../appSessionState.js';
import type { ModelPriceOverrideTarget } from '../../shared/modelPriceOverride.js';

const log = desktopMakerLogger.child('model-catalog-overrides');

/** main 同步读取的硬上限；目录 override 正常只有数 KB。 */
export const MAX_MODEL_CATALOG_OVERRIDE_FILE_BYTES = 1_048_576;

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

function createStore(filePath: () => string, scopeKey?: () => string) {
  return createOverrideSettingsFile<ModelCatalogOverrides>({
    filePath,
    scopeKey,
    defaults: EMPTY_MODEL_CATALOG_OVERRIDES,
    normalize,
    log,
    label: 'model-catalog-overrides',
    maxBytes: MAX_MODEL_CATALOG_OVERRIDE_FILE_BYTES,
    preserveUnreadableFile: true,
    mergeOverrides: ({ next, overrides }) => {
      if (overrides.version !== undefined && overrides.version !== 1) {
        throw new Error('Unsupported model catalog override version');
      }
      const previous = sanitizeModelCatalogOverrides(overrides).overrides.patches;
      const raw = overrides.patches;
      if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw))) {
        throw new Error('Invalid model catalog patches');
      }
      // A malformed sibling must remain available for repair, not disappear on save.
      const quarantined = Object.fromEntries(
        Object.entries(raw ?? {}).filter(([key]) => !Object.hasOwn(previous, key)),
      );
      for (const key of Object.keys(next.patches)) {
        if (Object.hasOwn(quarantined, key))
          throw new Error('Model override needs repair before editing');
      }
      return { ...overrides, version: 1, patches: { ...quarantined, ...next.patches } };
    },
  });
}

const store = createStore(
  () => ownerScopedUserDataPath('model-catalog-overrides.json'),
  () => String(getActiveAppSession().generation),
);

/** 当前 override 快照(注入 active-catalog 合并;mtime 守卫让手改文件下次读取生效)。 */
export function readModelCatalogOverrides(): ModelCatalogOverrides {
  store.invalidateIfChanged();
  return store.read();
}

const keyOf = (target: ModelPriceOverrideTarget) =>
  `${encodeURIComponent(target.providerId)}:${target.modelId}`;

export function readModelImageInputOverride(target: ModelPriceOverrideTarget): boolean | null {
  const patch = readModelCatalogOverrides().patches[keyOf(target)];
  if (patch?.agents && !patch.agents.includes(target.agent)) return null;
  return (
    patch?.perAgent?.[target.agent]?.supportsImageInput ?? patch?.base?.supportsImageInput ?? null
  );
}

/** Persist all row aliases together; refresh failure restores only this edit. */
export async function writeModelImageInputOverride(
  targets: readonly ModelPriceOverrideTarget[],
  value: boolean | null,
  refresh: () => Promise<void>,
): Promise<void> {
  const file = ownerScopedUserDataPath('model-catalog-overrides.json');
  const generation = getActiveAppSession().generation;
  const keys = new Set(targets.map(keyOf));
  let previous: ModelCatalogOverrides['patches'] = {};
  let written: ModelCatalogOverrides['patches'] = {};
  await store.updateAtomic((current) => {
    previous = current.value.patches;
    const patches = structuredClone(previous);
    for (const target of targets) {
      const key = keyOf(target);
      const entry = (patches[key] ??= {});
      if (entry.agents && !entry.agents.includes(target.agent)) {
        // Do not broaden other hand-authored fields to a new harness.
        throw new Error('Model override excludes this engine');
      }
      if (value === null) {
        if (entry.base) {
          delete entry.base.supportsImageInput;
          if (!Object.keys(entry.base).length) delete entry.base;
        }
        const fields = entry.perAgent?.[target.agent];
        if (fields) {
          delete fields.supportsImageInput;
          if (!Object.keys(fields).length) delete entry.perAgent![target.agent];
        }
        if (entry.perAgent && !Object.keys(entry.perAgent).length) delete entry.perAgent;
        if (!entry.base && !entry.perAgent && !entry.agents) delete patches[key];
      } else {
        entry.perAgent ??= {};
        entry.perAgent[target.agent] = {
          ...entry.perAgent[target.agent],
          supportsImageInput: value,
        };
      }
    }
    const checked = sanitizeModelCatalogOverrides({ ...current.value, patches });
    if (checked.invalid.length) throw new Error('Invalid model image input override');
    written = patches;
    return { patches };
  });
  try {
    await refresh();
  } catch (error) {
    // Roll back in the original account even if the active owner changed while refreshing.
    await createStore(() => file).updateAtomic((current) => {
      const patches = { ...current.value.patches };
      for (const key of keys) {
        if (JSON.stringify(patches[key]) !== JSON.stringify(written[key])) continue;
        if (previous[key]) patches[key] = previous[key];
        else delete patches[key];
      }
      return { patches };
    });
    if (getActiveAppSession().generation === generation) {
      try {
        await refresh();
      } catch {
        log.warn('model image input rollback refresh failed');
      }
    }
    throw error;
  }
}
