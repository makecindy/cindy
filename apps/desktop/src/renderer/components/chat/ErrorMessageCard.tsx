/**
 * ErrorMessageCard — 消息流里的静态错误记录卡
 * ---------------------------------------------------------------------------
 * 渲染历史里持久化的 role='error' 行(turn 失败终态,main 的 onTurnErrorEvent
 * 落库)。定位是**事后可追溯的时间线记录**,与输入框上方的 ErrorBanner 分工:
 *  - ErrorBanner:live 报错,带 Retry / Cancel / auth 同步等交互;
 *  - 本卡:历史加载时还原"这一轮在这里失败了",纯展示、无任何交互按钮
 *    (历史错误对应的 turn 早已收场,Retry 语义不成立)。
 *
 * 文案:errorReason 是 maker-core 的稳定 key,优先走 i18n(规则 18;与 live
 * ErrorBanner 的 reason → i18n 映射同款);没有 reason 或 key 未知时,回退经
 * decodeRemoteErrorMessage 解码后的 message(与 ErrorBanner 对齐,避免将
 * [REMOTE_*] / [DEVICE_LINK_*] bracket code 以原始文本展示给用户)。
 *
 * 视觉:走 `--error-bg` / `--error-border` / `--error-fg` 主题 token(规则 16;
 * 错误红属跨主题语义豁免色,token 默认值即语义红,非默认主题可按需 override),
 * 与 ErrorBanner 同语义但去掉按钮区,为随内容的 inline 卡。
 */

import { AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { decodeRemoteErrorMessage } from '../../lib/makerChatStore';
import { UPSTREAM_OVERLOAD_REASON } from '@/utils/overloadError';
import { CLAUDE_GATEWAY_OPUS_PLAN_MISMATCH_REASON } from '../../../shared/claudeGatewayError';

/** 稳定 reason key → i18n。error-tail-banner(CCAgentSessionView)复用同一映射,
 *  保证尾部可操作红条与历史静态卡展示同一段文案。 */
export const ERROR_REASON_I18N_KEYS: Record<string, string> = {
  'empty-response': 'logic.errors.emptyResponse',
  'turn-failed': 'logic.errors.turnFailed',
  'silent-stop-exhausted': 'logic.errors.silentStopExhausted',
  'permission-tighten-interrupt-failed': 'logic.errors.permissionTightenInterruptFailed',
  'codex-auto-review-unavailable': 'logic.errors.codexAutoReviewUnavailable',
  // 卡死自愈的两层看门狗(agent 层上游静默 / Session 层 turn 零事件)。两者的
  // maker-core 侧 message 是英文兜底,renderer 一律走这里的本地化文案。
  upstream_response_idle_timeout: 'logic.errors.upstreamResponseIdleTimeout',
  turn_no_event_timeout: 'logic.errors.turnNoEventTimeout',
  // 上游过载(重投预算耗尽后的终态)。**复用尾部 banner 的同一条文案**, 正是本表
  // 注释说的那个一致性: 不映射的话同一条过载错误会出现「尾部红条本地化、历史静态
  // 卡英文原文」的分裂 —— 而 codex 的过载原文还会随版本改措辞。
  [UPSTREAM_OVERLOAD_REASON]: 'chat.errorBanner.overloadBusyNoRetry',
  [CLAUDE_GATEWAY_OPUS_PLAN_MISMATCH_REASON]: 'chat.errorBanner.claudeGatewayOpusPlanMismatch',
};

export function ErrorMessageCard({ message, reason }: { message: string; reason?: string }) {
  const { t } = useTranslation();
  const i18nKey = reason ? ERROR_REASON_I18N_KEYS[reason] : undefined;
  const text = i18nKey ? t(i18nKey) : decodeRemoteErrorMessage(message);
  if (!text) return null;
  return (
    <div
      className="flex items-start gap-2 rounded-md px-3 py-2 border bg-[var(--error-bg)] border-[var(--error-border)]"
      data-testid="error-message-card"
    >
      <AlertCircle size={14} className="shrink-0 mt-[2px] text-[var(--error-fg)]" />
      <span className="min-w-0 text-xs break-all text-[var(--error-fg)]">{text}</span>
    </div>
  );
}
