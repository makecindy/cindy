import type { ModelPriceOverrideTarget } from './modelPriceOverride';

/**
 * 单模型思考档位的本地目录 override(设置 → 模型 → 高级设置)。
 *
 * 与价格 / 上下文上限 / 图片输入 override 共用 `(providerId, agent, modelId)` 目标形状。
 * 写入的是模型级 base patch 的 `efforts` + `defaultEffort`(思考档位是公共字段，见
 * `docs/product-rules/model-metadata-precedence.md`)。
 *
 * 为什么需要它:目录里的思考档位决定 Pi 能不能开真正的 thinking 通道
 * (`piThinkingLevels.mjs`:`reasoning !== true` → 零档位)。上游把一个**会推理**的模型
 * 声明成「不支持思考」时,Pi 没有通道可用,模型推理只能随 content 返回、被 Cindy 当
 * **普通 assistant 正文**渲染(实报:协同 worker 切到该模型后正文变成推理叙述)。
 * 这是「未声明」与「声明错误」两种真实状态,用户必须能自己显式声明。
 */
export interface ModelCatalogThinkingTarget extends ModelPriceOverrideTarget {
  /**
   * 同一行在**其它引擎**下的 wire id。桥接投影两端 id 不同(例如 openai 行:codex 用
   * `gpt-5.6-sol`、pi 用 `chatgpt/gpt-5.6-sol`),而本机 override 按 (providerId, modelId)
   * 精确匹配 —— 只写主展示引擎的 id,运行期真正消费档位的 Pi 读不到,UI 却显示已声明。
   */
  relatedTargets?: ModelPriceOverrideTarget[];
}

/** 读回视图。value=null 表示没有本地声明(跟随供应商)。 */
export interface ModelCatalogThinkingView {
  /** null = 没有本地声明(跟随供应商实报)。 */
  value: string[] | null;
  /**
   * 本机声明里的默认档。`value` 非 null 时才有意义。
   * 必须读回：否则用户在抽屉里改档位时无从知道当前默认是哪一档，写入侧只能猜一个
   * （例如「排序第一档」），那会把厂商声明的默认静默改掉且用户无从修正。
   */
  defaultEffort?: string | null;
  isCustomized: boolean;
  /**
   * 该行各引擎的声明**不一致**(手工改文件 / 旧版单键写入留下的存量数据)。展示值取运行期
   * 真正消费档位的引擎(Pi)那一侧,但 UI 必须允许用户「重选当前项」把分裂写回一致 ——
   * 否则同值 no-op 会让分叉永远修不掉。
   */
  diverged?: boolean;
}
