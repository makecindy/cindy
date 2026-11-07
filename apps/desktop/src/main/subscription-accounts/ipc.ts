import { ipcMain } from 'electron';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { getDeviceLinkInvokeContext } from '../device-link/invoke-context.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import {
  SUBSCRIPTION_ACCOUNTS_CHANNEL,
  isSubscriptionProvider,
} from '../../shared/subscriptionAccounts.js';
import { parseSubscriptionAccountCommand } from './commands.js';
export { parseSubscriptionAccountCommand } from './commands.js';
import { executeSubscriptionAccountCommand } from './service.js';
import { onSubscriptionAccountsChanged, readSubscriptionPoolUsage } from './runtime.js';
import { broadcast } from '../device-link/index.js';

export function registerSubscriptionAccountsIpc(): void {
  onSubscriptionAccountsChanged((providerId) =>
    broadcast('subscription-accounts:changed', { providerId }),
  );
  ipcMain.handle('maker:subscription-pool:quota', async (event, providerId: unknown) => {
    const context = getDeviceLinkInvokeContext();
    if (context?.sharedTask) throwIpcError('PERMISSION_DENIED', 'Account quota requires the owner');
    if (!context) assertTrustedAppRendererEvent(event);
    if (!isSubscriptionProvider(providerId))
      throwIpcError('INVALID_PARAMS', 'Invalid subscription provider');
    const usage = await readSubscriptionPoolUsage(providerId);
    return { providerId, pooled: usage !== undefined, usage: usage ?? null };
  });
  ipcMain.handle(SUBSCRIPTION_ACCOUNTS_CHANNEL, async (event, raw: unknown) => {
    const context = getDeviceLinkInvokeContext();
    if (context?.sharedTask)
      throwIpcError('PERMISSION_DENIED', 'Account management requires the owner');
    if (!context) assertTrustedAppRendererEvent(event);
    const command = parseSubscriptionAccountCommand(raw);
    try {
      return await executeSubscriptionAccountCommand(command);
    } catch (error) {
      const reason = error instanceof Error ? error.message : '';
      throwIpcError(
        reason === 'login_cancelled'
          ? 'SUBSCRIPTION_LOGIN_CANCELLED'
          : 'SUBSCRIPTION_ACCOUNT_FAILED',
        'Could not update the subscription account',
      );
    }
  });
}
