/**
 * Assembles `GhostFirstPartyFacts` for `resolveGhostFirstPartyPrivilege`.
 *
 * This loader only collects facts. It does not grant or refuse privileges.
 *
 * Do not return a bare `GhostFirstPartyFacts` object: callers must be able to
 * tell "facts are complete" from "a required fact could not be obtained".
 * `marketRecord: null` means the ledger confirmed there is no row — never
 * "the ledger could not be read".
 *
 * `currentOrganization.pluginPrefix: null` is a positive server statement
 * ("this org has no registered prefix"). Cache `absent` / `unavailable` must
 * not be folded into that shape.
 *
 * Builtin official plugins (priority 1 of the pure function) do not need the
 * organization prefix. Their conclusion stays available on a personal identity
 * and when the prefix cache has never been filled.
 */
import type { PluginMarketInstallationRecord } from '../plugin-market/ledger.js';
import type { OrganizationPrefixLookup } from '../plugin-market/organizationPrefixStore.js';
import { isTrustedPublicCindyResource } from './ghostFirstPartyPrivilege.js';
import type {
  GhostFirstPartyFacts,
  GhostFirstPartyMarketRecord,
  GhostFirstPartyTrustedSource,
} from './ghostFirstPartyPrivilege.js';
import {
  parsePluginInstallRelId,
  parsePluginStoragePart,
  pluginInstanceInstallRelId,
} from '../../shared/pluginIdentity.js';

export type GhostFirstPartyFactsPurpose = 'install' | 'runtime';

export type GhostFirstPartyFactsUnavailableAction =
  | 'refuse-install'
  | 'load-without-privilege';

export type GhostFirstPartyFactsUnavailableReason =
  | 'installed-list-read-failed'
  | 'market-installation-read-failed'
  | 'organization-prefix-absent'
  | 'organization-prefix-unavailable';

export interface GhostFirstPartyFactsIdentity {
  membershipKind: 'personal' | 'org';
  orgId: string | null;
  orgSlug?: string | null;
}

export type GhostFirstPartyFactsLoad =
  | { kind: 'ready'; facts: GhostFirstPartyFacts }
  | {
      kind: 'unavailable';
      reason: GhostFirstPartyFactsUnavailableReason;
      purpose: GhostFirstPartyFactsPurpose;
      action: GhostFirstPartyFactsUnavailableAction;
    };

export interface GhostFirstPartyFactsLoader {
  load(
    ghostId: string,
    purpose: GhostFirstPartyFactsPurpose,
    identity: GhostFirstPartyFactsIdentity,
    overrides?: GhostFirstPartyFactsOverrides,
  ): GhostFirstPartyFactsLoad;
}

export interface LoadGhostFirstPartyFactsLoaderOptions {
  readInstalledBuiltin(ghostId: string): boolean;
  readMarketInstallation(ghostId: string): PluginMarketInstallationRecord | null;
  /** Missing or legacy package evidence must return null. */
  readApprovedPackageSha256(ghostId: string): string | null;
  lookupOrganizationPrefix(orgId: string): OrganizationPrefixLookup;
  /** 显式 ghost_forge_install 返回 agent-forge；其它入口返回 manual。 */
  readInstallOrigin(ghostId: string): 'manual' | 'agent-forge';
  /**
   * Trusted receipt namespace. `undefined` means no delivery field; explicit
   * `null` is root. Do not invent the current org slug here.
   */
  readInstallNamespace?(ghostId: string): string | null | undefined;
  isPendingLegacyForge?(ghostId: string): boolean;
  isPendingLegacyNamespace?(installRelId: string): boolean;
  readTrustedSource?(installRelId: string): GhostFirstPartyTrustedSource | null;
  readLegacyFirstPartyEligible?(installRelId: string): boolean;
}

function actionFor(purpose: GhostFirstPartyFactsPurpose): GhostFirstPartyFactsUnavailableAction {
  return purpose === 'install' ? 'refuse-install' : 'load-without-privilege';
}

function toMarketRecord(
  record: PluginMarketInstallationRecord,
  approvedPackageSha256: string | null,
): GhostFirstPartyMarketRecord {
  return {
    scope: record.scope,
    organizationId: record.organizationId,
    source: record.source,
    installed: record.installed,
    sha256: record.sha256,
    approvedPackageSha256,
  };
}

export type GhostFirstPartyPendingMarketRecord = Omit<
  GhostFirstPartyMarketRecord,
  'approvedPackageSha256'
