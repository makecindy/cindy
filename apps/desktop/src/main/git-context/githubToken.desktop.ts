import { activeOwnerScopeKey } from '../appSessionState.js';
import { readGhostSecret } from '../secrets/providerSecretStore.js';
import { getSharedGhCliTokenSource, type GhCliTokenReadResult } from './ghCliTokenSource.js';
import { readGithubAppToken } from './githubAppAuthorization.desktop.js';
import { createPluginLogicalIdentity, pluginInstallStoragePart, pluginNewInstallRelId } from '../../shared/pluginIdentity.js';

/**
 * Prefer the GitHub plugin's credentials (explicit plugin PAT, then Cindy GitHub App
 * authorization) before falling back to local `gh` CLI sign-in, matching GitLab's
 * plugin-first precedence. Never switch identities after an API rejects a token.
 */
export async function readGithubTokenDetailed(): Promise<GhCliTokenReadResult> {
  const scope = activeOwnerScopeKey();
  const instance = pluginInstallStoragePart(
    pluginNewInstallRelId(createPluginLogicalIdentity(null, 'cindy-github')),
  );
  // A temporary App refresh failure falls through cleanly so callers batching GitHub
  // with other forges (PR/MR status) are not failed as a whole.
  const pluginToken =
    readGhostSecret(instance, 'github_pat') ??
    readGhostSecret('cindy-github', 'github_pat') ??
    (await readGithubAppToken().catch(() => null));
  if (scope !== activeOwnerScopeKey()) return { ok: false, reason: 'gh-not-logged-in' };
  if (pluginToken && pluginToken.trim().length > 0) {
    return { ok: true, token: pluginToken.trim() };
  }
  const local = await getSharedGhCliTokenSource().readTokenDetailed();
  if (scope !== activeOwnerScopeKey()) return { ok: false, reason: 'gh-not-logged-in' };
  return local;
}
