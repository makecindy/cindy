/**
 * Host-side first-party privilege resolver.
 *
 * Collects "where this installed plugin came from" into a structured
 * conclusion. Callers decide whether to refuse install or only withhold
 * privileges; this module does not refuse loading.
 *
 * Call sites must not treat `cindy-` / `filo-` / `xd-` names as privileges.
 * Official plugins still qualify through builtin seed or trusted public market
 * facts; enterprise broker qualifies through current-organization market facts.
 *
 * Input priority: first evaluable of
 *   1. approved builtin resource, or a captured legacy qualification
 *   2. explicit agent-forge install + current organization prefix
 *   3. reserved Cindy public resources or current organization server packages
 *      in the plugin-market ledger (source + scope + organizationId + Release sha256)
 *      paired with the approved receipt packageSha256
 *   4. neither → fail-closed, no privilege
 *
 * Discriminator is the combination of `source` and `scope`, not `scope`
 * alone. Custom / git market rows write `scope: 'public'` as a placeholder
 * (`plugin-market/service.ts`); that is not a trust statement. Server-market
 * public is only trusted when `source === 'market'`.
 *
 * A matching official prefix is never a security proof by itself. Cindy public
 * resources require exact approved server-market package evidence; historical
 * XD/Filo names require a captured qualification from a real old public install.
 *
 * `facts.builtin` is id-based, not byte-based: it means "this id is on the
 * bundled seed roster" (`listBuiltinSeedIds` / directory name), not "these
 * bytes came from the bundled seed". Byte-level guarantees live in
 * provisioning content matching and `approveTrustedBundledInstall`. A trusted
 * source resource must additionally match the approved identity and content hash.
 */
import type { PluginScope } from '@cindy/plugin-protocol';

import { GHOST_OFFICIAL_ID_PREFIX, isOfficialGhostId } from '../../shared/ghost.js';

const PACKAGE_SHA256_RE = /^[a-f0-9]{64}$/;

/**
 * Ghost ids that share Host credential aliases (`GHOST_SECRET_STORAGE_ALIASES`).
 * A local package impersonating these ids must never receive first-party
 * privilege. Keep this list in sync with `shared/providerSecrets.ts`.
 */
export const FIRST_PARTY_ALIAS_GHOST_IDS = Object.freeze(['cindy-web-search', 'xd-mivo'] as const);

export type GhostFirstPartyBasis =
  | 'builtin-official'
  | 'market-public'
  | 'market-organization-current'
  | 'forge-current-org'
  | 'legacy-existing-install'
  | 'denied-alias'
  | 'denied-foreign-org'
  | 'denied-unknown-origin';

export interface GhostFirstPartyPrivilege {
  brokerEligible: boolean;
  hostPrimitiveEligible: boolean;
  basis: GhostFirstPartyBasis;
}

export interface GhostFirstPartyMarketRecord {
  scope: PluginScope;
  organizationId: string | null;
  source: 'market' | 'legacy-adopted' | 'git-market' | 'local-market';
  installed: boolean;
  /** Release package hash retained by the server-market ledger row. */
  sha256: string;
  /** Approved receipt hash; null includes legacy/reapproved receipts without package evidence. */
  approvedPackageSha256: string | null;
}

export interface GhostFirstPartyCurrentOrganization {
  organizationId: string;
  pluginPrefix?: string | null;
  /** Permanent org slug; required to bind Forge self-test to the install namespace. */
  orgSlug?: string | null;
}

export interface GhostFirstPartyFacts {
  ghostId: string;
  /** Install namespace. null is root; a string is the bound orgSlug. */
  namespace: string | null;
  /** True when the id is on the bundled seed roster (`InstalledGhost.builtin`). */
  builtin: boolean;
  marketRecord: GhostFirstPartyMarketRecord | null;
  currentOrganization: GhostFirstPartyCurrentOrganization | null;
  /** 仅显式 ghost_forge_install 写入 agent-forge；其它入口均为 manual。 */
  installOrigin: 'manual' | 'agent-forge';
  legacyPendingForge?: boolean;
  legacyPendingNamespace?: boolean;
  trustedSource?: GhostFirstPartyTrustedSource | null;
  approvedPackageSha256?: string | null;
  legacyFirstPartyEligible?: boolean;
}

export interface GhostFirstPartyTrustedSource {
  kind: 'builtin-official';
  ghostId: string;
  namespace: string | null;
  packageSha256: string;
}

export function hasTrustedFirstPartySource(facts: GhostFirstPartyFacts): boolean {
  const source = facts.trustedSource;
  return source != null && source.ghostId === facts.ghostId &&
    source.namespace === facts.namespace &&
    PACKAGE_SHA256_RE.test(source.packageSha256) &&
    source.packageSha256 === facts.approvedPackageSha256;
}

