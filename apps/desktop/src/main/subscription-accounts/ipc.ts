import { ipcMain } from 'electron';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { isProviderSharePeer } from '@cindy/device-link';
import { getDeviceLinkInvokeContext, type DeviceLinkInvokeContext } from '../device-link/invoke-context.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import {
  SUBSCRIPTION_ACCOUNTS_CHANNEL,
  isSubscriptionProvider,
} from '../../shared/subscriptionAccounts.js';
import {
  parseSubscriptionAccountCommand,
  parseSubscriptionSessionAccountQuery,
} from './commands.js';
export { parseSubscriptionAccountCommand } from './commands.js';
import { executeSubscriptionAccountCommand } from './service.js';
import {
  onSubscriptionAccountsChanged,
  readSubscriptionPoolUsage,
  readSubscriptionPoolModelAvailability,
  readLegacySubscriptionPoolUsage,
  readSubscriptionSessionAccount,
  readSubscriptionSessionUsage,
} from './runtime.js';
import { broadcast } from '../device-link/index.js';
import { setRemoteSubscriptionPoolQuotaReader } from '../device-link/dispatch.desktop.js';
import { readLegacySubscriptionQuota } from './legacyQuota.js';

/** 远程调用来自同账号的其他电脑：不是分享受邀者，也不是共享任务访客。 */
function isOwnComputerContext(context: DeviceLinkInvokeContext | null): boolean {
  return !!context && !context.sharedTask && !isProviderSharePeer(context.controllerDeviceId);
}

export function registerSubscriptionAccountsIpc(): void {
  setRemoteSubscriptionPoolQuotaReader((channel, args) =>
    readLegacySubscriptionQuota(readLegacySubscriptionPoolUsage, channel, args, readSubscriptionSessionUsage),
  );
  onSubscriptionAccountsChanged((providerId, resetAccountId) =>
    broadcast('subscription-accounts:changed', { providerId, ...(resetAccountId ? { resetAccountId } : {}) }),
  );
  ipcMain.handle('maker:subscription-pool:quota', async (event, providerId: unknown, model?: unknown) => {
    const context = getDeviceLinkInvokeContext();
    if (context?.sharedTask) throwIpcError('PERMISSION_DENIED', 'Account quota requires the owner');
    if (!context) assertTrustedAppRendererEvent(event);
    if (!isSubscriptionProvider(providerId))
      throwIpcError('INVALID_PARAMS', 'Invalid subscription provider');
    if (model !== undefined) {
      if (typeof model !== 'string' || !model.trim() || model.length > 512)
        throwIpcError('INVALID_PARAMS', 'Invalid subscription model');
      return { providerId, model, available: await readSubscriptionPoolModelAvailability(providerId, model, {
        remote: !!context,
        ownComputer: isOwnComputerContext(context),
      }) };
    }
    const usage = await readSubscriptionPoolUsage(providerId);
    return { providerId, pooled: usage !== undefined, usage: usage ?? null };
  });
  ipcMain.handle(SUBSCRIPTION_ACCOUNTS_CHANNEL, async (event, raw: unknown) => {
    const context = getDeviceLinkInvokeContext();
    if (context?.sharedTask)
      throwIpcError('PERMISSION_DENIED', 'Account management requires the owner');
    if (!context) assertTrustedAppRendererEvent(event);
    // Read-only task account for its usage display; same owner gate as `read`.
    const session = parseSubscriptionSessionAccountQuery(raw);
    if (session) {
      try {
        return await readSubscriptionSessionAccount(session.providerId, session, {
          remote: !!context, ownComputer: isOwnComputerContext(context),
        });
      } catch {
        throwIpcError('SUBSCRIPTION_ACCOUNT_FAILED', 'Could not read the task account');
      }
    }
    const command = parseSubscriptionAccountCommand(raw);
    try {
      return await executeSubscriptionAccountCommand(command);
    } catch (error) {
      const reason = error instanceof Error ? error.message : '';
      if (reason === 'codex_provider_managed_auth')
        throwIpcError(
          'SUBSCRIPTION_CODEX_PROVIDER_AUTH',
          'The active Codex provider does not expose a ChatGPT account',
        );
      if (reason === 'account_mismatch')
        throwIpcError(
          'SUBSCRIPTION_CLAUDE_ACCOUNT_MISMATCH',
          'Sign in again with the selected Claude account',
        );
      if (reason === 'account_identity_unknown')
        throwIpcError(
          'SUBSCRIPTION_CLAUDE_IDENTITY_UNKNOWN',
          'The selected Claude account identity could not be confirmed',
        );
      throwIpcError(
        reason === 'login_cancelled'
          ? 'SUBSCRIPTION_LOGIN_CANCELLED'
          : 'SUBSCRIPTION_ACCOUNT_FAILED',
        'Could not update the subscription account',
      );
    }
  });
}
