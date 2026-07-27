/**
 * model-discovery/anthropic —— Anthropic(Claude.ai 订阅)模型清单的动态发现。
 * ---------------------------------------------------------------------------
 * 2026-07-19 模型列表统一重构:anthropic 供应商的清单**唯一来源是动态发现**,
 * 产品目录静态段已退役(bundled 恒为空)。两条互补通道,汇入同一个 apply:
 *
 *   1. **HTTP `/v1/models`**(登录成功 / 启动时):订阅 OAuth Bearer +
 *      `anthropic-beta: oauth-2025-04-20`(与 title-one-shot 同一套已验证的头)。
 *      即时出清单;响应可能不带 effort/fast 能力信息,此时按确定性默认合成
 *      (见 mapAnthropicHttpModels),等 SDK 通道精化。
 *   2. **SDK `supportedModels()`**(每次 claude-code 会话 init 后捕获,经
 *      maker-core setClaudeSupportedModelsListener):效力最高——effort 档 /
 *      fastMode 是 SDK 明说的,逐字段可信。
 *
 * 合并纪律(确定性,无隐藏兜底):
 *   - 两条通道都按 id、按字段合并:effort / fastMode 哪项明确返回就只覆盖并记录哪项;
 *     缺席字段只保留**明确探测过**的旧值,旧版缓存 / 合成默认会用当前产品目录基线刷新
 *     (防止历史 low/medium/high 永久盖住新模型的 xhigh/max,也防止 fast-only 响应清空档位);
 *   - HTTP 明说的 max_input_tokens 单独记账(explicitWindows,随缓存持久化),SDK
 *     通道覆盖时不许把精确窗口打回 1M/200k 猜测值;
 *   - 同一授权世代内失败不清列表(上一次成功结果 + 磁盘缓存是「陈旧的真数据」,
 *     可溯源);登出 / 直接换号都会先清空并删缓存,旧账号结果不得跨世代继承;
 *   - 成功但**骤减**的快照同样不生效(isDegenerateModelListShrink,质量下限护栏):
 *     清单无静态兜底,一次退化响应不允许把整个供应商清单打塌。
 *
 * 登录态门控(2026-07-19 对抗性 review P1):两条通道的 apply 都必须以「当前确有
 * Claude.ai OAuth」为前提——SDK 捕获来自本地 CLI 注册表,不需要 Anthropic 凭证也能
 * 应答,不设门会让未登录 / 已登出用户长出 anthropic 清单并重建刚删掉的缓存;HTTP
 * 在途请求跨越授权边界完成时同理。世代计数(authGeneration)在登出 / 换号时自增,
 * 作废一切在途写回,并让新账号拉取不被旧 single-flight 吞掉。磁盘缓存写删经同一
 * 串行队列 + 原子 rename,保证登出删缓存不会被较早的 SDK 持久化反向覆盖。
 *
 * contextWindow 规则:
 *   HTTP 响应带 max_input_tokens 用之;否则读取当前 cindyModelMeta 的已知窗口；
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
  getCindyModelContextWindow,
  getCindyModelEffortBaseline,
  setAnthropicDiscoveredModels,
} from '../active-catalog.js';
import { hasClaudeAiOAuth } from '../claude-credentials-store.js';
import { getValidClaudeAiOAuth } from '../claude-oauth-refresh.js';

const log = createLogger('model-discovery:anthropic');

const VALID_EFFORTS: ReadonlySet<string> = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const HTTP_TIMEOUT_MS = 15_000;
/** /v1/models 游标分页的最大页数(现实模型数远小于单页 1000,纯防御)。 */
const MAX_MODEL_PAGES = 5;

/** 最近一次生效的发现结果(含缓存加载),合并时的能力字段保留源。 */
let lastApplied: CatalogModel[] = [];
/**
 * 能力字段由 HTTP / SDK 明确声明过的模型 id。effort / fastMode 必须分开记账,因为上游
 * 可能只返回其中一项；旧版缓存里的 low/medium/high 既可能是合成默认,也可能是上游实值,
 * 只看模型值无法安全判断。旧缓存没有来源字段时一律按非明确处理。
 */
