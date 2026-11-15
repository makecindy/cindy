import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { preparePinnedClaudeSkillInvocation } from '../pinned-skill-invocation.js';

const tempDirs: string[] = [];

async function writeSkill(name = 'learn'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-pinned-skill-'));
  tempDirs.push(dir);
  const skillFile = path.join(dir, 'SKILL.md');
  await fs.writeFile(skillFile, [
    '---',
    `name: ${name}`,
    'description: Test Skill.',
    '---',
    '',
    '# Exact Skill body',
  ].join('\n'));
  return skillFile;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('preparePinnedClaudeSkillInvocation', () => {
  // #8549 (unit): the provider must expand the exact attested file for
  // /cindy:learn. Existing coverage only exercised the unqualified aliases;
  // the bare namespaced command is the smallest previously failing input.
  it.each([
    { input: '/learn release flow', args: 'release flow' },
    { input: '/skill:learn release flow', args: 'release flow' },
    { input: '/cindy:learn', args: '' },
    { input: '/cindy:learn release flow', args: 'release flow' },
    {
      input: '/CINDY:LEARN hub:market:release-flow notes\nmore details',
      args: 'hub:market:release-flow notes\nmore details',
    },
  ])(
    'keeps the original $input invocation while loading the attested file',
    async ({ input, args }) => {
      const skillFile = await writeSkill();

      await expect(preparePinnedClaudeSkillInvocation(
        input,
        { name: 'learn', path: skillFile },
      )).resolves.toBe([
        '<command-name>learn</command-name>',
        '<command-message>/learn</command-message>',
        ...(args ? [`<command-args>${args}</command-args>`] : []),
        '',
        '# Exact Skill body',
      ].join('\n'));
    },
  );

  it('fails closed when the command or frontmatter does not match the pin', async () => {
    const skillFile = await writeSkill('other');

    for (const input of [
      '/other release flow',
      '/cindy:other release flow',
      '/other:learn release flow',
      '/cindy:learner release flow',
    ]) {
      await expect(preparePinnedClaudeSkillInvocation(
        input,
        { name: 'learn', path: skillFile },
      )).rejects.toThrow('does not match the user invocation');
    }
    for (const input of ['/learn release flow', '/cindy:learn release flow']) {
      await expect(preparePinnedClaudeSkillInvocation(
        input,
        { name: 'learn', path: skillFile },
      )).rejects.toThrow('metadata does not match');
    }
  });
});
