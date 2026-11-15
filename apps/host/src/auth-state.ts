import type { User as AccountUser } from '../../desktop/src/shared/authUser.js';

/**
 * The auth state the Host projects to windows and the web client.
 *
 * `dataOwnerId` + `ownerGeneration` here are what a desktop proxy stamps on a
 * registered IPC call, and the IPC route compares that stamp with the app
 * session (`getActiveDataOwnerPushStamp()`). The two sources must agree whenever
 * `canEnterApp` is true, or every call would be rejected as an account change.
 */
export function projectHostAuthState(input: {
  account: { authenticated: boolean; realm: string | null; error?: string };
  accountUser: AccountUser | null;
  owner: string | null;
  generation: number;
  deviceId: string | null;
}) {
  const { account, accountUser, owner } = input;
  const authenticated = Boolean(account.authenticated && accountUser && accountUser.id === owner);
  return {
    authenticated, isAuthenticated: authenticated, user: authenticated ? accountUser : null,
    realm: account.realm, owner, dataOwnerId: authenticated ? owner : null,
    mode: authenticated ? 'cloud' : 'signed-out', canEnterApp: authenticated,
    ownerGeneration: input.generation, isCanary: false, deviceId: input.deviceId,
    hasAccountDeletionReceipt: false, accountDeletionRestored: false,
    credentialStoreUnavailable: Boolean(account.error),
  };
}