export function isTrustedPublicCindyResource(facts: GhostFirstPartyFacts): boolean {
  const record = facts.marketRecord;
  return facts.namespace === null && facts.ghostId.startsWith(GHOST_OFFICIAL_ID_PREFIX) &&
    record !== null && record.installed && record.source === 'market' &&
    record.scope === 'public' && record.organizationId === null &&
    record.approvedPackageSha256 !== null && PACKAGE_SHA256_RE.test(record.sha256) &&
    record.sha256 === record.approvedPackageSha256;
}

export function captureLegacyFirstPartyEligibility(input: {
  legacyExistingInstall: boolean;
  ghostId: string;
  namespace: string | null;
  approved: boolean;
  approvedPackageSha256: string | null;
  marketRecord: (GhostFirstPartyMarketRecord & { ghostId: string; namespace?: string | null }) | null;
  approvedOfficialTrust?: boolean;
}): boolean {
  const record = input.marketRecord;
  if (!input.legacyExistingInstall || !input.approved || input.namespace !== null ||
      !isOfficialGhostId(input.ghostId) || input.approvedPackageSha256 === null ||
      !PACKAGE_SHA256_RE.test(input.approvedPackageSha256)) return false;
  if (input.approvedOfficialTrust === true) return true;
  return record !== null && record.ghostId === input.ghostId &&
    record.namespace == null &&
    record.installed && record.source === 'market' &&
    record.scope === 'public' && record.organizationId === null &&
    record.approvedPackageSha256 !== null && PACKAGE_SHA256_RE.test(record.sha256) &&
    record.approvedPackageSha256 === input.approvedPackageSha256 &&
    record.sha256 === record.approvedPackageSha256;
}

function isCurrentOrganizationRecord(
  record: GhostFirstPartyMarketRecord,
  currentOrganization: GhostFirstPartyCurrentOrganization | null,
): boolean {
  return (
    record.scope === 'organization' &&
    currentOrganization !== null &&
    record.organizationId === currentOrganization.organizationId
  );
}

/**
 * The single byte-identity gate for organization server-market Broker access.
 * `manifestDigest` is intentionally absent: an attacker can keep ghost.json
 * unchanged while replacing executable package bytes.
 */
export function marketInstallationMatchesApprovedPackage(
  record: GhostFirstPartyMarketRecord,
  currentOrganization: GhostFirstPartyCurrentOrganization | null,
): boolean {
  return (
    record.installed &&
    record.source === 'market' &&
    isCurrentOrganizationRecord(record, currentOrganization) &&
    record.approvedPackageSha256 !== null &&
    PACKAGE_SHA256_RE.test(record.sha256) &&
    PACKAGE_SHA256_RE.test(record.approvedPackageSha256) &&
    record.sha256 === record.approvedPackageSha256
  );
}

export function isTrustedMivoSecretAlias(facts: GhostFirstPartyFacts, pendingLegacy: boolean): boolean {
  if (facts.ghostId !== 'xd-mivo') return false;
  if (facts.builtin && facts.trustedSource?.kind === 'builtin-official' &&
      hasTrustedFirstPartySource(facts)) return true;
  const record = facts.marketRecord;
  const organization = facts.currentOrganization;
  if (!record || record.source !== 'market' || record.scope !== 'organization' ||
      !record.installed || !organization ||
      !(organization.orgSlug === 'xd' || (organization.orgSlug == null &&
        (facts.namespace === 'xd' || organization.pluginPrefix === 'xd'))) ||
      record.organizationId !== organization.organizationId) return false;
  return (facts.namespace === 'xd' || (facts.namespace === null && pendingLegacy)) &&
    marketInstallationMatchesApprovedPackage(record, organization);
}

function allow(basis: GhostFirstPartyBasis, hostPrimitiveEligible: boolean): GhostFirstPartyPrivilege {
  return { brokerEligible: true, hostPrimitiveEligible, basis };
}

function deny(basis: Extract<GhostFirstPartyBasis, `denied-${string}`>): GhostFirstPartyPrivilege {
  return { brokerEligible: false, hostPrimitiveEligible: false, basis };
}

export function matchesPendingLegacyForge(
  ghostId: string,
  namespace: string | null,
  pending: boolean,
  pluginPrefix: string | null,
): boolean {
  return pending && namespace === null && !!pluginPrefix && ghostId.startsWith(pluginPrefix + '-');
}

/**
 * Pure first-party privilege conclusion from already-collected facts.
 * Does not read disk, ledger, or Electron.
 */
