/**
 * The structured signals of a terminal turn error, as the desktop's event preparation reads them before it
 * hands the error to the input coordinator (sessionEventPreparation.ts). Moved verbatim out of
 * prepareSessionEvent so the Node Host hands the coordinator the same message and signals (checkpoint 4).
 * Pure: provider-controlled data is parsed into bounded shapes here and never kept as live state.
 */
import type { AgentEvent } from '@cindy/maker-core';
import { parseOutputLimitDetails } from '@cindy/maker-shared';
import { parseAgentInputToolLoopDetails } from '../../shared/agentInputQueue.js';

/** prepareSessionEvent's reading of a terminal error: its data, the message and the signals for the coordinator. */
export function readTerminalTurnErrorSignals(
  attributedEvent: AgentEvent,
  broadcastEvent: AgentEvent,
) {
  const errData =
    attributedEvent.type === 'error'
      ? (attributedEvent.data as
          | {
              message?: unknown;
              reason?: unknown;
              sdkError?: unknown;
              errorStatus?: unknown;
              toolLoop?: unknown;
              outputLimit?: unknown;
              usageLimit?: unknown;
              usageResetAt?: unknown;
              codexErrorInfo?: unknown;
            }
          | undefined)
      : undefined;
  // Terminal error details cross the coordinator/device-link boundary as untrusted data.
  // Keep only the bounded tool-loop shape; never let a provider-controlled object become
  // live projection state or renderer interpolation.
  const toolLoop = parseAgentInputToolLoopDetails(errData?.toolLoop);
  const outputLimit = parseOutputLimitDetails(errData?.outputLimit);
  return {
    errData,
    message:
      typeof broadcastEvent.data === 'object' &&
      broadcastEvent.data !== null &&
      typeof (broadcastEvent.data as { message?: unknown }).message === 'string'
        ? (broadcastEvent.data as { message: string }).message
        : undefined,
    signals:
      // 结构化信号:自动续跑的判据靠它们收紧(见 isInterruptedTurnError),不靠文本猜。
      {
        ...(typeof errData?.sdkError === 'string' ? { sdkError: errData.sdkError } : {}),
        ...(typeof errData?.reason === 'string' ? { reason: errData.reason } : {}),
        ...(typeof errData?.errorStatus === 'number' ? { errorStatus: errData.errorStatus } : {}),
        ...(toolLoop ? { toolLoop } : {}),
        ...(outputLimit ? { outputLimit } : {}),
        // 账号限额信号:普通任务据此等额度重置后自动继续(见 usageLimitAutoResume.ts)。
        ...(errData?.usageLimit === true ? { usageLimit: true } : {}),
        ...(typeof errData?.usageResetAt === 'number' && Number.isFinite(errData.usageResetAt)
          ? { usageResetAt: errData.usageResetAt }
          : {}),
        ...(typeof errData?.codexErrorInfo === 'string'
          ? { codexErrorInfo: errData.codexErrorInfo }
          : {}),
      },
  };
}
