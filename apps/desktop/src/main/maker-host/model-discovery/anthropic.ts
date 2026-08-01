/**
 * model-discovery/anthropic —— Anthropic(Claude.ai 订阅)模型清单的动态发现。
 * ---------------------------------------------------------------------------
 * 2026-07-19 模型列表统一重构:anthropic 供应商的清单**唯一来源是动态发现**,
 * 产品目录静态段已退役(bundled 恒为空)。两条互补通道,汇入同一个 apply:
 *
 *   1. **HTTP `/v1/models`**(启动时 / 登录成功 / 本机凭证被认领给当前 owner /
 *      暂时性失败的有限次重试 / 用户在设置页手动重试):订阅 OAuth Bearer +
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

import type {
  CatalogModel,
  Effort,
  ProviderModelDiscoveryFailure,
} from '@cindy/model-providers';

import { createLogger } from '../../logger.js';
import {
  getActiveCatalog,
  getCindyModelContextWindow,
  getCindyModelEffortBaseline,
  setAnthropicDiscoveredModels,
} from '../active-catalog.js';
import { hasClaudeAiOAuth, readClaudeAiOAuth } from '../claude-credentials-store.js';
import { getValidClaudeAiOAuth } from '../claude-oauth-refresh.js';
import { outboundFetch } from '../outbound-fetch.js';

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
let httpRefreshInflight: Promise<boolean> | null = null;
/** 在途拉取所属的世代;世代已变时新调用不复用旧 promise(换号补拉不被吞)。 */
let httpRefreshInflightGen = -1;
/**
 * 最近一次发现失败的归因;成功即清空。
 *
 * 本供应商的清单没有静态兜底,拉不到就是零模型,所以失败必须如实记账、由 UI 讲明理由,
 * 而不是一直说「正在发现」。是否自动重试按归因分流(见 isRetryableFailure):暂时性故障
 * 悄悄重试几次,确定性拒绝(地域 / 凭证 / 请求被拒)一次都不重试 —— 那种情况重试只会
 * 把真正的原因藏起来。
 */
let lastFailure: ProviderModelDiscoveryFailure | null = null;
/**
 * 暂时性失败的重试节奏(ms)。刻意保持「简单、短」:目的是扛过链路抖动 / 上游瞬时 5xx,
 * 不是替代用户的判断 —— 一分钟内收敛不了就停手,把失败理由和重试入口交还给用户。
 */
const HTTP_RETRY_DELAYS_MS = [2_000, 8_000, 30_000] as const;
let httpRetryTimer: NodeJS.Timeout | null = null;
let httpRetryAttempt = 0;
/**
 * 失败态变化的收口(desktop host 注入 = 广播 PROVIDER_CHANGED)。
 *
 * 归因只活在本模块的内存里,不进 active-catalog —— 清单没变,catalog 也就没有 revision
 * 变化可言。但 renderer 早在拉取失败**之前**就取走了 provider 快照(15s 超时那条路径
 * 尤其明显),不主动通知的话它会一直显示「正在发现」,直到用户手动切页重取。
 */
let failureChangedListener: (() => void) | null = null;
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

/**
 * contextWindow 规则:HTTP 明示 > 目录已知值 > 未知模型启发式(默认 1M,Haiku 200k)。
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
 * 记账随磁盘缓存持久化(persistPendingShrink):HTTP 刷新的触发点稀疏(启动 / 登录 /
 * 绑定认领 / 手动重试,失败只在暂时性归因下自动重试有限次),跨重启不累计的话收敛永远
 * 不会发生——重启后由 loadAnthropicModelsFromDiskCache 恢复,登出 / 换号随缓存文件一起清除。
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
        ...contextWindowFor(id),
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
        ...contextWindowFor(id, maxInput ?? undefined),
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
  return generationCanApply(generation, models);
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
        // key 同样归一化:历史缓存可能以带 [1m] 后缀的脏 id 记账。归一化后撞 key 时
        // first-wins,与下方 models 去重同口径,避免拼出「窗口来自 A、能力来自 B」的杂交态。
        if (typeof win !== 'number' || win <= 0) continue;
        const normalizedId = normalizeModelId(id);
        if (!explicitWindows.has(normalizedId)) explicitWindows.set(normalizedId, win);
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
        // 签名按当前归一化口径重算(排序 id 集):历史签名可能含脏 id,口径漂移会让
        // 跨重启的骤减确认计数被无声重置。
        httpShrinkSignature = [...new Set(p.signature.split('\n').map(normalizeModelId))]
          .sort()
          .join('\n');
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
      return {
        ...rest,
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
 * 按 id 合并:条目带能力信息则覆盖,否则保留已精化条目;HTTP 明说过的窗口不回退。
 */
