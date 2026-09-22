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
 * 写入面:本轮只开「模型级图片输入能力」一个字段
 * (setModelCatalogImageInput)——「未声明」是真实状态,用户必须能把它显式声明为
 * 支持/不支持(见 model-metadata-precedence.md 的字段继承与用户显式覆盖)。
 * 仍然**只开这一条**:通用 patch 写入口会让任意目录字段可从 renderer 改写,
 * 超出当前需求;价格、defaultEnabled、routing 依旧不在此列。用户仍可直接手改
 * 文件;坏 JSON/超限文件原样保留,修正后下一次同步自动恢复。
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

const store = createOverrideSettingsFile<ModelCatalogOverrides>({
  filePath: () => ownerScopedUserDataPath('model-catalog-overrides.json'),
  defaults: EMPTY_MODEL_CATALOG_OVERRIDES,
  normalize,
  log,
  label: 'model-catalog-overrides',
  maxBytes: MAX_MODEL_CATALOG_OVERRIDE_FILE_BYTES,
  preserveUnreadableFile: true,
});

/** 当前 override 快照(注入 active-catalog 合并;mtime 守卫让手改文件下次读取生效)。 */
export function readModelCatalogOverrides(): ModelCatalogOverrides {
  store.invalidateIfChanged();
  return store.read();
}

/** 模型级图片输入能力的 override 目标。 */
export interface ModelCatalogImageInputTarget {
  providerId: string;
  modelId: string;
}

/** patch 条目的键格式，与 sanitize/合并侧保持一致。 */
function patchKey(providerId: string, modelId: string): string {
  return `${encodeURIComponent(providerId)}:${modelId}`;
}

/**
 * 声明某个模型的图片输入能力：`true`/`false` 写 base patch，`null` 删除该覆盖回到
 * 「跟随供应商」。缺字段继承、false 明确关闭，所以三态必须都能表达。
 *
 * 写 base 而不是 perAgent：图片能力是公共字段(model-metadata-precedence.md 的公共
 * 字段范围)，运行期门按解析后的模型读它；perAgent 留给真正逐引擎不同的场景。
 * 只动 base.supportsImageInput 一个键，条目里其它字段与其它条目原样保留。
 */
export async function setModelCatalogImageInput(
  target: ModelCatalogImageInputTarget,
  value: boolean | null,
): Promise<ModelCatalogOverrides> {
  const key = patchKey(target.providerId, target.modelId);
  return store.updateAtomic((current) => {
    const patches: Record<string, ModelCatalogOverrideEntry> = { ...current.value.patches };
    const entry: ModelCatalogOverrideEntry = { ...patches[key] };
    const base = { ...entry.base };
    if (value === null) delete base.supportsImageInput;
    else base.supportsImageInput = value;
    if (Object.keys(base).length > 0) entry.base = base;
    else delete entry.base;
    // 条目空掉就整条删除：不留 "{} 条目" 噪音，也让文件能回到"无覆盖"状态。
    if (entry.base || entry.perAgent || entry.agents) patches[key] = entry;
    else delete patches[key];
    return { patches };
  });
}

/**
 * 读该模型的图片输入 override。`isCustomized` 让 UI 能区分「跟随供应商」与
 * 「显式声明了一个刚好等于目录的值」—— 只报 value 会让「恢复跟随供应商」无从表达。
 */
export function readModelCatalogImageInput(target: ModelCatalogImageInputTarget): {
  value: boolean | null;
  isCustomized: boolean;
} {
  const overrides = readModelCatalogOverrides();
  const entry = overrides.patches[patchKey(target.providerId, target.modelId)];
  const value = entry?.base?.supportsImageInput;
  return typeof value === 'boolean'
    ? { value, isCustomized: true }
    : { value: null, isCustomized: false };
}
