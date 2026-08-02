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

/** exported for testing;正常订阅路径在 installProviderUpstreamErrorToastListener()。 */
export function handleProviderUpstreamError(payload: ProviderUpstreamErrorPayload): void {
  const message = i18n.t(`providerError.${payload.code}`, {
    defaultValue: i18n.t('providerError.UNKNOWN'),
  });
  const text = i18n.t('providerError.upstreamToast', {
    provider: payload.providerName ?? payload.providerId,
    message,
  });
  if (payload.retryable) toast.warning(text);
  else toast.error(text);
}

/** 在 renderer 启动期挂一次(App.tsx);返回 unsubscribe 供 useEffect cleanup。 */
export function installProviderUpstreamErrorToastListener(): () => void {
  return window.electronAPI.maker.onProviderUpstreamError(handleProviderUpstreamError);
}
