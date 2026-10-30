/** 本机确认卡提供的授权标记；只免除当前任务的供应商分享凭证确认。 */
export const PROVIDER_SHARE_CREDENTIAL_SESSION_APPROVAL = {
  type: 'providerShareCredentialSessionApproval',
  destination: 'session',
} as const;

/** 只接受完整的单项授权，避免把其他规则或权限档变更当成凭证授权。 */
export function isProviderShareCredentialSessionApproval(updates: unknown): boolean {
  if (!Array.isArray(updates) || updates.length !== 1) return false;
  const update = updates[0];
  return !!update && typeof update === 'object' && !Array.isArray(update)
    && Object.keys(update).length === 2
    && update.type === PROVIDER_SHARE_CREDENTIAL_SESSION_APPROVAL.type
    && update.destination === 'session';
}
