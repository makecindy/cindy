/**
 * 只转发明确的同账号管理操作，不重放写请求；链接在本机 Main 登记后才能复制。
 * 本机生成的链接由本机弹审批窗(provider-sharing.md §4.1)：生成后关注那条分享，本机处理过的申请随即移除。
 */
import { PROVIDER_GROUP_REMOTE_CHANNEL, PROVIDER_SHARE_LINK_TTL_MS } from '@cindy/device-link';

import type { ProviderManagementReply, ProviderManagementRequest } from '../../shared/providerManagement.js';
import type { ProviderShareOwnerState } from '../../shared/providerShare.js';
import { forgetWatchedProviderShareRequest, watchProviderShareRequests } from '../device-link/providerShareHost.js';
import { rememberIssuedClipboardText } from '../textClipboard.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import type { ProviderGroupRemoteInvoke } from './remoteClient.js';
import { captureProviderManagementScope } from './managementScope.js';

export async function invokeProviderManagement(
  invoke: ProviderGroupRemoteInvoke,
  deviceId: string,
  request: ProviderManagementRequest,
  readInvoke: ProviderGroupRemoteInvoke = invoke,
): Promise<unknown> {
  const assertOwner = captureProviderManagementScope();
  const response = await invoke(deviceId, PROVIDER_GROUP_REMOTE_CHANNEL, [request], { preSend: assertOwner });
  assertOwner();
  if (!response.ok) {
    const message = response.error?.message ?? '';
    // 旧版组所在电脑不认识新的分享命令(如 usage-history)时回 `[INVALID_PARAMS] Unknown command`：同样是需要更新。
    if (
      response.error?.code === 'CHANNEL_NOT_ALLOWED'
      || /unknown provider group action/.test(message)
      || (request.action === 'manage-share' && /\[INVALID_PARAMS\] Unknown command/.test(message))
    ) {
      throwIpcError('UNSUPPORTED_CAPABILITY', 'Provider management requires an update on the computer with the group');
    }
    throw new Error(/^\[[A-Z_]+\]/.test(message) ? message : '[REMOTE_AGENT_UNAVAILABLE] Provider management failed');
  }
  const reply = response.result as ProviderManagementReply | null;
  if (!reply || typeof reply !== 'object' || !Object.hasOwn(reply, 'result') || !Number.isFinite(reply.respondedAt)) {
    throwIpcError('PRECONDITION_FAILED', 'Invalid provider management response');
  }
  if (request.action === 'manage-share' && request.command.action === 'create-link') {
    const created = reply.result as { link?: unknown; linkId?: unknown; expiresAt?: unknown } | null;
    if (created && created.linkId === undefined) {
      throwIpcError('UNSUPPORTED_CAPABILITY', 'Remote share links require an update on the provider computer and provider share server');
    }
    if (!created || typeof created.link !== 'string' || !created.link || created.link.length > 4096
      || typeof created.linkId !== 'string' || !/^[a-f0-9]{64}$/.test(created.linkId)
      || typeof created.expiresAt !== 'string' || !Number.isFinite(Date.parse(created.expiresAt))) {
      throwIpcError('PRECONDITION_FAILED', 'Invalid provider share link');
    }
    const responseReceivedAt = Date.now();
    const remoteRemaining = Math.max(0, Math.min(PROVIDER_SHARE_LINK_TTL_MS, Date.parse(created.expiresAt) - reply.respondedAt));
    await watchProviderShareRequests(deviceId, request.command.providerId, created.linkId,
      () => readProviderManagementShares(readInvoke, deviceId));
    assertOwner();
    const postResponseElapsed = Math.max(0, Date.now() - responseReceivedAt);
    const remaining = Math.max(0, remoteRemaining - postResponseElapsed);
    const expiresAt = new Date(Date.now() + remaining).toISOString();
    rememberIssuedClipboardText(created.link, expiresAt);
    return { link: created.link, linkId: created.linkId, expiresAt };
  }
  if (request.action === 'manage-share' && (request.command.action === 'approve' || request.command.action === 'reject')) {
    forgetWatchedProviderShareRequest(request.command.requestId);
  }
  return reply.result;
}

/** 原始生成和重启恢复共用同一只读通道；仍在发送前与回包后核对当前账号。 */
export async function readProviderManagementShares(invoke: ProviderGroupRemoteInvoke, deviceId: string) {
  const snapshot = await invokeProviderManagement(invoke, deviceId, {
    action: 'manage-share', command: { action: 'owned', range: '7d' },
  }) as ProviderShareOwnerState | null;
  if (!snapshot?.ready || !Array.isArray(snapshot.shares)) {
    throwIpcError('PRECONDITION_FAILED', 'Provider share snapshot is not available on the managing computer');
  }
  return snapshot.shares;
}
