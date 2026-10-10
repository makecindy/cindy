import type { ModelPriceOverrideTarget } from './modelPriceOverride';

/**
 * 单模型图片输入能力的本地目录 override(设置 → 模型 → 高级设置)。
 *
 * 与价格/上下文上限 override 共用 (providerId, agent, modelId) 目标形状；agent 只用于
 * 目录成员校验，实际写入的是**模型级** base patch(图片能力是公共字段，见
 * docs/product-rules/model-metadata-precedence.md)。
 */
export interface ModelCatalogImageInputTarget extends ModelPriceOverrideTarget {
  /**
   * 同一行在**其它引擎**下的 wire id。桥接投影两端 id 不同（例如 openai 行：codex 用
   * `gpt-5.6-sol`、pi 用 `chatgpt/gpt-5.6-sol`），而本机 override 按 (providerId, modelId)
   * 精确匹配 —— 只写主展示引擎的 id，运行期真正消费该能力的 Pi 读不到，UI 却会显示已声明。
   */
  relatedTargets?: ModelPriceOverrideTarget[];
}

/** 读回视图。value=null 表示没有本地声明(跟随供应商)。 */
export interface ModelCatalogImageInputView {
  value: boolean | null;
  isCustomized: boolean;
  /**
   * 该行各引擎的声明**不一致**(手工改文件/旧版单键写入留下的存量数据)。展示值取运行期
   * 真正消费该能力的引擎(Pi)那一侧，但 UI 必须允许用户“重选当前项”把分裂写回一致 ——
   * 否则同值 no-op 会让分叉永远修不掉。
   */
  diverged?: boolean;
}
