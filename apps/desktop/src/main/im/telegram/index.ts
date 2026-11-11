/**
 * main/im/telegram/index.ts
 * ---------------------------------------------------------------------------
 * Wire a personal Telegram IM transport up to the shared orchestrator, and
 * attach the group-window data plane (every group message the bot can see —
 * trigger or not, plus the bot's own outbound echoes — lands in the local
 * rolling window that feeds dispatch context assembly).
 *
 * 设置页那份个人 bot 与伙伴自有连接都走这里: 后者每条连接一份传输层实例, 带
 * `instanceKey` 与 `companionBotId`, 且不注册设置卡的 session-auth IPC。
 */

import type { TelegramIM } from '@cindy/im';

import { createLogger } from '../../logger';
import {
  captureImAccountGeneration,
  isImAccountScopeClosedError,
  runInImAccountGeneration,
} from '../accountBoundary';
import { createImOrchestrator, type ImOrchestrator } from '../shared/orchestrator';
import type { ImOrchestratorConfig } from '../shared/types';
import { buildTelegramAdapter } from './adapter';
import { describeCompanionForAmbientJudge, getAmbientReplyJudge } from '../shared/ambientReplyJudgeRuntime';
import { recordTelegramGroupMessage } from './groupWindow';
import { registerTelegramSessionAuthIpc } from './sessionAuth';

const log = createLogger('main:im:telegram');

export interface WireTelegramOrchestratorOptions {
  /** 注册表键(缺省 = 渠道名, 即设置页那份)。 */
  instanceKey?: string;
  /** 伙伴自有连接: 这个 bot 属于哪位伙伴。 */
  companionBotId?: string;
  /** 是否注册设置卡的 `telegramBot:check-session-auth`(缺省 true; 伙伴连接不注册)。 */
  sessionAuthIpc?: boolean;
}

export function wireTelegramOrchestrator(
  telegramIm: TelegramIM,
  config: ImOrchestratorConfig,
  options: WireTelegramOrchestratorOptions = {},
): ImOrchestrator {
  const orchestrator = createImOrchestrator(
    buildTelegramAdapter(telegramIm, config, {
      ...(options.companionBotId
        ? {
            companionBotId: options.companionBotId,
            describeSelfForAmbientJudge: describeCompanionForAmbientJudge(options.companionBotId),
          }
        : {}),
      // 全响应群消息先问辅助模型该不该插话(个人 bot 与伙伴连接同一条链)。
      ambientReplyJudge: getAmbientReplyJudge(),
    }),
    {
      ...(options.instanceKey ? { instanceKey: options.instanceKey } : {}),
      ...(options.companionBotId ? { companionBotId: options.companionBotId } : {}),
    },
  );
  if (options.sessionAuthIpc !== false) registerTelegramSessionAuthIpc(config);

  // 群窗口数据面: 入窗走账号世代边界(登出后迟到的落库直接丢弃, 与
  // messageHandler 同口径), 失败只警告 — 窗口是尽力而为的上下文缓存,
  // 不阻断消息主链路。
  telegramIm.onGroupWindowMessage((entry) => {
    const generation = captureImAccountGeneration();
    if (generation === null) return;
    void runInImAccountGeneration(generation, () => recordTelegramGroupMessage(entry)).catch(
      (err) => {
        if (isImAccountScopeClosedError(err)) return;
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`telegram group window record failed (non-fatal): ${msg}`);
      },
    );
  });
  return orchestrator;
}