const explicitEffortModelIds = new Set<string>();
const explicitFastModeModelIds = new Set<string>();
/** HTTP 明说过 max_input_tokens 的模型窗口(id → tokens);SDK 覆盖时优先于启发式规则。 */
const explicitWindows = new Map<string, number>();
/** 授权边界(登出 / 换号)自增:在途发现若世代已变,结果作废不写回。 */
let authGeneration = 0;
let httpRefreshInflight: Promise<void> | null = null;
/** 在途拉取所属的世代;世代已变时新调用不复用旧 promise(换号补拉不被吞)。 */
let httpRefreshInflightGen = -1;
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
  return generation === authGeneration && (models.length === 0 || hasClaudeAiOAuth());
}

/** 剥掉 dated wire id 的日期后缀(claude-opus-4-8-20260401 → claude-opus-4-8)。 */
function normalizeModelId(raw: string): string {
  return raw.replace(/-20\d{6}$/, '');
}

/** contextWindow 规则:HTTP 明示 > 目录已知值 > 未知模型启发式(默认 1M,Haiku 200k)。 */
function contextWindowFor(id: string, explicit?: number): number {
  if (typeof explicit === 'number' && explicit > 0) return explicit;
  const catalogWindow = getCindyModelContextWindow(id);
  if (catalogWindow !== null) return catalogWindow;
  return /haiku/.test(id) ? 200_000 : 1_000_000;
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

/** 连续多少次相同的 HTTP 骤减快照 = 确认为真实下架(收敛放行,防护栏永久卡死)。 */
const CONFIRMED_SHRINK_STREAK = 3;
/** 待确认骤减快照的签名(排序 id 集)与连续命中次数。 */
let httpShrinkSignature: string | null = null;
let httpShrinkStreak = 0;

function resetHttpShrinkStreak(): void {
  httpShrinkSignature = null;
  httpShrinkStreak = 0;
}

/**
 * 待确认骤减记账落盘(review P2 二轮:HTTP 刷新只在启动 / OAuth 登录各跑一次,
 * 记账若只在内存,用户每次重启 streak 都归零,3 次确认永远凑不齐)。写进现有磁盘
 * 缓存文件的 `pendingShrink` 字段(read-modify-write + 原子 rename,与其它缓存
 * 写删同队列串行);缓存文件不存在 = 无已确认清单,重启后护栏本就不触发,无需记账。
 */
function persistPendingShrink(): void {
  const state =
    httpShrinkSignature !== null ? { signature: httpShrinkSignature, streak: httpShrinkStreak } : null;
  const generation = authGeneration;
  void enqueueCacheMutation(async () => {
    if (generation !== authGeneration || !hasClaudeAiOAuth()) return;
    const file = cacheFilePath();
    let raw: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(await fsp.readFile(file, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>;
      }
    } catch {
      /* 缓存缺失 / 损坏:不为记账凭空造缓存 */
    }
    if (!raw) return;
    if (state) raw.pendingShrink = state;
    else if (raw.pendingShrink === undefined) return; // 无变化不写盘
    else delete raw.pendingShrink;
    const temp = `${file}.${process.pid}.${cacheTempSequence += 1}.tmp`;
    try {
      await fsp.writeFile(temp, JSON.stringify(raw, null, 2), 'utf-8');
      if (generation !== authGeneration || !hasClaudeAiOAuth()) return;
      await fsp.rename(temp, file);
    } finally {
      await fsp.rm(temp, { force: true }).catch(() => undefined);
    }
  });
}

/**
 * HTTP `/v1/models` 快照的骤减收敛记账(review P2:护栏不能把真实批量下架永久拦死):
 *   - 非骤减 → 直接放行并清零 streak;
 *   - 骤减 → 记签名(排序 id 集);**连续 CONFIRMED_SHRINK_STREAK 次相同**的骤减快照
 *     视为上游真实下架,放行收敛;签名变化(上游还在抖)则重新计数。
 * 记账随磁盘缓存持久化(persistPendingShrink):HTTP 刷新每进程只有启动 / 登录两个
 * 触发点,跨重启不累计的话收敛永远不会发生——重启后由 loadAnthropicModelsFromDiskCache
 * 恢复,登出 / 换号随缓存文件一起清除。
 * 只有 HTTP 通道参与收敛:它是 Anthropic 官方列模型端点,连续一致可作可用性证据;
 * SDK 捕获(本地 CLI 注册表,正是打塌事故的退化来源)永不收敛,等 HTTP 纠正。
 */
export function evaluateHttpShrink(prevCount: number, nextIds: readonly string[]): 'accept' | 'reject' {
  let verdict: 'accept' | 'reject';
  if (!isDegenerateModelListShrink(prevCount, nextIds.length)) {
    resetHttpShrinkStreak();
    verdict = 'accept';
  } else {
    const signature = [...nextIds].sort().join('\n');
    httpShrinkStreak = signature === httpShrinkSignature ? httpShrinkStreak + 1 : 1;
    httpShrinkSignature = signature;
    if (httpShrinkStreak >= CONFIRMED_SHRINK_STREAK) {
      resetHttpShrinkStreak();
      verdict = 'accept';
    } else {
      verdict = 'reject';
    }
  }
  persistPendingShrink();
  return verdict;
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
  const efforts: Effort[] = /haiku/.test(id)
    ? []
    : ['low', 'medium', 'high', 'xhigh', 'max'];
  return { efforts, defaultEffort: pickDefaultEffort(efforts) };
}

/**
 * SDK `supportedModels()` 条目 → 映射结果。纯函数。
 * 只收 `claude` 开头的显式版本 id(规则 10:禁止 opus/sonnet 裸别名进目录)。
 * ModelInfo 的能力字段全部 optional:字段在场时 SDK 是能力权威(supportsEffort=false =
 * 不可调);**字段缺席 = 该字段未知**,按 cindyModelMeta 基线 / 确定性默认合成,
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
    const id = normalizeModelId(e.value);
    if (!id.startsWith('claude') || seen.has(id)) continue;
    seen.add(id);
    const hasEffortInfo =
      e.supportsEffort !== undefined || e.supportedEffortLevels !== undefined;
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
      efforts = levels && levels.length > 0 ? levels : e.supportsEffort === true ? fallback.efforts : [];
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
        name: typeof e.displayName === 'string' && e.displayName.length > 0 ? e.displayName : id,
        group: 'anthropic',
        sortOrder: out.length,
        ...(typeof e.description === 'string' && e.description.length > 0
          ? { description: e.description }
          : {}),
        contextWindow: contextWindowFor(id),
        efforts,
        defaultEffort,
        supportsFastMode: e.supportsFastMode === true,
        status: 'active',
        // 旧产品目录刻意把 haiku 收起(defaultEnabled:false);默认可见性是客户端
        // 展示策略,不随清单动态化而漂移。
        ...(/haiku/.test(id) ? { defaultEnabled: false } : {}),
      },
    });
  }
  return out;
}

/** HTTP 映射结果:每项能力是响应明说的还是合成默认的(决定逐字段合并与来源记账)。 */
export interface HttpMappedModel {
  model: CatalogModel;
  hasEffortInfo: boolean;
  hasFastModeInfo: boolean;
  /** 响应明说的 max_input_tokens(null = 未下发,窗口来自启发式规则)。 */
  explicitContextWindow: number | null;
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
function mergeCapabilitiesWithPrevious(
  mapped: readonly CapabilityMappedModel[],
): {
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
        efforts: prev.efforts,
        defaultEffort: prev.defaultEffort,
      };
    }
    if (hasFastModeInfo) {
      nextExplicitFastMode.add(model.id);
    } else if (prev && explicitFastModeModelIds.has(model.id)) {
      nextExplicitFastMode.add(model.id);
      merged = { ...merged, supportsFastMode: prev.supportsFastMode };
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
 * HTTP `GET /v1/models` 单页条目数组 → 映射结果。纯函数,对响应形状容错:
 * 能力字段(capabilities.efforts / fast_mode)是 Anthropic 侧未固化的扩展,逐字段识别；
 * effort 认不出时按 cindyModelMeta 能力基线合成,目录也没有才回落当代旗舰 5 档
 * (low/medium/high/xhigh/max,默认 high),haiku 系例外 0 档。fastMode 未知时先为 false,
 * 合并阶段会保留已明确探测过的旧值。
 */
export function mapAnthropicHttpModels(raw: unknown): HttpMappedModel[] {
  if (!Array.isArray(raw)) return [];
  const out: HttpMappedModel[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as {
      id?: unknown;
      type?: unknown;
      display_name?: unknown;
      max_input_tokens?: unknown;
      capabilities?: unknown;
    };
    if (e.type !== undefined && e.type !== 'model') continue;
    if (typeof e.id !== 'string' || e.id.length === 0) continue;
    const id = normalizeModelId(e.id);
    // /v1/models 新发布在前;dated 变体剥后缀去重 first-wins = 保留最新。
    if (!id.startsWith('claude') || seen.has(id)) continue;
    seen.add(id);
    const caps =
      e.capabilities && typeof e.capabilities === 'object'
        ? (e.capabilities as { efforts?: unknown; effort_levels?: unknown; fast_mode?: unknown })
        : null;
    const capEfforts = caps ? (toEfforts(caps.efforts) ?? toEfforts(caps.effort_levels)) : null;
    const hasEffortInfo = capEfforts !== null;
    const hasFastModeInfo = typeof caps?.fast_mode === 'boolean';
    const fallback = fallbackEffortBaseline(id);
    const efforts: Effort[] = capEfforts ?? fallback.efforts;
    const defaultEffort = capEfforts !== null ? pickDefaultEffort(efforts) : fallback.defaultEffort;
    const maxInput =
      typeof e.max_input_tokens === 'number' && e.max_input_tokens > 0 ? e.max_input_tokens : null;
    out.push({
      hasEffortInfo,
      hasFastModeInfo,
      explicitContextWindow: maxInput,
      model: {
        id,
        name: typeof e.display_name === 'string' && e.display_name.length > 0 ? e.display_name : id,
        group: 'anthropic',
        sortOrder: out.length,
        contextWindow: contextWindowFor(id, maxInput ?? undefined),
        efforts,
        defaultEffort,
        supportsFastMode: caps?.fast_mode === true,
        status: 'active',
        ...(/haiku/.test(id) ? { defaultEnabled: false } : {}),
      },
    });
  }
  return out;
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
): Promise<void> {
  if (!generationCanApply(generation, models)) return;
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
  if (!modelsChanged && !capabilityProvenanceChanged) return;
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
        // 整份重写不得抹掉跨重启的待确认骤减记账(SDK 每会话都会持久化一次)。
        ...(httpShrinkSignature !== null
          ? { pendingShrink: { signature: httpShrinkSignature, streak: httpShrinkStreak } }
          : {}),
      },
      null,
      2,
    );
    await enqueueCacheMutation(async () => {
      if (!generationCanApply(generation, models)) return;
      const file = cacheFilePath();
      const temp = `${file}.${process.pid}.${cacheTempSequence += 1}.tmp`;
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
}

/**
 * 启动时加载磁盘缓存(上一次动态获取的成功结果)。未登录不加载(登出即清,
 * 残留缓存也不能代表可用性);缓存缺失 / 坏 JSON 静默跳过(等 HTTP / SDK 通道)。
 */
export async function loadAnthropicModelsFromDiskCache(): Promise<void> {
  if (!hasClaudeAiOAuth()) return;
  const generation = authGeneration;
  try {
    const raw: unknown = JSON.parse(await fsp.readFile(cacheFilePath(), 'utf-8'));
    if (generation !== authGeneration || !hasClaudeAiOAuth()) return;
    const models = (raw as { models?: unknown } | null)?.models;
    if (!Array.isArray(models) || models.length === 0) return;
    // 恢复「窗口来自 HTTP 明说」的记账,否则重启后首个 SDK 捕获会把精确窗口打回猜测值。
    const windows = (raw as { explicitWindows?: unknown }).explicitWindows;
    if (windows && typeof windows === 'object' && !Array.isArray(windows)) {
      for (const [id, win] of Object.entries(windows as Record<string, unknown>)) {
        if (typeof win === 'number' && win > 0) explicitWindows.set(id, win);
      }
    }
    // 恢复待确认骤减记账(跨重启累计,见 persistPendingShrink;坏字段静默忽略)。
    const pending = (raw as { pendingShrink?: unknown }).pendingShrink;
    if (pending && typeof pending === 'object' && !Array.isArray(pending)) {
      const p = pending as { signature?: unknown; streak?: unknown };
      if (
        typeof p.signature === 'string' &&
        p.signature.length > 0 &&
        typeof p.streak === 'number' &&
        Number.isInteger(p.streak) &&
        p.streak > 0
      ) {
        httpShrinkSignature = p.signature;
        httpShrinkStreak = Math.min(p.streak, CONFIRMED_SHRINK_STREAK);
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
    const validIds = new Set(valid.map((model) => model.id));
    const restoreIds = (value: unknown): Set<string> => {
      const restored = new Set<string>();
      if (Array.isArray(value)) {
        for (const id of value) {
          if (typeof id === 'string' && validIds.has(id)) restored.add(id);
        }
      }
      return restored;
    };
    // 旧的 explicitCapabilityModelIds 无法区分 effort / fastMode,刻意不恢复；
    // 把有歧义的整模型来源当作非明确,下一次 HTTP / SDK 会按逐字段证据重新记账。
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
    const normalized = valid.map((model) => {
      const effortBaseline = restoredExplicitEffortIds.has(model.id)
        ? null
        : fallbackEffortBaseline(model.id);
      return {
        ...model,
        contextWindow: contextWindowFor(model.id, explicitWindows.get(model.id)),
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
 * 按 id 合并:条目带能力信息则覆盖,否则保留已精化条目;HTTP 明说过的窗口不回退。
 */
export function noteAnthropicSdkSupportedModels(raw: unknown): void {
  if (!hasClaudeAiOAuth()) return;
  const generation = authGeneration;
  const mapped = mapAnthropicSdkModels(raw);
  if (mapped.length === 0) return;
  const mappedWithWindows = mapped.map(({ model, hasEffortInfo, hasFastModeInfo }) => {
    const explicit = explicitWindows.get(model.id);
    const base = explicit !== undefined ? { ...model, contextWindow: explicit } : model;
    return { model: base, hasEffortInfo, hasFastModeInfo };
  });
  const { models, explicitEffortIds, explicitFastModeIds } =
    mergeCapabilitiesWithPrevious(mappedWithWindows);
  // SDK 通道骤减恒拒绝其**存在性快照**、**不参与收敛**:持续一致的退化 SDK 快照正是
  // 打塌事故的形态,给 SDK 开 streak 收敛等于把事故门重新打开(真退化会一直一致,
  // streak 必然凑齐)。但 cc 当前可能只返回本会话模型这一条,其中明确携带的 capability
  // 仍是该模型的权威信息:保留完整清单,只把同 id 的 effort / fast 字段增量合入。
  // 否则 HTTP `/v1/models` 不带 capabilities 时会永久停在合成的 low/medium/high,
  // Fable / Opus 的 xhigh 永远无法进入 UI。
  // 真实批量下架的收敛只认 HTTP 权威通道(evaluateHttpShrink);为了不依赖「下次重启 /
  // 登录」才仲裁,这里在拒绝的同时主动触发一次 HTTP 刷新(单飞防抖):HTTP 可达时要么
  // 纠正要么推进收敛 streak;HTTP 持续不可达时保留陈旧超集(fail-visible:多出的条目
  // 发请求时报错,不会静默丢模型)——两难下的取舍,review P1 讨论定案。
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
          efforts: patch.model.efforts,
          defaultEffort: patch.model.defaultEffort,
        };
      }
      if (patch.hasFastModeInfo) {
        next = { ...next, supportsFastMode: patch.model.supportsFastMode };
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
      `anthropic SDK capture looks degenerate (${lastApplied.length} -> ${models.length}); keeping current list, merging ${capabilityPatches.size} capability patch(es), and consulting HTTP`,
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
    void refreshAnthropicModelsFromHttp().catch(() => undefined);
    return;
  }
  log.info(`anthropic models captured from SDK init: ${models.length}`);
  void applyModels(models, true, generation, explicitEffortIds, explicitFastModeIds).catch((err) => {
    log.warn('apply anthropic SDK models failed', { error: String(err) });
  });
}

/**
 * HTTP `/v1/models` 拉取(登录成功 / 启动时)。single-flight;失败只记日志、
 * 保留现值(缓存是上次成功的真数据);成功按合并纪律生效并持久化。
 */
export function refreshAnthropicModelsFromHttp(): Promise<void> {
  // 只复用**同世代**的在途拉取:登出后世代已变,旧 promise 的结果注定作废,
  // 复用会吞掉换号后新账号的补拉。
  if (httpRefreshInflight && httpRefreshInflightGen === authGeneration) return httpRefreshInflight;
  const gen = authGeneration;
  const flight = (async () => {
    const oauth = await getValidClaudeAiOAuth();
    if (!oauth?.accessToken) return;
    if (gen !== authGeneration || !hasClaudeAiOAuth()) return;
    const provider = getActiveCatalog().providers.find((p) => p.id === 'anthropic');
    const upstream = provider?.routing['claude-code']?.upstream ?? 'https://api.anthropic.com';
    const entries: unknown[] = [];
    let url: string | null = `${upstream.replace(/\/+$/, '')}/v1/models?limit=1000`;
    try {
      for (let page = 0; url && page < MAX_MODEL_PAGES; page += 1) {
        const res: Response = await fetch(url, {
          headers: {
            authorization: `Bearer ${oauth.accessToken}`,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'oauth-2025-04-20',
          },
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { data?: unknown[]; has_more?: boolean; last_id?: string };
        if (Array.isArray(body.data)) entries.push(...body.data);
        url =
          body.has_more && typeof body.last_id === 'string'
            ? `${upstream.replace(/\/+$/, '')}/v1/models?limit=1000&after_id=${encodeURIComponent(body.last_id)}`
            : null;
      }
    } catch (err) {
      // 失败不清列表:现值(含磁盘缓存)是上次成功的真数据;SDK 通道随后仍会精化。
      log.warn('anthropic /v1/models fetch failed; keeping current list', { error: String(err) });
      return;
    }
    // 在途期间登出 / 换号:结果作废,不写回、不重建缓存(review P1 竞态豁口)。
    if (gen !== authGeneration || !hasClaudeAiOAuth()) {
      log.info('anthropic /v1/models result discarded: auth changed mid-flight');
      return;
    }
    const mapped = mapAnthropicHttpModels(entries);
    if (mapped.length === 0) {
      log.warn('anthropic /v1/models returned no usable models; keeping current list');
      return;
    }
    // 退化判定必须先于任何状态写入:被拒快照连 explicitWindows 也不许污染,
    // 否则后续 SDK 捕获会把退化响应带来的窗口值用作精确记账(review P2)。
    // 连续多次相同的骤减快照经 evaluateHttpShrink 收敛放行(真实批量下架自愈)。
    if (evaluateHttpShrink(lastApplied.length, mapped.map((m) => m.model.id)) === 'reject') {
      log.warn(
        `anthropic /v1/models response looks degenerate (${lastApplied.length} -> ${mapped.length}); keeping current list (streak ${httpShrinkStreak}/${CONFIRMED_SHRINK_STREAK})`,
      );
      return;
    }
    for (const { model, explicitContextWindow } of mapped) {
      if (explicitContextWindow != null) explicitWindows.set(model.id, explicitContextWindow);
    }
    // HTTP 不带能力时只保留明确探测过的旧能力；旧版缓存 / 合成默认用当前目录基线刷新。
    const { models, explicitEffortIds, explicitFastModeIds } =
      mergeCapabilitiesWithPrevious(mapped);
    log.info(`anthropic models refreshed via HTTP: ${models.length}`);
    await applyModels(models, true, gen, explicitEffortIds, explicitFastModeIds);
  })().finally(() => {
    // 只清自己的登记:世代变化后可能已有新 flight 顶替,不能误清。
    if (httpRefreshInflight === flight) httpRefreshInflight = null;
  });
  httpRefreshInflight = flight;
  httpRefreshInflightGen = gen;
  return flight;
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
  resetHttpShrinkStreak();
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
  explicitWindows.clear();
  explicitEffortModelIds.clear();
  explicitFastModeModelIds.clear();
  resetHttpShrinkStreak();
  // 不回拨世代:即便测试误留异步任务,旧任务也不会重新获得生效资格。
  authGeneration += 1;
  httpRefreshInflight = null;
  httpRefreshInflightGen = -1;
}
