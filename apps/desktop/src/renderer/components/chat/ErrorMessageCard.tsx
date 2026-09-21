/**
 * ErrorMessageCard — 消息流里的静态错误记录卡
 * ---------------------------------------------------------------------------
 * 渲染历史里持久化的 role='error' 行(turn 失败终态,main 的 onTurnErrorEvent
 * 落库)。定位是**事后可追溯的时间线记录**,与输入框上方的 ErrorBanner 分工:
 *  - ErrorBanner:live 报错,带 Retry / Cancel / auth 同步等交互;
 *  - 本卡:历史加载时还原"这一轮在这里失败了"。Retry 语义不成立(turn 早已收场),
 *    唯一交互是友好文案/协议拆封后的「查看原始错误」,与 live ErrorBanner 对齐。
 *
 * 文案:errorReason 是 maker-core 的稳定 key,优先走 i18n(规则 18;与 live
 * ErrorBanner 的 reason → i18n 映射同款);没有 reason 或 key 未知时,回退经
 * decodeRemoteErrorMessage 解码后的 message(与 ErrorBanner 对齐,避免将
 * [REMOTE_*] / [DEVICE_LINK_*] bracket code 以原始文本展示给用户)。
 *
 * 视觉:走 `--error-bg` / `--error-border` / `--error-fg` 主题 token(规则 16;
 * 错误红属跨主题语义豁免色,token 默认值即语义红,非默认主题可按需 override),
 * 与 ErrorBanner 同语义,为随内容的 inline 卡。
 */

import { useEffect, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { isCindyGatewayProxyTokenInvalidError } from '@cindy/maker-shared/error-redaction';
import {
  isStreamInterruptedErrorMessage,
  unwrapProviderErrorDisplay,
} from '@/utils/streamInterruptError';
import { decodeRemoteErrorMessage } from '../../lib/makerChatStore';
import { ERROR_REASON_I18N_KEYS } from './errorReasonI18n';
import { getToolLoopI18nKey } from './toolLoopI18n';
import type { ToolLoopErrorDetails } from '@cindy/maker-core';

export function ErrorMessageCard({
  message,
  reason,
  providerId,
  toolLoop,
}: {
  message: string;
  reason?: string;
  providerId?: string;
  /** Structured details for a tool-loop terminal error (optional for legacy rows). */
  toolLoop?: ToolLoopErrorDetails;
}) {
  const { t } = useTranslation();
  const [showRaw, setShowRaw] = useState(false);
  const decoded = decodeRemoteErrorMessage(message);
  const i18nKey = reason ? ERROR_REASON_I18N_KEYS[reason] : undefined;
  const isStreamInterrupted = isStreamInterruptedErrorMessage(message, reason);
  const isGatewayProxyTokenInvalid = isCindyGatewayProxyTokenInvalidError({
    reason,
    message: decoded,
    providerId: providerId ?? null,
  });
  const unwrapped = unwrapProviderErrorDisplay(decoded);
  const toolLoopI18nKey = reason === 'tool_use_loop_detected' ? getToolLoopI18nKey(toolLoop) : undefined;
  const localizedReasonError =
    toolLoopI18nKey && toolLoop
      ? t(toolLoopI18nKey, { count: toolLoop.count })
      : i18nKey
        ? t(i18nKey)
        : undefined;
  const text = isStreamInterrupted
    ? t('chat.errorBanner.streamInterruptedNoRetry')
    : isGatewayProxyTokenInvalid
      ? t('chat.errorBanner.gatewayProxyTokenInvalidNoRetry')
      : localizedReasonError
        ? localizedReasonError
        : unwrapped;
  const showRawToggle =
    isStreamInterrupted ||
    isGatewayProxyTokenInvalid ||
    (!i18nKey && unwrapped !== decoded);

  useEffect(() => {
    setShowRaw(false);
  }, [message, reason]);

  if (!text) return null;
  return (
    <div
      className="flex items-start gap-2 rounded-md px-3 py-2 border bg-[var(--error-bg)] border-[var(--error-border)]"
      data-testid="error-message-card"
    >
      <AlertCircle size={14} className="shrink-0 mt-[2px] text-[var(--error-fg)]" />
      <div className="flex-1 min-w-0">
        <span className="block min-w-0 text-xs break-all text-[var(--error-fg)]">{text}</span>
        {showRawToggle && (
          <>
            <button
              type="button"
              onClick={() => setShowRaw((v) => !v)}
              className="mt-0.5 block text-xs underline opacity-70 hover:opacity-50 transition-opacity text-[var(--error-fg)]"
            >
              {showRaw
                ? t('chat.errorBanner.networkHideRaw')
                : t('chat.errorBanner.networkShowRaw')}
            </button>
            {showRaw && (
              <span className="mt-0.5 block text-xs break-all opacity-70 text-[var(--error-fg)]">
                {decoded}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}
