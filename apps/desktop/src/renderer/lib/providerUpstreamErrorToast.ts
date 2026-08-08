/**
 * providerUpstreamErrorToast — 自定义供应商上游错误(main proxy 观察器分类广播)的 toast 呈现。
 *
 * 设计要点(对齐 systemNetworkErrorToast 模式):
 * - main 侧已按 (providerId, code) 30s 节流,这里不再二次节流;
 * - 文案走 i18n `providerError.<code>`(分类人话 + 行动建议),外层包
 *   `providerError.upstreamToast` 标明是哪个供应商;
 * - retryable(限流/网络/5xx)用 warning 级——请求会话内自然重试/可手动重试;
 *   不可重试(key 无效/模型不存在/wire 不兼容)用 error 级——需要用户去设置页修配置。
 */

import { i18n } from '@/i18n';

import { toast } from './toast';

import type { ProviderErrorCode } from '../../shared/providerErrors';

interface ProviderUpstreamErrorPayload {
  agent: 'claude-code' | 'codex' | 'pi';
  providerId: string;
  providerName?: string;
  code: ProviderErrorCode;
  retryable: boolean;
  status: number;
  detail?: string;
}

function formatDiagnostics(payload: ProviderUpstreamErrorPayload): string {
  const lines = [
    'Cindy provider error',
    `Time: ${new Date().toISOString()}`,
    `Agent: ${payload.agent}`,
    `Provider: ${payload.providerName ?? payload.providerId}`,
    `Code: ${payload.code}`,
    `HTTP status: ${payload.status}`,
    `Retryable: ${payload.retryable ? 'yes' : 'no'}`,
  ];
  if (payload.detail) lines.push(`Detail: ${payload.detail}`);
  return lines.join('\n');
}

function unknownErrorActions(payload: ProviderUpstreamErrorPayload) {
  return [
    {
      label: i18n.t('providerError.openLogs'),
      onClick: async () => {
        try {
          const result = await window.electronAPI.openLogsDir();
          if (!result.success) toast.error(result.error || i18n.t('providerError.openLogsFailed'));
        } catch {
          toast.error(i18n.t('providerError.openLogsFailed'));
        }
      },
    },
    {
      label: i18n.t('providerError.copyDiagnostics'),
      onClick: async () => {
        try {
          await navigator.clipboard.writeText(formatDiagnostics(payload));
          toast.success(i18n.t('providerError.diagnosticsCopied'));
        } catch {
          toast.error(i18n.t('providerError.copyDiagnosticsFailed'));
        }
      },
    },
  ];
}

/** exported for testing;正常订阅路径在 installProviderUpstreamErrorToastListener()。 */
export function handleProviderUpstreamError(payload: ProviderUpstreamErrorPayload): void {
  const message = i18n.t(`providerError.${payload.code}`, {
    defaultValue: i18n.t('providerError.UNKNOWN'),
  });
  const text = i18n.t('providerError.upstreamToast', {
    provider: payload.providerName ?? payload.providerId,
    message,
  });
  if (payload.code === 'UNKNOWN') {
    const options = { actions: unknownErrorActions(payload) };
    if (payload.retryable) toast.warning(text, options);
    else toast.error(text, options);
    return;
  }
  if (payload.retryable) toast.warning(text);
  else toast.error(text);
}

export { formatDiagnostics };

/** 在 renderer 启动期挂一次(App.tsx);返回 unsubscribe 供 useEffect cleanup。 */
export function installProviderUpstreamErrorToastListener(): () => void {
  return window.electronAPI.maker.onProviderUpstreamError(handleProviderUpstreamError);
}
