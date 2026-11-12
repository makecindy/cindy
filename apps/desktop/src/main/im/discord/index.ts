/**
 * main/im/discord/index.ts
 * ---------------------------------------------------------------------------
 * Wire the Discord IM channel up to the shared orchestrator. 设置页那份个人 bot 与
 * 伙伴自有连接都走这里: 后者每条连接一份传输层实例, 带 `instanceKey` 与
 * `companionBotId`, 且不注册设置卡的 session-auth IPC。
 */

import type { DiscordIM } from '@cindy/im';

import { createImOrchestrator, type ImOrchestrator } from '../shared/orchestrator';
import type { ImOrchestratorConfig } from '../shared/types';
import { buildDiscordAdapter } from './adapter';
import { registerDiscordSessionAuthIpc } from './sessionAuth';

export interface WireDiscordOrchestratorOptions {
  /** 注册表键(缺省 = 渠道名, 即设置页那份)。 */
  instanceKey?: string;
  /** 伙伴自有连接: 这个 bot 属于哪位伙伴。 */
  companionBotId?: string;
  /** 是否注册设置卡的 `discordBot:check-session-auth`(缺省 true; 伙伴连接不注册)。 */
  sessionAuthIpc?: boolean;
}

export function wireDiscordOrchestrator(
  discordIm: DiscordIM,
  config: ImOrchestratorConfig,
  options: WireDiscordOrchestratorOptions = {},
): ImOrchestrator {
  const orchestrator = createImOrchestrator(
    buildDiscordAdapter(discordIm, config, {
      ...(options.companionBotId ? { companionBotId: options.companionBotId } : {}),
    }),
    {
      ...(options.instanceKey ? { instanceKey: options.instanceKey } : {}),
      ...(options.companionBotId ? { companionBotId: options.companionBotId } : {}),
    },
  );
  if (options.sessionAuthIpc !== false) registerDiscordSessionAuthIpc(config);
  return orchestrator;
}
