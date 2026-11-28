import type { TFunction } from 'i18next';
import type { NoticeExplainContent } from '@/components/ui/notice-explain-popover';

export type ChatErrorExplainKind =
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

/**
 * 解析可用于面向用户错误文案点名的**外部模型供应商**名称：
 * - Cindy AI / XD 网关（`providerId === 'xd'` 或名称为 Cindy AI）返回 undefined，
 *   走通用保底「模型供应商」，避免把上游模型侧异常归咎到 Cindy；
 * - Anthropic / OpenAI 订阅连接固定返回品牌名 `'Anthropic'` / `'OpenAI'`，
 *   不泄漏本机订阅连接别名或邮箱；
 * - 显式第三方供应商（如 OpenRouter）在当前 providers 目录中可查到时返回展示名；
 *   查不到的未知/已删除 id 返回 undefined，绝不把内部 id 暴露给用户。
 */
export function resolveExternalErrorProviderName({
  providerId,
  providerName,
  providers,
}: {
  providerId?: string | null;
  providerName?: string | null;
  providers?: readonly { id: string; name?: string | null; auth?: { native?: string } }[];
}): string | undefined {
  const id = providerId?.trim() || null;
  if (id === 'xd') return undefined;

  if (id === 'anthropic') return 'Anthropic';
  if (id === 'openai') return 'OpenAI';

  if (id && providers?.length) {
    const matched = providers.find((item) => item.id === id);
    if (matched) {
      if (matched.auth?.native === 'claude') return 'Anthropic';
      if (matched.auth?.native === 'codex') return 'OpenAI';
      const trimmed = matched.name?.trim();
      if (trimmed && !CINDY_GATEWAY_NAME_RE.test(trimmed)) return trimmed;
      return undefined;
    }
  }

  const explicit = providerName?.trim();
  if (explicit && !CINDY_GATEWAY_NAME_RE.test(explicit)) return explicit;
  return undefined;
}

/** 构造「了解原因」浮层的结构化内容。 */
export function buildChatErrorExplain(
  kind: ChatErrorExplainKind,
  t: TFunction,
  options?: { providerName?: string; status?: string },
): NoticeExplainContent {
  const provider = options?.providerName?.trim() || undefined;
  const status = options?.status;
  const vars: Record<string, string> = {
    ...(provider ? { provider } : {}),
    ...(status ? { status } : {}),
  };

  const prefix = `chat.errorExplain.${kind}`;
  const summaryKey =
    kind !== 'failedSamplingAttempt' && provider
      ? `${prefix}.summaryWithProvider`
      : `${prefix}.summary`;

  return {
    title: t(`${prefix}.title`, vars),
    summary: t(summaryKey, vars),
    causesTitle: t('chat.modelMismatch.infoCausesTitle'),
    causes: [t(`${prefix}.cause1`, vars), t(`${prefix}.cause2`, vars)],
    actionsTitle: t('chat.modelMismatch.infoActionsTitle'),
    actions: [t(`${prefix}.action1`, vars), t(`${prefix}.action2`, vars)],
  };
}
