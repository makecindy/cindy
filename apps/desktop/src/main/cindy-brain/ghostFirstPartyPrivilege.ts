/**
 * Host-side first-party privilege resolver.
 *
 * Collects "where this installed plugin came from" into a structured
 * conclusion. Callers decide whether to refuse install or only withhold
 * privileges; this module does not refuse loading.
 *
 * Call sites that previously used only `isBrokerEligibleGhostId` now ask this
 * resolver **after** the static official-prefix hit (`cindy-` / `filo-` / `xd-`).
 * Official-prefix plugins keep today's grant. Everything else is decided here.
 *
 * Input priority: first evaluable of
 *   1. builtin seed → static official table
 *   2. plugin-market ledger (source + scope + organizationId + Release sha256)
 *      paired with the approved receipt packageSha256
 *   3. neither → fail-closed, no privilege
 *
 * Discriminator is the combination of `source` and `scope`, not `scope`
 * alone. Custom / git market rows write `scope: 'public'` as a placeholder
 * (`plugin-market/service.ts`); that is not a trust statement. Server-market
 * public is only trusted when `source === 'market'`.
 *
 * A matching official prefix is never a security proof by itself. The
 * static table is only a criterion on the builtin branch and on trusted
 * server-market public installs.
 *
 * `facts.builtin` is id-based, not byte-based: it means "this id is on the
 * bundled seed roster" (`listBuiltinSeedIds` / directory name), not "these
 * bytes came from the bundled seed". Byte-level guarantees live in
 * provisioning content matching and `approveTrustedBundledInstall`. That is
 * the same strength as today's `isOfficialGhostId(id)`.
 */
import { PLUGIN_PREFIX_PATTERN, type PluginScope } from '@cindy/plugin-protocol';

import { isBrokerEligibleGhostId, isOfficialGhostId } from '../../shared/ghost.js';

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
  | 'legacy-forge-current-org-prefix'
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
  pluginPrefix: string | null;
}

export interface GhostFirstPartyFacts {
  ghostId: string;
  /** True when the id is on the bundled seed roster (`InstalledGhost.builtin`). */
  builtin: boolean;
  marketRecord: GhostFirstPartyMarketRecord | null;
  currentOrganization: GhostFirstPartyCurrentOrganization | null;
  /** 仅来自升级前 receipt；新安装恒为 manual。 */
  installOrigin: 'manual' | 'agent-forge';
}

function matchesCurrentOrgPrefix(
  ghostId: string,
  currentOrganization: GhostFirstPartyCurrentOrganization | null,
): boolean {
  const prefix = currentOrganization?.pluginPrefix;
  if (!prefix || !PLUGIN_PREFIX_PATTERN.test(prefix)) return false;
  return ghostId.startsWith(`${prefix}-`);
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

function allow(basis: GhostFirstPartyBasis, hostPrimitiveEligible: boolean): GhostFirstPartyPrivilege {
  return { brokerEligible: true, hostPrimitiveEligible, basis };
}

function deny(basis: Extract<GhostFirstPartyBasis, `denied-${string}`>): GhostFirstPartyPrivilege {
  return { brokerEligible: false, hostPrimitiveEligible: false, basis };
}

/**
 * Pure first-party privilege conclusion from already-collected facts.
 * Does not read disk, ledger, or Electron.
 */
export function resolveGhostFirstPartyPrivilege(facts: GhostFirstPartyFacts): GhostFirstPartyPrivilege {
  if (facts.builtin) {
    return isOfficialGhostId(facts.ghostId)
      ? allow('builtin-official', true)
      : deny('denied-unknown-origin');
  }

  if ((FIRST_PARTY_ALIAS_GHOST_IDS as readonly string[]).includes(facts.ghostId)) {
    return deny('denied-alias');
  }

  const record = facts.marketRecord;
  if (record !== null) {
    if (!record.installed) {
      // A ledger row that exists but is not installed must not fall through to
      // the local-package tail below. Two reasons, both mattering:
      //   1. Fail-open direction. `{scope: 'personal', installed: true}` is
      //      denied here; flipping `installed` to false would have turned that
      //      same row into an allow via the tail. A security predicate must
      //      never grant more when one of its fields is false.
      //   2. It is the impersonation case, not the self-test case. Once an id
      //      appears in the market ledger, a hand-built local package carrying
      //      that same id is impersonating it. Author self-test is unaffected:
      //      a never-published id has no ledger row at all (`marketRecord`
      //      is null) and still reaches the tail.
      return deny('denied-unknown-origin');
    }
    if (record.scope === 'public' && record.source === 'market') {
      return isOfficialGhostId(facts.ghostId)
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
      if (!isCurrentOrganizationRecord(record, facts.currentOrganization)) {
        return deny('denied-foreign-org');
      }
      if (!marketInstallationMatchesApprovedPackage(record, facts.currentOrganization)) {
        return deny('denied-unknown-origin');
      }
      if (!matchesCurrentOrgPrefix(facts.ghostId, facts.currentOrganization)) {
        return deny('denied-unknown-origin');
      }
      return allow('market-organization-current', false);
    }
    if (
      facts.installOrigin === 'agent-forge' &&
      (record.source === 'git-market' || record.source === 'local-market') &&
      matchesCurrentOrgPrefix(facts.ghostId, facts.currentOrganization)
    ) {
      return allow('legacy-forge-current-org-prefix', false);
    }
    return deny('denied-unknown-origin');
  }

  if (
    facts.installOrigin === 'agent-forge' &&
    matchesCurrentOrgPrefix(facts.ghostId, facts.currentOrganization)
  ) {
    return allow('legacy-forge-current-org-prefix', false);
  }

  return deny('denied-unknown-origin');
}

/**
 * Incremental broker gate: official prefix (`cindy-` / `filo-` / `xd-`) keeps
 * today's grant without consulting facts. Everything else asks the resolver.
 * Unavailable facts are fail-closed (no broker).
 */
export function authorizeGhostTokenBroker(
  ghostId: string,
  load: { kind: 'ready'; facts: GhostFirstPartyFacts } | { kind: string },
): boolean {
  if (isBrokerEligibleGhostId(ghostId)) return true;
  if (load.kind !== 'ready' || !('facts' in load)) return false;
  return resolveGhostFirstPartyPrivilege(load.facts).brokerEligible;
}
