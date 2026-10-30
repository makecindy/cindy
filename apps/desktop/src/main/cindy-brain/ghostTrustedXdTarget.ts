import type { InstalledGhost } from '../../shared/ghost.js';
import { hasDeliveryNamespace } from '../../shared/pluginIdentity.js';
import type { GhostFirstPartyFactsLoad } from './ghostFirstPartyFacts.js';
import {
  hasTrustedFirstPartySource,
  marketInstallationMatchesApprovedPackage,
} from './ghostFirstPartyPrivilege.js';

export function isTrustedXdGhostForScriptTarget(
  ghost: InstalledGhost,
  load: GhostFirstPartyFactsLoad,
  pendingLegacy: boolean,
): boolean {
  if (load.kind !== 'ready' || ghost.approval.state !== 'approved') return false;
  const facts = load.facts;
  const organization = facts.currentOrganization;
  if (
    !organization?.organizationId ||
    (organization.orgSlug != null && organization.orgSlug !== 'xd') ||
    facts.ghostId !== ghost.manifest.id ||
    facts.namespace !== (ghost.namespace ?? null)
  )
    return false;
  if (hasDeliveryNamespace(ghost)) {
    if (ghost.namespace !== 'xd') return false;
  } else if (
    !pendingLegacy ||
    (organization.orgSlug !== 'xd' && organization.pluginPrefix !== 'xd')
  )
    return false;
  const trustedMarket =
    facts.marketRecord !== null &&
    marketInstallationMatchesApprovedPackage(facts.marketRecord, organization);
  const trustedBuiltin =
    facts.builtin &&
    facts.trustedSource?.kind === 'builtin-official' &&
    hasTrustedFirstPartySource(facts);
  return trustedMarket || trustedBuiltin;
}