export function noteAnthropicSdkSupportedModels(raw: unknown): void {
  if (!hasClaudeAiOAuth()) return;
  const generation = authGeneration;
  const mapped = mapAnthropicSdkModels(raw);
  if (mapped.length === 0) return;
  const mappedWithWindows = mapped.map(({ model, hasEffortInfo, hasFastModeInfo }) => {
    const explicit = explicitWindows.get(model.id);
    // explicitWindows 存的是 HTTP 明说过的 max_input_tokens —— 恢复它时必须连
    // contextWindowVerified 一起恢复。SDK 通道重新映射同一模型时走的是「无 explicit」
    // 分支(目录里没有该模型就落到启发式、不带标记), 只覆盖 contextWindow 会把这份
    // provenance 静默擦掉, 之后就不再拿这个真实上限去收敛虚高的上报值了。
    const base =
      explicit !== undefined
        ? { ...model, contextWindow: explicit, contextWindowVerified: true as const }
        : model;
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

/** 非 2xx 响应:带上状态码与响应体片段抛出 —— 地域拒绝只能从响应体认出来。 */
class DiscoveryHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`HTTP ${status}`);
    this.name = 'DiscoveryHttpError';
  }
}

/** 响应体只留够判定与诊断的前缀,避免把上游的大 HTML 错误页整个搬进日志。 */
const ERROR_BODY_SNIPPET_LIMIT = 2_000;

/**
 * HTTP 200 但正文不可用 —— 解析不了,或解析出来根本不是 /v1/models 的形状。
 * 都是上游 / 中间层的问题,与链路不通要分开归因(且属于可重试类)。
 */
class DiscoveryResponseError extends Error {
  constructor(detail: string) {
    super(`malformed response body: ${detail}`);
    this.name = 'DiscoveryResponseError';
  }
}

/**
 * 地域拒绝的识别标记。Anthropic 对不支持的国家 / 地区返回
 * `unsupported_country_region_territory`,**400 与 403 都出现过**(取决于是否经中间层),
 * 所以只看状态码不够 —— 必须认响应体。同为 403 的
 * `{"error":{"type":"forbidden","message":"Request not allowed"}}` 是另一回事
 * (Cloudflare 对代理 / VPN 出口的拦截),两者对用户的下一步完全不同。
 */
const REGION_BLOCK_MARKERS = [
  'unsupported_country_region_territory',
  'unsupported countries, regions, or territories',
] as const;

function looksRegionBlocked(status: number, body: string): boolean {
  if (status !== 400 && status !== 403) return false;
  const lower = body.toLowerCase();
  return REGION_BLOCK_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * fetch / HTTP 错误 → 用户能理解的归因。
 *
 * undici 在 DNS 失败、连接被拒、TLS 失败时统一抛 `TypeError: fetch failed`,真正的
 * errno 藏在 `cause.code` —— 链路不通时最常见的形态,必须挖出来才能区分「连不上」
 * 和「连上了但超时」。detail 只进日志与诊断,不直接展示给用户。
 */
function classifyDiscoveryError(err: unknown): {
  kind: ProviderModelDiscoveryFailure['kind'];
  detail: string;
} {
  // 200 + 坏正文:上游侧问题,归 upstream(可重试),不是「连不上」。
  if (err instanceof DiscoveryResponseError) return { kind: 'upstream', detail: err.message };
  if (err instanceof DiscoveryHttpError) {
    const detail = err.body ? `HTTP ${err.status}: ${err.body}` : `HTTP ${err.status}`;
    if (looksRegionBlocked(err.status, err.body)) return { kind: 'regionBlocked', detail };
    if (err.status === 401) return { kind: 'unauthorized', detail };
    if (err.status === 403) return { kind: 'forbidden', detail };
    // 408 Request Timeout 是上游 / 中间代理说「这次超时了」—— 与本地超时同源的一过性状况,
    // 归 timeout 走重试;落到 rejected 会让空清单的用户被迫手动重试(PR #548 review)。
    if (err.status === 408) return { kind: 'timeout', detail };
    // 5xx / 429 是服务端侧故障,可能几秒后就好;其它 4xx 是我们这边请求本身被拒。
    if (err.status >= 500 || err.status === 429) return { kind: 'upstream', detail };
    return { kind: 'rejected', detail };
  }
  const base = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return { kind: 'timeout', detail: base };
  }
  const cause = err instanceof Error ? (err.cause as { code?: unknown } | undefined) : undefined;
  const code = typeof cause?.code === 'string' ? cause.code : undefined;
  const detail = code ? `${base} (${code})` : base;
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return { kind: 'timeout', detail };
  }
  return { kind: 'network', detail };
}

