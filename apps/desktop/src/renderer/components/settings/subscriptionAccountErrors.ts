import { extractIpcError } from '@/utils/ipcError';
import { pluginLoginErrorKeys } from '../../../shared/subscriptionAccounts';

/**
 * Toast text for a failed account command, shared by every place that signs in or edits accounts.
 * `null` for a cancelled sign-in, which needs no message.
 */
export function subscriptionAccountErrorKey(error: unknown): string | null {
  const ipc = extractIpcError(error);
  switch (ipc?.code) {
    case 'SUBSCRIPTION_ACCOUNT_FAILED':
      return pluginLoginErrorKeys.get(ipc.message.replace(/^\[SUBSCRIPTION_ACCOUNT_FAILED\] /, '')) ?? 'subscriptionAccounts.failed';
    case 'SUBSCRIPTION_LOGIN_CANCELLED': return null;
    case 'NOT_FOUND': return 'subscriptionAccounts.boundUnavailable';
    // A connection problem, not a lost login: say so instead of sending the user to sign in again.
    case 'SUBSCRIPTION_ACCOUNT_UNREACHABLE': return 'subscriptionAccounts.unreachable';
    case 'SUBSCRIPTION_CODEX_PROVIDER_AUTH': return 'subscriptionAccounts.providerManagedAuth';
    case 'SUBSCRIPTION_CLAUDE_ACCOUNT_MISMATCH': return 'subscriptionAccounts.loginIdentityMismatch';
    case 'SUBSCRIPTION_CLAUDE_IDENTITY_UNKNOWN': return 'subscriptionAccounts.loginIdentityUnknown';
    case 'SUBSCRIPTION_CLAUDE_TOKEN_NEEDS_LOGIN': return 'subscriptionAccounts.longLivedToken.needsLogin';
    case 'SUBSCRIPTION_CLAUDE_TOKEN_NOT_PERMITTED': return 'subscriptionAccounts.longLivedToken.notPermitted';
    case 'SUBSCRIPTION_CLAUDE_TOKEN_UNSUPPORTED': return 'subscriptionAccounts.longLivedToken.unsupported';
    default: return 'subscriptionAccounts.failed';
  }
}
