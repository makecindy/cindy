/**
 * vision-bridge —— 视觉桥钩子实现（层 B）。
 *
 * 装配成 maker-core 的 VisionBridgeHook，注入 Session 后，用户贴图在交给 agent 前
 * 被转成文字描述（用配置的主/fallback 视觉后端）。
 *
 * 对齐 docs/vision-bridge-design.md 层 B + 五、视觉通道：
 *  - 判定：总开关 + 当前模型 ∈ targetModels（用户显式多选）；
 *  - 命中后把 user 消息里的 image block 替换为描述 text block（前置来源标注），
 *    纯文本模型直接可用，不依赖层 A；层 A 对纯文本请求自然 no-op；
 *  - 主后端失败 → fallback；都挂 → 图片替换为「不可用」占位文本 + note 提示（不留
 *    原始 image block，否则层 A 会对同一失败后端二次调用，加倍延迟），绝不阻塞；
 *  - 进程内缓存 sha256(imagePath+prompt) → 描述，LRU 128，同图同 hint 零重复调用。
 */
import { createHash } from 'node:crypto';

import type { UserContentBlock, UserMessage } from '@cindy/maker-core';
import type { VisionBridgeHook, VisionBridgeResult } from '@cindy/maker-core';

import { isKnownNoVisionModel, normalizeVisionModelId } from '@cindy/model-providers';

import {
  isTargetModelsCustomized,
  readVisionBridgeSettings,
} from './vision-bridge-settings-store.js';
import {
  describeImageWithProvider,
  resolveVisionBackendEndpoint,
  VisionBackendError,
  type VisionChannelDeps,
} from './vision-channel.js';

interface LoggerLike {
  info?(msg: string, meta?: Record<string, unknown>): void;
  warn?(msg: string, meta?: Record<string, unknown>): void;
  debug?(msg: string, meta?: Record<string, unknown>): void;
}

/** 视觉桥依赖：视觉通道 deps + 配置 + 提示回调。 */
export interface VisionBridgeDeps extends VisionChannelDeps {
  logger?: LoggerLike;
  /** 视觉桥不可用 / fallback 生效时的提示回调（host 可据此发 UI 事件）。sessionId 由 hook ctx 传入。
   *  kind 是结构化原因（'unavailable' | 'fallback'），host 据此分流，不做字符串匹配。 */
  onNote?: (note: string, sessionId: string, kind: 'unavailable' | 'fallback') => void;
  /** 视觉桥开始描述图片时的提示回调（host 可据此发「正在识别图片中」UI 事件）。sessionId 由 hook ctx 传入。 */
  onStart?: (sessionId: string, imageCount: number) => void;
  /** 缓存上限。缺省 128。 */
  cacheLimit?: number;
}

const DESCRIPTION_PREFIX = '[用户贴了一张图片，已由外部多模态模型转成文字描述：]\n\n';

/** 失败图独立占位：不套「已转成文字描述」前缀（语义矛盾），直接声明不可用、约束不猜测。 */
const IMAGE_UNAVAILABLE_TEXT =
  '[Image unavailable / 图片不可用: the vision bridge could not convert this image to text. ' +
  'Do not infer visual details; tell the user the image could not be inspected. / ' +
  '视觉桥未能将这张图片转成文字描述。不要推测图片内容；请告知用户无法查看这张图片。]';

/** 进程内描述缓存。key 含实际命中的后端 (providerId, modelId)，换后端/换描述模型即换 key。 */
interface CacheEntry {
  value: string;
  order: number;
}
type DescCache = Map<string, CacheEntry>;

function cacheKey(imageSource: string, prompt: string, backendRef: { providerId: string; modelId: string }): string {
  return createHash('sha256')
    .update(imageSource)
    .update('\x00')
    .update(prompt)
    .update('\x00')
    .update(backendRef.providerId)
    .update('/')
    .update(backendRef.modelId)
    .digest('hex');
}

