/**
 * Claude subscription state for the host.
 *
 * All three inputs are shared with the Desktop:
 *   - CLI login status, read with `readClaudeCliLoginStatusBySpawn` and cached by
 *     the same `claude-native-cli-status` module;
 *   - Cindy's usage permission (`nativeProviderAuthBinding`);
 *   - the combined verdict (`claude-native-auth`).
 *
 * Nothing here reads or copies Claude credentials: the CLI owns them.
 */

import { readClaudeCliLoginStatusBySpawn } from '@cindy/maker-core/claude-cli-login-status';
import { publishClaudeCliLoginStatus } from '../../../desktop/src/main/maker-host/claude-native-cli-status.ts';
import { hasClaudeNativeLogin } from '../../../desktop/src/main/maker-host/claude-native-auth.ts';
import { configureOwnerContext } from '../../../desktop/src/main/ownerContext.ts';
import { configureUserDataDir } from '../../../desktop/src/main/userDataPath.ts';

/**
 * Install the host's owner facts once, so owner-scoped stores resolve to the
 * same profile the CLI and the Desktop use.
 */
export function configureHostOwner(options) {
  configureUserDataDir(options.userDataDir);
  configureOwnerContext({
    read: () => ({
      dataOwnerId: options.ownerId,
      generation: 0,
      boundaryPending: false,
    }),
    // The host has no signed-out temp namespace: an unresolved owner must fail
    // closed instead of writing into a shared directory.
    fallbackBaseDir: () => {
      throw new Error('cindy-host has no active owner yet; run `cindy-host login`');
    },
  });
}

/**
 * @param {{binary: string, env: NodeJS.ProcessEnv, timeoutMs?: number}} options
 * @returns {Promise<{cliLoggedIn: boolean, allowed: boolean, connected: boolean}>}
 */
export async function readClaudeSubscriptionState(options) {
  const status = await readClaudeCliLoginStatusBySpawn({
    binary: options.binary,
    env: options.env,
    timeoutMs: options.timeoutMs ?? 20_000,
  }).catch(() => null);
  if (status) publishClaudeCliLoginStatus(status);
  const cliLoggedIn = status?.loggedIn === true;
  const connected = hasClaudeNativeLogin();
  return { cliLoggedIn, allowed: cliLoggedIn && connected, connected };
}
