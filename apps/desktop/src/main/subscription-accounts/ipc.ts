import { ipcMain } from 'electron';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { isProviderSharePeer } from '@cindy/device-link';
import { getDeviceLinkInvokeContext, type DeviceLinkInvokeContext } from '../device-link/invoke-context.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import {
  SUBSCRIPTION_ACCOUNTS_CHANNEL,
  isSubscriptionPoolProviderIdShape,
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
  readSubscriptionPoolScheduling,
  readLegacySubscriptionPoolUsage,
  readSubscriptionSessionAccount,
  readSubscriptionSessionUsage,
} from './runtime.js';
import { broadcast } from '../device-link/index.js';
import { setRemoteSubscriptionPoolQuotaReader } from '../device-link/dispatch.desktop.js';
import { readLegacySubscriptionQuota } from './legacyQuota.js';
import { isAccountServiceUnreachable } from './accountServiceError.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';

const log = desktopMakerLogger.child('subscription-accounts');

// Reasons the runtime raises on purpose. Anything else is logged by error type only: some read
// paths parse credential files, whose parse errors may quote file contents.
const KNOWN_FAILURE_REASONS = new Set([
  'login_cancelled', 'login_failed', 'login_in_progress', 'not_a_subscription',
  'codex_provider_managed_auth', 'account_mismatch', 'account_identity_unknown',
  'Account is in use', 'Account not found', 'Too many subscription accounts',
  'Subscription accounts changed', 'Codex CLI unavailable',
]);

/** 远程调用来自同账号的其他电脑：不是分享受邀者，也不是共享任务访客。 */
function isOwnComputerContext(context: DeviceLinkInvokeContext | null): boolean {
  return !!context && !context.sharedTask && !isProviderSharePeer(context.controllerDeviceId);
}

export function registerSubscriptionAccountsIpc(): void {
  setRemoteSubscriptionPoolQuotaReader((channel, args) =>
    readLegacySubscriptionQuota(readLegacySubscriptionPoolUsage, channel, args, readSubscriptionSessionUsage),
  );
  onSubscriptionAccountsChanged((providerId, resetAccountId, change) =>
    broadcast('subscription-accounts:changed', { providerId, ...(resetAccountId ? { resetAccountId } : {}),
      ...(change ? { change } : {}) }),
  );
  ipcMain.handle('maker:subscription-pool:quota', async (event, providerId: unknown, model?: unknown, scope?: unknown) => {
    const context = getDeviceLinkInvokeContext();
    if (context?.sharedTask) throwIpcError('PERMISSION_DENIED', 'Account quota requires the owner');
    if (!context) assertTrustedAppRendererEvent(event);
    const scheduling = scope && typeof scope === 'object' && !Array.isArray(scope)
      ? scope as { scheduling?: unknown; ownComputer?: unknown; capability?: unknown } : null;
    if (scheduling?.scheduling === 1) {
      if (context && !isOwnComputerContext(context)) throwIpcError('PERMISSION_DENIED', 'Account scheduling requires the owner');
      if (!isSubscriptionPoolProviderIdShape(providerId) || typeof model !== 'string' || !model.trim() || model.length > 512
        || typeof scheduling.ownComputer !== 'boolean'
        || (scheduling.capability !== undefined && scheduling.capability !== 'image.generate'))
        throwIpcError('INVALID_PARAMS', 'Invalid subscription scheduling query');
      return { providerId, model, scheduling: await readSubscriptionPoolScheduling(providerId, model, {
        remote: !!context, ownComputer: isOwnComputerContext(context) && scheduling.ownComputer === true,
        ...(scheduling.capability === 'image.generate' ? { capability: scheduling.capability } : {}),
      }) };
    }
    if (!isSubscriptionPoolProviderIdShape(providerId))
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
    return { providerId, pooled: usage !== undefined, usage: usage ?? null,
      ...(usage !== undefined ? { schedulingVersion: 1 } : {}),
    };
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
      const unreachable = isAccountServiceUnreachable(error);
      // Without this line every failure reads as "check the CLI login" (2026-11-18 diagnosis).
      if (reason !== 'login_cancelled')
        log.warn('subscription account command failed', {
          action: command.action,
          providerId: command.providerId,
          reason: unreachable ? 'account_service_unreachable'
            : KNOWN_FAILURE_REASONS.has(reason) ? reason
              : error instanceof Error ? error.name : typeof error,
        });
      if (reason === 'Account not found') throwIpcError('NOT_FOUND', 'Subscription account not found');
      if (unreachable)
        throwIpcError(
          'SUBSCRIPTION_ACCOUNT_UNREACHABLE',
          'The account service could not be reached; the sign-in could not be confirmed',
        );
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
