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
  /**
   * 上游 JSON 错误体中的 `error.type`(白名单枚举,main 侧已过滤未知值)。
   * 低风险结构化字段,不含 message——message 可能回显 prompt 片段。
   */
  errorType?: string;
  /**
   * 本地代理层请求序号(anthropic-compat-proxy ResponseObserverCtx.reqId)。
   * 供用户对照日志拉取完整往返;仅 observer 路径有,桥接路径无此值。
   */
  reqId?: number;
}

/**
 * 生成可分享的诊断文本。
 *
 * 安全约束(P1):只输出 main 侧白名单过的结构化字段。`payload.detail`
 * 虽然 main 侧经 redactSensitiveText 处理过凭证,但上游 message 仍可能
 * 回显 prompt 片段,属于用户内容,不得复制到剪贴板供外部分享。
 * `occurredAt` 在收到事件时捕获,而非点击复制时,保证时间戳反映错误
 * 实际发生时刻。
 */
function formatDiagnostics(
  payload: ProviderUpstreamErrorPayload,
  occurredAt: Date,
): string {
  const lines = [
    'Cindy provider error',
    `Time: ${occurredAt.toISOString()}`,
    `Agent: ${payload.agent}`,
    `Provider: ${payload.providerName ?? payload.providerId}`,
    `Code: ${payload.code}`,
    `HTTP status: ${payload.status}`,
    `Retryable: ${payload.retryable ? 'yes' : 'no'}`,
  ];
  if (payload.errorType) lines.push(`Error type: ${payload.errorType}`);
  if (payload.reqId !== undefined) lines.push(`Request ID: ${payload.reqId}`);
  return lines.join('\n');
}

function unknownErrorActions(payload: ProviderUpstreamErrorPayload, occurredAt: Date) {
  return [
    {
      label: i18n.t('providerError.openLogs'),
      onClick: async () => {
        try {
          const result = await window.electronAPI.openLogsDir();
          // 不展示 result.error:shell.openPath 的错误串可能包含 userData
          // 绝对路径(本机隐私),只显示本地化失败文案。
          if (!result.success) toast.error(i18n.t('providerError.openLogsFailed'));
        } catch {
          toast.error(i18n.t('providerError.openLogsFailed'));
        }
      },
    },
    {
      label: i18n.t('providerError.copyDiagnostics'),
      onClick: async () => {
        try {
          await navigator.clipboard.writeText(formatDiagnostics(payload, occurredAt));
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
  // 在事件到达时(而非用户点击复制时)捕获时间戳,保证诊断时间反映错误发生时刻。
  const occurredAt = new Date();
  const message = i18n.t(`providerError.${payload.code}`, {
    defaultValue: i18n.t('providerError.UNKNOWN'),
  });
  const text = i18n.t('providerError.upstreamToast', {
    provider: payload.providerName ?? payload.providerId,
    message,
  });
  if (payload.code === 'UNKNOWN') {
    const options = { actions: unknownErrorActions(payload, occurredAt) };
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
