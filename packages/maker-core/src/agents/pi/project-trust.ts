import type {
  PiProjectApprovalSnapshot,
  PiProjectCanonicalPathEvidence,
  PiProjectDiscoveredResources,
  PiProjectIdentityResolution,
  PiProjectSettingsProjection,
  PiProjectSettingsValues,
  PiProjectTrustCapabilities,
  PiProjectTrustDecision,
  PiProjectWindowsCaseComparison,
} from '../../types/pi-project-trust.js';

function normalizePath(
  value: string,
  platform: 'posix' | 'win32',
  windowsCaseComparison?: PiProjectWindowsCaseComparison,
): string | null {
  if (value.includes('\0') || value.includes('\uFFFD')) return null;
  if (platform === 'posix') {
    // Canonical POSIX paths come from the host resolver. Preserve their literal
    // bytes so a valid path containing spaces or backslashes cannot alias another.
    return value.startsWith('/') && !hasDotSegments(value) ? value : null;
  }

  if (!value) return null;
  if (windowsCaseComparison !== 'ordinal-insensitive' && windowsCaseComparison !== 'case-sensitive') return null;
  let withForwardSlashes = value.replaceAll('\\', '/');
  // JavaScript Unicode case folding is not the Win32 ordinal comparison used
  // by the filesystem. Until the host supplies a Win32 comparison identity,
  // reject non-ASCII paths rather than allowing approval-key collisions.
  if (
    windowsCaseComparison === 'ordinal-insensitive' &&
    Array.from(withForwardSlashes).some((character) => (character.codePointAt(0) ?? 0) > 0x7f)
  ) {
    return null;
  }
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
  if (hasDotSegments(slash)) return null;
  if (platform === 'win32') {
    if (!/^(?:[A-Za-z]:\/|\/\/)/.test(slash)) return null;
    if (slash.startsWith('//') && !/^\/\/[^/]+\/[^/]+(?:\/|$)/.test(slash)) return null;
    if (/^[A-Za-z]:\/$/.test(slash)) {
      return windowsCaseComparison === 'ordinal-insensitive' ? slash.toLowerCase() : slash;
    }
    const withoutTrailingSlash = slash.replace(/\/$/, '');
    return windowsCaseComparison === 'ordinal-insensitive'
      ? withoutTrailingSlash.toLowerCase()
      : withoutTrailingSlash;
  }
  return null;
}

/** Compare two host canonical paths with the exact platform identity used by approval keys. */
export function piCanonicalPathsEqual(
  identity: Pick<PiProjectIdentityResolution, 'platform' | 'windowsCaseComparison'>,
  first: string,
  second: string,
): boolean {
  const left = normalizePath(first, identity.platform, identity.windowsCaseComparison);
  const right = normalizePath(second, identity.platform, identity.windowsCaseComparison);
  return left !== null && right !== null && left === right;
}

