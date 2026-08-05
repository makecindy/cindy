/**
 * 「会话尾部停在错误行」的可操作提示条(输入框上方,与 live ErrorBanner 同位置)
 * ---------------------------------------------------------------------------
 * 数据源是持久化的 role='error' 消息行:当它是会话最后一条消息、未被忽略且会话
 * 空闲时,由 CCAgentSessionView 渲染(与 live ErrorBanner / CredentialSwitchWaitBanner
 * 互斥;此时消息流内不再重复渲染 ErrorMessageCard,由本处独家承载)。
 *
 * 两种语义、两个组件(2026-07-05 产品决策统一:所有尾部错误都要有可操作按钮):
 *  - InterruptedTurnBanner:app 退出中断标记行(reason='app-exit-interrupted')。
 *    文案固定,「继续任务」+「忽略」。
 *  - ErrorTailErrorBanner:普通 turn 失败行(process exited / turn-failed 等,
 *    典型来源是重启后 live ErrorBanner 内存态已丢、只剩历史行)。**直接复用
 *    live ErrorBanner**(review P2)—— 它已内置 codex thread not found / 401
 *    auth-missing / invalid-encrypted-content 等不可重试错误的 Retry 门控与
 *    恢复路径(同步登录态 / fork 剥离),此处只包一层:主按钮语义换成隐藏续跑
 *    指令、关闭换成 dismissed 持久化。
 *
 * 主按钮都发送隐藏英文续跑指令([UI_ACTION_TRIGGER] 前缀,聊天不显示气泡)——
 * SDK transcript 里已有原任务与(可能的)部分进展,模型自查进度从中断/失败处
 * 继续,不重复已产生外部副作用的步骤。「忽略/关闭」把 dismissed 持久化进该行
 * content(messages:dismiss-error,main 侧 merge 不丢字段),跨重启不再提示,
 * 该行退回消息流作静态历史记录。
 *
 * 红点:**展示不清点**(2026-07 统一)。此前 mount 即以 explicit 清掉该会话的
 * 'error' attention,于是红点灭了而横幅还在 —— 用户反馈的割裂点。现在红点是未处理
 * 告警的派生投影(usePendingAlertAttention 按 main 侧 pending-alerts 查询收敛),
 * 只有用户点「继续任务」/「忽略」把处置结果落库后才消失。
 *
 * 颜色走主题 token(规则 16):error 语义豁免色 --error-bg / --error-border /
 * --error-fg / --error-fg-strong(与 ErrorMessageCard 同组),不硬编码 Tailwind red。
 */

import { useState } from 'react';
import { CirclePause, Play, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { ErrorBanner } from './ErrorBanner';

export function InterruptedTurnBanner({
  onContinue,
  onDismiss,
  className,
  style,
}: {
  /** 「继续任务」——上层负责发送隐藏续跑指令并隐藏本条。 */
  onContinue: () => Promise<void> | void;
  /** 「忽略」——上层负责持久化 dismissed 并隐藏本条。 */
  onDismiss: () => void;
  className?: string;
  style?: React.CSSProperties;
}) {
  const { t } = useTranslation();
  const [sending, setSending] = useState(false);

  const handleContinue = async () => {
    if (sending) return;
    setSending(true);
    try {
      await onContinue();
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className={cn(
        'mx-auto flex select-none items-start gap-2 rounded-md px-3 py-2',
        'border bg-[var(--error-bg)] border-[var(--error-border)]',
        className,
      )}
      style={style}
      data-testid="interrupted-turn-banner"
      data-banner-kind="interrupted"
    >
      <CirclePause size={14} className="shrink-0 mt-[2px] text-[var(--error-fg)]" />
      <span className="flex-1 min-w-0 text-xs break-all text-[var(--error-fg)]">
        {t('chat.interruptedBanner.text')}
      </span>
      <button
        type="button"
        onClick={() => void handleContinue()}
        disabled={sending}
        className={cn(
          'shrink-0 flex items-center gap-1 text-xs font-medium',
          'text-[var(--error-fg-strong)]',
          'hover:opacity-70 transition-opacity',
          'disabled:opacity-50 disabled:cursor-not-allowed',
        )}
        title={t('chat.interruptedBanner.continueTitle')}
      >
        <Play size={12} />
        {sending ? t('chat.interruptedBanner.continuing') : t('chat.interruptedBanner.continueAction')}
      </button>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 text-[var(--error-fg)] opacity-60 hover:opacity-100 transition-opacity"
        title={t('chat.interruptedBanner.dismissTitle')}
      >
        <X size={14} />
      </button>
    </div>
  );
}

/** ErrorBanner 的 retryText 只是显示 Retry 的非空 typed token,onRetry 忽略它。 */
const ERROR_TAIL_RETRY_TOKEN = '__xdt_error_tail_continue__';

export function ErrorTailErrorBanner({
  errorText,
  onContinue,
  onDismiss,
  agentKind,
  remoteHostId,
  deviceLinkDeviceId,
  modelId,
  providerId,
  silentEncryptedRetryEnabled,
  onForkStripEncrypted,
  forkStripEncryptedRunning,
  errorReason,
  onSilentStopContinue,
  className,
  style,
}: {
  /** 持久化 error 行的 **raw** 文案(只解码 bracket code,不 i18n 化)——
   *  ErrorBanner 的不可重试门控靠对原文的正则命中。 */
  errorText: string;
  onContinue: () => Promise<void> | void;
  onDismiss: () => void;
  agentKind?: 'cc' | 'codex';
  remoteHostId?: string;
  deviceLinkDeviceId?: string | null;
  modelId?: string;
  providerId?: string | null;
  silentEncryptedRetryEnabled?: boolean;
  onForkStripEncrypted?: () => void | Promise<void>;
  forkStripEncryptedRunning?: boolean;
  errorReason?: string | null;
  onSilentStopContinue?: () => void;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <ErrorBanner
      error={errorText}
      errorReason={errorReason}
      retryText={ERROR_TAIL_RETRY_TOKEN}
      onRetry={() => void onContinue()}
      onCancel={onDismiss}
      onSilentStopContinue={onSilentStopContinue}
      agentKind={agentKind}
      remoteHostId={remoteHostId}
      deviceLinkDeviceId={deviceLinkDeviceId}
      modelId={modelId}
      providerId={providerId}
      silentEncryptedRetryEnabled={silentEncryptedRetryEnabled}
      onForkStripEncrypted={onForkStripEncrypted}
      forkStripEncryptedRunning={forkStripEncryptedRunning}
      className={className}
      style={style}
    />
  );
}
