import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { TEAMMATE_TEMPLATE_RECORD, applyTeammateTemplate, teammateTemplateFiles } from '../botProjectTemplate.js';

// 2026-11-09: every teammate starts from a clean template it then owns. A newer template
// must never overwrite what the owner or the teammate changed, nor an upgraded teammate's own rules.
describe('applyTeammateTemplate', () => {
  let dir = '';
  afterEach(async () => { if (dir) await fs.rm(dir, { recursive: true, force: true }); });

  it('starts a project from the template, keeps its own files, and leaves changed files for merging', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teammate-template-'));
    const read = (relative: string) => fs.readFile(path.join(dir, relative), 'utf8');
    // An upgraded teammate already has its own rules: they stay, untracked.
    await fs.writeFile(path.join(dir, 'AGENTS.md'), 'my own rules\n');
    await expect(applyTeammateTemplate(dir, 'Mimi')).resolves.toBe(true);
    await expect(read('AGENTS.md')).resolves.toBe('my own rules\n');
    await expect(read('.agents/skills/hand-off/SKILL.md')).resolves.toContain('name: hand-off');
    await expect(applyTeammateTemplate(dir, 'Mimi')).resolves.toBe(false);

    // The owner reshapes the skill; a later template version updates nothing it changed.
    await fs.writeFile(path.join(dir, '.agents/skills/hand-off/SKILL.md'), 'reshaped\n');
    const v2 = { ...teammateTemplateFiles('Mimi'), '.agents/skills/hand-off/SKILL.md': 'v2 skill\n', 'NEW.md': 'new\n' };
    await expect(applyTeammateTemplate(dir, 'Mimi', 2, v2)).resolves.toBe(true);
    await expect(read('.agents/skills/hand-off/SKILL.md')).resolves.toBe('reshaped\n');
    await expect(read('.cindy/template/.agents/skills/hand-off/SKILL.md')).resolves.toBe('v2 skill\n');
    await expect(read('NEW.md')).resolves.toBe('new\n');
    expect(JSON.parse(await read(TEAMMATE_TEMPLATE_RECORD))).toMatchObject({
      version: 2, pending: ['.agents/skills/hand-off/SKILL.md'],
    });
  });
});
