import { pickModelMetadata } from '@cindy/model-providers';
/**
 * model-discovery/anthropic —— Anthropic(Claude.ai 订阅)模型清单的动态发现。
 * ---------------------------------------------------------------------------
 * 2026-07-19 模型列表统一重构:anthropic 供应商的清单**唯一来源是动态发现**,
 * 产品目录静态段已退役(bundled 恒为空);2026-09-27 起 Registry 也不再补入 SDK
 * 没返回的型号,只给返回的型号补资料。
 *
 *   **SDK `supportedModels()`**(claude-code 会话 init 后捕获;maker 就绪、登录 / 认领后
 *   与手动刷新时由 requestAnthropicModelProbe 主动读取,两者经 maker-core
 *   setClaudeSupportedModelsListener 汇入同一入口):effort 档 / fastMode 是 SDK 明说的,
 *   逐字段可信。上一次成功结果持久化为磁盘缓存,启动即恢复。
 *
 * Claude 订阅凭证只在内置 Claude Code CLI 里(claude-native-cli),Cindy 不带它
 * 直接请求 Anthropic,所以没有 HTTP `/v1/models` 通道。旧版缓存里 HTTP 记下的
 * 精确窗口(explicitWindows)仍会被恢复并沿用。
 *
 * 合并纪律(确定性,无隐藏兜底):
 *   - 按 id、按字段合并:effort / fastMode 哪项明确返回就只覆盖并记录哪项;
 *     缺席字段只保留**明确探测过**的旧值,旧版缓存 / 合成默认会用当前产品目录基线刷新
 *     (防止历史 low/medium/high 永久盖住新模型的 xhigh/max,也防止 fast-only 响应清空档位);
 *   - 旧版 HTTP 明说的 max_input_tokens 单独记账(explicitWindows,随缓存持久化),SDK
 *     通道覆盖时不许把精确窗口打回 1M/200k 猜测值;
 *   - 同一授权世代内失败不清列表(上一次成功结果 + 磁盘缓存是「陈旧的真数据」,
 *     可溯源);登出 / 直接换号都会先清空并删缓存,旧账号结果不得跨世代继承;
 *   - 成功但**骤减**的快照同样不生效(isDegenerateModelListShrink,质量下限护栏):
 *     清单无静态兜底,一次退化响应不允许把整个供应商清单打塌。
 *
 * 登录态门控(2026-07-19 对抗性 review P1):apply 必须以「Cindy 已连接本机 Claude Code
 * 登录」为前提——SDK 捕获来自本地 CLI 注册表,任何 provider 的 cc 会话都会应答,不设门
 * 会让未登录 / 已登出用户长出 anthropic 清单并重建刚删掉的缓存。世代计数(authGeneration)
 * 在登出 / 换号时自增,作废一切在途写回。磁盘缓存写删经同一串行队列 + 原子 rename,
 * 保证登出删缓存不会被较早的 SDK 持久化反向覆盖。
 *
 * contextWindow 规则:
 *   旧缓存恢复的精确窗口用之;否则读取当前 modelRegistry 的已知窗口；
 *   目录未知时默认 1M,仅 id 含 "haiku" 例外 200k。这样已知旧模型不会被错误提升到
 *   1M,未来新模型仍可在目录更新前按当代默认工作。
 *
 * 磁盘缓存:`<userData>/model-discovery/anthropic-models.json`
 * ({ fetchedAt, models, explicitEffortModelIds, explicitFastModeModelIds });只缓存动态获取的
 * 成功结果,与静态兜底是两回事。
 */

import { app } from 'electron';
import fsp from 'node:fs/promises';
import path from 'node:path';

import type { CatalogModel, Effort } from '@cindy/model-providers';

import { createLogger } from '../../logger.js';
import {
  getActiveCatalog,
  getCindyAnthropicModelName,
  getCindyModelContextWindow,
  getCindyModelEffortBaseline,
  setAnthropicDiscoveredModels,
} from '../active-catalog.js';
import { hasClaudeNativeLogin } from '../claude-native-auth.js';

const log = createLogger('model-discovery:anthropic');