/** 从 user 消息抽图片 block（保留原引用位置索引）。畸形 content（null/object/number）安全返回空。 */
function imageBlocks(content: UserMessage['content']): Array<{ idx: number; path: string }> {
  if (typeof content === 'string' || !Array.isArray(content)) return [];
  const out: Array<{ idx: number; path: string }> = [];
  content.forEach((block, idx) => {
    // SSH 远程会话的图片路径属于远端主机，本地 fs 不能读——读本地同名文件会泄漏
    // 或误替换为不可用占位。只有 pathOrigin === 'desktop-host' 的图片才可本地读。
    if (block.type === 'image' && block.pathOrigin === 'desktop-host') {
      out.push({ idx, path: block.path });
    }
  });
  return out;
}

/** 把 image block 替换为描述 text block，并附加来源标注。失败图（alreadyAnnotated）不再套前缀。 */
function buildBridgedMessage(
  msg: UserMessage,
  descriptions: Array<{ idx: number; text: string; alreadyAnnotated?: boolean }>,
): UserMessage {
  if (typeof msg.content === 'string' || !Array.isArray(msg.content)) return msg;
  const nextContent: UserContentBlock[] = msg.content.map((block) => ({ ...block }));
  for (const d of descriptions) {
    nextContent[d.idx] = {
      type: 'text',
      text: d.alreadyAnnotated ? d.text : DESCRIPTION_PREFIX + d.text,
    };
  }
  return { ...msg, content: nextContent };
}

