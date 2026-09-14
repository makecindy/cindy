/**
 * Host-owned Connection audience resolution. Explicit Forge installs for the
 * current organization and intact organization-market installs are the two
 * dynamic bases. A named local-install exception exists only for ghostId
 * `mivo-canvas`: organization members may resolve after the org gate when the
 * installed manifest's exact oidc-token host is only `mivo-canvas.dsworks.cn`.
 * An intact organization market record, including installed:false, still takes
 * the digest path and must not skip via this exception. A present but invalid
 * market ledger is a hard failure, not an absent record. The Host derives the
 * audience from current identity + plugin id.
 */
import { isValidGhostId, isValidGhostNetworkHostPattern } from '../../shared/ghost.js';
import type { GhostManifest } from '../../shared/ghost.js';
import type { PluginMarketInstallationRecord } from '../plugin-market/ledger.js';
import {
  verifyInstalledMarketManifest,
  type InstalledMarketManifestIdentity,
} from '../plugin-market/installedManifestIdentity.js';
import { PLUGIN_MEMBER_PUBLISHER_GHOST_ID } from '../plugin-publisher/types.js';
import { PLUGIN_PREFIX_PATTERN } from '@cindy/plugin-protocol';

export interface ConnectionAudienceIdentity {
  membershipId: string;
  membershipKind: 'personal' | 'org';
  orgId: string | null;
  orgSlug: string | null;
}

export interface ConnectionAudienceResolution {
  membershipId: string;
  audience: string;
  pluginSlug: string;
  allowedHosts: readonly string[];
}

export interface ConnectionAudienceResolver {
  resolve(
    ghostId: string,
    identity: ConnectionAudienceIdentity,
  ): ConnectionAudienceResolution | null;
}

const ORG_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PLUGIN_SLUG_RE = /^[a-z][a-z0-9-]{0,31}$/;
/** Named local-install Connection exception. Must stay an exact id, not a prefix. */
const LOCAL_OIDC_ALLOWLIST_GHOST_ID = 'mivo-canvas';
/** Local exception may inject the org JWT only to this exact BFF host. */
const LOCAL_OIDC_ALLOWLIST_HOST = 'mivo-canvas.dsworks.cn';

/**
 * Host-owned Connection audiences that plugins must never mint.
 * `cindy-publisher` is the member-upload publisher identity; `xd-publisher`
 * is the retired slug kept as defense in depth after the rename.
 */
export const RESERVED_CONNECTION_PLUGIN_SLUGS = Object.freeze([
  PLUGIN_MEMBER_PUBLISHER_GHOST_ID,
  'xd-publisher',
] as const);

export function isReservedConnectionPluginSlug(ghostId: string): boolean {
  return (RESERVED_CONNECTION_PLUGIN_SLUGS as readonly string[]).includes(ghostId);
}

/** A managed secret is ready only when its exact injection host is declared. */
export function isConnectionSecretReady(
  injectHosts: readonly string[],
  resolution: ConnectionAudienceResolution | null,
): boolean {
  return resolution !== null && injectHosts.some((host) => resolution.allowedHosts.includes(host));
}

/** Exact non-wildcard hosts declared for Host-injected Connection JWTs. */
export function declaredOidcTokenHosts(manifest: GhostManifest): string[] {
  return [
    ...new Set(
      (manifest.network?.secrets ?? [])
        .filter((secret) => secret.source === 'oidc-token')
        .flatMap((secret) => secret.inject.hosts ?? [])
        .filter((host) => isValidGhostNetworkHostPattern(host) && !host.startsWith('*.')),
    ),
  ];
}

export type MarketInstallationLookup =
  | { kind: 'absent' }
  | { kind: 'found'; record: PluginMarketInstallationRecord }
  | { kind: 'invalid' };

