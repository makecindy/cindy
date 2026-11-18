import { extractIpcError } from '@/utils/ipcError';

/**
 * Toast text for a failed account command, shared by every place that signs in or edits accounts.
 * `null` for a cancelled sign-in, which needs no message.
 */
export function subscriptionAccountErrorKey(error: unknown): string | null {
  switch (extractIpcError(error)?.code) {
    case 'SUBSCRIPTION_LOGIN_CANCELLED': return null;
    // A connection problem, not a lost login: say so instead of sending the user to sign in again.
    case 'SUBSCRIPTION_ACCOUNT_UNREACHABLE': return 'subscriptionAccounts.unreachable';
    case 'SUBSCRIPTION_CODEX_PROVIDER_AUTH': return 'subscriptionAccounts.providerManagedAuth';
    case 'SUBSCRIPTION_CLAUDE_ACCOUNT_MISMATCH': return 'subscriptionAccounts.loginIdentityMismatch';
    case 'SUBSCRIPTION_CLAUDE_IDENTITY_UNKNOWN': return 'subscriptionAccounts.loginIdentityUnknown';
    default: return 'subscriptionAccounts.failed';
  }
}
