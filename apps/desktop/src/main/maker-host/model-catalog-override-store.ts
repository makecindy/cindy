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

import fs from 'node:fs';

import { desktopMakerLogger } from './logger-adapter.js';
import { createOverrideSettingsFile } from './override-settings-file.js';
import {
  EMPTY_MODEL_CATALOG_OVERRIDES,
  sanitizeModelCatalogOverrides,
  type ModelCatalogOverrideEntry,
  type ModelCatalogOverrides,
} from './model-plane/localCatalogOverrides.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import type { AgentKind } from '@cindy/model-providers';

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
  filePath: overrideFilePath,
  defaults: EMPTY_MODEL_CATALOG_OVERRIDES,
  normalize,
  log,
  label: 'model-catalog-overrides',
  maxBytes: MAX_MODEL_CATALOG_OVERRIDE_FILE_BYTES,
  preserveUnreadableFile: true,
  // patch 只替换被写入键的快照，其余原样落盘：不加这条时 writePatch 会用 sanitize 后的
  // 整段 patches 覆盖原文件，手改引入的未知字段/超限条目会被静默删除。
  mergeOverrides: ({ patch, overrides }) => {
    const next: Record<string, unknown> = { ...overrides };
    for (const key of Object.keys(patch)) {
      const value = patch[key as keyof ModelCatalogOverrides];
      if (key === 'patches' && isPlainObject(value) && Object.keys(value).length === 0) {
        delete next.patches;
      } else {
        next[key] = value;
      }
    }
    // 空段不落盘（与 reset 语义一致：没有条目时不留 `{}` 噪音）。
    for (const section of ['patches', 'additions'] as const) {
      if (isPlainObject(next[section]) && Object.keys(next[section]).length === 0) {
        delete next[section];
      }
    }
    // 除 version 外什么都不剩 → 整文件收回「无覆盖」。
    if (Object.keys(next).every((key) => key === 'version')) return {};
    return next;
  },
});

/** 当前 override 快照(注入 active-catalog 合并;mtime 守卫让手改文件下次读取生效)。 */
export function readModelCatalogOverrides(): ModelCatalogOverrides {
  store.invalidateIfChanged();
  return store.read();
}

/** 模型级图片输入能力的 override 目标。agent 只影响读取时的有效值(base + perAgent 合并)。 */
export interface ModelCatalogImageInputTarget {
  providerId: string;
  modelId: string;
  agent?: AgentKind;
}

function overrideFilePath(): string {
  return ownerScopedUserDataPath('model-catalog-overrides.json');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** patch 条目的键格式，与 sanitize/合并侧保持一致。 */
function patchKey(providerId: string, modelId: string): string {
  return `${encodeURIComponent(providerId)}:${modelId}`;
}

/**
 * 写盘会把 `patches` 整段换成 sanitize 后的快照 —— 手改文件里被隔离的条目（未知字段、
 * 超上限的尾部条目）会被静默丢掉。在锁内現读原文件，发现会丢就显式拒绝，而不是把用户的
 * 手改当垃圾清掉（与 sanitize 的「显式契约」一致）。
 */
function assertNoPatchEntriesWouldBeLost(): void {
  let rawText: string;
  try {
    rawText = fs.readFileSync(overrideFilePath(), 'utf-8');
  } catch {
    // 文件不存在/不可读：没东西可丢；真不可读时 store 自己会拒绝覆写。
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return; // 坏 JSON 由 store 的 preserveUnreadableFile 语义处理。
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.patches)) return;
  const rawPatchKeys = Object.keys(parsed.patches);
  if (rawPatchKeys.length === 0) return;
  const { overrides, invalid } = sanitizeModelCatalogOverrides(parsed);
  const keptPatchKeys = new Set(Object.keys(overrides.patches));
  const lostKeys = rawPatchKeys.filter((key) => !keptPatchKeys.has(key));
  const patchSectionInvalid = invalid.filter(
    (entry) => entry === 'patches' || entry.startsWith('patches:'),
  );
  if (lostKeys.length > 0 || patchSectionInvalid.length > 0) {
    throw new Error(
      'model-catalog-overrides.json 里有本版本无法保留的 patches 条目' +
        `（${[...new Set([...lostKeys, ...patchSectionInvalid])].slice(0, 5).join(', ')}）；` +
        '请先修正该文件再在设置里改动图片输入能力，以免手改内容被静默丢弃。',
    );
  }
}