/**
 * 该归因值不值得自动重试。
 *
 * 分界是「这次失败是否可能只是暂时的」:链路不通 / 超时 / 上游 5xx 有可能几秒后自愈,
 * 值得替用户悄悄再试几次;而地域拒绝、凭证被拒、请求被拒、空清单都是**确定性**答复
 * —— 同一个请求再发一百次也是同一个结果,重试只会把「被拒绝」拖成「一直在发现中」,
 * 把真正的原因藏起来。
 */
function isRetryableFailure(kind: ProviderModelDiscoveryFailure['kind']): boolean {
  return kind === 'network' || kind === 'timeout' || kind === 'upstream';
}

/** 取消待执行的重试并清零退避计数(成功 / 授权边界 / 确定性失败 / 测试重置)。 */
function cancelHttpRetry(): void {
  if (httpRetryTimer) {
    clearTimeout(httpRetryTimer);
    httpRetryTimer = null;
  }
  httpRetryAttempt = 0;
}

/**
 * 安排下一次重试。已有待执行的重试不重复排;退避次数用尽就停手(等下一次启动、显式
 * 登录、绑定认领或用户手动重试)。世代变化后回调直接放弃 —— 登出 / 换号的在途结果本就
 * 作废。timer 不持有事件循环(unref),不拖慢退出。
 */
function scheduleHttpRetry(generation: number): void {
  if (httpRetryTimer) return;
  if (generation !== authGeneration) return;
  const delay = HTTP_RETRY_DELAYS_MS[httpRetryAttempt];
  if (delay === undefined) return;
  httpRetryAttempt += 1;
  const attempt = httpRetryAttempt;
  const timer = setTimeout(() => {
    httpRetryTimer = null;
    if (generation !== authGeneration || !hasClaudeAiOAuth()) return;
    // fromRetry:这是退避链自身的下一档,不是新一轮 —— 不能重置计数,否则会无限轮询。
    void refreshAnthropicModelsFromHttp({ fromRetry: true }).catch(() => undefined);
  }, delay);
  timer.unref?.();
  httpRetryTimer = timer;
  log.info(
    `anthropic /v1/models retry scheduled in ${delay}ms (attempt ${attempt}/${HTTP_RETRY_DELAYS_MS.length})`,
  );
}

/**
 * 记一次发现失败并按归因决定要不要自动重试;世代已变(登出 / 换号)的结果不写回。
 *
 * 确定性拒绝会**主动取消**待执行的重试并清零退避:上一轮可能因为链路抖动排了重试,
 * 这一轮上游明确答了「不允许」—— 继续按旧节奏重试既无意义,也会让失败理由在
 * 「发现中」和「被拒绝」之间来回跳。
 */
function noteDiscoveryFailure(
  generation: number,
  kind: ProviderModelDiscoveryFailure['kind'],
  detail?: string,
): void {
  if (generation !== authGeneration) return;
  lastFailure = {
    kind,
    at: new Date().toISOString(),
    ...(detail ? { detail } : {}),
  };
  log.warn(`anthropic model discovery failed (${kind})`, { detail });
  notifyFailureChanged();
  if (isRetryableFailure(kind)) {
    scheduleHttpRetry(generation);
    return;
  }
  cancelHttpRetry();
}

/**
 * 清掉失败态与待执行的重试 —— 用于「上游已经答了、且用户手里确有可用清单」的所有出口,
 * 不只是清单被成功替换的那一条。
 *
 * 失败态**由有变无也要通知**:applyModels 只在清单真的变了时才 markChanged 广播,而
 * 「上次失败、这次成功且清单与上次一致」正好落在它的 early return 里;快照被 shrink 守卫
 * 拒绝时更是连 applyModels 都不会走到。不在这里通知,UI 会继续显示已经不成立的失败理由。
 */
function clearDiscoveryFailure(): void {
  const hadFailure = lastFailure !== null;
  lastFailure = null;
  cancelHttpRetry();
  if (hadFailure) notifyFailureChanged();
}

/**
 * 注册失败态变化的收口(desktop host 装配时接广播;传 null 解绑)。监听器不可抛 ——
 * 广播失败不该反过来打断发现流程。
 */
