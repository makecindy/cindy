import type { ModelPriceOverrideTarget } from './modelPriceOverride';

/**
 * 单模型图片输入能力的本地目录 override(设置 → 模型 → 高级设置)。
 *
 * 与价格/上下文上限 override 共用 (providerId, agent, modelId) 目标形状；agent 只用于
 * 目录成员校验，实际写入的是**模型级** base patch(图片能力是公共字段，见
 * docs/product-rules/model-metadata-precedence.md)。
 */
export type ModelCatalogImageInputTarget = ModelPriceOverrideTarget;

/** 读回视图。value=null 表示没有本地声明(跟随供应商)。 */
export interface ModelCatalogImageInputView {
  value: boolean | null;
  isCustomized: boolean;
}
