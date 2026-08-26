/**
 * Host-owned Connection audience resolution. Explicit Forge installs for the
 * current organization and intact organization-market installs are the two
 * dynamic bases. The Host derives the audience from current identity + plugin id.
 */
import { isValidGhostId, isValidGhostNetworkHostPattern } from '../../shared/ghost.js';
import type { GhostManifest } from '../../shared/ghost.js';
import type { PluginMarketInstallationRecord } from '../plugin-market/ledger.js';
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

export interface LoadConnectionAudienceResolverOptions {
  readInstalledManifest(ghostId: string): GhostManifest | null;
  readInstalledManifestDigest(ghostId: string): string | null;
  readMarketInstallation(ghostId: string): PluginMarketInstallationRecord | null;
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

      const readManifest = (): GhostManifest | null => {
        try {
          return options.readInstalledManifest(ghostId);
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
          const manifest = readManifest();
          if (!manifest) return reject('plugin-not-installed');
          if (manifest.id !== ghostId) return reject('plugin-id-mismatch');
          return finish(manifest);
        }
      }

      let installation: PluginMarketInstallationRecord | null = null;
      try {
        installation = options.readMarketInstallation(ghostId);
      } catch {
        return reject('market-installation-read-failed');
      }
      if (!installation || !installation.installed) {
        return reject('market-installation-missing');
      }
      if (installation.source !== 'market') return reject('market-installation-untrusted');
      if (installation.scope !== 'organization') {
        return reject('market-installation-not-organization');
      }
      if (installation.organizationId !== identity.orgId) {
        return reject('market-installation-org-mismatch');
      }
      if (!installation.manifestDigest) {
        return reject('market-manifest-digest-missing');
      }

      let manifest: GhostManifest | null = null;
      try {
        manifest = options.readInstalledManifest(ghostId);
      } catch {
        return reject('installed-manifest-read-failed');
      }
      if (!manifest) return reject('plugin-not-installed');
      if (manifest.id !== ghostId) return reject('plugin-id-mismatch');
      let installedManifestDigest: string | null = null;
      try {
        installedManifestDigest = options.readInstalledManifestDigest(ghostId);
      } catch {
        return reject('installed-manifest-digest-read-failed');
      }
      if (installedManifestDigest !== installation.manifestDigest) {
        return reject('installed-manifest-digest-mismatch');
      }
      return finish(manifest);
    },
  };
}
