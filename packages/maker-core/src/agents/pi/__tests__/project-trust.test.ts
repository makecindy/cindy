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
  settings: ['/repo/.pi/settings.json'],
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
      identity: { ...identity, canonicalRepoRoot: null, repoRootStatus: 'unavailable' },
      approval: approval(),
      discovered,
    });
    expect(result.status).toBe('unavailable');
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
      },
      approval: approval({ scopeKey: 'c:/repo\0c:/repo/app' }),
      discovered,
    });
    expect(result.status).toBe('approved');
  });

  it('preserves a Windows drive root when deriving the project key', () => {
    const driveRootIdentity: PiProjectIdentityResolution = {
      ...identity,
      workingDir: 'C:\\',
      canonicalWorkingDir: 'C:/',
      canonicalRepoRoot: 'C:/',
      platform: 'win32',
      canonicalPathEncoding: 'utf16-lossless',
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

  it('only exposes non-empty reviewed settings projections', () => {
    const projection: PiProjectSettingsProjection = {
      sourcePath: '/repo/.pi/settings.json',
      values: { compaction: { reserveTokens: 16_384, keepRecentTokens: 8_192 } },
      revision: 'settings-rev-1',
    };
    const result = evaluatePiProjectTrust({
      identity,
      approval: approval(),
      discovered,
      capabilities: { projectedSettings: true },
      settingsProjection: projection,
    });
    expect(result.resources.settings).toBe('discovered');
    expect(evaluatePiProjectTrust({
      identity,
      approval: approval(),
      discovered,
      capabilities: { explicitSkills: true },
      settingsProjection: {
        sourcePath: '/repo/.pi/settings.json',
        values: { compaction: { reserveTokens: undefined } },
      },
    }).resources.settings).toBe('discovered');
    const provenResult = evaluatePiProjectTrust({
      identity,
      approval: approval(),
      discovered,
      capabilities: { projectedSettings: true, packagesDisabled: true, extensionsDisabled: true },
      settingsProjection: projection,
    });
    expect(provenResult.resources.settings).toBe('eligible');
    expect(provenResult.settingsProjection).toEqual(projection);
    expect(provenResult.eligibleSettingsPaths).toEqual([projection.sourcePath]);
    expect(evaluatePiProjectTrust({
      identity,
      approval: approval(),
      discovered,
      capabilities: { projectedSettings: true },
      settingsProjection: { sourcePath: '/repo/.pi/settings.json', values: {} },
    }).resources.settings).toBe('discovered');
    expect(evaluatePiProjectTrust({
      identity,
      approval: approval(),
      discovered,
      capabilities: { projectedSettings: true },
      settingsProjection: { sourcePath: '/repo/.pi/other-settings.json', values: { compaction: { reserveTokens: 16_384 } } },
    }).resources.settings).toBe('discovered');
    for (const forbiddenKey of ['packages', 'extensions', 'defaultProjectTrust']) {
      expect(evaluatePiProjectTrust({
        identity,
        approval: approval(),
        discovered,
        capabilities: { projectedSettings: true },
        settingsProjection: { sourcePath: '/repo/.pi/settings.json', values: { [forbiddenKey]: [] } },
      }).resources.settings).toBe('discovered');
    }
    expect(evaluatePiProjectTrust({
      identity,
      approval: approval(),
      discovered,
      capabilities: { projectedSettings: true },
      settingsProjection: {
        sourcePath: '/repo/.pi/settings.json',
        values: Object.assign(Object.create({ inherited: true }) as Record<string, unknown>, { compaction: true }),
      },
    }).resources.settings).toBe('discovered');
    for (const sourcePath of ['/repo/.pi/settings\0.json', '/repo/.pi/settings\uFFFD.json', '']) {
      expect(evaluatePiProjectTrust({
        identity,
        approval: approval(),
        discovered,
        capabilities: { projectedSettings: true, packagesDisabled: true, extensionsDisabled: true },
        settingsProjection: {
          sourcePath,
          values: { compaction: { reserveTokens: 16_384 } },
        },
      }).resources.settings).toBe('discovered');
    }
    expect(evaluatePiProjectTrust({
      identity,
      approval: approval(),
      discovered,
      capabilities: { projectedSettings: true },
      settingsProjection: {
        sourcePath: '/repo/.pi/settings.json',
        values: null as unknown as Readonly<Record<string, unknown>>,
      },
    }).resources.settings).toBe('discovered');
    expect(evaluatePiProjectTrust({
      identity,
      approval: approval(),
      discovered,
      capabilities: { projectedSettings: true, packagesDisabled: true, extensionsDisabled: true },
      settingsProjection: {
        sourcePath: '/repo/.pi/settings.json',
        values: { compaction: { reserveTokens: -1 } },
      },
    }).resources.settings).toBe('discovered');
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
    const { platform: _platform, ...identityWithoutPlatform } = identity;
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

  it('preserves Windows UNC canonical roots while matching approval scope', () => {
    const uncIdentity: PiProjectIdentityResolution = {
      ...identity,
      workingDir: '\\\\Server\\Share\\Repo\\App',
      canonicalWorkingDir: '//server/share/repo/app',
      canonicalRepoRoot: '//server/share/repo',
      platform: 'win32',
      canonicalPathEncoding: 'utf16-lossless',
    };
    const result = evaluatePiProjectTrust({
      identity: uncIdentity,
      approval: approval({ scopeKey: '//SERVER\\SHARE\\REPO\0//server/share/repo/app' }),
      discovered,
    });
    expect(result.status).toBe('approved');
    expect(result.projectKey).toBe('//server/share/repo\0//server/share/repo/app');
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
      discovered: { ...discovered, skills: ['/repo/other/.pi/skills/c'] },
      capabilities: { explicitSkills: true },
    });
    expect(first.approvalRevision).toBe('a');
    expect(first.eligibleSkillPaths).toEqual(discovered.skills);
    expect(second.approvalRevision).toBe('b');
    expect(second.eligibleSkillPaths).toEqual(['/repo/other/.pi/skills/c']);
  });
});