>;

/**
 * The pending install exception is Host-built only after inspecting the real
 * `.cindy` bytes. The caller supplies the ledger Release hash, never the
 * approved side of the comparison.
 */
export function bindPendingMarketRecordToInspectedPackage(
  record: GhostFirstPartyPendingMarketRecord,
  inspectedPackageSha256: string,
): GhostFirstPartyMarketRecord {
  return { ...record, approvedPackageSha256: inspectedPackageSha256 };
}

export type GhostFirstPartyFactsOverrides = {
  installOrigin?: 'manual' | 'agent-forge';
  marketRecord?: GhostFirstPartyMarketRecord | null;
  /**
   * Install-time delivery namespace. Runtime keeps parsing the storage part /
   * install rel id; callers must not invent the current org slug at runtime.
   * `undefined` means "parse from ghostId"; explicit `null` is root.
   */
  namespace?: string | null;
  trustedSource?: GhostFirstPartyTrustedSource | null;
  legacyFirstPartyEligible?: boolean;
};

export function loadGhostFirstPartyFactsLoader(
  options: LoadGhostFirstPartyFactsLoaderOptions,
): GhostFirstPartyFactsLoader {
  return {
    load(ghostId, purpose, identity, overrides) {
      const parsed =
        parsePluginStoragePart(ghostId) ?? parsePluginInstallRelId(ghostId);
      const logicalGhostId = parsed?.ghostId ?? ghostId;
      // Receipts / origin live under install rel id (`helper` or `_ns/acme/helper`).
      // Runtime oauth may pass a storage part (`_ns__acme__helper`).
      const installRelId = pluginInstanceInstallRelId(ghostId) ?? ghostId;
      const recordedNamespace =
        overrides?.namespace !== undefined
          ? overrides.namespace
          : options.readInstallNamespace?.(installRelId);
      const namespace =
        recordedNamespace !== undefined ? recordedNamespace : (parsed?.namespace ?? null);
      const legacyPendingForge = purpose === 'runtime' && recordedNamespace === undefined &&
        namespace === null && options.isPendingLegacyForge?.(installRelId) === true;
      const legacyPendingNamespace = purpose === 'runtime' && recordedNamespace === undefined &&
        namespace === null && options.isPendingLegacyNamespace?.(installRelId) === true;
      const unavailable = (
        reason: GhostFirstPartyFactsUnavailableReason,
      ): GhostFirstPartyFactsLoad => ({
        kind: 'unavailable',
        reason,
        purpose,
        action: actionFor(purpose),
      });

      let trustedSource: GhostFirstPartyTrustedSource | null = null;
      let legacyFirstPartyEligible = false;
      let approvedPackageSha256: string | null = null;
      try {
        trustedSource = overrides?.trustedSource !== undefined
          ? overrides.trustedSource
          : purpose === 'runtime' ? options.readTrustedSource?.(installRelId) ?? null : null;
        legacyFirstPartyEligible = overrides?.legacyFirstPartyEligible !== undefined
          ? overrides.legacyFirstPartyEligible === true
          : purpose === 'runtime' && options.readLegacyFirstPartyEligible?.(installRelId) === true;
        approvedPackageSha256 = overrides?.marketRecord !== undefined
          ? overrides.marketRecord?.approvedPackageSha256 ?? null
          : options.readApprovedPackageSha256(installRelId);
      } catch {
        trustedSource = null;
        legacyFirstPartyEligible = false;
        approvedPackageSha256 = null;
      }
      const privilegeEvidence = {
        ...(legacyPendingNamespace ? { legacyPendingNamespace: true } : {}),
        ...(trustedSource ? { trustedSource, approvedPackageSha256 } : {}),
        ...(legacyFirstPartyEligible ? { legacyFirstPartyEligible: true } : {}),
      };

      let builtin: boolean;
      try {
        builtin = options.readInstalledBuiltin(ghostId);
      } catch {
        return unavailable('installed-list-read-failed');
      }

      let installOrigin: 'manual' | 'agent-forge' = 'manual';
      if (overrides?.installOrigin !== undefined) {
        installOrigin = overrides.installOrigin;
      } else {
        try {
          installOrigin = options.readInstallOrigin(installRelId);
        } catch {
          installOrigin = 'manual';
        }
      }

      let marketRecord: GhostFirstPartyMarketRecord | null = null;
      if (overrides?.marketRecord !== undefined) {
        marketRecord = overrides.marketRecord;
      } else {
        try {
          const installation = options.readMarketInstallation(ghostId);
          marketRecord = installation
            ? toMarketRecord(installation, approvedPackageSha256)
            : null;
        } catch {
          // Builtin official plugins and explicit Forge self-tests do not depend
          // on the ledger. A corrupt cache must not take either qualification away.
          if (!builtin && !trustedSource && !legacyFirstPartyEligible && installOrigin !== 'agent-forge') {
            return unavailable('market-installation-read-failed');
          }
          marketRecord = null;
        }
      }

      if (identity.membershipKind !== 'org' || !identity.orgId) {
        return {
          kind: 'ready',
          facts: {
            ghostId: logicalGhostId,
            namespace,
            builtin,
            marketRecord,
            currentOrganization: null,
            installOrigin,
            ...(legacyPendingForge ? { legacyPendingForge: true } : {}),
            ...privilegeEvidence,
          },
        };
      }

      /**
       * 随包插件的结论不依赖组织事实，所以前缀取不到时它照旧可求值。
       *
       * ⚠️ 这里填的 `currentOrganization: null` **不是一个真事实**：当前身份确实是
       * 组织身份，只是前缀这个事实拿不到，而输入类型没有「是组织但前缀未知」这种
       * 表示（`{organizationId, pluginPrefix: null}` 的含义是「该组织确实没登记
       * 前缀」，那是服务端才能给出的正面声明，用在这里会是更严重的失真）。
       *
       * 之所以安全，靠的是一条不变量：**纯函数的优先级 1（`facts.builtin`）在返回前
       * 不读 `currentOrganization` 与 `marketRecord`。** 这条不变量已由
       * `__tests__/ghostFirstPartyPrivilege.test.ts` 里
       * 「priority 1 is independent of ledger and organization facts」钉住——
       * 哪天有人让优先级 1 开始读这两个字段，那条测试会红，
       * 提醒他这里的填充值会变成静默误报。
       */
      const builtinOnlyFacts = (): Extract<GhostFirstPartyFactsLoad, { kind: 'ready' }> => ({
        kind: 'ready',
        facts: { ghostId: logicalGhostId, namespace, builtin, marketRecord, currentOrganization: null, installOrigin, ...(legacyPendingForge ? { legacyPendingForge: true } : {}), ...privilegeEvidence },
      });

      if (installOrigin === 'manual' && isTrustedPublicCindyResource(builtinOnlyFacts().facts)) {
        return builtinOnlyFacts();
      }

      if (identity.orgSlug && (namespace === identity.orgSlug ||
          (legacyPendingNamespace && installOrigin !== 'agent-forge')) ||
          (namespace !== null && identity.orgSlug == null && installOrigin !== 'agent-forge' &&
            marketRecord?.source === 'market' && marketRecord.scope === 'organization' &&
            marketRecord.organizationId === identity.orgId)) {
        return {
          kind: 'ready',
          facts: {
            ghostId: logicalGhostId, namespace, builtin, marketRecord, installOrigin,
            currentOrganization: { organizationId: identity.orgId, orgSlug: identity.orgSlug },
            ...privilegeEvidence,
          },
        };
      }

      let lookup: OrganizationPrefixLookup;
      try {
        lookup = options.lookupOrganizationPrefix(identity.orgId);
      } catch {
        if (builtin || trustedSource || legacyFirstPartyEligible) return builtinOnlyFacts();
        return unavailable('organization-prefix-unavailable');
      }

      if (lookup.kind === 'known') {
        return {
          kind: 'ready',
          facts: {
            ghostId: logicalGhostId,
            namespace,
            builtin,
            marketRecord,
            currentOrganization: {
              organizationId: identity.orgId,
              pluginPrefix: lookup.pluginPrefix,
              orgSlug: identity.orgSlug ?? null,
            },
            installOrigin,
            ...(legacyPendingForge ? { legacyPendingForge: true } : {}),
            ...privilegeEvidence,
          },
        };
      }

      // Prefix is required for non-builtin evaluation. Builtin still concludes
      // from `facts.builtin` and must not wait on a market-list cache fill.
      if (builtin || trustedSource || legacyFirstPartyEligible) return builtinOnlyFacts();

      return unavailable(
        lookup.kind === 'absent'
          ? 'organization-prefix-absent'
          : 'organization-prefix-unavailable',
      );
    },
  };
}
