import { describe, expect, it } from 'vitest';

import {
  isInstallPathForSkill,
  isInstallPathUnderProject,
  joinSkillInstallPath,
  normalizeInstallPathKey,
} from '../installTargetPaths';

describe('install target path helpers', () => {
  // Unit regression for PR #8019 / discussion_r4420676333: registry keys
  // must match a merged UNC project's selected spelling, including skill case.
  // Existing tests cover drive paths only; no filesystem IO is involved.
  it.each([
    '//server/share/Repo/.agents/skills/Demo/',
    '\\\\server\\share\\Repo\\.agents\\skills\\Demo\\',
    '\\\\?\\UNC\\server\\share\\Repo\\.agents\\skills\\Demo',
  ])('matches an installed UNC skill and its project: %s', (installed) => {
    const options = { windows: true };
    const project = '//Server/Share/repo';
    expect(normalizeInstallPathKey(installed, options)).toBe(
      normalizeInstallPathKey(joinSkillInstallPath(project, 'demo'), options),
    );
    expect(isInstallPathForSkill(installed, 'demo', options)).toBe(true);
    expect(isInstallPathUnderProject(installed, project, options)).toBe(true);
    expect(isInstallPathUnderProject(installed, '//Server/Share/Repo2', options)).toBe(false);
  });

  it('keeps POSIX install keys case-sensitive even for double-slash roots', () => {
    const options = { windows: false };
    expect(normalizeInstallPathKey('//Server/Share/Repo', options)).not.toBe(
      normalizeInstallPathKey('//server/share/repo', options),
    );
    expect(isInstallPathUnderProject(
      '//server/share/repo/.agents/skills/demo', '//Server/Share/Repo', options,
    )).toBe(false);
    expect(isInstallPathForSkill('//Server/Share/Repo/.agents/skills/Demo', 'demo', options)).toBe(false);
  });

  it('normalizes POSIX install paths without changing case', () => {
    expect(normalizeInstallPathKey('/Users/Sam/Repo/.agents/skills/Demo/')).toBe(
      '/Users/Sam/Repo/.agents/skills/Demo',
    );
  });

  it('normalizes Windows install paths for registry comparison', () => {
    expect(normalizeInstallPathKey('C:\\Users\\Sam\\Repo\\.agents\\skills\\Demo\\')).toBe(
      'c:/users/sam/repo/.agents/skills/demo',
    );
    expect(normalizeInstallPathKey('C:/Users/Sam/Repo/.agents/skills/Demo')).toBe(
      'c:/users/sam/repo/.agents/skills/demo',
    );
  });

  it('joins install paths using the separator style of the chosen base dir', () => {
    expect(joinSkillInstallPath('/Users/sam/repo', 'demo')).toBe('/Users/sam/repo/.agents/skills/demo');
    expect(joinSkillInstallPath('C:\\Users\\Sam\\Repo', 'demo')).toBe(
      'C:\\Users\\Sam\\Repo\\.agents\\skills\\demo',
    );
  });

  it('matches installed skill paths across Windows separator and case differences', () => {
    expect(isInstallPathForSkill('C:\\Users\\Sam\\.agents\\skills\\Demo', 'demo')).toBe(true);
    expect(isInstallPathForSkill('/Users/Sam/.agents/skills/Demo', 'demo')).toBe(false);
  });

  it('detects project installs across Windows separator and case differences', () => {
    expect(isInstallPathUnderProject(
      'C:\\Work\\Repo\\.agents\\skills\\Demo',
      'C:/work/repo',
    )).toBe(true);
    expect(isInstallPathUnderProject(
      'C:\\Work\\Repo2\\.agents\\skills\\Demo',
      'C:/work/repo',
    )).toBe(false);
  });
});
