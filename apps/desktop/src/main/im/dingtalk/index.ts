/**
 * main/im/dingtalk/index.ts
 * ---------------------------------------------------------------------------
 * 把钉钉传输层接到共享编排器。设置页那份个人 bot 与伙伴自有连接都走这里:
 * 后者每条连接一份传输层实例, 带 `instanceKey` 与 `companionBotId`。
 */
import type { DingTalkChannelIM, DingTalkIM } from '@cindy/im';

import { createImOrchestrator, type ImOrchestrator } from '../shared/orchestrator';
import type { ImOrchestratorConfig } from '../shared/types';
import { buildDingTalkAdapter } from './adapter';

export interface WireDingTalkOrchestratorOptions {
  /** 注册表键(缺省 = 渠道名, 即设置页那份)。 */
  instanceKey?: string;
  /** 伙伴自有连接: 这个 bot 属于哪位伙伴。 */
  companionBotId?: string;
}

export function wireDingTalkOrchestrator(
  dingtalkIm: DingTalkChannelIM | DingTalkIM,
  config: ImOrchestratorConfig,
  options: WireDingTalkOrchestratorOptions = {},
): ImOrchestrator {
  return createImOrchestrator(
    buildDingTalkAdapter(dingtalkIm, config, {
      ...(options.companionBotId ? { companionBotId: options.companionBotId } : {}),
    }),
    {
      ...(options.instanceKey ? { instanceKey: options.instanceKey } : {}),
      ...(options.companionBotId ? { companionBotId: options.companionBotId } : {}),
    },
  );
}
