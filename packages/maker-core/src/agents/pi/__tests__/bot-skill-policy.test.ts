import { describe, expect, it } from 'vitest';

import { applyPiBotSkillPolicy } from '../bot-skill-policy.js';
import type { PiProjectResourceAssemblySnapshot } from '../project-resource-assembly.js';

const assembly: PiProjectResourceAssemblySnapshot = {
  decision: null,
  skillPaths: ['/repo/.pi/skills/project-skill'],
  launchSkillPaths: ['/snapshot/skills/project-skill'],
  launchSkillDigests: ['digest'],
  launchSkillSourceFingerprints: ['fingerprint'],
  diagnostic: {
    status: 'approved',
    reason: 'fixture',
    approvalRevision: 'rev-1',
    requestedSkillCount: 1,
  },
};

describe('applyPiBotSkillPolicy', () => {
  it('keeps inherited Pi discovery unchanged', () => {
    expect(applyPiBotSkillPolicy({
      mode: 'inherit',
      configured: [],
      catalog: [],
    }, assembly)).toMatchObject({
      disableImplicitSkills: false,
      explicitSkillPaths: ['/snapshot/skills/project-skill'],
      projectAssembly: assembly,
    });
  });

  it('uses explicit user Skills and only approved project snapshots for an allowlist', () => {
    const selected = applyPiBotSkillPolicy({
      mode: 'allowlist',
      configured: ['skill:user-skill', 'skill:project-skill', 'skill:unapproved'],
      catalog: [
        {
          name: 'user-skill',
          runtimeCommandName: 'skill:user-skill',
          path: '/home/.agents/skills/user-skill',
          scope: 'user',
        },
        {
          name: 'project-skill',
          runtimeCommandName: 'skill:project-skill',
          path: '/repo/.pi/skills/project-skill',
          scope: 'repo',
          runtimeStatus: 'discovered',
        },
        {
          name: 'unapproved',
          runtimeCommandName: 'skill:unapproved',
          path: '/repo/.pi/skills/unapproved',
          scope: 'repo',
          runtimeStatus: 'discovered',
        },
      ],
    }, assembly);

    expect(selected.disableImplicitSkills).toBe(true);
    expect(selected.explicitSkillPaths).toEqual([
      '/home/.agents/skills/user-skill',
      '/snapshot/skills/project-skill',
    ]);
    expect(selected.projectAssembly.skillPaths).toEqual(['/repo/.pi/skills/project-skill']);
  });

  /*
    伙伴自己沉淀的技能不走 allowlist —— 那份名单管的是「用户允许保留哪些 harness
    发现到的 Skill」。这些是伙伴自己写进 Cindy 存储的文件,恒挂载。
  */
  it('always mounts the Bot\'s own learned Skills, ahead of user and project ones', () => {
    const selected = applyPiBotSkillPolicy({
      mode: 'allowlist',
      configured: ['skill:user-skill'],
      catalog: [
        {
          name: 'user-skill',
          runtimeCommandName: 'skill:user-skill',
          path: '/home/.agents/skills/user-skill',
          scope: 'user',
        },
      ],
      ownSkills: [
        { name: 'weekly-report', path: '/userdata/bot-skills/bot-1/skills/weekly-report' },
      ],
      ownSkillPluginRoots: ['/userdata/bot-skills/bot-1'],
    }, assembly);

    // 项目 Skill 没进 allowlist,所以这里只剩「自己的 + 用户允许的」两条。
    expect(selected.explicitSkillPaths).toEqual([
      '/userdata/bot-skills/bot-1/skills/weekly-report',
      '/home/.agents/skills/user-skill',
    ]);
  });

  it('mounts learned Skills even when the Bot inherits Pi discovery', () => {
    const selected = applyPiBotSkillPolicy({
      mode: 'inherit',
      configured: [],
      catalog: [],
      ownSkills: [{ name: 'weekly-report', path: '/userdata/bot-skills/bot-1/skills/weekly-report' }],
    }, assembly);

    expect(selected.disableImplicitSkills).toBe(false);
    expect(selected.explicitSkillPaths).toEqual([
      '/userdata/bot-skills/bot-1/skills/weekly-report',
      '/snapshot/skills/project-skill',
    ]);
  });

  it('does not let a blank learned path turn into a bare --skill flag', () => {
    const selected = applyPiBotSkillPolicy({
      mode: 'inherit',
      configured: [],
      catalog: [],
      ownSkills: [{ name: 'broken', path: '   ' }],
    }, assembly);

    expect(selected.explicitSkillPaths).toEqual(['/snapshot/skills/project-skill']);
  });
});