/** Check containment using the same canonical comparison identity as approval keys. */
export function piCanonicalPathIsWithin(
  identity: Pick<PiProjectIdentityResolution, 'platform' | 'windowsCaseComparison'>,
  root: string,
  candidate: string,
): boolean {
  const normalizedRoot = normalizePath(root, identity.platform, identity.windowsCaseComparison);
  const normalizedCandidate = normalizePath(candidate, identity.platform, identity.windowsCaseComparison);
  if (normalizedRoot === null || normalizedCandidate === null) return false;
  const rootPrefix = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`;
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(rootPrefix);
}

function hasLosslessCanonicalEncoding(
  identity: Pick<PiProjectIdentityResolution, 'platform' | 'canonicalPathEncoding' | 'windowsCaseComparison'>,
): boolean {
  return identity.platform === 'posix'
    ? identity.canonicalPathEncoding === 'utf8-lossless'
    : identity.platform === 'win32' &&
      identity.canonicalPathEncoding === 'utf16-lossless' &&
      (identity.windowsCaseComparison === 'ordinal-insensitive' || identity.windowsCaseComparison === 'case-sensitive');
}

function isPathWithinRoot(root: string, candidate: string): boolean {
  const rootPrefix = root.endsWith('/') ? root : `${root}/`;
  return candidate === root || candidate.startsWith(rootPrefix);
}

function hasDotSegments(value: string): boolean {
  return value.split('/').some((segment) => segment === '.' || segment === '..');
}

function isCanonicalPathEvidence(value: unknown): value is PiProjectCanonicalPathEvidence {
  if (typeof value !== 'object' || value === null) return false;
  const evidence = value as Record<string, unknown>;
  return typeof evidence.discoveredPath === 'string' && typeof evidence.canonicalPath === 'string';
}

export function piProjectKey(
  identity: Pick<PiProjectIdentityResolution, 'canonicalWorkingDir' | 'canonicalRepoRoot' | 'platform' | 'canonicalPathEncoding' | 'windowsCaseComparison'>,
): string | null {
  const platform = identity.platform;
  if (!platform || !hasLosslessCanonicalEncoding(identity)) return null;
  const repoRoot = identity.canonicalRepoRoot && normalizePath(identity.canonicalRepoRoot, platform, identity.windowsCaseComparison);
  const workingDir = identity.canonicalWorkingDir && normalizePath(identity.canonicalWorkingDir, platform, identity.windowsCaseComparison);
  if (!repoRoot || !workingDir) return null;
  return `${repoRoot}\0${workingDir}`;
}

function approvalScopeKey(
  identity: Pick<PiProjectIdentityResolution, 'canonicalWorkingDir' | 'canonicalRepoRoot' | 'platform' | 'canonicalPathEncoding' | 'windowsCaseComparison'>,
  scope: 'working-dir' | 'repo-root',
): string | null {
  const platform = identity.platform;
  if (!platform || !hasLosslessCanonicalEncoding(identity)) return null;
  const repoRoot = identity.canonicalRepoRoot && normalizePath(identity.canonicalRepoRoot, platform, identity.windowsCaseComparison);
  if (!repoRoot) return null;
  if (scope === 'repo-root') return repoRoot;
  const workingDir = identity.canonicalWorkingDir && normalizePath(identity.canonicalWorkingDir, platform, identity.windowsCaseComparison);
  return workingDir ? `${repoRoot}\0${workingDir}` : null;
}

function normalizeApprovalScopeKey(
  value: string,
  platform: 'posix' | 'win32',
  scope: 'working-dir' | 'repo-root',
  windowsCaseComparison?: PiProjectWindowsCaseComparison,
): string | null {
  if (scope === 'repo-root') return normalizePath(value, platform, windowsCaseComparison);
  const separator = value.indexOf('\0');
  if (separator < 0 || value.lastIndexOf('\0') !== separator) return null;
  const repoRoot = normalizePath(value.slice(0, separator), platform, windowsCaseComparison);
  const workingDir = normalizePath(value.slice(separator + 1), platform, windowsCaseComparison);
  return repoRoot && workingDir ? `${repoRoot}\0${workingDir}` : null;
}

function canonicalEligibleSkillPaths(
  identity: PiProjectIdentityResolution,
  discovered: PiProjectDiscoveredResources,
): readonly string[] {
  const skillsEvidence = discovered.canonicalSkillEvidence;
  if (!skillsEvidence || skillsEvidence.length !== discovered.skills.length || skillsEvidence.length === 0) return [];
  if (skillsEvidence.some((evidence, index) => !isCanonicalPathEvidence(evidence) || evidence.discoveredPath !== discovered.skills[index])) return [];
  const repoRoot = identity.canonicalRepoRoot &&
    normalizePath(identity.canonicalRepoRoot, identity.platform, identity.windowsCaseComparison);
  if (!repoRoot) return [];
  const normalizedSkills = skillsEvidence.map((evidence) =>
    normalizePath(evidence.canonicalPath, identity.platform, identity.windowsCaseComparison),
  );
  const validSkills = normalizedSkills.filter((skillPath): skillPath is string => skillPath !== null);
  if (validSkills.length !== normalizedSkills.length || new Set(validSkills).size !== validSkills.length) return [];
  return validSkills.every((skillPath) => isPathWithinRoot(repoRoot, skillPath))
    ? skillsEvidence.map((evidence) => evidence.canonicalPath)
    : [];
}

function canonicalEligibleSettingsPaths(
  identity: PiProjectIdentityResolution,
  discovered: PiProjectDiscoveredResources,
): readonly string[] {
  const settingsEvidence = discovered.canonicalSettings;
  if (!settingsEvidence || settingsEvidence.length !== discovered.settings.length || settingsEvidence.length === 0) return [];
  if (settingsEvidence.some((evidence, index) => !isCanonicalPathEvidence(evidence) || evidence.discoveredPath !== discovered.settings[index])) return [];
  const repoRoot = identity.canonicalRepoRoot &&
    normalizePath(identity.canonicalRepoRoot, identity.platform, identity.windowsCaseComparison);
  if (!repoRoot) return [];
  const normalizedSettings = settingsEvidence.map((evidence) =>
    normalizePath(evidence.canonicalPath, identity.platform, identity.windowsCaseComparison),
  );
  const validSettings = normalizedSettings.filter((settingsPath): settingsPath is string => settingsPath !== null);
  if (validSettings.length !== normalizedSettings.length || new Set(validSettings).size !== validSettings.length) return [];
  return validSettings.every((settingsPath) => isPathWithinRoot(repoRoot, settingsPath))
    ? settingsEvidence.map((evidence) => evidence.canonicalPath)
    : [];
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
  // 信任边界:项目 settings 是不可信内容,上界防不可信仓库把保留量写到天文数字让自动压缩永不触发。
  // 下界按 pi 契约取 0:两个字段都是「非负安全整数」(pinned pi 的 settings 契约),
  // 0 合法 —— 拒了会把用户已批准的项目设置整份丢掉,连同合法的 keepRecentTokens 一起失效。
  // 本仓生成侧的 Math.max(1,…) 是运行时保留量,与这里的项目白名单不是一回事。
  const plausible = (tokens: unknown): tokens is number =>
    typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens >= 0 && tokens <= 100_000_000;
  if (
    (reserveTokens !== undefined && !plausible(reserveTokens)) ||
    (keepRecentTokens !== undefined && !plausible(keepRecentTokens))
  ) return null;
  const clone = {
    ...(reserveTokens === undefined ? {} : { reserveTokens }),
    ...(keepRecentTokens === undefined ? {} : { keepRecentTokens }),
  };
  if (Object.keys(clone).length === 0) return null;
  return Object.freeze({ compaction: Object.freeze(clone) });
}

function snapshotSettingsProjection(projection: PiProjectSettingsProjection): PiProjectSettingsProjection | null {
  if (
    typeof projection.sourcePath !== 'string' ||
    !projection.sourcePath ||
    projection.sourcePath.includes('\0') ||
    projection.sourcePath.includes('\uFFFD')
  ) {
    return null;
  }
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
    projectKey: status === 'unavailable' ? null : piProjectKey(identity),
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
  const normalizedRepoRoot = normalizePath(identity.canonicalRepoRoot, identity.platform, identity.windowsCaseComparison);
  const normalizedWorkingDir = normalizePath(identity.canonicalWorkingDir, identity.platform, identity.windowsCaseComparison);
  if (!normalizedRepoRoot || !normalizedWorkingDir || !isPathWithinRoot(normalizedRepoRoot, normalizedWorkingDir)) {
    return emptyDecision(identity, 'unavailable', 'working-dir-outside-repo-root', null, discovered);
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
    identity.windowsCaseComparison,
  );
  if (!expectedKey || suppliedKey !== expectedKey) {
    return emptyDecision(identity, 'unapproved', 'approval-scope-mismatch', approval.revision, discovered);
  }

  const capabilities: PiProjectTrustCapabilities = {
    explicitSkills: input.capabilities?.explicitSkills === true,
    projectedSettings: input.capabilities?.projectedSettings === true,
    packagesDisabled: input.capabilities?.packagesDisabled === true,
    extensionsDisabled: input.capabilities?.extensionsDisabled === true,
  };
  const suppliedProjection = input.settingsProjection;
  const projectionSnapshot = suppliedProjection ? snapshotSettingsProjection(suppliedProjection) : null;
  const eligibleCanonicalSettings = canonicalEligibleSettingsPaths(identity, discovered);
  const settingsSourceIndex = projectionSnapshot ? discovered.settings.indexOf(projectionSnapshot.sourcePath) : -1;
  const canonicalSettingsSource = settingsSourceIndex >= 0 ? eligibleCanonicalSettings[settingsSourceIndex] : undefined;
  const settingsProjection =
    capabilities.projectedSettings &&
    capabilities.packagesDisabled &&
    capabilities.extensionsDisabled &&
    projectionSnapshot &&
    settingsSourceIndex >= 0 &&
    eligibleCanonicalSettings.length === discovered.settings.length &&
    canonicalSettingsSource !== undefined &&
    projectionSnapshot.sourcePath.length > 0
      ? snapshotSettingsProjection({ ...projectionSnapshot, sourcePath: canonicalSettingsSource })
      : null;
  const settingsEligible = settingsProjection !== null;
  const eligibleSkillPaths = capabilities.explicitSkills ? canonicalEligibleSkillPaths(identity, discovered) : [];
  return {
    ...emptyDecision(identity, 'approved', 'approval-matched', approval.revision, discovered, settingsProjection),
    eligibleSkillPaths,
    eligibleSettingsPaths: settingsProjection ? [settingsProjection.sourcePath] : [],
    resources: {
      skills: eligibleSkillPaths.length ? 'eligible' : discovered.skills.length ? 'discovered' : 'blocked',
      settings: settingsEligible && discovered.settings.length ? 'eligible' : discovered.settings.length ? 'discovered' : 'blocked',
      packages: discovered.packages.length ? 'discovered' : 'blocked',
      extensions: discovered.extensions.length ? 'discovered' : 'blocked',
    },
  };
}
