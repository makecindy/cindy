import type { AgentEvent } from '@cindy/maker-core';
import {
  GATEWAY_PROXY_TOKEN_INVALID_REASON,
  isCindyGatewayProviderId,
  isGatewayProxyTokenInvalidError,
} from '@cindy/maker-shared/error-redaction';

import { isTerminalTurnErrorEvent } from './sessionTurnActivityTracker.js';

/**
 * 判定一个智能体事件是否为「回合因 Cindy AI Key 失效而终止」:终止型 error、会话走 Cindy
 * 网关(显式 `xd` 或旧会话未写 provider),且错误带网关代理 token 失效的结构化 reason 或文本。
 * register.ts 用它决定错误是否交给 renderer 自愈、是否落库,以及是否上报 Key 失效;
 * 抽成纯函数便于按供应商单测。
 */
export function isGatewayProxyTokenRecoveryErrorEventForProvider(
  providerId: string | null | undefined,
  event: AgentEvent,
): boolean {
  if (event.type !== 'error' || !isTerminalTurnErrorEvent(event)) return false;
  const data = event.data as { message?: unknown; reason?: unknown } | undefined;
  return (
    isCindyGatewayProviderId(providerId) &&
    (data?.reason === GATEWAY_PROXY_TOKEN_INVALID_REASON ||
      isGatewayProxyTokenInvalidError(typeof data?.message === 'string' ? data.message : ''))
  );
}
