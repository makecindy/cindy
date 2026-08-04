/**
 * main/im/telegram/index.ts
 * ---------------------------------------------------------------------------
 * Wire the personal Telegram IM channel up to the shared orchestrator, and
 * attach the group-window data plane (every group message the bot can see —
 * trigger or not, plus the bot's own outbound echoes — lands in the local
 * rolling window that feeds dispatch context assembly).
 */

import type { TelegramIM } from '@cindy/im';

import { createLogger } from '../../logger';
import {
  captureImAccountGeneration,
  isImAccountScopeClosedError,
  runInImAccountGeneration,
} from '../accountBoundary';
import { createImOrchestrator } from '../shared/orchestrator';
import type { ImOrchestratorConfig } from '../shared/types';
import { buildTelegramAdapter } from './adapter';
import { recordTelegramGroupMessage } from './groupWindow';
import { registerTelegramSessionAuthIpc } from './sessionAuth';

const log = createLogger('main:im:telegram');

export function wireTelegramOrchestrator(
  telegramIm: TelegramIM,
  config: ImOrchestratorConfig,
): void {
  createImOrchestrator(buildTelegramAdapter(telegramIm, config));
  registerTelegramSessionAuthIpc(config);

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
}
