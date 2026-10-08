/**
 * 打开某个供应商的分享管理页：设置 → 模型供应商，带一次性参数 `shareProvider=<id>`。
 * ProvidersSection 就绪后消费并从 URL 摘除(与 `connect` 深链同一做法)。
 */
export const PROVIDER_SHARE_MANAGE_PARAM = 'shareProvider';

export function providerShareManagePath(providerId: string): string {
  const params = new URLSearchParams({ tab: 'providers', [PROVIDER_SHARE_MANAGE_PARAM]: providerId });
  return `/settings?${params.toString()}`;
}
