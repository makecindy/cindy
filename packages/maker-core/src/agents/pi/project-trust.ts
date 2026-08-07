import type {
  PiProjectApprovalSnapshot,
  PiProjectDiscoveredResources,
  PiProjectIdentityResolution,
  PiProjectSettingsProjection,
  PiProjectSettingsValues,
  PiProjectTrustCapabilities,
  PiProjectTrustDecision,
} from '../../types/pi-project-trust.js';

const DEFAULT_CAPABILITIES: PiProjectTrustCapabilities = {
  explicitSkills: true,
  projectedSettings: false,
  packagesDisabled: true,
  extensionsDisabled: true,
};

function normalizePath(value: string, platform: 'posix' | 'win32'): string | null {
  if (value.includes('\0') || value.includes('\uFFFD')) return null;
  if (platform === 'posix') {
    // Canonical POSIX paths come from the host resolver. Preserve their literal
    // bytes so a valid path containing spaces or backslashes cannot alias another.
    return value.startsWith('/') ? value : null;
  }

  if (!value) return null;
  let withForwardSlashes = value.replaceAll('\\', '/');
  if (withForwardSlashes.toLowerCase().startsWith('//?/unc/')) {
    withForwardSlashes = `//${withForwardSlashes.slice(8)}`;
  } else if (/^\/\/\?\/[A-Za-z]:\//.test(withForwardSlashes)) {
    withForwardSlashes = withForwardSlashes.slice(4);
  } else if (withForwardSlashes.startsWith('//?/') || withForwardSlashes.startsWith('//./')) {
    return null;
  }
  const slash = withForwardSlashes.startsWith('//')
    ? `//${withForwardSlashes.slice(2).replace(/\/+/g, '/')}`
    : withForwardSlashes.replace(/\/+/g, '/');
  if (platform === 'win32') {
    if (!/^(?:[A-Za-z]:\/|\/\/)/.test(slash)) return null;
    if (/^[A-Za-z]:\/$/.test(slash)) return slash.toLowerCase();
    return slash.replace(/\/$/, '').toLowerCase();
  }
  return null;
}

function hasLosslessCanonicalEncoding(
  identity: Pick<PiProjectIdentityResolution, 'platform' | 'canonicalPathEncoding'>,
): boolean {
  return identity.platform === 'posix'
    ? identity.canonicalPathEncoding === 'utf8-lossless'
    : identity.platform === 'win32' && identity.canonicalPathEncoding === 'utf16-lossless';
}

export function piProjectKey(
  identity: Pick<PiProjectIdentityResolution, 'canonicalWorkingDir' | 'canonicalRepoRoot' | 'platform' | 'canonicalPathEncoding'>,
): string | null {
  const platform = identity.platform;
  if (!platform || !hasLosslessCanonicalEncoding(identity)) return null;
  const repoRoot = identity.canonicalRepoRoot && normalizePath(identity.canonicalRepoRoot, platform);
  const workingDir = identity.canonicalWorkingDir && normalizePath(identity.canonicalWorkingDir, platform);
  if (!repoRoot || !workingDir) return null;
  return `${repoRoot}\0${workingDir}`;
}

function approvalScopeKey(
  identity: Pick<PiProjectIdentityResolution, 'canonicalWorkingDir' | 'canonicalRepoRoot' | 'platform' | 'canonicalPathEncoding'>,
  scope: 'working-dir' | 'repo-root',
): string | null {
  const platform = identity.platform;
  if (!platform || !hasLosslessCanonicalEncoding(identity)) return null;
  const repoRoot = identity.canonicalRepoRoot && normalizePath(identity.canonicalRepoRoot, platform);
  if (!repoRoot) return null;
  if (scope === 'repo-root') return repoRoot;
  const workingDir = identity.canonicalWorkingDir && normalizePath(identity.canonicalWorkingDir, platform);
  return workingDir ? `${repoRoot}\0${workingDir}` : null;
}

function normalizeApprovalScopeKey(value: string, platform: 'posix' | 'win32', scope: 'working-dir' | 'repo-root'): string | null {
  if (scope === 'repo-root') return normalizePath(value, platform);
  const separator = value.indexOf('\0');
  if (separator < 0 || value.lastIndexOf('\0') !== separator) return null;
  const repoRoot = normalizePath(value.slice(0, separator), platform);
  const workingDir = normalizePath(value.slice(separator + 1), platform);
  return repoRoot && workingDir ? `${repoRoot}\0${workingDir}` : null;
}

function isPlainObject(values: unknown): values is Record<string, unknown> {
  if (typeof values !== 'object' || values === null || Array.isArray(values)) return false;
  const prototype = Object.getPrototypeOf(values);
  return prototype === Object.prototype || prototype === null;
}

function cloneAllowedSettings(values: unknown): Readonly<PiProjectSettingsValues> | null {
  if (!isPlainObject(values) || Object.keys(values).length !== 1 || !('compaction' in values)) return null;
  const compaction = values.compaction;
  if (!isPlainObject(compaction)) return null;
  const keys = Object.keys(compaction);
  if (
    keys.length === 0 ||
    keys.some((key) => key !== 'reserveTokens' && key !== 'keepRecentTokens')
  ) return null;

  const reserveTokens = compaction.reserveTokens;
  const keepRecentTokens = compaction.keepRecentTokens;
  if (
    (reserveTokens !== undefined &&
      (typeof reserveTokens !== 'number' || !Number.isSafeInteger(reserveTokens) || reserveTokens < 0)) ||
    (keepRecentTokens !== undefined &&
      (typeof keepRecentTokens !== 'number' || !Number.isSafeInteger(keepRecentTokens) || keepRecentTokens < 0))
  ) return null;
  const clone = {
    ...(reserveTokens === undefined ? {} : { reserveTokens }),
    ...(keepRecentTokens === undefined ? {} : { keepRecentTokens }),
  };
  return Object.freeze({ compaction: Object.freeze(clone) });
}

