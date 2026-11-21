import { activeOwnerScopeKey } from '../appSessionState.js';
import { readGhostSecret } from '../secrets/providerSecretStore.js';
import { getSharedGhCliTokenSource, type GhCliTokenReadResult } from './ghCliTokenSource.js';
import { readGithubAppToken } from './githubAppAuthorization.desktop.js';
import { createPluginLogicalIdentity, pluginInstallStoragePart, pluginNewInstallRelId } from '../../shared/pluginIdentity.js';

/** Keep existing account precedence. Never switch identities after an API rejects a token. */
export async function readGithubTokenDetailed(): Promise<GhCliTokenReadResult> {
  const scope = activeOwnerScopeKey();
  const local = await getSharedGhCliTokenSource().readTokenDetailed();
  if (scope !== activeOwnerScopeKey()) return { ok: false, reason: 'gh-not-logged-in' };
  if (local.ok) return local;
  const instance = pluginInstallStoragePart(pluginNewInstallRelId(createPluginLogicalIdentity(null, 'cindy-github')));
  // A temporary App refresh failure reads as "no GitHub token" here, so callers that batch
  // GitHub with other forges (PR/MR status) are not failed as a whole.
  const token = readGhostSecret(instance, 'github_pat') ?? readGhostSecret('cindy-github', 'github_pat')
    ?? await readGithubAppToken().catch(() => null);
  if (scope !== activeOwnerScopeKey()) return { ok: false, reason: 'gh-not-logged-in' };
  return token ? { ok: true, token } : local;
}