export function createVisionBridge(deps: VisionBridgeDeps): {
  hook: VisionBridgeHook;
  /** 判定某 model 是否启用视觉桥（层 A proxy transform 复用）。 */
  isTargetModel: (model: string) => boolean;
  /** 描述一张图（层 A proxy transform / ghost 工具结果描述复用，imageUrl 或 imagePath 形态）。 */
  describeImage: (input: {
    imageUrl?: string;
    imagePath?: string;
    prompt: string;
    signal?: AbortSignal;
  }) => Promise<string>;
  dispose: () => void;
} {
  const logger = deps.logger;
  const cache: DescCache = new Map();
  const cacheLimit = deps.cacheLimit ?? 128;
  let order = 0;
  /** in-flight 去重：同 key（图+prompt+后端）进行中的描述请求合并，防 thundering herd。 */
  const inFlight = new Map<string, Promise<{ text: string; usedFallback: boolean }>>();
  /** dispose 后置 true：跑着的 in-flight 请求 resolve 后不再回填 cache（生命周期硬封口）。 */
  let disposed = false;

  function cacheGet(key: string): string | null {
    const entry = cache.get(key);
    if (!entry) return null;
    // 命中即 touch order（真正 LRU，热条目不被误淘汰）。
    entry.order = order++;
    return entry.value;
  }
  function cacheSet(key: string, value: string): void {
    // 已有 key 直接更新（不淘汰）：同 key 并发 miss 后第二次 cacheSet 不应再淘汰
    // 一个无关旧条目（满缓存时会让 LRU 行为不严格、缓存命中率下降）。
    if (cache.has(key)) {
      cache.set(key, { value, order: order++ });
      return;
    }
    if (cache.size >= cacheLimit) {
      // LRU 淘汰 order 最小（最近最久未用）项。
      let oldestKey: string | null = null;
      let oldestOrder = Number.POSITIVE_INFINITY;
      for (const [k, e] of cache) {
        if (e.order < oldestOrder) {
          oldestOrder = e.order;
          oldestKey = k;
        }
      }
      if (oldestKey !== null) cache.delete(oldestKey);
    }
    cache.set(key, { value, order: order++ });
  }

  /** 判定某 model 是否启用视觉桥（总开关 + 目标模型命中）。层 B 与层 A 共用。 */
  function isTargetModel(model: string): boolean {
    const settings = readVisionBridgeSettings();
    if (!settings.enabled) {
      logger?.debug?.('vision bridge: target check -> disabled', { model });
      return false;
    }
    // 显式命中：运行时 model 可能带 [1m]/codex//bare 变体，targetModels 存的是 catalog id；
    // 两边都归一化后再比对，避免勾选命中失败（如 deepseek/deepseek-v4-flash vs ...[1m]）。
    const normalizedModel = normalizeVisionModelId(model);
    if (settings.targetModels.some((id) => normalizeVisionModelId(id) === normalizedModel)) {
      logger?.debug?.('vision bridge: target check -> explicit hit', { model, normalizedModel, targetModels: settings.targetModels });
      return true;
    }
    // 默认合并：用户未显式自定义 targetModels 时，已知无视觉模型（deepseek 等）默认
    // 走视觉桥——对齐设计文档「no-vision 默认勾选」。用户显式保存过 targetModels 后，
    // 按用户勾选（可显式取消 no-vision）。
    const customized = isTargetModelsCustomized();
    const knownNoVision = isKnownNoVisionModel(model);
    if (!customized && knownNoVision) {
      logger?.debug?.('vision bridge: target check -> default no-vision hit', { model, normalizedModel });
      return true;
    }
    logger?.debug?.('vision bridge: target check -> miss', { model, normalizedModel, customized, knownNoVision });
    return false;
  }

  /** 提取错误 message 用于内部诊断日志（不直接进用户可见 note）。 */
  function reasonOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  /** 取 VisionBackendError 的细分错误码（非后端错误返回 undefined），供日志关联。 */
  function errorCodeOf(err: unknown): string | undefined {
    return err instanceof VisionBackendError ? err.code : undefined;
  }

  /**
   * 解析某后端的实际出站信息（resolved model / wire 协议 / 请求路径），供失败日志关联。
   * 纯内存解析（复用 resolveVisionBackendEndpoint，不触发网络）；解析失败时返回空对象——
   * 日志仍是 configured backendModelId 兜底。
   */
  function routeInfoOf(providerId: string, modelId: string): { resolvedModel?: string; wireProtocol?: string; requestPath?: string } {
    try {
      const ep = resolveVisionBackendEndpoint(providerId, modelId, deps);
      return { resolvedModel: ep.model, wireProtocol: ep.wireProtocol, requestPath: ep.requestPath };
    } catch {
      return {};
    }
  }

  /**
   * 等待共享 in-flight flight（并发同 key 去重的等待方）。
   * 等待方不继承发起方的 signal：被取消时应立即以 abort 失败返回，而不是干等发起方跑完
   * （并发同 key 时第二个请求即使已 Stop/取消，也能及时退出）。flight settle 时移除 abort
   * 监听，避免 race 后无人消费的 unhandled rejection。无 signal 时直接返回原 flight。
   */
  function awaitSharedFlight(
    flight: Promise<{ text: string; usedFallback: boolean }>,
    signal?: AbortSignal,
  ): Promise<{ text: string; usedFallback: boolean }> {
    if (!signal) return flight;
    return new Promise<{ text: string; usedFallback: boolean }>((resolve, reject) => {
      const onAbort = () => reject(new VisionBackendError('abort', 'vision request cancelled'));
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      flight.then(
        (v) => {
          signal.removeEventListener('abort', onAbort);
          resolve(v);
        },
        (e) => {
          signal.removeEventListener('abort', onAbort);
          reject(e);
        },
      );
    });
  }

  /** 描述一张图（主/fallback + 缓存）。供层 B（imagePath）与层 A（imageUrl）共用。 */
  async function describeWithFallback(
    input: { imagePath?: string; imageUrl?: string },
    prompt: string,
    signal?: AbortSignal,
    runtimeModel?: string,
  ): Promise<{ text: string; usedFallback: boolean }> {
    if (disposed) {
      throw new VisionBackendError('unavailable', 'vision bridge disposed');
    }
    const settings = readVisionBridgeSettings();
    const primary = settings.primary;
    if (!primary) {
      throw new VisionBackendError('unavailable', 'vision bridge has no primary backend configured');
    }
    const imageSource = input.imagePath ?? input.imageUrl ?? '';
    const ck = cacheKey(imageSource, prompt, primary);
    const cached = cacheGet(ck);
    if (cached !== null) {
      // 不记 imagePath（本地路径/文件名是元数据，日志可能被上传/外发）。
      logger?.debug?.('vision bridge cache hit', { sourceType: input.imagePath ? 'path' : 'url' });
      return { text: cached, usedFallback: false };
    }
    // in-flight 去重：并发同 key（同图同 prompt 同后端）miss 时合并请求，避免 thundering
    // herd 重复打视觉后端（concurrency=2 会放大重复）。完成后写缓存，finally 删除。
    const existing = inFlight.get(ck);
    if (existing) {
      return awaitSharedFlight(existing, signal);
    }
    const flight = (async (): Promise<{ text: string; usedFallback: boolean }> => {
      const primaryStartedAt = Date.now();
      try {
        const text = await describeImageWithProvider(
          primary.providerId,
          primary.modelId,
          { ...input, prompt, signal },
          deps,
        );
        // dispose 后不回填已清空的 cache（旧实例生命周期硬封口）。
        if (!disposed) cacheSet(ck, text);
        return { text, usedFallback: false };
      } catch (primaryErr) {
      // 取消不是 primary 失败：Stop/拆离/超时 abort 时静默抛出（不 warn、不尝试 fallback），
      // 由外层 hook 按取消语义 quiet 收口，避免把「用户取消」记成「后端失败」。
      if (signal?.aborted || (primaryErr instanceof VisionBackendError && primaryErr.code === 'abort')) {
        throw primaryErr;
      }
      logger?.warn?.('vision bridge primary backend failed', {
        backendRole: 'primary',
        model: runtimeModel,
        providerId: primary.providerId,
        backendModelId: primary.modelId,
        ...routeInfoOf(primary.providerId, primary.modelId),
        errorCode: errorCodeOf(primaryErr),
        durationMs: Date.now() - primaryStartedAt,
        error: primaryErr instanceof Error ? primaryErr.message : String(primaryErr),
      });
      const fallback = settings.fallback;
      // fallback 与 primary 的 (providerId, modelId) 完全相同才算重复；同 provider 不同
      // model（如 openrouter 下主 gpt-4o-mini、备 qwen-vl）是独立后端选择，应允许。
      const sameBackend =
        fallback &&
        fallback.providerId === primary.providerId &&
        fallback.modelId === primary.modelId;
      if (fallback && !sameBackend) {
        // fallback 缓存/去重闭环：primary 持续失败时复用已缓存的 fallback 描述，
        // 不同 primary 共享同 fallback 时合并请求。
        const fallbackCk = cacheKey(imageSource, prompt, fallback);
        const cachedFallback = cacheGet(fallbackCk);
        if (cachedFallback !== null) {
          logger?.debug?.('vision bridge fallback cache hit');
          return { text: cachedFallback, usedFallback: true };
        }
        const existingFallbackFlight = inFlight.get(fallbackCk);
        // fallback 等待方同样继承 signal 取消（与主分支语义一致）。
        if (existingFallbackFlight) return awaitSharedFlight(existingFallbackFlight, signal);
        const fallbackStartedAt = Date.now();
        const fallbackFlight = (async (): Promise<{ text: string; usedFallback: boolean }> => {
          const text = await describeImageWithProvider(
            fallback.providerId,
            fallback.modelId,
            { ...input, prompt, signal },
            deps,
          );
          if (!disposed) cacheSet(fallbackCk, text);
          return { text, usedFallback: true };
        })().finally(() => {
          inFlight.delete(fallbackCk);
        });
        inFlight.set(fallbackCk, fallbackFlight);
        try {
          const result = await fallbackFlight;
          // 用本次实际 fallback 快照（局部 fallback + fallbackStartedAt）记录成功后端与耗时，
          // 避免 hook 末尾重读 settings 在 turn 内设置变更时归因到新后端。
          logger?.info?.('vision bridge used fallback backend', {
            backendRole: 'fallback',
            model: runtimeModel,
            providerId: fallback.providerId,
            backendModelId: fallback.modelId,
            durationMs: Date.now() - fallbackStartedAt,
          });
          return result;
        } catch (fallbackErr) {
          // 取消不是 fallback 失败：abort 时静默抛出，不 warn、不包成「双后端不可用」。
          if (signal?.aborted || (fallbackErr instanceof VisionBackendError && fallbackErr.code === 'abort')) {
            throw fallbackErr;
          }
          logger?.warn?.('vision bridge fallback backend failed', {
            backendRole: 'fallback',
            model: runtimeModel,
            providerId: fallback.providerId,
            backendModelId: fallback.modelId,
            ...routeInfoOf(fallback.providerId, fallback.modelId),
            errorCode: errorCodeOf(fallbackErr),
            durationMs: Date.now() - fallbackStartedAt,
            error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
          });
          // 双后端都失败：保留两个原因供诊断（内部日志），对外抛泛化错误。
          const fallbackReason = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          throw new VisionBackendError(
            'unavailable',
            `vision backends unavailable (primary: ${reasonOf(primaryErr)}, fallback: ${fallbackReason})`,
          );
        }
      }
      // 主后端失败且无 fallback：回退无视觉桥。
      const reason = reasonOf(primaryErr);
      throw new VisionBackendError('unavailable', `vision backends unavailable (${reason})`);
      }
    })().finally(() => {
      inFlight.delete(ck);
    });
    inFlight.set(ck, flight);
    return flight;
  }

  const hook: VisionBridgeHook = async (msg, ctx) => {
    // 总开关 + 目标模型命中。未启用 / 不命中 → 原样透传（零干扰契约）。
    const target = isTargetModel(ctx.model);
    logger?.debug?.('vision bridge: hook invoked', { model: ctx.model, target });
    if (!target) {
      return { applied: false, message: msg };
    }
    const blocks = imageBlocks(msg.content);
    logger?.debug?.('vision bridge: hook target hit', { model: ctx.model, imageCount: blocks.length });
    if (blocks.length === 0) return { applied: false, message: msg };
    // 命中且有图 → 提示「正在识别图片中」（fire-and-forget，host 据此发 UI 事件）。
    // sessionId 由 maker-core session 传入（见 types/vision-bridge.ts ctx）。
    deps.onStart?.(ctx.sessionId ?? '', blocks.length);

    // focus hint = 同消息其余文本（比 proxy 层提取更准，有真实语义边界）。
    const textParts = typeof msg.content === 'string'
      ? [msg.content]
      : msg.content
          .filter((b) => b.type === 'text' && typeof b.text === 'string')
          .map((b) => (b as { text: string }).text);
    const focusHint = textParts.join('\n').trim();

    const descriptions: Array<{ idx: number; text: string; alreadyAnnotated?: boolean }> = [];
    let usedFallback = false;
    // 有界并发描述（concurrency=2）：串行会让 2-4 张图拖慢 turn 启动（每张最坏
    // primary+fallback 10s）；并发 2 压缩延迟且不放大内存/provider QPS 太多。
    // abort 后不再启动新图，在跑的 fetch 由 signal 中止。
    const CONCURRENCY = 2;
    let nextIdx = 0;
    let anySucceeded = false;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (ctx.signal?.aborted) return;
        const current = nextIdx++;
        if (current >= blocks.length) return;
        const block = blocks[current];
        try {
          const r = await describeWithFallback({ imagePath: block.path }, focusHint, ctx.signal, ctx.model);
          if (r.usedFallback) usedFallback = true;
          descriptions.push({ idx: block.idx, text: r.text });
          anySucceeded = true;
        } catch (err) {
          // 取消不是失败：Stop/拆离/超时 abort 时应 quiet 终止本 worker（外层循环也会因
          // signal.aborted 退出），不打 image failed warn、不写占位、不把取消误判成后端故障。
          if (ctx.signal?.aborted || (err instanceof VisionBackendError && err.code === 'abort')) {
            return;
          }
          // 按图片粒度降级：单图失败不整条回退（保留其他成功图），该图用泛化占位文本
          // （不进原始错误细节，避免把路径/URL 泄漏给模型）。
          const reason = reasonOf(err);
          logger?.warn?.('vision bridge image failed, degrading this image only', {
            model: ctx.model,
            errorCode: errorCodeOf(err),
            error: reason,
          });
          descriptions.push({
            idx: block.idx,
            text: IMAGE_UNAVAILABLE_TEXT,
            alreadyAnnotated: true,
          });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, blocks.length) }, worker));
    // 按原 idx 排序回填（并发完成顺序乱，需保持消息内图片顺序稳定）。
    descriptions.sort((a, b) => a.idx - b.idx);
    if (!anySucceeded) {
      // 取消不是故障：Stop/拆离/超时 abort 导致全部图未处理时，静默透传，不打 warn、不发
      // note（避免把「用户取消」记成「视觉桥故障」）。
      if (ctx.signal?.aborted) {
        return { applied: false, message: msg };
      }
      // 全部图都失败：回退无视觉桥状态，用文字提示代替 + 清晰提示（不再「原样透传」——
      // 原始 image block 会被层 A 再次处理同一个失败后端，见下方占位替换逻辑）。
      const note = '视觉桥当前不可用，本次图片无法转成文字描述，已用文字提示代替';
      logger?.warn?.('vision bridge unavailable, falling back to passthrough', { model: ctx.model });
      deps.onNote?.(note, ctx.sessionId ?? '', 'unavailable');
      // 关键：返回的 message 不能带原始 image block——层 A（proxy transform）对同一模型
      // 仍启用，见到 image block 会再次调用同一个失败的视觉后端再转一次，加倍最坏延迟
      // 且与文档承诺的 pass-through 不符（P1）。这里把全部图替换为与层 A 一致的
      // 「图片不可用」占位，层 A 无 image block 可处理 → 行为确定：一次失败即占位。
      const unavailableDescriptions = blocks.map((b) => ({
        idx: b.idx,
        text: IMAGE_UNAVAILABLE_TEXT,
        alreadyAnnotated: true,
      }));
      return { applied: true, message: buildBridgedMessage(msg, unavailableDescriptions), note };
    }
    const bridged = buildBridgedMessage(msg, descriptions);
    logger?.debug?.('vision bridge: applied', {
      model: ctx.model,
      imageCount: blocks.length,
      described: descriptions.filter((d) => !d.alreadyAnnotated).length,
      unavailable: descriptions.filter((d) => d.alreadyAnnotated).length,
      usedFallback,
    });
    if (usedFallback) {
      const note = '视觉桥使用了 fallback 视觉后端（主后端不可用）';
      // fallback 成功后端与耗时已在 describeWithFallback 内记录（本次实际快照），此处只发 note。
      deps.onNote?.(note, ctx.sessionId ?? '', 'fallback');
      return { applied: true, message: bridged, note };
    }
    return { applied: true, message: bridged };
  };

  return {
    hook,
    /** 供层 A proxy transform 复用：判定某 model 是否启用视觉桥。 */
    isTargetModel,
    /** 供层 A proxy transform / ghost 工具结果描述复用：imageUrl 或 imagePath 形态。 */
    describeImage: (input: {
      imageUrl?: string;
      imagePath?: string;
      prompt: string;
      signal?: AbortSignal;
    }): Promise<string> =>
      describeWithFallback(
        { imageUrl: input.imageUrl, imagePath: input.imagePath },
        input.prompt,
        input.signal,
      ).then((r) => r.text),
    dispose: () => {
      // 硬封口：跑着的 in-flight 请求 resolve 后不再回填 cache（disposed 检查在 cacheSet 前）。
      disposed = true;
      cache.clear();
      inFlight.clear();
    },
  };
}
