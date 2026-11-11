/**
 * main/im/wecom/index.ts
 * ---------------------------------------------------------------------------
 * 把企业微信传输层接到共享编排器。设置页那份个人 bot 与伙伴自有连接都走这里:
 * 后者每条连接一份传输层实例, 带 `instanceKey` 与 `companionBotId`。
 */
import type { WecomIM } from '@cindy/im';

import { createImOrchestrator, type ImOrchestrator } from '../shared/orchestrator';
import type { ImOrchestratorConfig } from '../shared/types';
import { buildWecomAdapter } from './adapter';
import { WecomTextInteractions } from './textInteractions';

export interface WireWecomOrchestratorOptions {
  /** 注册表键(缺省 = 渠道名, 即设置页那份)。 */
  instanceKey?: string;
  /** 伙伴自有连接: 这个 bot 属于哪位伙伴。 */
  companionBotId?: string;
}

export function wireWecomOrchestrator(
  wecomIm: WecomIM,
  config: ImOrchestratorConfig,
  options: WireWecomOrchestratorOptions = {},
): ImOrchestrator {
  const interactions = new WecomTextInteractions(wecomIm);
  return createImOrchestrator(
    buildWecomAdapter(wecomIm, interactions, config, {
      ...(options.companionBotId ? { companionBotId: options.companionBotId } : {}),
    }),
    {
      ...(options.instanceKey ? { instanceKey: options.instanceKey } : {}),
      ...(options.companionBotId ? { companionBotId: options.companionBotId } : {}),
    },
  );
}
