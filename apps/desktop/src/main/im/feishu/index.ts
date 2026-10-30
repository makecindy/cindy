/**
 * main/im/feishu/index.ts
 * ---------------------------------------------------------------------------
 * Wire a feishu IM transport up to the shared orchestrator.
 *
 * 设置页那份个人 bot 在 app ready 时接一次(订阅随进程存活); 伙伴自有连接每条一份
 * 传输层实例, 带 `instanceKey` 与 `companionBotId`, 可随连接移除而注销。
 *
 * The caller passes an ImOrchestratorConfig that holds all IM-layer product
 * decisions (agent kind, default model, default permission mode, effort
 * overrides) — 编排逻辑全部在 im/shared/, 本文件只组装 feishu adapter。
 */

import type { FeishuIM } from '@cindy/im';

import { createImOrchestrator, type ImOrchestrator } from '../shared/orchestrator';
import type { ImOrchestratorConfig } from '../shared/types';
import { buildFeishuAdapter } from './adapter';

/** 兼容别名 — 历史命名, 形状即 ImOrchestratorConfig。 */
export type FeishuOrchestratorConfig = ImOrchestratorConfig;

export interface WireFeishuOrchestratorOptions {
  /** 注册表键(缺省 = 渠道名, 即设置页那份)。 */
  instanceKey?: string;
  /** 伙伴自有连接: 这个 bot 属于哪位伙伴。 */
  companionBotId?: string;
}

export function wireFeishuOrchestrator(
  feishuIm: FeishuIM,
  config: ImOrchestratorConfig,
  options: WireFeishuOrchestratorOptions = {},
): ImOrchestrator {
  return createImOrchestrator(
    buildFeishuAdapter(feishuIm, config, {
      ...(options.companionBotId ? { companionBotId: options.companionBotId } : {}),
    }),
    {
      ...(options.instanceKey ? { instanceKey: options.instanceKey } : {}),
      ...(options.companionBotId ? { companionBotId: options.companionBotId } : {}),
    },
  );
}
