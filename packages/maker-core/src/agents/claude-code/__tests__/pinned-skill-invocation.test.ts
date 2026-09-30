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
  it.each(['/learn release flow', '/skill:learn release flow'])(
    'keeps the original %s invocation while loading the attested file',
    async (input) => {
      const skillFile = await writeSkill();

      await expect(preparePinnedClaudeSkillInvocation(
        input,
        { name: 'learn', path: skillFile },
      )).resolves.toBe([
        '<command-name>learn</command-name>',
        '<command-message>/learn</command-message>',
        '<command-args>release flow</command-args>',
        '',
        '# Exact Skill body',
      ].join('\n'));
    },
  );

  it('fails closed when the command or frontmatter does not match the pin', async () => {
    const skillFile = await writeSkill('other');

    await expect(preparePinnedClaudeSkillInvocation(
      '/other release flow',
      { name: 'learn', path: skillFile },
    )).rejects.toThrow('does not match the user invocation');
    await expect(preparePinnedClaudeSkillInvocation(
      '/learn release flow',
      { name: 'learn', path: skillFile },
    )).rejects.toThrow('metadata does not match');
  });
});
