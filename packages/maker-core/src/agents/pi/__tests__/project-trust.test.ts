import { describe, expect, it } from 'vitest';

import { evaluatePiProjectTrust, piProjectKey } from '../project-trust.js';
import type {
  PiProjectApprovalSnapshot,
  PiProjectDiscoveredResources,
  PiProjectIdentityResolution,
  PiProjectSettingsProjection,
} from '../../../types/pi-project-trust.js';

const identity: PiProjectIdentityResolution = {
  workingDir: '/repo/packages/app',
  canonicalWorkingDir: '/repo/packages/app',
  canonicalRepoRoot: '/repo',
  repoRootStatus: 'resolved',
  platform: 'posix',
  canonicalPathEncoding: 'utf8-lossless',
};

const discovered: PiProjectDiscoveredResources = {
  skills: ['/repo/.pi/skills/a', '/repo/.agents/skills/b'],
  canonicalSkillEvidence: [
    { discoveredPath: '/repo/.pi/skills/a', canonicalPath: '/repo/.pi/skills/a' },
    { discoveredPath: '/repo/.agents/skills/b', canonicalPath: '/repo/.agents/skills/b' },
  ],
  settings: ['/repo/.pi/settings.json'],
  canonicalSettings: [{ discoveredPath: '/repo/.pi/settings.json', canonicalPath: '/repo/.pi/settings.json' }],
  packages: ['/repo/.pi/package.json'],
  extensions: ['/repo/.pi/extensions/x.ts'],
};

const approval = (overrides: Partial<Extract<PiProjectApprovalSnapshot, { status: 'approved' }>> = {}): PiProjectApprovalSnapshot => ({
  status: 'approved',
  scope: 'working-dir',
  scopeKey: '/repo\0/repo/packages/app',
  revision: 'rev-1',
  ...overrides,
});

const provenSettingsCapabilities = {
  projectedSettings: true,
  packagesDisabled: true,
  extensionsDisabled: true,
} as const;

function expectSettingsDiscovered(result: ReturnType<typeof evaluatePiProjectTrust>): void {
  expect(result.resources.settings).toBe('discovered');
  expect(result.settingsProjection).toBeNull();
  expect(result.eligibleSettingsPaths).toEqual([]);
}