export interface LoadConnectionAudienceResolverOptions {
  /** Manifest and byte identity from one bounded read of the installed ghost.json. */
  readInstalledManifestIdentity(ghostId: string): InstalledMarketManifestIdentity | null;
  readMarketInstallation(
    ghostId: string,
  ): PluginMarketInstallationRecord | MarketInstallationLookup | null;
  readApprovedPackageSha256?(ghostId: string): string | null;
  readInstallOrigin?(ghostId: string): 'manual' | 'agent-forge';
  lookupOrganizationPrefix?(
    orgId: string,
  ): { kind: 'known'; pluginPrefix: string | null } | { kind: 'absent' } | { kind: 'unavailable' };
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export function loadConnectionAudienceResolver(
  options: LoadConnectionAudienceResolverOptions,
): ConnectionAudienceResolver {
  return {
    resolve(ghostId, identity) {
      const reject = (reason: string): null => {
        options.log?.warn('ghost Connection audience resolution rejected', {
          ghostId,
          reason,
        });
        return null;
      };
      if (!isValidGhostId(ghostId) || !PLUGIN_SLUG_RE.test(ghostId)) {
        return reject('plugin-id-invalid');
      }
      if (isReservedConnectionPluginSlug(ghostId)) {
        return reject('plugin-id-reserved');
      }
      if (identity.membershipKind !== 'org') return reject('membership-not-org');
      if (!identity.membershipId) return reject('membership-id-empty');
      if (!identity.orgId) return reject('org-id-unavailable');
      if (!identity.orgSlug || !ORG_SLUG_RE.test(identity.orgSlug)) {
        return reject('org-slug-unavailable');
      }

      const finish = (manifest: GhostManifest): ConnectionAudienceResolution | null => {
        const allowedHosts = declaredOidcTokenHosts(manifest);
        if (allowedHosts.length === 0) return reject('oidc-host-declaration-missing');
        const audience = `${identity.orgSlug}:${ghostId}`;
        if (audience.length > 64) return reject('audience-too-long');
        options.log?.info('ghost Connection audience resolved', {
          ghostId,
          allowedHostCount: allowedHosts.length,
        });
        return {
          membershipId: identity.membershipId,
          audience,
          pluginSlug: ghostId,
          allowedHosts,
        };
      };

      const readManifestIdentity = (): InstalledMarketManifestIdentity | null => {
        try {
          return options.readInstalledManifestIdentity(ghostId);
        } catch {
          return null;
        }
      };

      // 显式 ghost_forge_install 的企业作者自测分支，同时兼容升级前已有的
      // agent-forge receipt。个人身份、未知前缀与缺失批准包哈希均 fail closed。
      const forgeOrigin = options.readInstallOrigin?.(ghostId);
      if (forgeOrigin === 'agent-forge') {
        const prefixLookup = options.lookupOrganizationPrefix?.(identity.orgId);
        const prefix =
          prefixLookup && prefixLookup.kind === 'known' ? prefixLookup.pluginPrefix : null;
        if (prefix && PLUGIN_PREFIX_PATTERN.test(prefix) && ghostId.startsWith(`${prefix}-`)) {
          const approvedSha = options.readApprovedPackageSha256?.(ghostId) ?? null;
          if (!approvedSha || !/^[a-f0-9]{64}$/.test(approvedSha)) {
            return reject('forge-package-sha-missing');
          }
          const identitySnapshot = readManifestIdentity();
          if (!identitySnapshot) return reject('plugin-not-installed');
          if (identitySnapshot.manifest.id !== ghostId) return reject('plugin-id-mismatch');
          return finish(identitySnapshot.manifest);
        }
      }

      let installation: PluginMarketInstallationRecord | null = null;
      try {
        const lookup = options.readMarketInstallation(ghostId);
        if (
          lookup &&
          typeof lookup === 'object' &&
          'kind' in lookup &&
          (lookup.kind === 'absent' || lookup.kind === 'found' || lookup.kind === 'invalid')
        ) {
          if (lookup.kind === 'invalid') return reject('market-installation-invalid');
          if (lookup.kind === 'found') installation = lookup.record;
        } else {
          installation = lookup;
        }
      } catch {
        return reject('market-installation-read-failed');
      }
      if (!installation) {
        // Named exception after the org gate and before market-missing reject.
        // Any persisted market row, including installed:false, still takes digest.
        if (ghostId === LOCAL_OIDC_ALLOWLIST_GHOST_ID) {
          const allowlisted = readManifestIdentity();
          if (!allowlisted) return reject('plugin-not-installed');
          if (allowlisted.manifest.id !== ghostId) return reject('plugin-id-mismatch');
          const allowlistedHosts = declaredOidcTokenHosts(allowlisted.manifest);
          if (
            allowlistedHosts.length !== 1 ||
            allowlistedHosts[0] !== LOCAL_OIDC_ALLOWLIST_HOST
          ) {
            return reject('oidc-host-not-allowlisted');
          }
          return finish(allowlisted.manifest);
        }
        return reject('market-installation-missing');
      }
      if (!installation.installed) return reject('market-installation-missing');
      if (installation.source !== 'market') return reject('market-installation-untrusted');
      if (installation.scope !== 'organization') {
        return reject('market-installation-not-organization');
      }
      if (installation.organizationId !== identity.orgId) {
        return reject('market-installation-org-mismatch');
      }
      if (!installation.rawManifestSha256 && !installation.manifestDigest) {
        return reject('market-manifest-identity-missing');
      }

      let identitySnapshot: InstalledMarketManifestIdentity | null = null;
      try {
        identitySnapshot = options.readInstalledManifestIdentity(ghostId);
      } catch {
        return reject('installed-manifest-read-failed');
      }
      if (!identitySnapshot) return reject('plugin-not-installed');
      if (identitySnapshot.manifest.id !== ghostId) return reject('plugin-id-mismatch');
      if (!verifyInstalledMarketManifest(installation, identitySnapshot)) {
        return reject('installed-manifest-identity-mismatch');
      }
      return finish(identitySnapshot.manifest);
    },
  };
}