export function setAnthropicDiscoveryFailureListener(listener: (() => void) | null): void {
  failureChangedListener = listener;
}

function notifyFailureChanged(): void {
  try {
    failureChangedListener?.();
  } catch (err) {
    log.warn('anthropic discovery failure broadcast failed', { error: String(err) });
  }
}

/**
 * 最近一次清单发现失败(供 listProviders 合成 ProviderView)。
 *
 * 未登录时一律返回 null:没有授权就谈不上「发现失败」,那种状态下 UI 该讲的是「去连接」,
 * 而不是把上一个账号留下的失败理由摆给新用户看。
 *
 * `knownConnected` 让调用方交出同一次快照里**已经算好**的连接态。macOS 上 hasClaudeAiOAuth()
 * 会同步 `execFileSync('security', ...)` 读一次 Keychain —— listProviders 先在 connection 回调
 * 里读过一遍,这里再读一遍就是白白让 Electron 主线程多阻塞一个子进程,而供应商列表还会随
 * PROVIDER_CHANGED 反复重取(PR #548 review)。
 */
export function getAnthropicModelDiscoveryFailure(
  knownConnected?: boolean,
): ProviderModelDiscoveryFailure | null {
  const connected = knownConnected ?? hasClaudeAiOAuth();
  if (!connected) return null;
  return lastFailure;
}

/**
 * HTTP `/v1/models` 拉取(启动时 / 登录成功 / 绑定认领成功 / 用户手动重试 / 自动重试)。
 * single-flight;失败记日志 + 记账归因、保留现值(缓存是上次成功的真数据),并按归因决定
 * 要不要自动重试(暂时性故障重试有限次,确定性拒绝一次都不重试,见 isRetryableFailure);
 * 成功按合并纪律生效并持久化。
 *
 * `fromRetry` 仅由退避回调传入。**外部触发一律开启新一轮退避**:否则上一轮把三档用尽后
 * `httpRetryAttempt` 停在上限,此后用户手动点「重试」或新的凭证认领再次触发发现时,这次
 * 若又遇到暂时性失败就再也排不出自动重试 —— 链路稍后恢复也只能靠用户反复手点(PR #548
 * review)。
 */
