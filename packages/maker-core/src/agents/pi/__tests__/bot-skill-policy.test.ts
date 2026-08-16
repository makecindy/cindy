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
});
