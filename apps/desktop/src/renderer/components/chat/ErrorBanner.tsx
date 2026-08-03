/**
 * ErrorBanner — 错误横幅 + Retry / Cancel
 * ---------------------------------------------------------------------------
 * 显示当前 session 的错误信息。
 * - Retry：只使用上层传入的 retryText。这里不能从 messages[] 里猜最后一条
 *          user，因为排队发送时 messages[] 里的 user 已经发给 agent 了；
 *          猜错会把已发送内容再次塞回队列。
 *          找不到安全 retryText 时隐藏 Retry。
 * - Cancel：调用 onCancel()，让上层把 error 状态清掉（仅关掉横幅，不撤回任何东西）。
 * - 远端 codex 401 / Missing bearer:识别为 auth.json 缺失,换上"同步登录态"按钮 +
 *   友好文案。点击同步成功后 Retry 按钮重新出现,用户自行点击重发。
 *   (auth 缺失场景 Retry 立刻重发等于撞同一个 401,所以同步前先把 Retry 隐藏。)
 */

import { useEffect, useState } from 'react';
import {
  AlertCircle,
  Check,
  GitFork,
  Play,
  RotateCcw,
  RefreshCw,
  Timer,
  Wallet,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { Spinner } from '@/components/ui/spinner';
import { extractIpcError } from '@/utils/ipcError';
import { buildCodexSyncWarning } from '@/utils/codexAuthSync';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { useCodexRuntimeRoute } from '@/hooks/useCodexRuntimeRoute';
import { isChatGptConnectionConnected, useCodexAuth } from '@/hooks/useCodexAuth';
import {
  isCodexSessionExpiredError,
  useCodexSessionExpiredPrompt,
} from '@/hooks/useCodexSessionExpiredPrompt';
import { cn } from '@/lib/utils';
import { isInvalidEncryptedContentError } from '@/utils/encryptedContentError';
import { isNetworkishErrorMessage, parseReconnectAttemptMessage } from '@/utils/networkError';
import { isOverloadErrorMessage, parseOverloadRetryProgress } from '@/utils/overloadError';
import { isQuotaExhaustedErrorMessage } from '@/utils/quotaError';
import { CLAUDE_GATEWAY_OPUS_PLAN_MISMATCH_REASON } from '../../../shared/claudeGatewayError';
import { isPiImageInputUnsupportedError } from '../../../shared/inputError';

interface ErrorBannerProps {
  error: string;
  /** terminal error 的稳定 reason key。'silent-stop-exhausted'(silent-stop 自动
   *  续跑额度耗尽)时隐藏 Retry、改显「继续」按钮(onSilentStopContinue)。 */
  errorReason?: string | null;
  retryText?: string | null;
  onRetry: (text: string) => void;
  onCancel?: () => void;
  /** silent-stop 耗尽横幅「继续」:清横幅 + 发隐藏续跑指令(见 makerChatStore)。 */
  onSilentStopContinue?: () => void;
  /** 账号用量限制：打开预填好的一次性 Automation，由用户确认后创建。 */
  onContinueAfterUsageReset?: () => void;
  /** 当前 session 的 agent kind。codex 的 401 / Missing bearer 必须 hide Retry,
   *  否则 retry 撞同一个 in-memory auth retry-loop 产生重复失败 turn。 */
  agentKind?: 'cc' | 'codex' | 'pi';
  /** 当前 session 的远端 host id;非空 + agentKind='codex' 时显「同步登录态」按钮。
   *  本地 codex 401 仍 hide Retry, 但只能提示用户去自己 fix login (没有 sync 入口)。 */
  remoteHostId?: string;
  /** device-link 被控端设备 id。非空表示 turn 不在本机执行，本机认证恢复入口必须禁用。 */
  deviceLinkDeviceId?: string | null;
  /** 当前 session 的 model id。折扣版 GPT (budget, `codex/` 前缀) 报错时,在通用
   *  错误文案后追加一句「可切到普通版 GPT 试试」的引导 (折扣版走 gateway, 偶发
   *  限流/不可用时,普通版往往能正常出)。仅对没有专属引导的通用错误分支生效,
   *  避免和 auth/stale/encrypted 等分支的具体指引打架。 */
  modelId?: string;
  /** 当前会话显式选择的模型来源。OpenAI 重连只能处理 openai / 无显式来源的历史会话；
   * 其它 provider 的 OAuth 错误必须留给对应来源处理。 */
  providerId?: string | null;
  /** XD Gateway 返回了误导性的 Claude Pro/Opus 套餐错误时，切到已连接的
   * Claude.ai 订阅来源并重试本轮。未连接 Anthropic 时不提供此操作。 */
  onSwitchToClaudeSubscription?: () => Promise<void>;
  /**
   * 打开「用量和计费」查看余额并充值。**只有在计费面对当前账号可见时**（cloud +
   * personal，判据 `canAccessBillingSettings`）父组件才传它 —— 判定留在有 Auth
   * 上下文的父组件里，横幅只负责「有出口就给出口」。为空即视为没有可跳的地方：
   * 此时余额不足的错误保持原样文案、不加按钮（加一个点不出结果的按钮比不加更糟）。
   */
  onViewBalance?: () => void;
  /**
   * **产生这条错误的** provider(错误发生时刻的快照)。余额分类只认它,不认上面的
   * `providerId` —— providerId 是会话当前值,任务中途可切换并持久化:历史错误恢复
   * 或报错后切换 provider 时,用当前值会把别家的 insufficient_quota 误判成 Cindy AI
   * 余额不足(或反向丢失充值入口)。null/undefined = 来源不明,不启用余额分类。
   * live 路径由父组件在错误出现时刻快照;持久化路径读 error 行自带的 errorProviderId。
   */
  errorSourceProviderId?: string | null;
  silentEncryptedRetryEnabled?: boolean;
  onForkStripEncrypted?: () => void | Promise<void>;
  forkStripEncryptedRunning?: boolean;
  /** 当前 error 是非终止的 recoverableError(turn 还在跑,agent/daemon 在自动
   *  重试,如 codex 网络 retry-loop 透出)。网络类分支据此区分文案:「正在自动
   *  重试…」vs「服务暂时不可达,可点击重试」。历史尾部行恒为 false。 */
  isRecoverable?: boolean;
  style?: React.CSSProperties;
  className?: string;
}

export function ErrorBanner({
  error,
  errorReason,
  retryText,
  onRetry,
  onCancel,
  onSilentStopContinue,
  onContinueAfterUsageReset,
  agentKind,
  remoteHostId,
  deviceLinkDeviceId,
  modelId,
  providerId,
  onSwitchToClaudeSubscription,
  onViewBalance,
  errorSourceProviderId,
  silentEncryptedRetryEnabled = false,
  onForkStripEncrypted,
  forkStripEncryptedRunning = false,
  isRecoverable = false,
  style,
  className,
}: ErrorBannerProps) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const promptCodexSessionExpired = useCodexSessionExpiredPrompt({
    // 横幅已说明影响范围；用户点击“重新连接 ChatGPT”后直接进入浏览器连接流程，
    // 不再叠一层重复确认弹窗。
    confirmBeforeLogin: false,
  });
  // SSH 与 device-link 是两种互斥的远端来源，但都不能读取或修复控制端本机认证。
  // 保留具体 id 而不是只传 boolean，SSH Codex 仍可使用既有的定向凭证同步入口。
  const isAnyRemoteSession = Boolean(remoteHostId) || Boolean(deviceLinkDeviceId);
  // 本会话 codex app-server 的 spawn 鉴权注入(oauth-bearer = 走订阅 / env-key = 走网关 / provider-oauth = proxy 注入供应商 OAuth)。
  // 默认 'env-key'(保守):真值未回来前不会误命中 OAuth 引导分支而短暂 hide Retry。
  const { authInjection: codexAuthInjection } = useCodexRuntimeRoute({
    enabled: agentKind === 'codex' && !isAnyRemoteSession,
  });
  const [syncing, setSyncing] = useState(false);
  // 已同步标志:点击同步成功后置 true, 让 displayError 切换成"已同步,请重试"提示,
  // 同时把 Retry 按钮显出来。
  const [syncedSinceError, setSyncedSinceError] = useState(false);
  // 防御性 reset: 当前流程下 Retry 会清 error → ErrorBanner unmount → 自然丢 state。
  // 但若未来父组件改造保留 mount 仅切 error / 切远端来源, 这条 useEffect
  // 让 syncedSinceError 跟当前错误关联, 避免 stale 标志让新错误显示成"已同步"。
  useEffect(() => {
    setSyncedSinceError(false);
  }, [error, isAnyRemoteSession, remoteHostId]);

  // 凭证切换忙:本会话要求的模型来源与共享 codex 进程当前钥匙形态不同,重启进程前
  // 必须等其它本地 Codex 任务全部结束。main 侧用 CREDENTIAL_SWITCH_BUSY: 前缀编码
  // (makerSendTransaction),这里换成可操作文案;Retry 保留 —— 其它任务结束后重试即成功。
  const isCredentialSwitchBusy = error.startsWith('CREDENTIAL_SWITCH_BUSY:');
  // Codex 单例 app-server 切换鉴权模式(或服务重启)后,旧会话的 thread 随旧进程销毁,
  // 续聊会撞 codex 'thread not found'。把这个看不懂的协议错换成可操作的友好提示:
  // 新建会话即可在新模式下生效(重开本会话走 thread/resume 也可)。'thread not found'
  // 是 codex 专属措辞,不会误伤 Claude 的错误。
  const isCodexThreadStale = /thread not found/i.test(error);
  // 仅本地 Codex 会话:远端会话 rollout 在远端机器, 本地 fork 剥离做不到, 不给入口。
  const showInvalidEncryptedContentRecovery =
    agentKind === 'codex' &&
    !isAnyRemoteSession &&
    !silentEncryptedRetryEnabled &&
    isInvalidEncryptedContentError(error);
  // Codex 401 auth-missing detection 分三层:
  //  - isCodexAuthMissing: codex session + 401/Missing bearer pattern。
  //  - isCodexRemoteAuthMissing: 远端 codex + 上面命中 → 显「同步登录态」按钮。
  //  - isCodexLocalOAuthAuthMissing: 本地 codex + oauth-bearer spawn(走订阅) + 401 → hide
  //    Retry + 引导 user codex login。**env-key spawn(走网关)不命中**: 网关 401 通常是 gateway
  //    key 过期 / rate-limit / proxy 故障, makerChatStore 已经在 401 时自动 refresh
  //    gateway key, retry 即可恢复; 强行 hide Retry + 显 "codex login" 反而误导。
  // 父组件 (CCAgentSessionView) 必须只对 codex session 传 agentKind='codex' +
  // remoteHostId; Claude session 的 401 走默认 retry 流程不应被吞。
  // xAI / 自定义来源的真实凭证由 provider-oauth proxy 注入；显式 providerId 是权威来源，
  // 不能因为错误文案碰巧含 token_revoked 就引导用户去修 ChatGPT 登录态。历史无来源
  // 会话仍允许从非 provider-oauth runtime + 非 XD/xAI 前缀推断 OpenAI，守住旧数据兼容。
  const normalizedProviderId = providerId?.trim() || null;
  // Cindy AI 网关的余额耗尽:钱花完那一刻是用户最需要计费页的时刻,给一条能就地
  // 跳过去的出口。判定绑定**错误来源** provider(errorSourceProviderId,错误发生
  // 时刻的快照),不用会话当前的 providerId —— 报错后切换 provider / 恢复历史错误
  // 时两者会分叉,用当前值会误判来源。来源不明确(null)或非 xd 的错误一个字都不改
  // (保持原始上游文案与既有交互):没有可跳的余额页时,给按钮点不出结果比不给更糟。
  const isGatewayQuotaExhausted =
    (errorSourceProviderId?.trim() || null) === 'xd' &&
    Boolean(onViewBalance) &&
    isQuotaExhaustedErrorMessage(error);
  const hasExplicitOpenAiProvider = normalizedProviderId === 'openai';
  const hasImplicitOpenAiProvider =
    normalizedProviderId === null &&
    codexAuthInjection !== 'provider-oauth' &&
    !modelId?.startsWith('codex/') &&
    !modelId?.startsWith('xai/');
  const isCodexOpenAiSource =
    agentKind === 'codex' && (hasExplicitOpenAiProvider || hasImplicitOpenAiProvider);
  // Pattern: 跟 translator.ts:180 一致, 收紧到 \b401\b | Missing bearer 避开
  // "Unauthorized file system access" 等非 HTTP-auth 误伤。
  const isCodexAuthMissing =
    agentKind === 'codex' && isCodexOpenAiSource && /\b401\b|Missing bearer/i.test(error);
  const isCodexRemoteAuthMissing = isCodexAuthMissing && !!remoteHostId;
  const isCodexLocalOAuthAuthMissing =
    isCodexAuthMissing && !isAnyRemoteSession && codexAuthInjection === 'oauth-bearer';
  // 明确的 OpenAI token/session invalidation 不可直接 Retry。Codex 路径不再要求当前
  // runtime route 仍是 oauth-bearer：invalidate 会先收割旧 host 并把 route 广播成
  // env-key，再把错误渲染到会话；继续依赖 route 会把真实失效原因漏成原始英文报错。
  // Claude 的 chatgpt/* 模型复用同一份连接，bridge 鉴权不可用时也走同一恢复入口。
  const isClaudeChatgptBridgeModel =
    agentKind === 'cc' &&
    (hasExplicitOpenAiProvider || normalizedProviderId === null) &&
    !!modelId &&
    modelId.startsWith('chatgpt/');
  const isOpenAiConnectionExpired =
    !isAnyRemoteSession &&
    ((isCodexOpenAiSource && isCodexSessionExpiredError(error)) ||
      (isClaudeChatgptBridgeModel && isCodexSessionExpiredError(error)));
  // 以共享的 Codex OAuth 状态机为唯一真相源：设置页、横幅或其它入口完成重连时，
  // AUTH_STATE_CHANGED 都会让现存横幅同步恢复 Retry；后续失效 / 登出广播也会撤销恢复态。
  // 非连接错误期间暂停订阅时 hook 会同时清掉旧快照；下次失效先保持“需重连”，直到
  // 新 getState() 或广播确认已恢复，避免跨 error 复用过期的 authenticated 状态。
  const {
    state: openAiAuthState,
    reconnectCredentialScope,
    recoveryCheck: openAiRecoveryCheck,
    refresh: refreshOpenAiAuth,
  } = useCodexAuth({
    enabled: isOpenAiConnectionExpired,
    recoveryHint: isOpenAiConnectionExpired ? { reason: error } : undefined,
  });
  const openAiConnectionRecoveredSinceError =
    isOpenAiConnectionExpired && isChatGptConnectionConnected(openAiAuthState, false);
  const openAiReconnectRequired = isOpenAiConnectionExpired && !openAiConnectionRecoveredSinceError;
  const openAiAuthLoading = openAiAuthState.kind === 'loading';
  const openAiLoginPending = openAiAuthState.kind === 'login-pending';
  const openAiRecoveryBusy =
    openAiAuthLoading || openAiRecoveryCheck === 'checking' || openAiLoginPending;
  const openAiCredentialScope =
    openAiAuthState.kind === 'reconnect-required'
      ? (openAiAuthState.credentialScope ?? 'unknown')
      : (reconnectCredentialScope ?? 'unknown');
  // 网络类错误(502/连接失败/fetch failed 等):友好文案 + 原始错误折叠可查。
  // Codex `Reconnecting... N/M` 额外解析次数，让 recoverable 状态持续更新而非裸英文。
  const reconnectAttempt = parseReconnectAttemptMessage(error);
  const isNetworkishError = reconnectAttempt !== null || isNetworkishErrorMessage(error);
  // 服务过载(模型容量不足 / 上游 529):与网络类分开判定——把容量问题说成"网络
  // 异常"会让用户白折腾自己的网络。带 `(auto-retry N/M)` 后缀 = 仍在自动重试。
  //
  // 判定优先吃 errorReason 的稳定 key(maker-core 的 UPSTREAM_OVERLOAD_REASON):
  // Codex 的容量文案是它二进制里硬编码的提示语, 改一次措辞就会让这里退回英文原文,
  // 而这条判定驱动的正是本地化文案、重试进度与 hideRetry。文案匹配保留作兜底
  // (老 daemon / Anthropic 侧 / 历史持久化错误行 —— 后者只有文案可用)。
  const isOverloadError = isOverloadErrorMessage(error, undefined, errorReason);
  const overloadRetryProgress = parseOverloadRetryProgress(error);
  // Retry 的显示条件与网络错误文案必须共用同一个判定。外部发起的 turn（例如
  // scheduler / goal）失败时没有安全的 recovery target，errorRetryText 会是 null；
  // 此时不能一边隐藏按钮，一边仍提示用户“点击重试”。
  const isSilentStopExhausted = errorReason === 'silent-stop-exhausted';
  const isClaudeGatewayOpusPlanMismatch = errorReason === CLAUDE_GATEWAY_OPUS_PLAN_MISMATCH_REASON;
  const hideRetry =
    isSilentStopExhausted ||
    isClaudeGatewayOpusPlanMismatch ||
    isCodexThreadStale ||
    showInvalidEncryptedContentRecovery ||
    (isCodexRemoteAuthMissing && !syncedSinceError) ||
    openAiReconnectRequired ||
    isCodexLocalOAuthAuthMissing;
  const safeRetryText = !hideRetry && retryText ? retryText : null;
  const [showRawNetworkError, setShowRawNetworkError] = useState(false);
  const [switchingClaudeSubscription, setSwitchingClaudeSubscription] = useState(false);
  useEffect(() => {
    setShowRawNetworkError(false);
    setSwitchingClaudeSubscription(false);
  }, [error]);

  // hasSpecialGuidance: 是否命中下面任一「有专属可操作指引」的特殊分支。用一个在
  // else 兜底里翻转的标志, 而不是另写一遍 5 个条件取反 —— 将来新增特殊分支只要照常
  // 加 else if, 标志自动保持 true, 折扣版提示不会误叠加 (无需记得同步维护条件表)。
  let displayError: string;
  let hasSpecialGuidance = true;
  if (isPiImageInputUnsupportedError(error)) {
    displayError = t('ipcError.PI_IMAGE_INPUT_UNSUPPORTED');
  } else if (isCredentialSwitchBusy) {
    displayError = t('chat.errorBanner.credentialSwitchBusy');
  } else if (isCodexThreadStale) {
    displayError = t('chat.errorBanner.codexThreadStale');
  } else if (showInvalidEncryptedContentRecovery) {
    displayError = t('chat.errorBanner.invalidEncryptedContent');
  } else if (isCodexRemoteAuthMissing) {
    displayError = syncedSinceError
      ? t('chat.errorBanner.codexAuthSynced')
      : t('chat.errorBanner.codexAuthMissing');
  } else if (isOpenAiConnectionExpired) {
    displayError = openAiConnectionRecoveredSinceError
      ? t('chatgptAuthRecovery.recovered')
      : t(
          openAiCredentialScope === 'system-shared'
            ? 'chatgptAuthRecovery.systemSharedInvalidated'
            : openAiCredentialScope === 'instance-isolated'
              ? 'chatgptAuthRecovery.instanceIsolatedInvalidated'
              : 'chatgptAuthRecovery.unknownInvalidated',
        );
  } else if (isCodexLocalOAuthAuthMissing) {
    displayError = t('chat.errorBanner.codexAuthMissingLocal');
  } else if (isClaudeGatewayOpusPlanMismatch) {
    displayError = t('chat.errorBanner.claudeGatewayOpusPlanMismatch');
  } else if (isGatewayQuotaExhausted) {
    // 「配额或余额不足，请检查供应商账户」对网关用户是半句话:账户就在 Cindy 里,
    // 该说的是「去充值」而不是「去检查」。右端的内联出口负责「去哪充」。
    displayError = t('chat.errorBanner.gatewayQuotaExhausted');
  } else if (isOverloadError) {
    // 服务过载:上游模型没有可用容量。原始英文("Selected model is at capacity")
    // 对用户没有行动价值,换成友好文案 + 明确的下一步;原始错误折叠可查。
    // 放在网络类之前:两者都可能重试自愈,但只有这里该建议"换模型"。
    // 终态文案刻意**不**声称"多次重试仍未成功": 走到终态的原因不止"预算耗尽",
    // 还包括"本 turn 已有产出所以不重投"以及接管条件不满足(如 daemon 自己已经
    // retry 很久后升级成终态)。那些情况下一次自动重试都没发生过, 说"重试多次"
    // 是假信息(review #844 codex P1)。真的重试过时用户也已经在退避窗口里逐帧看过
    // 「正在自动重试（N/M）」, 信息不丢。两个分支只按"有没有重试按钮"给不同下一步。
    displayError = overloadRetryProgress
      ? t('chat.errorBanner.overloadRetrying', {
          attempt: overloadRetryProgress.attempt,
          maxAttempts: overloadRetryProgress.maxAttempts,
        })
      : t(safeRetryText ? 'chat.errorBanner.overloadBusy' : 'chat.errorBanner.overloadBusyNoRetry');
  } else if (isNetworkishError) {
    // 网络类错误:原始英文报错(502/ECONNREFUSED/fetch failed 等)对用户没有
    // 行动价值,换成友好文案;原始错误折叠可查(下方「查看原始错误」)。
    // 非终止(isRecoverable,daemon 自动重试中)与终止(可点重试)文案区分。
    // 放在所有专属指引分支之后:401 等更具体的分支优先。
    displayError = isRecoverable
      ? reconnectAttempt
        ? t('chat.errorBanner.networkReconnecting', {
            attempt: reconnectAttempt.attempt,
            maxAttempts: reconnectAttempt.maxAttempts,
          })
        : t('chat.errorBanner.networkAutoRetrying')
      : t(
          safeRetryText
            ? 'chat.errorBanner.networkUnreachable'
            : 'chat.errorBanner.networkUnreachableNoRetry',
        );
  } else {
    displayError = error;
    hasSpecialGuidance = false;
  }

  // 折扣版 GPT (budget, `codex/` 前缀) 走 gateway, 偶发限流 / 后端不可用时, 普通版
  // 往往能正常出。仅在通用错误分支 (上面没命中任何特殊分支) 追加一句切普通版的引导
  // —— auth/stale/encrypted/session-expired 分支各自已有指引, 叠加会噪 / 打架。
  // budget 判定与全项目一致: `codex/` 前缀。
  // 例外:网络类分支(终止态)仍叠加 —— 折扣版 gateway 挂掉恰恰多表现为 502 /
  // upstream unreachable,「切普通版试试」对症;自动重试中不叠(用户无需行动)。
  // 过载类同理叠加:折扣版 gateway 的容量往往比官方版更紧,「切普通版试试」对症。
  // 仍在自动重试时不叠(用户无需行动)——判据是有没有进度后缀,而不是 isRecoverable:
  // 预算耗尽后的终止错误没有后缀,那时才该给建议。
  const isBudgetModel = !!modelId && modelId.startsWith('codex/');
  const showBudgetHint =
    isBudgetModel &&
    (!hasSpecialGuidance ||
      (isNetworkishError && !isRecoverable) ||
      (isOverloadError && !overloadRetryProgress));

  const handleSwitchToClaudeSubscription = async (): Promise<void> => {
    if (!onSwitchToClaudeSubscription || switchingClaudeSubscription) return;
    setSwitchingClaudeSubscription(true);
    try {
      await onSwitchToClaudeSubscription();
    } catch (e) {
      const ipcErr = extractIpcError(e);
      const msg = ipcErr?.message ?? (e instanceof Error ? e.message : String(e));
      toast.error(t('chat.errorBanner.claudeSubscriptionSwitchFailed', { msg }));
    } finally {
      setSwitchingClaudeSubscription(false);
    }
  };

  const handleOpenAiRecovery = async (): Promise<void> => {
    if (openAiRecoveryBusy) return;
    if (openAiRecoveryCheck === 'failed') {
      await refreshOpenAiAuth();
      return;
    }
    if (openAiCredentialScope === 'system-shared') {
      try {
        const result = await window.electronAPI.openChatGPTApp();
        if (!result.success) toast.error(t('chatgptAuthRecovery.openAppFailed'));
      } catch {
        toast.error(t('chatgptAuthRecovery.openAppFailed'));
      }
      return;
    }
    promptCodexSessionExpired(error);
  };

  // 走跟 Settings/RemoteHostDetail 同款的 check → confirm → sync 三步:
  // 1. checkCodexAuth: 探远端是否已有 auth.json (有则要 confirm 覆盖)
  // 2. 弹 confirm dialog: 显安全警告 + "共享 SSH 账号 = 凭证可能被偷"
  // 3. 用户确认 → 调 syncCodexAuth
  // 4. 看 daemonRestart.ok: false 时显软提示 (auth 推送了但 daemon 没重启,
  //    需要 reconnect 才能用新 auth) 而不是误导的 "已同步, 请重试"。
  const handleSyncAuth = async (): Promise<void> => {
    if (!remoteHostId) return;
    setSyncing(true);
    try {
      const status = await window.electronAPI.remoteSsh.checkCodexAuth(remoteHostId);
      if (!status.localExists) {
        toast.error(t('settings.remote.toast.codexSyncNoLocal'));
        return;
      }
      const description = buildCodexSyncWarning(
        remoteHostId,
        status.remoteExists,
        status.remoteMtime,
        t,
      );
      const ok = await confirm({
        title: t('settings.remote.codexSync.confirmTitle'),
        description,
        confirmText: status.remoteExists
          ? t('settings.remote.codexSync.confirmOverwrite')
          : t('settings.remote.codexSync.confirmPush'),
        cancelText: t('settings.remote.add.cancel'),
        autoFocusConfirm: false,
      });
      if (!ok) return;

      const syncResult = await window.electronAPI.remoteSsh.syncCodexAuth(remoteHostId);
      if (!syncResult.daemonRestart.ok) {
        // pkill 失败 (eg. 远端没装 pkill / 权限不足) → daemon 还在跑旧 auth, 不能
        // 让 banner 切成 "已同步, Retry" 否则 Retry 还会撞 401。提示用户去
        // reconnect (拉新 daemon)。
        toast.error(t('chat.errorBanner.syncAuthDaemonRestartFailed'));
        return;
      }
      setSyncedSinceError(true);
      toast.success(t('chat.errorBanner.syncAuthSuccess'));
    } catch (e) {
      const ipcErr = extractIpcError(e);
      const msg = ipcErr?.message ?? (e instanceof Error ? e.message : String(e));
      toast.error(t('chat.errorBanner.syncAuthFailed', { msg }));
    } finally {
      setSyncing(false);
    }
  };

  // Retry hide 条件: stale thread / 远端 auth 缺失未同步 / 本地 OAuth auth 缺失
  // (本地没 sync 入口, 用户去 codex login 再来; retry 立刻撞同样 401 没意义)。
  // **API mode 不在 hide 列表里** — gateway key 自动 refresh, retry 大概率成功。
  return (
    <div
      className={cn(
        'mx-auto flex items-start gap-2 border px-3 py-2',
        isOpenAiConnectionExpired
          ? 'rounded-xl bg-[var(--surface-elevated)] border-[var(--border-default)]'
          : 'rounded-md bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800',
        className,
      )}
      style={style}
    >
      {openAiConnectionRecoveredSinceError ? (
        <Check size={14} className="mt-[2px] shrink-0 text-[var(--text-secondary)]" />
      ) : (
        <AlertCircle
          size={14}
          className={cn(
            'mt-[2px] shrink-0',
            isOpenAiConnectionExpired
              ? 'text-[var(--settings-integration-warning)]'
              : 'text-red-500',
          )}
        />
      )}
      <div className="flex-1 min-w-0">
        <span
          className={cn(
            'block break-all text-xs',
            isOpenAiConnectionExpired
              ? 'text-[var(--text-secondary)]'
              : 'text-red-600 dark:text-red-400',
          )}
        >
          {displayError}
        </span>
        {showBudgetHint && (
          <span className="mt-0.5 block text-xs text-red-600 dark:text-red-400 break-all">
            {t('chat.errorBanner.budgetModelHint')}
          </span>
        )}
        {(isNetworkishError || isOverloadError || isClaudeGatewayOpusPlanMismatch) && (
          // 网络类与过载类的原始错误折叠可查:友好文案替换了原文,但排障(端口/URL/
          // errno/上游原话)仍需要原文,点击展开。新增控件走 --error-fg token(规则 16;
          // 本组件其余 red-600/400 为历史存量,error 属语义豁免色但新代码仍走 token)。
          <>
            <button
              type="button"
              onClick={() => setShowRawNetworkError((v) => !v)}
              className="mt-0.5 block text-xs underline opacity-70 hover:opacity-50 transition-opacity text-[var(--error-fg)]"
            >
              {showRawNetworkError
                ? t('chat.errorBanner.networkHideRaw')
                : t('chat.errorBanner.networkShowRaw')}
            </button>
            {showRawNetworkError && (
              <span className="mt-0.5 block text-xs break-all opacity-70 text-[var(--error-fg)]">
                {error}
              </span>
            )}
          </>
        )}
      </div>
      {openAiReconnectRequired && (
        // 系统共享凭证必须回 ChatGPT App 修复；Cindy 独立凭证才启动 Cindy OAuth。
        // 登录候选出现后先走账号级服务端探测，探测成功前继续隐藏请求 Retry。
        <button
          type="button"
          onClick={() => void handleOpenAiRecovery()}
          disabled={openAiRecoveryBusy}
          className={cn(
            'shrink-0 flex select-none items-center gap-1 text-xs font-medium',
            'text-[var(--text-primary)]',
            'hover:opacity-70 transition-opacity',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
          title={t(
            openAiRecoveryCheck === 'failed'
              ? 'chatgptAuthRecovery.recheck'
              : openAiRecoveryBusy
                ? 'chatgptAuthRecovery.checking'
                : openAiCredentialScope === 'system-shared'
                  ? 'chatgptAuthRecovery.openApp'
                  : 'chatgptAuthRecovery.relogin',
          )}
        >
          <Spinner icon={RefreshCw} size={12} spinning={openAiRecoveryBusy} />
          {t(
            openAiRecoveryBusy
              ? 'chatgptAuthRecovery.checking'
              : openAiRecoveryCheck === 'failed'
                ? 'chatgptAuthRecovery.recheck'
                : openAiCredentialScope === 'system-shared'
                  ? 'chatgptAuthRecovery.openApp'
                  : 'chatgptAuthRecovery.relogin',
          )}
        </button>
      )}
      {isClaudeGatewayOpusPlanMismatch && onSwitchToClaudeSubscription && (
        <button
          type="button"
          onClick={() => void handleSwitchToClaudeSubscription()}
          disabled={switchingClaudeSubscription}
          className={cn(
            'shrink-0 flex select-none items-center gap-1 text-xs font-medium',
            'text-[var(--error-fg-strong)]',
            'hover:opacity-70 transition-opacity',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
          title={t('chat.errorBanner.switchClaudeSubscriptionTitle')}
        >
          <Spinner icon={RefreshCw} size={12} spinning={switchingClaudeSubscription} />
          {switchingClaudeSubscription
            ? t('chat.errorBanner.switchingClaudeSubscription')
            : t('chat.errorBanner.switchClaudeSubscription')}
        </button>
      )}
      {isGatewayQuotaExhausted && onViewBalance && (
        // 与「切换到 Claude.ai 并重试」同一档低打扰内联恢复动作:不弹窗、不抢焦点。
        <button
          type="button"
          onClick={onViewBalance}
          className={cn(
            'shrink-0 flex select-none items-center gap-1 text-xs font-medium',
            'text-[var(--error-fg-strong)]',
            'hover:opacity-70 transition-opacity',
          )}
          title={t('chat.errorBanner.viewBalanceTitle')}
        >
          <Wallet size={12} />
          {t('chat.errorBanner.viewBalance')}
        </button>
      )}
      {isCodexRemoteAuthMissing && !syncedSinceError && (
        <button
          type="button"
          onClick={handleSyncAuth}
          disabled={syncing}
          className={cn(
            'shrink-0 flex items-center gap-1 text-xs font-medium',
            'text-red-600 dark:text-red-400',
            'hover:opacity-70 transition-opacity',
            'disabled:opacity-50 disabled:cursor-not-allowed',
          )}
          title={t('chat.errorBanner.syncAuthTitle')}
        >
          <Spinner icon={RefreshCw} size={12} spinning={syncing} />
          {syncing ? t('chat.errorBanner.syncAuthSyncing') : t('chat.errorBanner.syncAuth')}
        </button>
      )}
      {isSilentStopExhausted && onSilentStopContinue && (
        <button
          type="button"
          onClick={onSilentStopContinue}
          className={cn(
            'shrink-0 flex items-center gap-1 text-xs font-medium',
            'text-red-600 dark:text-red-400',
            'hover:opacity-70 transition-opacity',
          )}
          title={t('chat.errorBanner.silentStopContinueTitle')}
        >
          <Play size={12} />
          {t('chat.errorBanner.silentStopContinue')}
        </button>
      )}
      {onContinueAfterUsageReset && (
        <button
          type="button"
          onClick={onContinueAfterUsageReset}
          className={cn(
            'shrink-0 flex items-center gap-1 text-xs font-medium',
            'text-[var(--error-fg)]',
            'hover:opacity-70 transition-opacity',
          )}
          title={t('chat.errorBanner.continueAfterResetTitle')}
        >
          <Timer size={12} />
          {t('chat.errorBanner.continueAfterReset')}
        </button>
      )}
      {safeRetryText && (
        <button
          type="button"
          onClick={() => onRetry(safeRetryText)}
          className={cn(
            'shrink-0 flex items-center gap-1 text-xs font-medium',
            isOpenAiConnectionExpired
              ? 'text-[var(--text-primary)]'
              : 'text-red-600 dark:text-red-400',
            'hover:opacity-70 transition-opacity',
          )}
          title={t('chat.errorBanner.retryTitle')}
        >
          <RotateCcw size={12} />
          {t('chat.errorBanner.retry')}
        </button>
      )}
      {showInvalidEncryptedContentRecovery && onForkStripEncrypted && (
        <button
          type="button"
          onClick={() => void onForkStripEncrypted()}
          disabled={forkStripEncryptedRunning}
          className={cn(
            'shrink-0 flex items-center gap-1 text-xs font-medium',
            'text-red-600 dark:text-red-400',
            'hover:opacity-70 transition-opacity',
            'disabled:opacity-50 disabled:cursor-not-allowed',
          )}
          title={t('chat.errorBanner.forkStripEncryptedTitle')}
        >
          <GitFork size={12} />
          {forkStripEncryptedRunning
            ? t('chat.errorBanner.forkStripEncryptedRunning')
            : t('chat.errorBanner.forkStripEncrypted')}
        </button>
      )}
      {/* 关闭:纯 X 图标,与 InterruptedTurnBanner / WorktreeRestoreBanner / UpgradeBanner
          的关闭按钮统一(2026-07 统一:输入框上方所有提示条的关闭一律是一个 X,不带
          文字标签)。配色走 --error-fg token,不用本文件存量的硬编码 red(规则 16,
          见上方 349 行注释)。语义由 title 承载,供 hover 与读屏。 */}
      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          className="shrink-0 text-[var(--error-fg)] opacity-60 hover:opacity-100 transition-opacity"
          title={t('chat.errorBanner.cancelTitle')}
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