export function resolveGhostFirstPartyPrivilege(facts: GhostFirstPartyFacts): GhostFirstPartyPrivilege {
  if (facts.builtin && facts.trustedSource?.kind === 'builtin-official' &&
      hasTrustedFirstPartySource(facts)) {
    return allow('builtin-official', true);
  }

  if (facts.installOrigin === 'manual' && isTrustedPublicCindyResource(facts)) {
    return allow('market-public', true);
  }

  if ((FIRST_PARTY_ALIAS_GHOST_IDS as readonly string[]).includes(facts.ghostId)) {
    return deny('denied-alias');
  }

  if (facts.namespace === null && facts.installOrigin === 'manual' &&
      facts.legacyFirstPartyEligible === true && isOfficialGhostId(facts.ghostId) &&
      (facts.marketRecord === null || (facts.marketRecord.installed &&
        facts.marketRecord.source === 'market' && facts.marketRecord.scope === 'public' &&
        facts.marketRecord.organizationId === null &&
        PACKAGE_SHA256_RE.test(facts.marketRecord.sha256) &&
        facts.marketRecord.sha256 === facts.marketRecord.approvedPackageSha256))) {
    return allow('legacy-existing-install', true);
  }

  // 企业作者的显式 Forge 自测资格来自本次安装来源与当前组织身份，和市场账本
  // 是否已有同 id、是否仍标记 installed 无关。它只开放 Broker / oidc-token，
  // 宿主原语仍保持拒绝。
  if (facts.installOrigin === 'agent-forge') {
    const orgSlug = facts.currentOrganization?.orgSlug;
    const legacyMatchesCurrentOrg = matchesPendingLegacyForge(
      facts.ghostId,
      facts.namespace,
      facts.legacyPendingForge === true,
      facts.currentOrganization?.pluginPrefix ?? null,
    );
    if (!orgSlug || (facts.namespace !== orgSlug && !legacyMatchesCurrentOrg)) {
      return deny(facts.currentOrganization ? 'denied-foreign-org' : 'denied-unknown-origin');
    }
    return allow('forge-current-org', false);
  }

  const record = facts.marketRecord;
  if (record !== null) {
    if (!record.installed) {
      // Uninstalled ledger rows stay denied. Explicit Forge self-test is
      // decided above from origin + current organization, before this market branch.
      return deny('denied-unknown-origin');
    }
    if (record.scope === 'public' && record.source === 'market') {
      return isTrustedPublicCindyResource(facts)
        ? allow('market-public', true)
        : deny('denied-unknown-origin');
    }
    if (record.scope === 'organization') {
      // Same discipline as the public branch: scope is only meaningful together
      // with source. `legacy-adopted` rows are synthesized after a successful
      // market listing for official-prefix plugins that predate the market
      // (`plugin-market/service.ts::adoptLegacyInstallations`) — they attest
      // "this id exists on this machine", not "these bytes were distributed by
      // that organization's server market". `git-market` / `local-market` rows
      // carry a placeholder scope, which is likewise not a trust statement.
      if (record.source !== 'market') return deny('denied-unknown-origin');
      if (facts.namespace === null && facts.legacyPendingNamespace !== true) {
        return deny('denied-unknown-origin');
      }
      if (!isCurrentOrganizationRecord(record, facts.currentOrganization)) {
        return deny('denied-foreign-org');
      }
      if (!marketInstallationMatchesApprovedPackage(record, facts.currentOrganization)) {
        return deny('denied-unknown-origin');
      }
      const organization = facts.currentOrganization;
      const xdOrganization = organization?.orgSlug === 'xd' ||
        (organization?.orgSlug == null && organization?.pluginPrefix === 'xd');
      return allow('market-organization-current',
        (facts.namespace === 'xd' && (organization?.orgSlug == null || organization.orgSlug === 'xd')) ||
        (facts.namespace === null && facts.legacyPendingNamespace === true && xdOrganization));
    }
    return deny('denied-unknown-origin');
  }

  return deny('denied-unknown-origin');
}

/**
 * Broker gate from collected facts. Prefixes are not a grant.
 * Unavailable facts are fail-closed.
 */
export function authorizeGhostTokenBroker(
  _ghostId: string,
  load: { kind: 'ready'; facts: GhostFirstPartyFacts } | { kind: string },
): boolean {
  if (load.kind !== 'ready' || !('facts' in load)) return false;
  return resolveGhostFirstPartyPrivilege(load.facts).brokerEligible;
}

/** Port reclaim / identity avatar download. Prefixes are not a grant. */
export function authorizeGhostHostPrimitive(
  _ghostId: string,
  load: { kind: 'ready'; facts: GhostFirstPartyFacts } | { kind: string },
): boolean {
  if (load.kind !== 'ready' || !('facts' in load)) return false;
  return resolveGhostFirstPartyPrivilege(load.facts).hostPrimitiveEligible;
}
