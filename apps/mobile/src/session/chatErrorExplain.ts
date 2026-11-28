import type { TFunction } from 'i18next';
import {
  isAccountUsageLimitReachedText,
  matchesDeterministicUsageExhaustionText,
  isProviderSafetyRefusalError,
  isRemoteCompactEncryptedContentError,
} from '@cindy/maker-shared/error-redaction';
import type { NoticeExplainContent } from './NoticeExplainSheet';

export type MobileChatErrorExplainKind =
  | 'providerSafetyRefusal'
  | 'overload'
  | 'streamInterrupted'
  | 'upstreamStatus'
  | 'modelAccessDenied'
  | 'providerQuotaExceeded'
  | 'usageLimit'
  | 'encryptedContent'
  | 'failedSamplingAttempt';

const CINDY_GATEWAY_NAME_RE = /^cindy(?:\s+ai)?(?:\s*·.*)?$/i;
const UPSTREAM_STATUS_5XX_RE = /\b(5\d{2})\s+status code\b/i;
const OVERLOAD_TEXT_RE = /\bat capacity\b|\bcurrently overloaded\b|\boverloaded_error\b|\b529\b/i;
const STREAM_INTERRUPTED_RE = /Response API in-stream error/i;
const INVALID_ENCRYPTED_CONTENT_RE = /invalid_encrypted_content/i;
const PAYMENT_REQUIRED_RE =
  /\bpayment\s+required\b|(?:\b(?:http|status|code|error)\b[^0-9a-z]{0,10}402\b|\(\s*402\s*\)|\b402\s+payment\s+required\b|(?:^|[\r\n])\s*402\s*:)/i;

/**
 * 解析可用于移动端错误提示点名的外部模型供应商名：
 * - `xd` / Cindy AI 网关返回 undefined，走通用保底「模型供应商」；
 * - `anthropic` / `openai` 返回品牌名，不泄漏本机订阅别名；
 * - 显式第三方名称去除首尾空白后使用（非 Cindy AI 时）。
 */
export function resolveMobileExternalProviderName({
  providerId,
  providerName,
}: {
  providerId?: string | null;
  providerName?: string | null;
}): string | undefined {
  const id = providerId?.trim() || null;
  if (id === 'xd') return undefined;
  if (id === 'anthropic') return 'Anthropic';
  if (id === 'openai') return 'OpenAI';
  const explicit = providerName?.trim();
  if (explicit && !CINDY_GATEWAY_NAME_RE.test(explicit)) return explicit;
  return undefined;
}

export function buildMobileChatErrorExplain(
  kind: MobileChatErrorExplainKind,
  t: TFunction,
  options?: { providerName?: string; status?: string },
): NoticeExplainContent {
  const provider = options?.providerName?.trim() || undefined;
  const status = options?.status;
  const vars: Record<string, string> = {
    ...(provider ? { provider } : {}),
    ...(status ? { status } : {}),
  };
  const prefix = `message.errorExplain.${kind}`;
  const summaryKey =
    kind !== 'failedSamplingAttempt' && provider
      ? `${prefix}.summaryWithProvider`
      : `${prefix}.summary`;
  return {
    title: t(`${prefix}.title`, vars),
    summary: t(summaryKey, vars),
    causesTitle: t('message.modelMismatch.infoCausesTitle'),
    causes: [t(`${prefix}.cause1`, vars), t(`${prefix}.cause2`, vars)],
    actionsTitle: t('message.modelMismatch.infoActionsTitle'),
    actions: [t(`${prefix}.action1`, vars), t(`${prefix}.action2`, vars)],
  };
}

export function isMobileOverloadError(message: string, reason?: unknown): boolean {
  if (reason === 'upstream-overload' || reason === 'UPSTREAM_OVERLOADED' || reason === 'acp-overloaded') {
    return true;
  }
  return OVERLOAD_TEXT_RE.test(message);
}

export function isMobileStreamInterruptedError(message: string, reason?: unknown): boolean {
  return reason === 'upstream-stream-interrupted' || STREAM_INTERRUPTED_RE.test(message);
}

export function parseMobileUpstreamStatus(message: string): string | null {
  const match = UPSTREAM_STATUS_5XX_RE.exec(message);
  return match ? match[1] : null;
}

export function isMobileQuotaExhaustedError(message: string): boolean {
  return matchesDeterministicUsageExhaustionText(message) || PAYMENT_REQUIRED_RE.test(message);
}

/**
 * 识别移动端错误对应的「了解原因」结构化说明；未命中 7 类模型/供应商错误时返回 null。
 */
export function resolveMobileErrorExplain(
  {
    message,
    reason,
    providerId,
    providerName,
    hasUsageLimitWait,
  }: {
    message: string;
    reason?: unknown;
    providerId?: string | null;
    providerName?: string | null;
    hasUsageLimitWait?: boolean;
  },
  t: TFunction,
): NoticeExplainContent | null {
  const trimmed = message.trim();
  if (!trimmed && !reason && !hasUsageLimitWait) return null;
  if (trimmed.startsWith('provider-rejected-before-dispatch:')) return null;

  const provider = resolveMobileExternalProviderName({ providerId, providerName });
  const reasonStr = typeof reason === 'string' ? reason : undefined;

  if (isProviderSafetyRefusalError(trimmed, reasonStr)) {
    return buildMobileChatErrorExplain('providerSafetyRefusal', t, { providerName: provider });
  }
  if (isRemoteCompactEncryptedContentError(trimmed, reason) || INVALID_ENCRYPTED_CONTENT_RE.test(trimmed)) {
    return buildMobileChatErrorExplain('encryptedContent', t, { providerName: provider });
  }
  if (reasonStr === 'user_model_access_denied') {
    return buildMobileChatErrorExplain('modelAccessDenied', t, { providerName: provider });
  }
  if (isMobileStreamInterruptedError(trimmed, reason)) {
    return buildMobileChatErrorExplain('streamInterrupted', t, { providerName: provider });
  }
  if (isMobileOverloadError(trimmed, reason)) {
    return buildMobileChatErrorExplain('overload', t, { providerName: provider });
  }
  const status = parseMobileUpstreamStatus(trimmed);
  if (status) {
    return buildMobileChatErrorExplain('upstreamStatus', t, { providerName: provider, status });
  }
  if (hasUsageLimitWait || reasonStr === 'acp-usage-limit' || isAccountUsageLimitReachedText(trimmed)) {
    return buildMobileChatErrorExplain('usageLimit', t, { providerName: provider });
  }
  if ((providerId?.trim() || null) !== 'xd' && isMobileQuotaExhaustedError(trimmed)) {
    return buildMobileChatErrorExplain('providerQuotaExceeded', t, { providerName: provider });
  }
  return null;
}
