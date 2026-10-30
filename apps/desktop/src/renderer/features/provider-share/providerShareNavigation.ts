/**
 * 打开某个供应商的分享管理页：设置 → 模型供应商，带一次性参数 `shareProvider=<id>`。
 * ProvidersSection 就绪后消费并从 URL 摘除(与 `connect` 深链同一做法)。
 */
export const PROVIDER_SHARE_MANAGE_PARAM = 'shareProvider';

/** 打开「分享给我的供应商」里的某一条：一次性参数 `receivedShare=<shareId>`，消费方式同上。 */
export const PROVIDER_SHARE_RECEIVED_PARAM = 'receivedShare';

export function providerShareManagePath(providerId: string): string {
  const params = new URLSearchParams({ tab: 'providers', [PROVIDER_SHARE_MANAGE_PARAM]: providerId });
  return `/settings?${params.toString()}`;
}

/** 设置 → 模型供应商；给了分享 id 就直接选中那条分享来的供应商。 */
export function providersSettingsPath(target?: { shareId: string }): string {
  const params = new URLSearchParams({ tab: 'providers' });
  if (target) params.set(PROVIDER_SHARE_RECEIVED_PARAM, target.shareId);
  return `/settings?${params.toString()}`;
}