function snapshotSettingsProjection(projection: PiProjectSettingsProjection): PiProjectSettingsProjection | null {
  const values = cloneAllowedSettings(projection.values);
  if (!values) return null;
  return Object.freeze({
    sourcePath: projection.sourcePath,
    values,
    ...(projection.revision === undefined ? {} : { revision: projection.revision }),
  });
}

function emptyDecision(
  identity: PiProjectIdentityResolution,
  status: PiProjectTrustDecision['status'],
  reason: string,
  approvalRevision: string | null,
  discovered: PiProjectDiscoveredResources,
  settingsProjection: PiProjectSettingsProjection | null = null,
): PiProjectTrustDecision {
  return {
    status,
    projectKey: piProjectKey(identity),
    canonicalWorkingDir: identity.canonicalWorkingDir,
    canonicalRepoRoot: identity.canonicalRepoRoot,
    approvalRevision,
    reason,
    eligibleSkillPaths: [],
    eligibleSettingsPaths: [],
    settingsProjection,
    resources: {
      skills: discovered.skills.length ? 'discovered' : 'blocked',
      settings: discovered.settings.length ? 'discovered' : 'blocked',
      packages: discovered.packages.length ? 'discovered' : 'blocked',
      extensions: discovered.extensions.length ? 'discovered' : 'blocked',
    },
    launch: {
      approve: false,
      writeTrustJson: false,
      inheritUserPiHome: false,
      allowPackages: false,
      allowExtensions: false,
    },
    requiresNewSession: true,
  };
}

/**
 * Decide which discovered project resources PR4 may assemble for one session.
 * This function is intentionally fail-closed and does not claim runtime
 * `loaded`; only Pi's runtime capability manifest can make that claim.
 */
export function evaluatePiProjectTrust(input: {
  identity: PiProjectIdentityResolution;
  approval: PiProjectApprovalSnapshot | null;
  discovered: PiProjectDiscoveredResources;
  capabilities?: Partial<PiProjectTrustCapabilities>;
  settingsProjection?: PiProjectSettingsProjection | null;
}): PiProjectTrustDecision {
  const { identity, approval, discovered } = input;
  if (
    identity.repoRootStatus !== 'resolved' ||
    !hasLosslessCanonicalEncoding(identity) ||
    !identity.canonicalWorkingDir ||
    !identity.canonicalRepoRoot ||
    !piProjectKey(identity)
  ) {
    return emptyDecision(identity, 'unavailable', 'project-identity-unavailable', null, discovered);
  }
  if (!approval) return emptyDecision(identity, 'unapproved', 'approval-missing', null, discovered);
  if (approval.status !== 'approved') {
    return emptyDecision(
      identity,
      approval.status,
      approval.reason ?? `approval-${approval.status}`,
      approval.revision ?? null,
      discovered,
    );
  }

  const expectedKey = approvalScopeKey(identity, approval.scope);
  const suppliedKey = normalizeApprovalScopeKey(
    approval.scopeKey,
    identity.platform,
    approval.scope,
  );
  if (!expectedKey || suppliedKey !== expectedKey) {
    return emptyDecision(identity, 'unapproved', 'approval-scope-mismatch', approval.revision, discovered);
  }

  const capabilities: PiProjectTrustCapabilities = {
    explicitSkills: input.capabilities?.explicitSkills ?? DEFAULT_CAPABILITIES.explicitSkills,
    projectedSettings: input.capabilities?.projectedSettings ?? DEFAULT_CAPABILITIES.projectedSettings,
    packagesDisabled: input.capabilities?.packagesDisabled ?? DEFAULT_CAPABILITIES.packagesDisabled,
    extensionsDisabled: input.capabilities?.extensionsDisabled ?? DEFAULT_CAPABILITIES.extensionsDisabled,
  };
  const suppliedProjection = input.settingsProjection;
  const projectionSnapshot = suppliedProjection ? snapshotSettingsProjection(suppliedProjection) : null;
  const settingsProjection =
    capabilities.projectedSettings &&
    input.capabilities?.packagesDisabled === true &&
    input.capabilities?.extensionsDisabled === true &&
    projectionSnapshot &&
    discovered.settings.includes(projectionSnapshot.sourcePath) &&
    projectionSnapshot.sourcePath.length > 0
      ? projectionSnapshot
      : null;
  const settingsEligible = settingsProjection !== null;
  return {
    ...emptyDecision(identity, 'approved', 'approval-matched', approval.revision, discovered, settingsProjection),
    eligibleSkillPaths: capabilities.explicitSkills ? [...discovered.skills] : [],
    eligibleSettingsPaths: settingsProjection ? [settingsProjection.sourcePath] : [],
    resources: {
      skills: capabilities.explicitSkills && discovered.skills.length ? 'eligible' : discovered.skills.length ? 'discovered' : 'blocked',
      settings: settingsEligible && discovered.settings.length ? 'eligible' : discovered.settings.length ? 'discovered' : 'blocked',
      packages: discovered.packages.length ? 'discovered' : 'blocked',
      extensions: discovered.extensions.length ? 'discovered' : 'blocked',
    },
  };
}