describe('Pi project trust contract', () => {
  it('uses canonical repo root + workingDir and isolates sibling workingDirs', () => {
    expect(piProjectKey(identity)).toBe('/repo\0/repo/packages/app');
    expect(evaluatePiProjectTrust({ identity, approval: approval(), discovered }).status).toBe('approved');
    expect(evaluatePiProjectTrust({
      identity: { ...identity, canonicalWorkingDir: '/repo/packages/other' },
      approval: approval(),
      discovered,
    }).status).toBe('unapproved');
  });

  it('allows explicit skills only; settings/packages/extensions stay separated', () => {
    const result = evaluatePiProjectTrust({
      identity,
      approval: approval(),
      discovered,
      capabilities: { explicitSkills: true },
    });
    expect(result.eligibleSkillPaths).toEqual(discovered.skills);
    expect(result.eligibleSettingsPaths).toEqual([]);
    expect(result.settingsProjection).toBeNull();
    expect(result.resources).toEqual({
      skills: 'eligible', settings: 'discovered', packages: 'discovered', extensions: 'discovered',
    });
    expect(result.launch).toEqual({
      approve: false,
      writeTrustJson: false,
      inheritUserPiHome: false,
      allowPackages: false,
      allowExtensions: false,
    });
  });

  it('keeps skills discovered when canonical realpath evidence is missing', () => {
    const result = evaluatePiProjectTrust({
      identity,
      approval: approval(),
      discovered: {
        ...discovered,
        canonicalSkills: discovered.skills,
        canonicalSkillEvidence: undefined,
      },
      capabilities: { explicitSkills: true },
    });
    expect(result.resources.skills).toBe('discovered');
    expect(result.eligibleSkillPaths).toEqual([]);
  });

  it('rejects skill evidence whose discovered path does not match by position', () => {
    const result = evaluatePiProjectTrust({
      identity,
      approval: approval(),
      discovered: {
        ...discovered,
        canonicalSkillEvidence: [
          { discoveredPath: '/outside/untrusted-skill', canonicalPath: '/repo/.pi/skills/a' },
          { discoveredPath: '/repo/.agents/skills/b', canonicalPath: '/repo/.agents/skills/b' },
        ],
      },
      capabilities: { explicitSkills: true },
    });
    expect(result.resources.skills).toBe('discovered');
    expect(result.eligibleSkillPaths).toEqual([]);
  });

  it('fails closed for malformed skill evidence supplied at the host boundary', () => {
    const result = evaluatePiProjectTrust({
      identity,
      approval: approval(),
      discovered: {
        ...discovered,
        canonicalSkillEvidence: [null, { discoveredPath: '/repo/.agents/skills/b', canonicalPath: '/repo/.agents/skills/b' }],
      } as unknown as PiProjectDiscoveredResources,
      capabilities: { explicitSkills: true },
    });
    expect(result.resources.skills).toBe('discovered');
    expect(result.eligibleSkillPaths).toEqual([]);
  });

  it('emits canonical I/O paths for an in-repo skill symlink target', () => {
    const sourcePath = '/repo/.pi/skills/link';
    const canonicalPath = '/repo/.agents/skills/target';
    const result = evaluatePiProjectTrust({
      identity,
      approval: approval(),
      discovered: {
        ...discovered,
        skills: [sourcePath],
        canonicalSkillEvidence: [{ discoveredPath: sourcePath, canonicalPath }],
      },
      capabilities: { explicitSkills: true },
    });
    expect(result.resources.skills).toBe('eligible');
    expect(result.eligibleSkillPaths).toEqual([canonicalPath]);
  });

  it('maps a raw settings source path to its canonical I/O path', () => {
    const sourcePath = '/repo/.pi/settings-link.json';
    const canonicalPath = '/repo/.pi/settings.json';
    const result = evaluatePiProjectTrust({
      identity,
      approval: approval(),
      discovered: {
        ...discovered,
        settings: [sourcePath],
        canonicalSettings: [{ discoveredPath: sourcePath, canonicalPath }],
      },
      capabilities: provenSettingsCapabilities,
      settingsProjection: { sourcePath, values: { compaction: { reserveTokens: 1 } } },
    });
    expect(result.resources.settings).toBe('eligible');
    expect(result.settingsProjection?.sourcePath).toBe(canonicalPath);
    expect(result.eligibleSettingsPaths).toEqual([canonicalPath]);
  });

  it('rejects canonical skill paths that resolve outside the approved repo root', () => {
    const result = evaluatePiProjectTrust({
      identity,
      approval: approval(),
      discovered: {
        ...discovered,
        canonicalSkillEvidence: [
          { discoveredPath: '/repo/.pi/skills/a', canonicalPath: '/outside/shared-skill' },
          { discoveredPath: '/repo/.agents/skills/b', canonicalPath: '/repo/.agents/skills/b' },
        ],
      },
      capabilities: { explicitSkills: true },
    });
    expect(result.resources.skills).toBe('discovered');
    expect(result.eligibleSkillPaths).toEqual([]);
  });

  it('rejects non-canonical traversal segments in canonical skill evidence', () => {
    const result = evaluatePiProjectTrust({
      identity,
      approval: approval(),
      discovered: {
        ...discovered,
        canonicalSkillEvidence: [
          { discoveredPath: '/repo/.pi/skills/a', canonicalPath: '/repo/../outside/shared-skill' },
          { discoveredPath: '/repo/.agents/skills/b', canonicalPath: '/repo/.agents/skills/b' },
        ],
      },
      capabilities: { explicitSkills: true },
    });
    expect(result.resources.skills).toBe('discovered');
    expect(result.eligibleSkillPaths).toEqual([]);
  });

  it('fails closed when the working directory is outside the resolved repository root', () => {
    const result = evaluatePiProjectTrust({
      identity: {
        ...identity,
        canonicalWorkingDir: '/outside/worktree',
      },
      approval: approval({ scope: 'repo-root', scopeKey: '/repo' }),
      discovered,
      capabilities: { explicitSkills: true },
    });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('working-dir-outside-repo-root');
    expect(result.resources.skills).toBe('discovered');
    expect(result.eligibleSkillPaths).toEqual([]);
  });

  it('keeps restrictive defaults when optional capability fields are undefined', () => {
    const result = evaluatePiProjectTrust({
      identity,
      approval: approval(),
      discovered,
      capabilities: {
        explicitSkills: undefined,
        projectedSettings: undefined,
        packagesDisabled: undefined,
        extensionsDisabled: undefined,
      },
    });
    expect(result.eligibleSkillPaths).toEqual([]);
    expect(result.eligibleSettingsPaths).toEqual([]);
    expect(result.settingsProjection).toBeNull();
    expect(result.launch.allowPackages).toBe(false);
    expect(result.launch.allowExtensions).toBe(false);
  });

  it('treats truthy non-boolean capability values as false', () => {
    const result = evaluatePiProjectTrust({
      identity,
      approval: approval(),
      discovered,
      capabilities: {
        explicitSkills: 1 as unknown as boolean,
        projectedSettings: 'true' as unknown as boolean,
        packagesDisabled: 1 as unknown as boolean,
        extensionsDisabled: 'true' as unknown as boolean,
      },
      settingsProjection: projection,
    });
    expect(result.eligibleSkillPaths).toEqual([]);
    expectSettingsDiscovered(result);
  });

  it.each([
    ['missing', null, 'unapproved', 'approval-missing'],
    ['unapproved', { status: 'unapproved', reason: 'user-denied' } as PiProjectApprovalSnapshot, 'unapproved', 'user-denied'],
    ['revoked', { status: 'revoked', revision: 'revoked-2', reason: 'user-revoked' } as PiProjectApprovalSnapshot, 'revoked', 'user-revoked'],
    ['stale', { status: 'stale', revision: 'stale-2', reason: 'revision-old' } as PiProjectApprovalSnapshot, 'stale', 'revision-old'],
    ['unavailable', { status: 'unavailable', reason: 'store-offline' } as PiProjectApprovalSnapshot, 'unavailable', 'store-offline'],
  ])('fails closed for %s approval', (_label, input, status, reason) => {
    const result = evaluatePiProjectTrust({ identity, approval: input, discovered });
    expect(result.status).toBe(status);
    expect(result.reason).toBe(reason);
    expect(result.eligibleSkillPaths).toEqual([]);
  });

  it('keeps revoked/stale approval revisions as audit evidence', () => {
    expect(evaluatePiProjectTrust({
      identity,
      approval: { status: 'revoked', revision: 'revoked-2', reason: 'user-revoked' },
      discovered,
    }).approvalRevision).toBe('revoked-2');
    expect(evaluatePiProjectTrust({
      identity,
      approval: { status: 'stale', revision: 'stale-2', reason: 'revision-old' },
      discovered,
    }).approvalRevision).toBe('stale-2');
  });

  it('fails closed when realpath or repository root resolution is unavailable', () => {
    const result = evaluatePiProjectTrust({
      identity: {
        ...identity,
        canonicalRepoRoot: '/repo/old-root',
        canonicalWorkingDir: '/repo/old-root/packages/app',
        repoRootStatus: 'unavailable',
      },
      approval: approval(),
      discovered,
    });
    expect(result.status).toBe('unavailable');
    expect(result.projectKey).toBeNull();
    expect(result.resources.skills).toBe('discovered');
  });

  it('supports explicit repo-root approval for multiple workingDirs', () => {
    const repoApproval = approval({ scope: 'repo-root', scopeKey: '/repo' });
    expect(evaluatePiProjectTrust({
      identity: { ...identity, canonicalWorkingDir: '/repo/packages/other' },
      approval: repoApproval,
      discovered,
    }).status).toBe('approved');
  });

  it('normalizes symlink/realpath and Windows case/separators before matching', () => {
    const result = evaluatePiProjectTrust({
      identity: {
        ...identity,
        canonicalWorkingDir: 'C:/Repo/App',
        canonicalRepoRoot: 'C:/Repo',
        workingDir: 'C:\\repo\\app',
        platform: 'win32',
        canonicalPathEncoding: 'utf16-lossless',
        windowsCaseComparison: 'ordinal-insensitive',
      },
      approval: approval({ scopeKey: 'c:/repo\0c:/repo/app' }),
      discovered,
    });
    expect(result.status).toBe('approved');
  });

  it('requires a host Windows comparison identity', () => {
    const windowsIdentity: PiProjectIdentityResolution = {
      ...identity,
      workingDir: 'C:\\repo\\app',
      canonicalWorkingDir: 'C:/repo/app',
      canonicalRepoRoot: 'C:/repo',
      platform: 'win32',
      canonicalPathEncoding: 'utf16-lossless',
    };
    expect(evaluatePiProjectTrust({
      identity: windowsIdentity,
      approval: approval({ scopeKey: 'c:/repo\0c:/repo/app' }),
      discovered,
    }).status).toBe('unavailable');
  });

  it('preserves case when the host reports a case-sensitive Windows directory', () => {
    const caseSensitiveIdentity: PiProjectIdentityResolution = {
      ...identity,
      workingDir: 'C:\\repo\\App',
      canonicalWorkingDir: 'C:/repo/App',
      canonicalRepoRoot: 'C:/repo',
      platform: 'win32',
      canonicalPathEncoding: 'utf16-lossless',
      windowsCaseComparison: 'case-sensitive',
    };
    expect(evaluatePiProjectTrust({
      identity: caseSensitiveIdentity,
      approval: approval({ scopeKey: 'C:/repo\0C:/repo/App' }),
      discovered,
    }).status).toBe('approved');
    expect(evaluatePiProjectTrust({
      identity: caseSensitiveIdentity,
      approval: approval({ scopeKey: 'c:/repo\0c:/repo/app' }),
      discovered,
    }).status).toBe('unapproved');
  });

  it('preserves a Windows drive root when deriving the project key', () => {
    const driveRootIdentity: PiProjectIdentityResolution = {
      ...identity,
      workingDir: 'C:\\',
      canonicalWorkingDir: 'C:/',
      canonicalRepoRoot: 'C:/',
      platform: 'win32',
      canonicalPathEncoding: 'utf16-lossless',
      windowsCaseComparison: 'ordinal-insensitive',
    };
    const result = evaluatePiProjectTrust({
      identity: driveRootIdentity,
      approval: approval({ scope: 'repo-root', scopeKey: 'c:/' }),
      discovered,
    });
    expect(result.status).toBe('approved');
    expect(result.projectKey).toBe('c:/\0c:/');
  });

  it('normalizes Windows extended-length canonical paths', () => {
    const extendedIdentity: PiProjectIdentityResolution = {
      ...identity,
      workingDir: '\\\\?\\C:\\Repo\\App',
      canonicalWorkingDir: '//?/C:/Repo/App',
      canonicalRepoRoot: '//?/C:/Repo',
      platform: 'win32',
      canonicalPathEncoding: 'utf16-lossless',
      windowsCaseComparison: 'ordinal-insensitive',
    };
    expect(evaluatePiProjectTrust({
      identity: extendedIdentity,
      approval: approval({ scopeKey: 'c:/repo\0c:/repo/app' }),
      discovered,
    }).status).toBe('approved');

    const extendedUncIdentity: PiProjectIdentityResolution = {
      ...extendedIdentity,
      workingDir: '\\\\?\\UNC\\Server\\Share\\Repo\\App',
      canonicalWorkingDir: '//?/UNC/Server/Share/Repo/App',
      canonicalRepoRoot: '//?/UNC/Server/Share/Repo',
    };
    expect(evaluatePiProjectTrust({
      identity: extendedUncIdentity,
      approval: approval({ scopeKey: '//server/share/repo\0//server/share/repo/app' }),
      discovered,
    }).status).toBe('approved');
  });

  it.each([
    {
      label: 'drive',
      canonicalRepoRoot: '//?/C:/Repo',
      canonicalWorkingDir: '//?/C:/Repo/App',
      scopeKey: 'c:/repo\0c:/repo/app',
    },
    {
      label: 'UNC',
      canonicalRepoRoot: '//?/UNC/Server/Share/Repo',
      canonicalWorkingDir: '//?/UNC/Server/Share/Repo/App',
      scopeKey: '//server/share/repo\0//server/share/repo/app',
    },
  ])('preserves extended-length %s I/O paths with trailing space/dot', ({ canonicalRepoRoot, canonicalWorkingDir, scopeKey }) => {
    const skillPath = `${canonicalRepoRoot}/.pi/skills/skill `;
    const settingsPath = `${canonicalRepoRoot}/.pi/settings.json.`;
    const extendedResources: PiProjectDiscoveredResources = {
      skills: [skillPath],
      canonicalSkillEvidence: [{ discoveredPath: skillPath, canonicalPath: skillPath }],
      settings: [settingsPath],
      canonicalSettings: [{ discoveredPath: settingsPath, canonicalPath: settingsPath }],
      packages: [],
      extensions: [],
    };
    const extendedIdentity: PiProjectIdentityResolution = {
      ...identity,
      workingDir: canonicalWorkingDir,
      canonicalWorkingDir,
      canonicalRepoRoot,
      platform: 'win32',
      canonicalPathEncoding: 'utf16-lossless',
      windowsCaseComparison: 'ordinal-insensitive',
    };
    const result = evaluatePiProjectTrust({
      identity: extendedIdentity,
      approval: approval({ scopeKey }),
      discovered: extendedResources,
      capabilities: { explicitSkills: true, ...provenSettingsCapabilities },
      settingsProjection: { sourcePath: settingsPath, values: { compaction: { reserveTokens: 1 } } },
    });
    expect(result.resources.skills).toBe('eligible');
    expect(result.eligibleSkillPaths).toEqual([skillPath]);
    expect(result.resources.settings).toBe('eligible');
    expect(result.settingsProjection?.sourcePath).toBe(settingsPath);
    expect(result.eligibleSettingsPaths).toEqual([settingsPath]);
  });

  it('preserves literal POSIX canonical path bytes', () => {
    const literalIdentity: PiProjectIdentityResolution = {
      ...identity,
      workingDir: '/repo/packages/app ',
      canonicalWorkingDir: '/repo/packages/app \\',
      canonicalRepoRoot: '/repo',
    };
    const literalApproval = approval({ scopeKey: '/repo\0/repo/packages/app \\' });
    expect(evaluatePiProjectTrust({ identity: literalIdentity, approval: literalApproval, discovered }).status).toBe('approved');
    expect(evaluatePiProjectTrust({
      identity: { ...literalIdentity, canonicalWorkingDir: '/repo/packages/app' },
      approval: literalApproval,
      discovered,
    }).status).toBe('unapproved');
  });

  const projection: PiProjectSettingsProjection = {
    sourcePath: '/repo/.pi/settings.json',
    values: { compaction: { reserveTokens: 16_384, keepRecentTokens: 8_192 } },
    revision: 'settings-rev-1',
  };

  it('keeps settings discovered until every hard gate is explicitly proven', () => {
    const result = evaluatePiProjectTrust({
      identity,
      approval: approval(),
      discovered,
      capabilities: { projectedSettings: true },
      settingsProjection: projection,
    });
    expectSettingsDiscovered(result);
  });

  it('keeps settings discovered when canonical realpath evidence is missing', () => {
    const result = evaluatePiProjectTrust({
      identity,
      approval: approval(),
      discovered: { ...discovered, canonicalSettings: undefined },
      capabilities: provenSettingsCapabilities,
      settingsProjection: projection,
    });
    expectSettingsDiscovered(result);
  });

  it.each([
    ['outside the repo root', ['/outside/settings.json']],
    ['non-canonical', ['/repo/../outside/settings.json']],
  ])('keeps settings discovered when canonical settings evidence is %s', (_label, canonicalSettings) => {
    const result = evaluatePiProjectTrust({
      identity,
      approval: approval(),
      discovered: {
        ...discovered,
        canonicalSettings: canonicalSettings.map((canonicalPath) => ({
          discoveredPath: '/repo/.pi/settings.json',
          canonicalPath,
        })),
      },
      capabilities: provenSettingsCapabilities,
      settingsProjection: projection,
    });
    expectSettingsDiscovered(result);
  });

  it('rejects settings evidence whose discovered path does not match by position', () => {
    const result = evaluatePiProjectTrust({
      identity,
      approval: approval(),
      discovered: {
        ...discovered,
        canonicalSettings: [{ discoveredPath: '/outside/settings.json', canonicalPath: '/repo/.pi/settings.json' }],
      },
      capabilities: provenSettingsCapabilities,
      settingsProjection: projection,
    });
    expectSettingsDiscovered(result);
  });

  it('emits the canonical settings path for a reviewed in-repo symlink target', () => {
    const sourcePath = '/repo/.pi/settings-link.json';
    const canonicalPath = '/repo/.pi/settings.json';
    const result = evaluatePiProjectTrust({
      identity,
      approval: approval(),
      discovered: {
        ...discovered,
        settings: [sourcePath],
        canonicalSettings: [{ discoveredPath: sourcePath, canonicalPath }],
      },
      capabilities: provenSettingsCapabilities,
      settingsProjection: { ...projection, sourcePath },
    });
    expect(result.resources.settings).toBe('eligible');
    expect(result.settingsProjection?.sourcePath).toBe(canonicalPath);
    expect(result.eligibleSettingsPaths).toEqual([canonicalPath]);
  });

  it('exposes a non-empty reviewed settings projection after every hard gate is proven', () => {
    const result = evaluatePiProjectTrust({
      identity,
      approval: approval(),
      discovered,
      capabilities: provenSettingsCapabilities,
      settingsProjection: projection,
    });
    expect(result.resources.settings).toBe('eligible');
    expect(result.settingsProjection).toEqual(projection);
    expect(result.eligibleSettingsPaths).toEqual([projection.sourcePath]);
  });

  it.each([
    ['undefined-only values', { compaction: { reserveTokens: undefined } }],
    ['empty values', {}],
    ['packages key', { packages: [] }],
    ['extensions key', { extensions: [] }],
    ['defaultProjectTrust key', { defaultProjectTrust: 'always' }],
    [
      'non-plain values',
      Object.assign(
        Object.create({ inherited: true }) as Record<string, unknown>,
        { compaction: { reserveTokens: 16_384 } },
      ),
    ],
    ['null values', null],
    ['negative threshold', { compaction: { reserveTokens: -1 } }],
  ])('rejects %s after settings hard gates are proven', (_label, values) => {
    const result = evaluatePiProjectTrust({
      identity,
      approval: approval(),
      discovered,
      capabilities: provenSettingsCapabilities,
      settingsProjection: {
        sourcePath: '/repo/.pi/settings.json',
        values: values as PiProjectSettingsProjection['values'],
      },
    });
    expectSettingsDiscovered(result);
  });

  it('rejects a reviewed projection whose source was not discovered', () => {
    const result = evaluatePiProjectTrust({
      identity,
      approval: approval(),
      discovered,
      capabilities: provenSettingsCapabilities,
      settingsProjection: { sourcePath: '/repo/.pi/other-settings.json', values: { compaction: { reserveTokens: 16_384 } } },
    });
    expectSettingsDiscovered(result);
  });

  it.each([
    ['NUL', '/repo/.pi/settings\0.json'],
    ['replacement character', '/repo/.pi/settings\uFFFD.json'],
    ['empty path', ''],
  ])('rejects a discovered settings source containing %s', (_label, sourcePath) => {
    const result = evaluatePiProjectTrust({
      identity,
      approval: approval(),
      discovered: { ...discovered, settings: [sourcePath] },
      capabilities: provenSettingsCapabilities,
      settingsProjection: {
        sourcePath,
        values: { compaction: { reserveTokens: 16_384 } },
      },
    });
    expectSettingsDiscovered(result);
  });

  it('returns a detached frozen settings snapshot', () => {
    const mutableValues = { compaction: { reserveTokens: 16_384 } };
    const mutableProjection = {
      sourcePath: '/repo/.pi/settings.json',
      values: mutableValues,
      revision: 'settings-rev-1',
    };
    const result = evaluatePiProjectTrust({
      identity,
      approval: approval(),
      discovered,
      capabilities: { projectedSettings: true, packagesDisabled: true, extensionsDisabled: true },
      settingsProjection: mutableProjection,
    });
    mutableProjection.sourcePath = '/repo/.pi/other-settings.json';
    mutableValues.compaction.reserveTokens = 1;
    Object.assign(mutableValues, { defaultProjectTrust: 'always' });

    expect(result.settingsProjection).toEqual({
      sourcePath: '/repo/.pi/settings.json',
      values: { compaction: { reserveTokens: 16_384 } },
      revision: 'settings-rev-1',
    });
    expect(Object.isFrozen(result.settingsProjection)).toBe(true);
    expect(Object.isFrozen(result.settingsProjection?.values)).toBe(true);
    expect(Object.isFrozen(result.settingsProjection?.values.compaction)).toBe(true);
    expect(result.eligibleSettingsPaths).toEqual(['/repo/.pi/settings.json']);
  });

  it('rejects path NULs and ambiguous working-dir scope separators', () => {
    expect(evaluatePiProjectTrust({
      identity: { ...identity, canonicalWorkingDir: '/repo/app\0other' },
      approval: approval(),
      discovered,
    }).status).toBe('unavailable');
    expect(evaluatePiProjectTrust({
      identity,
      approval: approval({ scopeKey: '/repo\0/repo/packages/app\0other' }),
      discovered,
    }).status).toBe('unapproved');
  });

  it('fails closed when host platform semantics are missing', () => {
    const identityWithoutPlatform = { ...identity, platform: undefined } as unknown as PiProjectIdentityResolution;
    expect(evaluatePiProjectTrust({
      identity: identityWithoutPlatform as PiProjectIdentityResolution,
      approval: approval(),
      discovered,
    }).status).toBe('unavailable');
  });

  it('fails closed when POSIX canonical bytes are not lossless UTF-8', () => {
    expect(evaluatePiProjectTrust({
      identity: { ...identity, canonicalPathEncoding: 'unavailable' },
      approval: approval(),
      discovered,
    }).status).toBe('unavailable');
    expect(evaluatePiProjectTrust({
      identity: { ...identity, canonicalWorkingDir: '/repo/bad\uFFFDname' },
      approval: approval(),
      discovered,
    }).status).toBe('unavailable');
    expect(evaluatePiProjectTrust({
      identity: { ...identity, canonicalPathEncoding: 'utf16-lossless' },
      approval: approval(),
      discovered,
    }).status).toBe('unavailable');
  });

  it('preserves trailing whitespace in Windows canonical paths', () => {
    const trailingIdentity: PiProjectIdentityResolution = {
      ...identity,
      workingDir: 'C:\\repo\\app ',
      canonicalWorkingDir: 'C:/repo/app ',
      canonicalRepoRoot: 'C:/repo',
      platform: 'win32',
      canonicalPathEncoding: 'utf16-lossless',
      windowsCaseComparison: 'ordinal-insensitive',
    };
    expect(evaluatePiProjectTrust({
      identity: trailingIdentity,
      approval: approval({ scopeKey: 'c:/repo\0c:/repo/app ' }),
      discovered,
    }).status).toBe('approved');
    expect(evaluatePiProjectTrust({
      identity: { ...trailingIdentity, canonicalWorkingDir: 'C:/repo/app' },
      approval: approval({ scopeKey: 'c:/repo\0c:/repo/app ' }),
      discovered,
    }).status).toBe('unapproved');
  });

  it('fails closed for non-ASCII Windows paths without a Win32 comparison identity', () => {
    const nonAsciiIdentity: PiProjectIdentityResolution = {
      ...identity,
      workingDir: 'C:\\repo\\İ',
      canonicalWorkingDir: 'C:/repo/İ',
      canonicalRepoRoot: 'C:/repo',
      platform: 'win32',
      canonicalPathEncoding: 'utf16-lossless',
      windowsCaseComparison: 'ordinal-insensitive',
    };
    const result = evaluatePiProjectTrust({
      identity: nonAsciiIdentity,
      approval: approval({ scopeKey: 'c:/repo\0c:/repo/i̇' }),
      discovered,
      capabilities: { explicitSkills: true },
    });
    expect(result.status).toBe('unavailable');
    expect(result.resources.skills).toBe('discovered');
    expect(result.eligibleSkillPaths).toEqual([]);
  });

  it('preserves non-ASCII POSIX paths when the host proves UTF-8 losslessness', () => {
    const posixIdentity: PiProjectIdentityResolution = {
      ...identity,
      workingDir: '/repo/café',
      canonicalWorkingDir: '/repo/café',
      canonicalRepoRoot: '/repo',
      platform: 'posix',
      canonicalPathEncoding: 'utf8-lossless',
    };
    const result = evaluatePiProjectTrust({
      identity: posixIdentity,
      approval: approval({ scopeKey: '/repo\0/repo/café' }),
      discovered,
      capabilities: { explicitSkills: true },
    });
    expect(result.status).toBe('approved');
    expect(result.eligibleSkillPaths).toEqual(discovered.skills);
  });

  it('preserves Windows UNC canonical roots while matching approval scope', () => {
    const uncIdentity: PiProjectIdentityResolution = {
      ...identity,
      workingDir: '\\\\Server\\Share\\Repo\\App',
      canonicalWorkingDir: '//server/share/repo/app',
      canonicalRepoRoot: '//server/share/repo',
      platform: 'win32',
      canonicalPathEncoding: 'utf16-lossless',
      windowsCaseComparison: 'ordinal-insensitive',
    };
    const result = evaluatePiProjectTrust({
      identity: uncIdentity,
      approval: approval({ scopeKey: '//SERVER\\SHARE\\REPO\0//server/share/repo/app' }),
      discovered,
    });
    expect(result.status).toBe('approved');
    expect(result.projectKey).toBe('//server/share/repo\0//server/share/repo/app');
  });

  it.each(['//', '//server', '///server/share'])('fails closed for incomplete Windows UNC path %s', (invalidRoot) => {
    const invalidIdentity: PiProjectIdentityResolution = {
      ...identity,
      workingDir: invalidRoot,
      canonicalWorkingDir: invalidRoot,
      canonicalRepoRoot: invalidRoot,
      platform: 'win32',
      canonicalPathEncoding: 'utf16-lossless',
      windowsCaseComparison: 'ordinal-insensitive',
    };
    expect(evaluatePiProjectTrust({
      identity: invalidIdentity,
      approval: approval({ scope: 'repo-root', scopeKey: invalidRoot }),
      discovered,
    }).status).toBe('unavailable');
  });

  it('does not let concurrent session inputs leak into one another', () => {
    const first = evaluatePiProjectTrust({
      identity,
      approval: approval({ revision: 'a' }),
      discovered,
      capabilities: { explicitSkills: true },
    });
    const second = evaluatePiProjectTrust({
      identity: { ...identity, canonicalWorkingDir: '/repo/other' },
      approval: approval({ scopeKey: '/repo\0/repo/other', revision: 'b' }),
      discovered: {
        ...discovered,
        skills: ['/repo/other/.pi/skills/c'],
        canonicalSkillEvidence: [{ discoveredPath: '/repo/other/.pi/skills/c', canonicalPath: '/repo/other/.pi/skills/c' }],
      },
      capabilities: { explicitSkills: true },
    });
    expect(first.approvalRevision).toBe('a');
    expect(first.eligibleSkillPaths).toEqual(discovered.skills);
    expect(second.approvalRevision).toBe('b');
    expect(second.eligibleSkillPaths).toEqual(['/repo/other/.pi/skills/c']);
  });
});