export function refreshAnthropicModelsFromHttp(options?: {
  fromRetry?: boolean;
  /** 内部用:本次已经是「401 → 强制换 token」后的那一次,不再递归换第二次。 */
  afterForcedRefresh?: boolean;
}): Promise<boolean> {
  if (!options?.fromRetry) cancelHttpRetry();
  // 只复用**同世代**的在途拉取:登出后世代已变,旧 promise 的结果注定作废,
  // 复用会吞掉换号后新账号的补拉。
  if (httpRefreshInflight && httpRefreshInflightGen === authGeneration) return httpRefreshInflight;
  const gen = authGeneration;
  const flight = (async () => {
    const oauth = await getValidClaudeAiOAuth();
    if (!oauth?.accessToken) return false;
    if (gen !== authGeneration || !hasClaudeAiOAuth()) return false;
    const provider = getActiveCatalog().providers.find((p) => p.id === 'anthropic');
    const upstream = provider?.routing['claude-code']?.upstream ?? 'https://api.anthropic.com';
    const entries: unknown[] = [];
    let url: string | null = `${upstream.replace(/\/+$/, '')}/v1/models?limit=1000`;
    try {
      for (let page = 0; url && page < MAX_MODEL_PAGES; page += 1) {
        const res: Response = await outboundFetch(url, {
          headers: {
            authorization: `Bearer ${oauth.accessToken}`,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'oauth-2025-04-20',
          },
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
        if (!res.ok) {
          // 读响应体:地域拒绝与 Cloudflare 拦截同为 403,只有正文能把两者分开。
          const body = await res.text().catch(() => '');
          throw new DiscoveryHttpError(res.status, body.slice(0, ERROR_BODY_SNIPPET_LIMIT));
        }
        // 200 但正文坏掉(破损代理 / CDN 截断)是**上游**的问题,不是链路不通 —— 单独标记,
        // 否则会归到 network,让用户白查网络和 Proxy(PR #548 review)。
        let raw: unknown;
        try {
          raw = await res.json();
        } catch (parseErr) {
          throw new DiscoveryResponseError(
            parseErr instanceof Error ? parseErr.message : String(parseErr),
          );
        }
        // 先确认根是对象:JSON `null` / 标量 / 数组都是合法 JSON,直接取 .data 要么抛
        // TypeError(落到兜底被当成 network,让用户白查网络)、要么静默拿到 undefined。
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          throw new DiscoveryResponseError(
            `unexpected payload root (${raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw})`,
          );
        }
        // 再确认 data 是数组 = 拿到的确实是 /v1/models 的形状(典型反例:代理生成的
        // {"error":...} 却带 200)。静默跳过会一路走到「empty」——确定性归因、不重试,
        // 还会把上游故障说成用户的权限问题。
        const body = raw as { data?: unknown; has_more?: unknown; last_id?: unknown };
        if (!Array.isArray(body.data)) {
          throw new DiscoveryResponseError(
            `unexpected payload shape (data=${body.data === undefined ? 'missing' : typeof body.data})`,
          );
        }
        entries.push(...body.data);
        // has_more=true 却没给可用游标 —— 静默收尾会把「只翻了一页的前缀」当成完整清单交出去,
        // 而它完全可能小到刚好落进 shrink 守卫的放行区间,于是真清单被截断替换、失败态被清、
        // 也不排重试,用户从此少一半模型且毫无提示(PR #548 review)。这是响应本身不完整,归
        // upstream 让它重试。
        if (body.has_more === true) {
          if (typeof body.last_id !== 'string' || body.last_id.length === 0) {
            throw new DiscoveryResponseError(
              `has_more=true without a usable last_id cursor (got ${
                body.last_id === undefined ? 'missing' : typeof body.last_id
              })`,
            );
          }
          url = `${upstream.replace(/\/+$/, '')}/v1/models?limit=1000&after_id=${encodeURIComponent(body.last_id)}`;
        } else {
          url = null;
        }
      }
    } catch (err) {
      // 失败不清列表:现值(含磁盘缓存)是上次成功的真数据;SDK 通道随后仍会精化。
      const { kind, detail } = classifyDiscoveryError(err);
      // 401 先别急着判「确定性拒绝」:本地 expiresAt 未到时 getValidClaudeAiOAuth 会原样
      // 返回旧 token,而服务端可能已经拒绝它。refresh token 还有效的话,强制换一枚再试
      // 一次就能恢复 —— 否则用户明明只需静默续期,却被告知要断开重连,而且清单为空时他
      // 连个能用的模型都挑不出来(PR #548 review;运行时 401 回调走的也是这条路)。
      if (kind === 'unauthorized' && !options?.afterForcedRefresh) {
        let refreshError: unknown = null;
        const refreshed = await getValidClaudeAiOAuth({
          forceRefresh: true,
          staleToken: oauth.accessToken,
        }).catch((err: unknown) => {
          refreshError = err;
          return null;
        });
        if (
          refreshed?.accessToken &&
          refreshed.accessToken !== oauth.accessToken &&
          gen === authGeneration &&
          hasClaudeAiOAuth()
        ) {
          httpRefreshInflight = null;
          log.info('anthropic /v1/models got 401; retrying once with a force-refreshed token');
          return refreshAnthropicModelsFromHttp({
            fromRetry: options?.fromRetry ?? false,
            afterForcedRefresh: true,
          });
        }
        // 走到这里 = 没换到新 token,但原因有两种,归因不同:
        //
        //   · 刷新**交出了** token,只是和旧的那枚一样 —— 刷新链路本身是通的,服务端认为
        //     当前 token 就是最新的,而它确实被 401 了。这是真的授权问题。
        //   · 刷新**一枚都没交出**(返回 null 或抛错)—— 是这一步自己没成:token 端点超时 /
        //     5xx / 没抢到刷新锁。归 unauthorized 会取消全部重试、还叫用户去断开重连,可
        //     refresh token 很可能完全有效,过一会儿再刷就成了(PR #548 review)。
        //
        // 第二种还要再确认凭证现状才算数:真的授权失效时,invalid_grant 收尾已经把凭证清了
        // (setClaudeOAuthInvalidGrantHandler → invalidate),或者它本来就没有 refresh token
        // 可用 —— 那两种同样是 unauthorized。凭证还在、也还能刷,才是暂时性故障。
        if (refreshed == null) {
          const credential = readClaudeAiOAuth();
          const stillRefreshable = typeof credential?.refreshToken === 'string' && credential.refreshToken.length > 0;
          if (refreshError !== null || stillRefreshable) {
            noteDiscoveryFailure(
              gen,
              'upstream',
              `401 then forced token refresh yielded nothing${
                refreshError instanceof Error ? `: ${refreshError.message}` : ' (transient)'
              }`,
            );
            return false;
          }
        }
      }
      noteDiscoveryFailure(gen, kind, detail);
      return false;
    }
    // 在途期间登出 / 换号:结果作废,不写回、不重建缓存(review P1 竞态豁口)。
    if (gen !== authGeneration || !hasClaudeAiOAuth()) {
      log.info('anthropic /v1/models result discarded: auth changed mid-flight');
      return false;
    }
    const mapped = mapAnthropicHttpModels(entries);
    if (mapped.length === 0) {
      // 上游答了但一个可用模型都没有 —— 清单没有静态兜底,停在空清单等于供应商不可用,
      // 同样记账为失败,不让 UI 停在「正在发现」。
      //
      // 但要分清是哪一种「没有」:data 本来就是空数组 = 这个账号确实没有可用模型,是确定性
      // 事实,该按 empty 停下不重试;data 非空却一条都映射不出来 = 响应字段缺失或上游改版,
      // 那是上游故障,归 empty 会既取消重试、又叫用户去查账号权限(PR #548 review)。
      if (entries.length > 0) {
        noteDiscoveryFailure(
          gen,
          'upstream',
          `payload listed ${entries.length} entries but none mapped to a usable model`,
        );
        return false;
      }
      noteDiscoveryFailure(gen, 'empty');
      return false;
    }
    // 退化判定必须先于任何状态写入:被拒快照连 explicitWindows 也不许污染,
    // 否则后续 SDK 捕获会把退化响应带来的窗口值用作精确记账(review P2)。
    // 连续多次相同的骤减快照经 evaluateHttpShrink 收敛放行(真实批量下架自愈)。
    if (evaluateHttpShrink(lastApplied.length, mapped.map((m) => m.model.id)) === 'reject') {
      log.warn(
        `anthropic /v1/models response looks degenerate (${lastApplied.length} -> ${mapped.length}); keeping current list (streak ${httpShrinkStreak}/${CONFIRMED_SHRINK_STREAK})`,
      );
      // 快照被拒 ≠ 发现失败:上游确确实实答了,而且旧清单原样留用 —— 此刻供应商对用户是可用的。
      // 若还挂着上一次的 network / timeout 理由,UI 就会对着一个有模型可选的供应商说「连不上」;
      // 而这条早退路径既不记新失败也不排重试,那个过期理由会一直挂到下次成功发现(PR #548 review)。
      clearDiscoveryFailure();
      return false;
    }
    for (const { model, explicitContextWindow } of mapped) {
      if (explicitContextWindow != null) explicitWindows.set(model.id, explicitContextWindow);
    }
    // HTTP 不带能力时只保留明确探测过的旧能力；旧版缓存 / 合成默认用当前目录基线刷新。
    const { models, explicitEffortIds, explicitFastModeIds } =
      mergeCapabilitiesWithPrevious(mapped);
    log.info(`anthropic models refreshed via HTTP: ${models.length}`);
    // 拿到有效清单 = 发现已恢复,清掉失败态与待执行的重试(放在 apply 之前:apply 只负责
    // 生效,它因世代变化被 gate 掉时新世代会带着自己的触发重来)。
    clearDiscoveryFailure();
    return applyModels(models, true, gen, explicitEffortIds, explicitFastModeIds);
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
  // 失败态与待执行的重试都属于旧世代的账:登出 / 换号后既不能把上一个账号的失败理由
  // 摆给新账号看,也不该让旧世代排的重试继续跑(回调自带世代校验,这里再显式取消)。
  const hadFailure = lastFailure !== null;
  lastFailure = null;
  cancelHttpRetry();
  explicitWindows.clear();
  explicitEffortModelIds.clear();
  explicitFastModeModelIds.clear();
  resetHttpShrinkStreak();
  await applyModels([], false, generation);
  // 首次发现就失败时 lastApplied 本来就是空,applyModels([]) 会走「清单没变」早退、不广播。
  // 本地窗口碰巧还能靠 auth 事件刷新,但那个事件不过 device-link —— 配对的手机 / 控制端会
  // 一直留着旧的失败理由。失败态由有变无时补一次通知,让两边都收敛(PR #548 review)。
  if (hadFailure) notifyFailureChanged();
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
  lastFailure = null;
  cancelHttpRetry();
  // 不回拨世代:即便测试误留异步任务,旧任务也不会重新获得生效资格。
  authGeneration += 1;
  httpRefreshInflight = null;
  httpRefreshInflightGen = -1;
}