const VALID_EFFORTS: ReadonlySet<string> = new Set([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
/** 最近一次生效的发现结果(含缓存加载),合并时的能力字段保留源。 */
let lastApplied: CatalogModel[] = [];
/**
 * 能力字段由 SDK(或旧版 HTTP)明确声明过的模型 id。effort / fastMode 必须分开记账,因为上游
 * 可能只返回其中一项；旧版缓存里的 low/medium/high 既可能是合成默认,也可能是上游实值,
 * 只看模型值无法安全判断。旧缓存没有来源字段时一律按非明确处理。
 */
const explicitEffortModelIds = new Set<string>();
const explicitFastModeModelIds = new Set<string>();
/** 旧版 HTTP 明说过 max_input_tokens 的模型窗口(id → tokens,从缓存恢复);优先于启发式规则。 */
const explicitWindows = new Map<string, number>();
/** 授权边界(登出 / 换号)自增:在途发现若世代已变,结果作废不写回。 */
let authGeneration = 0;
/** 缓存写入 / 删除严格串行,保证授权边界后的删除一定排在旧世代写入之后。 */
let cacheMutationQueue: Promise<void> = Promise.resolve();
let cacheTempSequence = 0;

function cacheFilePath(): string {
  return path.join(app.getPath('userData'), 'model-discovery', 'anthropic-models.json');
}

/** 缓存 IO 串行化;单次失败记日志并吞掉,后续授权边界删除仍必须继续执行。 */
function enqueueCacheMutation(task: () => Promise<void>): Promise<void> {
  cacheMutationQueue = cacheMutationQueue.then(task).catch((err) => {
    log.warn('anthropic models cache mutation failed', { error: String(err) });
  });
  return cacheMutationQueue;
}

function generationCanApply(generation: number, models: CatalogModel[]): boolean {
  return generation === authGeneration && (models.length === 0 || hasClaudeNativeLogin());
}

/**
 * wire id → 目录 id 归一化:先剥 `[1m]` 等方括号路由后缀,再剥 dated 日期后缀
 * (claude-opus-4-8-20260401 → claude-opus-4-8)。SDK 注册表把长上下文变体报成
 * claude-fable-5[1m],而目录与会话选中的 id 无此后缀——不剥会让该模型在
 * sourcesForModel 的精确匹配整体 miss,顶栏误报「已断开」并禁发。口径与
 * claude-gateway-config / usageFormat 的既有归一化一致。
 */
function normalizeModelId(raw: string): string {
  return raw.replace(/\[[^\]]*\]$/, '').replace(/-20\d{6}$/, '');
}

/** 已记录过的目录未登记 / 无法解析的 SDK 简称条目,避免每个会话 init 重复打日志。 */
const unresolvedAliasLogged = new Set<string>();

/**
 * SDK 条目 → 目录模型 id;无法确定时返回 null(该条目不进清单)。
 *
 * 显式 `claude-*` id 原样归一化。SDK 对每个系列的当前型号常只报简称
 * (`default` / `opus` / `sonnet` …),具体版本只写在 description 开头
 * (如 "Opus 5.5 · …" / "Opus 4.7 with 1M context · …")。简称按说明里的系列与版本
 * 拼出 `claude-<系列>-<主>-<次>`(Anthropic 的 id 规则)。目录尚未登记的新版本
 * (如 Fable 5.2)照样按说明生成 id 并显示,资料用未知模型的默认值,绝不映射到相邻旧版本。
 * 只有无法从说明确定版本时才放弃:简称与说明的系列不一致(opus 却写 Sonnet)、
 * 版本号多于两段或说明缺失。
 */
function resolveSdkModelId(value: string, description: unknown): string | null {
  const normalized = normalizeModelId(value);
  if (normalized.startsWith('claude')) return normalized;
  const alias = normalized.toLowerCase();
  const match =
    typeof description === 'string'
      ? /^(?:Claude\s+)?([A-Za-z]+)\s+(\d+)(?:\.(\d+))?(?![\w.])/.exec(description.trim())
      : null;
  const family = match?.[1]?.toLowerCase();
  const id =
    match && family && (alias === 'default' || alias === family)
      ? `claude-${family}-${match[2]}${match[3] !== undefined ? `-${match[3]}` : ''}`
      : null;
  const known = id !== null && getCindyAnthropicModelName(id) !== null;
  if (known) return id;
  const logKey = `${value}\u0000${String(description)}`;
  if (!unresolvedAliasLogged.has(logKey)) {
    unresolvedAliasLogged.add(logKey);
    log.info(
      id
        ? 'anthropic SDK model alias resolved to a model not yet in the catalog'
        : 'anthropic SDK model alias has no parsable version; skipped',
      { value, candidate: id },
    );
  }
  return id;
}

/** claude-fable-5-1 → { family: 'fable', version: '5.1' };不符合 `claude-<系列>-<主>[-<次>]` 时返回 null。 */
function parseClaudeModelId(id: string): { family: string; version: string } | null {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?$/.exec(id);
  if (!match) return null;
  return {
    family: match[1]!,
    version: match[3] !== undefined ? `${match[2]}.${match[3]}` : match[2]!,
  };
}

/**
 * SDK displayName 能否作为该型号的名称:必须写出与 id 相同的版本号。SDK 对系列当前型号常只
 * 给系列名("Fable")、简称条目给 "Default (recommended)" / "Opus (1M context)"——这些
 * 不能区分同系列型号("1M" 里的数字是上下文长度,不是版本)。id 读不出版本时不采用。
 */
function displayNameMatchesModelId(name: string, id: string): boolean {
  const parsed = parseClaudeModelId(id);
  if (!parsed) return false;
  const escaped = parsed.version.replace('.', '\\.');
  return new RegExp(`(^|[^\\d.])${escaped}($|[^\\d.])`).test(name);
}

/** claude-fable-5-1 → "Fable 5.1";不符合 `claude-<系列>-<主>[-<次>]` 时返回 null。 */
function labelFromClaudeModelId(id: string): string | null {
  const parsed = parseClaudeModelId(id);
  if (!parsed) return null;
  return `${parsed.family[0]!.toUpperCase()}${parsed.family.slice(1)} ${parsed.version}`;
}

/**
 * contextWindow 规则:缓存恢复的精确值 > 目录已知值 > 未知模型启发式(默认 1M,Haiku 200k)。
 *
 * 前两档是**显式声明**的真实上限,一并标记 contextWindowVerified 让下游可以拿它收敛
 * 运行期上报的窗口;最后一档是猜的,不标记 —— 否则未知模型会被一个启发式常量当成硬
 * 上限(见 CatalogModel.contextWindowVerified 注释)。返回可直接展开进 CatalogModel。
 */
function contextWindowFor(
  id: string,
  explicit?: number,
): { contextWindow: number; contextWindowVerified?: true } {
  if (typeof explicit === 'number' && explicit > 0) {
    return { contextWindow: explicit, contextWindowVerified: true };
  }
  const catalogWindow = getCindyModelContextWindow(id);
  if (catalogWindow !== null) {
    return { contextWindow: catalogWindow, contextWindowVerified: true };
  }
  return { contextWindow: /haiku/.test(id) ? 200_000 : 1_000_000 };
}

function pickDefaultEffort(efforts: Effort[]): Effort | null {
  if (efforts.length === 0) return null;
  return efforts.includes('high') ? 'high' : efforts[efforts.length - 1];
}

function toEfforts(raw: unknown): Effort[] | null {
  if (!Array.isArray(raw)) return null;
  const out = raw.filter((e): e is Effort => typeof e === 'string' && VALID_EFFORTS.has(e));
  return out;
}

/**
 * 退化快照判定(2026-07-21「Anthropic 只剩单条 Fable」事故回归):上游返回**成功但
 * 骤减**的清单——一次少掉 2 条以上、且掉到不足现值一半——视为退化响应,保留现值
 * 不覆盖。这是「失败保留现值」之外的质量下限:清单唯一来源是动态发现、无静态兜底,
 * 一次退化响应会把整个供应商清单打塌。**逐个下架(含 2→1)永远合法**——真实下架是
 * 渐进的,单步递减不许被永久拦死(review P1);上游真一次腰斩时清单暂时偏旧(多出的
 * 条目发请求时报错暴露),后续正常快照自愈。纯函数。
 */
export function isDegenerateModelListShrink(prevCount: number, nextCount: number): boolean {
  if (prevCount === 0 || nextCount >= prevCount) return false;
  if (prevCount - nextCount <= 1) return false;
  return nextCount < Math.max(2, Math.ceil(prevCount / 2));
}

/** SDK 映射结果:每项能力是条目明说的还是合成默认的(决定逐字段合并与来源记账)。 */
export interface SdkMappedModel {
  model: CatalogModel;
  hasEffortInfo: boolean;
  hasFastModeInfo: boolean;
}

/**
 * 动态通道无能力信息时:产品目录基线优先；未知非 Haiku 模型按当代旗舰能力合成
 * 5 档，让新 Opus / Sonnet 上线后无需等客户端目录更新即可使用 xhigh / max。
 * Haiku 保持 0 档；上游后续明确返回能力时仍会逐字段覆盖此临时基线。
 */
function fallbackEffortBaseline(id: string): { efforts: Effort[]; defaultEffort: Effort | null } {
  const catalogBaseline = getCindyModelEffortBaseline(id);
  if (catalogBaseline) return catalogBaseline;
  const efforts: Effort[] = /haiku/.test(id) ? [] : ['low', 'medium', 'high', 'xhigh', 'max'];
  return { efforts, defaultEffort: pickDefaultEffort(efforts) };
}

/**
 * SDK `supportedModels()` 条目 → 映射结果。只读目录,无副作用(除一次性日志)。
 * 目录只收显式版本 id(规则 10:禁止 opus/sonnet 裸别名进目录):SDK 简称条目经
 * resolveSdkModelId 按说明里的版本解析为具体 id,确定不了版本才跳过。这份清单是 Anthropic
 * 成员的唯一来源,目录不再补入 SDK 没返回的型号。
 * 名称:SDK 的 displayName 写出与 id 相同的版本号才采用;否则用目录名称,目录未登记则按 id 推导。
 * ModelInfo 的能力字段全部 optional:字段在场时 SDK 是能力权威(supportsEffort=false =
 * 不可调);**字段缺席 = 该字段未知**,按 modelRegistry 基线 / 确定性默认合成,
 * 合并时保留该字段已精化的旧值——不能把「CLI 没填」解读成「不支持」而抹掉档位。
 */
export function mapAnthropicSdkModels(raw: unknown): SdkMappedModel[] {
  if (!Array.isArray(raw)) return [];
  const out: SdkMappedModel[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as {
      value?: unknown;
      displayName?: unknown;
      description?: unknown;
      supportsEffort?: unknown;
      supportedEffortLevels?: unknown;
      supportsFastMode?: unknown;
    };
    if (typeof e.value !== 'string' || e.value.length === 0) continue;
    const id = resolveSdkModelId(e.value, e.description);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const reportedName =
      typeof e.displayName === 'string' && displayNameMatchesModelId(e.displayName, id)
        ? e.displayName
        : undefined;
    const hasEffortInfo = e.supportsEffort !== undefined || e.supportedEffortLevels !== undefined;
    const hasFastModeInfo = e.supportsFastMode !== undefined;
    const fallback = fallbackEffortBaseline(id);
    let efforts: Effort[];
    let defaultEffort: Effort | null;
    if (!hasEffortInfo) {
      efforts = fallback.efforts;
      defaultEffort = fallback.defaultEffort;
    } else if (e.supportsEffort === false) {
      efforts = [];
      defaultEffort = null;
    } else {
      const levels = toEfforts(e.supportedEffortLevels);
      // supportsEffort=true 但没给档位清单:按目录基线 / 确定性默认合成,不解读为不可调。
      efforts =
        levels && levels.length > 0 ? levels : e.supportsEffort === true ? fallback.efforts : [];
      defaultEffort =
        levels && levels.length > 0
          ? pickDefaultEffort(efforts)
          : e.supportsEffort === true
            ? fallback.defaultEffort
            : null;
    }
    out.push({
      hasEffortInfo,
      hasFastModeInfo,
      model: {
        id,
        discoveredMetadata: pickModelMetadata({
          name: reportedName,
          description: e.description,
          efforts:
            e.supportsEffort === false ? [] : (toEfforts(e.supportedEffortLevels) ?? undefined),
          supportsFastMode: e.supportsFastMode,
        }),
        name: reportedName ?? getCindyAnthropicModelName(id) ?? labelFromClaudeModelId(id) ?? id,
        group: 'anthropic',
        sortOrder: out.length,
        ...(typeof e.description === 'string' && e.description.length > 0
          ? { description: e.description }
          : {}),
        ...contextWindowFor(id),
        efforts,
        defaultEffort,
        supportsFastMode: e.supportsFastMode === true,
        status: 'active',
        // 默认可见；哪些不默认显示只由模型目录的 defaultEnabled 决定。
      },
    });
  }
  return out;
}

interface CapabilityMappedModel {
  model: CatalogModel;
  hasEffortInfo: boolean;
  hasFastModeInfo: boolean;
}

/**
 * 把一份完整存在性快照与上一轮能力状态逐字段合并。缺席字段只有上一轮已标记为明确
 * 来源时才保留旧值；否则直接使用 mapper 生成的当前目录基线。
 */
function mergeCapabilitiesWithPrevious(mapped: readonly CapabilityMappedModel[]): {
  models: CatalogModel[];
  explicitEffortIds: Set<string>;
  explicitFastModeIds: Set<string>;
} {
  const prevById = new Map(lastApplied.map((model) => [model.id, model]));
  const nextExplicitEffort = new Set<string>();
  const nextExplicitFastMode = new Set<string>();
  const models = mapped.map(({ model, hasEffortInfo, hasFastModeInfo }) => {
    const prev = prevById.get(model.id);
    let merged = model;
    if (hasEffortInfo) {
      nextExplicitEffort.add(model.id);
    } else if (prev && explicitEffortModelIds.has(model.id)) {
      nextExplicitEffort.add(model.id);
      merged = {
        ...merged,
        discoveredMetadata: {
          ...merged.discoveredMetadata,
          ...pickModelMetadata({
            efforts: prev.discoveredMetadata?.efforts,
            defaultEffort: prev.discoveredMetadata?.defaultEffort,
          }),
        },
        efforts: prev.efforts,
        defaultEffort: prev.defaultEffort,
      };
    }
    if (hasFastModeInfo) {
      nextExplicitFastMode.add(model.id);
    } else if (prev && explicitFastModeModelIds.has(model.id)) {
      nextExplicitFastMode.add(model.id);
      merged = {
        ...merged,
        discoveredMetadata: {
          ...merged.discoveredMetadata,
          ...pickModelMetadata({ supportsFastMode: prev.discoveredMetadata?.supportsFastMode }),
        },
        supportsFastMode: prev.supportsFastMode,
      };
    }
    return merged;
  });
  return {
    models,
    explicitEffortIds: nextExplicitEffort,
    explicitFastModeIds: nextExplicitFastMode,
  };
}

/**
 * 生效 + 可选持久化。setAnthropicDiscoveredModels 统一经 active-catalog 的
 * markChanged 收口能力刷新、revision 递增与 PROVIDER_CHANGED 广播。
 * 内容与现值一致时整体跳过(SDK 捕获每会话触发,清单通常一字不变——不做比较会
 * 每开一个会话就白跑一次落盘 + 全窗口广播 + capabilities 重 derive,review P2)。
 */
async function applyModels(
  models: CatalogModel[],
  persist: boolean,
  generation = authGeneration,
  nextExplicitEffortIds: ReadonlySet<string> = explicitEffortModelIds,
  nextExplicitFastModeIds: ReadonlySet<string> = explicitFastModeModelIds,
): Promise<boolean> {
  if (!generationCanApply(generation, models)) return false;
  const modelIds = new Set(models.map((model) => model.id));
  const normalizedExplicitEffortIds = new Set(
    [...nextExplicitEffortIds].filter((id) => modelIds.has(id)),
  );
  const normalizedExplicitFastModeIds = new Set(
    [...nextExplicitFastModeIds].filter((id) => modelIds.has(id)),
  );
  const modelsChanged = JSON.stringify(models) !== JSON.stringify(lastApplied);
  const capabilityProvenanceChanged =
    normalizedExplicitEffortIds.size !== explicitEffortModelIds.size ||
    [...normalizedExplicitEffortIds].some((id) => !explicitEffortModelIds.has(id)) ||
    normalizedExplicitFastModeIds.size !== explicitFastModeModelIds.size ||
    [...normalizedExplicitFastModeIds].some((id) => !explicitFastModeModelIds.has(id));
  if (!modelsChanged && !capabilityProvenanceChanged) {
    return generationCanApply(generation, models);
  }
  lastApplied = models;
  explicitEffortModelIds.clear();
  for (const id of normalizedExplicitEffortIds) explicitEffortModelIds.add(id);
  explicitFastModeModelIds.clear();
  for (const id of normalizedExplicitFastModeIds) explicitFastModeModelIds.add(id);
  if (modelsChanged) setAnthropicDiscoveredModels(models);
  if (persist) {
    const payload = JSON.stringify(
      {
        fetchedAt: new Date().toISOString(),
        models,
        explicitWindows: Object.fromEntries(explicitWindows),
        explicitEffortModelIds: models
          .map((model) => model.id)
          .filter((id) => explicitEffortModelIds.has(id)),
        explicitFastModeModelIds: models
          .map((model) => model.id)
          .filter((id) => explicitFastModeModelIds.has(id)),
      },
      null,
      2,
    );
    await enqueueCacheMutation(async () => {
      if (!generationCanApply(generation, models)) return;
      const file = cacheFilePath();
      const temp = `${file}.${process.pid}.${(cacheTempSequence += 1)}.tmp`;
      try {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        if (!generationCanApply(generation, models)) return;
        await fsp.writeFile(temp, payload, 'utf-8');
        // 写临时文件期间可能发生登出 / 换号:禁止旧世代 rename 成正式缓存。
        if (!generationCanApply(generation, models)) return;
        await fsp.rename(temp, file);
      } finally {
        await fsp.rm(temp, { force: true }).catch(() => undefined);
      }
    });
  }
  return generationCanApply(generation, models);
}

/**
 * 启动时加载磁盘缓存(上一次动态获取的成功结果)。未登录不加载(登出即清,
 * 残留缓存也不能代表可用性);缓存缺失 / 坏 JSON 静默跳过(等 SDK 通道)。
 */
export async function loadAnthropicModelsFromDiskCache(): Promise<void> {
  if (!hasClaudeNativeLogin()) return;
  const generation = authGeneration;
  try {
    const raw: unknown = JSON.parse(await fsp.readFile(cacheFilePath(), 'utf-8'));
    if (generation !== authGeneration || !hasClaudeNativeLogin()) return;
    const models = (raw as { models?: unknown } | null)?.models;
    if (!Array.isArray(models) || models.length === 0) return;
    // 恢复「窗口来自 HTTP 明说」的记账,否则重启后首个 SDK 捕获会把精确窗口打回猜测值。
    const windows = (raw as { explicitWindows?: unknown }).explicitWindows;
    if (windows && typeof windows === 'object' && !Array.isArray(windows)) {
      for (const [id, win] of Object.entries(windows as Record<string, unknown>)) {
        // key 同样归一化:历史缓存可能以带 [1m] 后缀的脏 id 记账。归一化后撞 key 时
        // first-wins,与下方 models 去重同口径,避免拼出「窗口来自 A、能力来自 B」的杂交态。
        if (typeof win !== 'number' || win <= 0) continue;
        const normalizedId = normalizeModelId(id);
        if (!explicitWindows.has(normalizedId)) explicitWindows.set(normalizedId, win);
      }
    }
    // 缓存内容出自本模块 mapper,仍做最小结构校验防手改坏文件。
    const valid = models.filter(
      (m): m is CatalogModel =>
        !!m &&
        typeof m === 'object' &&
        typeof (m as CatalogModel).id === 'string' &&
        typeof (m as CatalogModel).name === 'string' &&
        typeof (m as CatalogModel).contextWindow === 'number' &&
        Array.isArray((m as CatalogModel).efforts),
    );
    if (valid.length === 0) return;
    // 归一化自愈:修复前的 SDK 捕获会把 claude-fable-5[1m] 这类脏 id 落盘。按当前口径
    // 清洗 + first-wins 去重,启动加载即恢复来源匹配,不等下一次动态捕获才纠正。
    const validIds = new Set<string>();
    const deduped: CatalogModel[] = [];
    for (const model of valid) {
      const id = normalizeModelId(model.id);
      if (validIds.has(id)) {
        // 折叠丢弃留痕:两条脏/裸变体的能力字段可能不同,first-wins 的输者信息
        // 会等下一次动态捕获刷新,这里记日志方便定位。
        log.info(`anthropic disk cache entry folded by id normalization: ${model.id}`);
        continue;
      }
      validIds.add(id);
      deduped.push(id === model.id ? model : { ...model, id });
    }
    const restoreIds = (value: unknown): Set<string> => {
      const restored = new Set<string>();
      if (Array.isArray(value)) {
        for (const id of value) {
          if (typeof id !== 'string') continue;
          const normalizedId = normalizeModelId(id);
          if (validIds.has(normalizedId)) restored.add(normalizedId);
        }
      }
      return restored;
    };
    // 旧的 explicitCapabilityModelIds 无法区分 effort / fastMode,刻意不恢复；
    // 把有歧义的整模型来源当作非明确,下一次 SDK 捕获会按逐字段证据重新记账。
    const restoredExplicitEffortIds = restoreIds(
      (raw as { explicitEffortModelIds?: unknown }).explicitEffortModelIds,
    );
    const restoredExplicitFastModeIds = restoreIds(
      (raw as { explicitFastModeModelIds?: unknown }).explicitFastModeModelIds,
    );
    // Cache versions before per-field provenance did not distinguish
    // mapper fallbacks from API/SDK-declared capabilities. Refresh every
    // non-explicit effort baseline and context window from the current
    // catalog so app upgrades cannot preserve stale model metadata.
    const normalized = deduped.map((model) => {
      const effortBaseline = restoredExplicitEffortIds.has(model.id)
        ? null
        : fallbackEffortBaseline(model.id);
      // 必须先抹掉缓存里的旧 provenance 再让 contextWindowFor 重新判定:它的启发式分支
      // **不返回** contextWindowVerified 键,残留的 true 会盖在新算出的启发式窗口上。
      // 触发面窄但后果正是本次要消除的那种:某模型被新版目录移除、又不在 explicitWindows
      // 里(命中目录的窗口不进那张表)时,会得到一个「已核实」的猜测值 —— 例如 Haiku 残留
      // 200K 而运行期真实 1M,反倒把上报值压小。这也是上面那条刷新不变量的要求。
      const { contextWindowVerified: _staleProvenance, ...rest } = model;
      // 旧版缓存会把 SDK 的系列名("Fable")当型号名落盘;按当前口径丢弃不含版本号的名称。
      const cachedName = model.discoveredMetadata?.name;
      const staleName =
        cachedName !== undefined && !displayNameMatchesModelId(cachedName, model.id);
      const { name: _staleName, ...cachedMetadata } = model.discoveredMetadata ?? {};
      return {
        ...rest,
        ...(staleName || !displayNameMatchesModelId(model.name, model.id)
          ? {
              name:
                getCindyAnthropicModelName(model.id) ??
                labelFromClaudeModelId(model.id) ??
                model.id,
            }
          : {}),
        discoveredMetadata:
          (model.discoveredMetadata && (staleName ? cachedMetadata : model.discoveredMetadata)) ??
          pickModelMetadata({
            contextWindow: explicitWindows.get(model.id),
            efforts: restoredExplicitEffortIds.has(model.id) ? model.efforts : undefined,
            supportsFastMode: restoredExplicitFastModeIds.has(model.id)
              ? model.supportsFastMode
              : undefined,
          }),
        ...contextWindowFor(model.id, explicitWindows.get(model.id)),
        ...(effortBaseline ?? {}),
      };
    });
    await applyModels(
      normalized,
      false,
      generation,
      restoredExplicitEffortIds,
      restoredExplicitFastModeIds,
    );
    log.info(`anthropic models loaded from disk cache: ${normalized.length}`);
  } catch {
    /* 缓存缺失 / 损坏:等动态通道,不影响启动 */
  }
}

/**
 * SDK 会话 init 捕获入口(maker-core setClaudeSupportedModelsListener 接线)。
 * 登录态门控:SDK 应答来自本地 CLI 注册表,任何 provider 的 cc 会话都会触发,
 * 未登录 Claude.ai 时不得注入(否则登出被击穿 / 纯网关用户长出 anthropic 清单)。
 * 按 id 合并:条目带能力信息则覆盖,否则保留已精化条目;缓存恢复的精确窗口不回退。
 */
export function noteAnthropicSdkSupportedModels(
  raw: unknown,
  generation: number = authGeneration,
): void {
  if (!hasClaudeNativeLogin() || generation !== authGeneration) return;
  const mapped = mapAnthropicSdkModels(raw);
  if (mapped.length === 0) return;
  const mappedWithWindows = mapped.map(({ model, hasEffortInfo, hasFastModeInfo }) => {
    const explicit = explicitWindows.get(model.id);
    // explicitWindows 存的是(旧版)HTTP 明说过的 max_input_tokens —— 恢复它时必须连
    // contextWindowVerified 一起恢复。SDK 通道重新映射同一模型时走的是「无 explicit」
    // 分支(目录里没有该模型就落到启发式、不带标记), 只覆盖 contextWindow 会把这份
    // provenance 静默擦掉, 之后就不再拿这个真实上限去收敛虚高的上报值了。
    const base =
      explicit !== undefined
        ? {
            ...model,
            discoveredMetadata: { ...model.discoveredMetadata, contextWindow: explicit },
            contextWindow: explicit,
            contextWindowVerified: true as const,
          }
        : model;
    return { model: base, hasEffortInfo, hasFastModeInfo };
  });
  const { models, explicitEffortIds, explicitFastModeIds } =
    mergeCapabilitiesWithPrevious(mappedWithWindows);
  // SDK 通道骤减恒拒绝其**存在性快照**:持续一致的退化 SDK 快照正是打塌事故的形态。
  // 但 cc 当前可能只返回本会话模型这一条,其中明确携带的 capability 仍是该模型的权威
  // 信息:保留完整清单,只把同 id 的 effort / fast 字段增量合入,否则 Fable / Opus 的
  // xhigh 永远无法进入 UI。拒绝时保留陈旧超集(fail-visible:多出的条目发请求时报错,
  // 不会静默丢模型);清单随登出 / 换号清空重建。
  if (isDegenerateModelListShrink(lastApplied.length, models.length)) {
    const capabilityPatches = new Map(
      mapped
        .filter(({ hasEffortInfo, hasFastModeInfo }) => hasEffortInfo || hasFastModeInfo)
        .map((entry) => [entry.model.id, entry] as const),
    );
    const merged = lastApplied.map((current) => {
      const patch = capabilityPatches.get(current.id);
      if (!patch) return current;
      let next = current;
      if (patch.hasEffortInfo) {
        next = {
          ...next,
          discoveredMetadata: {
            ...next.discoveredMetadata,
            ...pickModelMetadata({
              efforts: patch.model.discoveredMetadata?.efforts,
              defaultEffort: patch.model.discoveredMetadata?.defaultEffort,
            }),
          },
          efforts: patch.model.efforts,
          defaultEffort: patch.model.defaultEffort,
        };
      }
      if (patch.hasFastModeInfo) {
        next = {
          ...next,
          discoveredMetadata: {
            ...next.discoveredMetadata,
            ...pickModelMetadata({
              supportsFastMode: patch.model.discoveredMetadata?.supportsFastMode,
            }),
          },
          supportsFastMode: patch.model.supportsFastMode,
        };
      }
      return next;
    });
    const mergedExplicitEffortIds = new Set(explicitEffortModelIds);
    const mergedExplicitFastModeIds = new Set(explicitFastModeModelIds);
    for (const [id, patch] of capabilityPatches) {
      if (patch.hasEffortInfo) mergedExplicitEffortIds.add(id);
      if (patch.hasFastModeInfo) mergedExplicitFastModeIds.add(id);
    }
    log.warn(
      `anthropic SDK capture looks degenerate (${lastApplied.length} -> ${models.length}); keeping current list, merging ${capabilityPatches.size} capability patch(es)`,
    );
    void applyModels(
      merged,
      true,
      generation,
      mergedExplicitEffortIds,
      mergedExplicitFastModeIds,
    ).catch((err) => {
      log.warn('apply partial anthropic SDK capabilities failed', { error: String(err) });
    });
    return;
  }
  log.info(`anthropic models captured from SDK init: ${models.length}`);
  void applyModels(models, true, generation, explicitEffortIds, explicitFastModeIds).catch(
    (err) => {
      log.warn('apply anthropic SDK models failed', { error: String(err) });
    },
  );
}

/**
 * 主动清单探测(生产 = maker.refreshAgentLocalModels('claude-code', { onSupportedModels })),
 * maker 就绪后注入。结果只交给传入的回调,不经全局捕获监听器。
 */
type AnthropicModelProbe = (onModels: (models: unknown[]) => void) => Promise<boolean>;
let modelProbe: AnthropicModelProbe | null = null;
/** 同一授权世代内的在途探测;换代后不复用旧世代的探测。 */
let probeInflight: { generation: number; promise: Promise<boolean> } | null = null;

/** 注入 / 注销探测(maker 重建或重置时);换掉后旧探测的在途结果不再生效、也不再被复用。 */
export function setAnthropicModelProbe(probe: AnthropicModelProbe | null): void {
  modelProbe = probe;
  probeInflight = null;
}

/**
 * 主动读取一次清单并生效(启动、登录 / 认领后、手动刷新):清单只来自 SDK,没有这一步时
 * 新登录或没有缓存的用户要等跑过一次 Claude Code 任务才看得到模型。
 * 结果按**发起时**的授权世代走 noteAnthropicSdkSupportedModels:探测期间登出 / 换号
 * (clearAnthropicDiscoveredModels 让世代自增)或 maker 被重置(探测被注销 / 替换)时,
 * 迟到结果不写入清单与缓存。
 * 返回本次是否拿到了属于当前世代的清单;未登录或 maker 未就绪时返回 false。
 */
export function refreshAnthropicModelsFromProbe(): Promise<boolean> {
  const probe = modelProbe;
  if (!probe || !hasClaudeNativeLogin()) return Promise.resolve(false);
  const generation = authGeneration;
  if (probeInflight?.generation === generation) return probeInflight.promise;
  const isCurrent = () => modelProbe === probe && generation === authGeneration;
  const promise = probe((models) => {
    if (isCurrent()) noteAnthropicSdkSupportedModels(models, generation);
  })
    .then((delivered) => delivered && isCurrent())
    .finally(() => {
      if (probeInflight?.promise === promise) probeInflight = null;
    });
  probeInflight = { generation, promise };
  return promise;
}

/** 当前是否已有可用的 Anthropic 清单(磁盘缓存恢复或 SDK 捕获)。 */
export function hasAnthropicDiscoveredModels(): boolean {
  return lastApplied.length > 0;
}

/** 最近一次看到的已登录 Claude 账号(CLI 报告的 email),用于识别不经登出的直接换号。 */
let lastClaudeLoginEmail: string | undefined;

/**
 * 按 CLI 登录态变化同步 Anthropic 清单(bootstrap 的登录态监听调用)。
 * - 登出:清空清单与缓存(世代自增,作废在途探测);
 * - 已登录但账号变了(终端里 A → B,中间没有登出):按换号处理,先清空旧账号的清单、
 *   缓存与在途探测,再为新账号读取;
 * - 其它登录变化:请求一次主动读取(未绑定 Cindy 使用许可时内部跳过)。
 */
export function syncAnthropicModelsWithClaudeLogin(status: {
  loggedIn: boolean;
  email?: string;
}): void {
  if (!status.loggedIn) {
    lastClaudeLoginEmail = undefined;
    void clearAnthropicDiscoveredModels().catch(() => undefined);
    return;
  }
  const switched =
    lastClaudeLoginEmail !== undefined &&
    status.email !== undefined &&
    status.email !== lastClaudeLoginEmail;
  if (status.email !== undefined) lastClaudeLoginEmail = status.email;
  if (!switched) {
    requestAnthropicModelProbe();
    return;
  }
  void clearAnthropicDiscoveredModels()
    .catch(() => undefined)
    .then(() => requestAnthropicModelProbe());
}

/** 后台请求一次主动探测;失败只记日志。 */
export function requestAnthropicModelProbe(): void {
  void refreshAnthropicModelsFromProbe().then(
    (applied) => {
      if (!applied) log.info('anthropic model probe returned no current model list');
    },
    (err: unknown) => {
      log.warn('anthropic model probe failed', { error: String(err) });
    },
  );
}

/**
 * 授权边界收口(登出 / 直接换号共用):清空清单 + 删磁盘缓存 + 作废在途发现。
 * 删除与持久化走同一队列,所以函数 resolve 后旧世代缓存不可能重新出现。
 */
export async function clearAnthropicDiscoveredModels(): Promise<void> {
  const generation = authGeneration + 1;
  authGeneration = generation;
  explicitWindows.clear();
  explicitEffortModelIds.clear();
  explicitFastModeModelIds.clear();
  await applyModels([], false, generation);
  await enqueueCacheMutation(async () => {
    await fsp.rm(cacheFilePath(), { force: true });
  });
}

/** 仅测试:等待所有缓存写删完成,不在生产路径调用。 */
export function waitForAnthropicDiscoveryIdleForTest(): Promise<void> {
  return cacheMutationQueue;
}

/** 仅测试:重置模块态。 */
export function resetAnthropicDiscoveryForTest(): void {
  lastApplied = [];
  probeInflight = null;
  lastClaudeLoginEmail = undefined;
  explicitWindows.clear();
  explicitEffortModelIds.clear();
  explicitFastModeModelIds.clear();
  // 不回拨世代:即便测试误留异步任务,旧任务也不会重新获得生效资格。
  authGeneration += 1;
}
