/**
 * useModelPricing — 模型单价表 (model id → USD/Mtok) 的 renderer 侧只读缓存。
 *
 * 数据通道: main usage/modelPricing.ts (LiteLLM /model_group/info, 内存 + 磁盘缓存, 启动预热)
 *   → IPC maker:usage:model-pricing → 本 hook。
 *
 * 语义:
 *   - 价格是账号级静态数据, main 端全局缓存; renderer module-local 只保留一份只读快照,
 *     in-flight 共享 Promise, 后挂载者复用结果 (避免多个 ModelSelector 同开时重复 IPC)
 *   - 返回 null = 还没拉到 / 拉取失败 — 消费方隐藏价格展示, 不出 loading 态
 *     (符合设计规范: 数据未到时界面不变化)
 *   - 查不到某个 model id = 该模型无定价 (LiteLLM 未配价, 不是免费), 同样隐藏
 */

import { useEffect, useState } from 'react';

export interface ModelPrice {
  inputUsdPerMtok: number;
  outputUsdPerMtok: number;
  cacheReadUsdPerMtok?: number;
  cacheCreateUsdPerMtok?: number;
}

export type ModelPricingMap = Record<string, ModelPrice>;

let cache: ModelPricingMap | null = null;
let inflight: Promise<ModelPricingMap | null> | null = null;

function isValidMap(v: unknown): v is ModelPricingMap {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every(
    (p) => {
      if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
      const price = p as ModelPrice;
      return (
        typeof price.inputUsdPerMtok === 'number' &&
        Number.isFinite(price.inputUsdPerMtok) &&
        price.inputUsdPerMtok >= 0 &&
        typeof price.outputUsdPerMtok === 'number' &&
        Number.isFinite(price.outputUsdPerMtok) &&
        price.outputUsdPerMtok >= 0 &&
        (price.cacheReadUsdPerMtok === undefined ||
          (typeof price.cacheReadUsdPerMtok === 'number' &&
            Number.isFinite(price.cacheReadUsdPerMtok) &&
            price.cacheReadUsdPerMtok >= 0)) &&
        (price.cacheCreateUsdPerMtok === undefined ||
          (typeof price.cacheCreateUsdPerMtok === 'number' &&
            Number.isFinite(price.cacheCreateUsdPerMtok) &&
            price.cacheCreateUsdPerMtok >= 0))
      );
    },
  );
}

function load(): Promise<ModelPricingMap | null> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = window.electronAPI.maker.usage
      .getModelPricing()
      .then((res) => {
        if (isValidMap(res) && Object.keys(res).length > 0) cache = res;
        return cache;
      })
      .catch(() => null)
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export function useModelPricing(): ModelPricingMap | null {
  const [pricing, setPricing] = useState<ModelPricingMap | null>(cache);

  useEffect(() => {
    if (cache) return;
    let active = true;
    void load().then((res) => {
      if (active && res) setPricing(res);
    });
    return () => {
      active = false;
    };
  }, []);

  return pricing;
}