/** 从条目里拿指定 agent 的有效图片能力声明（perAgent 覆盖 base，与合并侧一致）。 */
function effectiveImageInput(
  entry: ModelCatalogOverrideEntry | undefined,
  agent: AgentKind | undefined,
): boolean | undefined {
  const perAgentValue = agent ? entry?.perAgent?.[agent]?.supportsImageInput : undefined;
  const baseValue = entry?.base?.supportsImageInput;
  const value = perAgentValue !== undefined ? perAgentValue : baseValue;
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * 声明图片输入能力：`true`/`false` 写 base patch，`null` 删除该覆盖回到「跟随供应商」。
 * 缺字段继承、false 明确关闭，所以三态必须都能表达。
 *
 * 写 base 而不是 perAgent：图片能力是公共字段(model-metadata-precedence.md 的公共
 * 字段范围)，运行期门按解析后的模型读它；perAgent 留给真正逐引擎不同的场景。
 * 调用方一次传该行的**全部引擎 id**（桥接两端 id 不同，只写主展示引擎会让运行期读不到）。
 * perAgent 里残留的 supportsImageInput 会遮蔽 base（导致 UI 显示与运行期不一致），连同
 * 本次写入一起清掉；条目里其它字段与其它条目原样保留。
 */
export async function setModelCatalogImageInput(
  target: ModelCatalogImageInputTarget | readonly ModelCatalogImageInputTarget[],
  value: boolean | null,
): Promise<ModelCatalogOverrides> {
  const targets = Array.isArray(target) ? target : [target as ModelCatalogImageInputTarget];
  const keys = [...new Set(targets.map((t) => patchKey(t.providerId, t.modelId)))];
  return store.updateAtomic((current) => {
    assertNoPatchEntriesWouldBeLost();
    const patches: Record<string, ModelCatalogOverrideEntry> = { ...current.value.patches };
    for (const key of keys) {
      const entry: ModelCatalogOverrideEntry = { ...patches[key] };
      const base = { ...entry.base };
      if (value === null) delete base.supportsImageInput;
      else base.supportsImageInput = value;
      if (Object.keys(base).length > 0) entry.base = base;
      else delete entry.base;
      if (entry.perAgent) {
        const perAgent = { ...entry.perAgent };
        for (const agent of Object.keys(perAgent) as AgentKind[]) {
          const fields = { ...perAgent[agent] };
          if (fields.supportsImageInput === undefined) continue;
          delete fields.supportsImageInput;
          if (Object.keys(fields).length > 0) perAgent[agent] = fields;
          else delete perAgent[agent];
        }
        if (Object.keys(perAgent).length > 0) entry.perAgent = perAgent;
        else delete entry.perAgent;
      }
      // 条目空掉就整条删除：不留 "{} 条目" 噪音，也让文件能回到"无覆盖"状态。
      if (entry.base || entry.perAgent || entry.agents) patches[key] = entry;
      else delete patches[key];
    }
    return { patches };
  });
}

/**
 * 读该模型的图片输入 override。`isCustomized` 让 UI 能区分「跟随供应商」与
 * 「显式声明了一个刚好等于目录的值」—— 只报 value 会让「恢复跟随供应商」无从表达。
 * 给了 agent 就按合并语义算有效值(base + perAgent[agent])，否则只看 base。
 */
export function readModelCatalogImageInput(target: ModelCatalogImageInputTarget): {
  value: boolean | null;
  isCustomized: boolean;
} {
  const overrides = readModelCatalogOverrides();
  const entry = overrides.patches[patchKey(target.providerId, target.modelId)];
  const value = effectiveImageInput(entry, target.agent);
  return value === undefined ? { value: null, isCustomized: false } : { value, isCustomized: true };
}
