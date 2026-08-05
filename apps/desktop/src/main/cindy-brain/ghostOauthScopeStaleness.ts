import type {
  GhostManifest,
  GhostSecretOauthDecl,
  GhostSetupAssessment,
  GhostSetupReauthSuggest,
} from '../../shared/ghost.js';
import { oauthConnectActionId, requirementRef } from './ghostSetupStatus.js';

/** 从清单顺序中挑首个陈旧 OAuth 凭证槽，生成有界且不含凭证明文的建议。 */
export function findGhostOauthReauthSuggest(
  manifest: GhostManifest,
  resolveMissingScopes: (secretKey: string, decl: GhostSecretOauthDecl) => readonly string[],
): GhostSetupReauthSuggest | undefined {
  for (const secret of manifest.network?.secrets ?? []) {
    if (secret.source !== 'oauth' || !secret.oauth) continue;
    const missing = resolveMissingScopes(secret.key, secret.oauth);
    if (missing.length === 0) continue;
    const ref = requirementRef({ kind: 'secret', key: secret.key });
    return {
      ghostId: manifest.id,
      secretKey: secret.key,
      missingScopes: [...missing],
      missingScopeCount: missing.length,
      requirement: {
        ref,
        kind: 'oauth',
        label: secret.label,
        action: {
          id: oauthConnectActionId(ref),
          kind: 'oauth_connect',
        },
      },
    };
  }
  return undefined;
}

/** required 保持原样；只有整体 ready 时才附加非阻塞建议。 */
export function appendReadyGhostOauthReauthSuggest(
  assessment: GhostSetupAssessment,
  suggest: GhostSetupReauthSuggest | undefined,
): GhostSetupAssessment {
  return assessment.state === 'ready' && suggest
    ? { ...assessment, reauthSuggest: suggest }
    : assessment;
}
