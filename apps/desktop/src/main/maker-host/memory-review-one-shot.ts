/**
 * apps/desktop/src/main/maker-host/memory-review-one-shot.ts
 *
 * memory_review 的一次性文本调用 — 走共享辅助模型链。链上没产出返回 null, 让
 * MakerMemoryManager 以可读原因 fail-closed(不再回退 review agent 的默认
 * oneShot 路由: 那是本账号无权模型, 只会给出与真实原因无关的 403)。
 *
 * 为什么需要这条链: review agent (claude-code) 的默认模型 claude-haiku-4-5 在部分
 * 供应商网关上不在账号可用清单内, 硬编码默认路由会让 memory_review 对这些账号
 * 100% 失败(403 user_model_access_denied, 2026-10-14 实测)。辅助模型链按用户配置的
 * 可用模型逐候选派发, 复用与自动命名同一套基础设施(停用轴 / owner 边界守卫 /
 * 候选诊断), 不新造平行路由。
 *
 * 边界与停用语义由 requestUtilityText 内部保证(owner 快照 + beforeDispatch 复核 +
 * readModelDisableOverrides); 这里只做 maker 就绪判断与失败降级, 不重复造守卫。
 */

import type { Maker } from '@cindy/maker-core';

import type { UtilityTextResult } from '../../shared/utilityTextResult.js';
import { requestUtilityText } from '../utility-model/oneShotCandidates.js';
import { createLogger } from '../logger.js';
import { getMakerIfReady } from './index.js';

const log = createLogger('maker-host/memory-review-one-shot');

export interface MemoryReviewOneShotDeps {
  getMaker: () => Maker | null;
  requestText: (
    maker: Maker,
    prompt: string,
    opts: Parameters<typeof requestUtilityText>[2],
  ) => Promise<UtilityTextResult>;
}

const DEFAULT_DEPS: MemoryReviewOneShotDeps = {
  getMaker: getMakerIfReady,
  requestText: requestUtilityText,
};

export type MemoryReviewOneShot = (
  prompt: string,
  opts: { maxTokens: number; timeoutMs: number },
) => Promise<string | null>;

/**
 * 生成注入给 MakerMemoryManager 的 reviewOneShot。任何「链上没产出」都返回 null
 * (不抛), 由 manager 决定如何收口 — 保持 fail-closed 的决策点在 manager 一侧。
 */
export function createMemoryReviewOneShot(
  deps: Partial<MemoryReviewOneShotDeps> = {},
): MemoryReviewOneShot {
  const resolved: MemoryReviewOneShotDeps = { ...DEFAULT_DEPS, ...deps };
  return async (prompt, opts) => {
    const maker = resolved.getMaker();
    if (!maker) return null;
    try {
      const result = await resolved.requestText(maker, prompt, {
        maxTokens: opts.maxTokens,
        timeoutMs: opts.timeoutMs,
        // review 要的是一段简短计划, provider 默认思考只会烧 token。
        disableReasoning: true,
      });
      if (result.ok) {
        return result.text.trim().length > 0 ? result.text : null;
      }
      log.warn('memory review utility chain produced no usable text', { reason: result.reason });
      return null;
    } catch (error) {
      log.warn('memory review utility chain failed', {
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return null;
    }
  };
}
