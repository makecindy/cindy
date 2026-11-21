import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createHash } from 'node:crypto';

import { OWN_RULES_HEADING, TEAMMATE_TEMPLATE_RECORD, TEAMMATE_TEMPLATE_VERSION, applyTeammateTemplate, teammateTemplateFiles } from '../botProjectTemplate.js';

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
    await fs.writeFile(path.join(dir, 'AGENTS.override.md'), 'my override rules\n');
    await fs.writeFile(path.join(dir, 'CLAUDE.md'), 'my Claude rules\n');
    await expect(applyTeammateTemplate(dir, 'Mimi')).resolves.toBe(true);
    const routed = await read('AGENTS.md');
    expect(routed).toMatch(/^my own rules\n/);
    expect(routed).toContain('<!-- project-memory -->');
    expect(await read('AGENTS.override.md')).toMatch(/^my override rules\n/);
    expect(await read('CLAUDE.md')).toMatch(/^my Claude rules\n/);
    expect(await read('CLAUDE.md')).toContain('<!-- project-memory -->');
    expect((await read('.cindy/memory/README.md')).length).toBeGreaterThan(0);
    await expect(read('.agents/skills/hand-off/SKILL.md')).resolves.toContain('name: hand-off');
    await expect(applyTeammateTemplate(dir, 'Mimi')).resolves.toBe(false);
    await expect(read('AGENTS.md')).resolves.toBe(routed);

    // The owner reshapes a plain template file; a later version updates nothing it changed.
    const guide = '.cindy/memory/README.md';
    await fs.writeFile(path.join(dir, guide), 'reshaped\n');
    const v2 = { ...teammateTemplateFiles('Mimi'), [guide]: 'v2 guide\n', 'NEW.md': 'new\n' };
    await expect(applyTeammateTemplate(dir, 'Mimi', TEAMMATE_TEMPLATE_VERSION + 1, v2)).resolves.toBe(true);
    await expect(read(guide)).resolves.toBe('reshaped\n');
    await expect(read(`.cindy/template/${guide}`)).resolves.toBe('v2 guide\n');
    await expect(read('NEW.md')).resolves.toBe('new\n');
    expect(JSON.parse(await read(TEAMMATE_TEMPLATE_RECORD))).toMatchObject({
      version: TEAMMATE_TEMPLATE_VERSION + 1, pending: [guide],
    });

    // A later version still offers its newer copy for the file the owner changed.
    await expect(applyTeammateTemplate(dir, 'Mimi', TEAMMATE_TEMPLATE_VERSION + 2, { ...v2, [guide]: 'v3 guide\n' })).resolves.toBe(true);
    await expect(read(guide)).resolves.toBe('reshaped\n');
    await expect(read(`.cindy/template/${guide}`)).resolves.toBe('v3 guide\n');
    expect(JSON.parse(await read(TEAMMATE_TEMPLATE_RECORD))).toMatchObject({
      version: TEAMMATE_TEMPLATE_VERSION + 2, pending: [guide],
    });
  });

  // 2026-11-22 owner decision: standard skills are two layers in one file. A new standard replaces
  // the standard text; the teammate's own rules, and what it had changed in the old standard text,
  // stay in its own section, so older teammates get the new default report-back too.
  describe('a layered standard skill', () => {
    const skill = '.agents/skills/hand-off/SKILL.md';
    const sha = (text: string) => createHash('sha256').update(text).digest('hex');
    const oldStandard = '---\nname: hand-off\n---\n\n# Hand-off\n\n- Pick the project.\n- Do not ask a task to send its result back.\n- Read results against the ask.\n';
    const newStandard = (extra = '') => `---\nname: hand-off\n---\n\n# Hand-off\n\n- Pick the project.\n- Ask every task to report back.\n- Read results against the ask.\n${extra}\n${OWN_RULES_HEADING}\n\nRules go here.\n`;
    const setUp = async (current: string, tracked: boolean, startedFrom = oldStandard) => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teammate-layered-'));
      await fs.mkdir(path.join(dir, '.agents/skills/hand-off'), { recursive: true });
      await fs.mkdir(path.join(dir, '.cindy'), { recursive: true });
      await fs.writeFile(path.join(dir, skill), current);
      await fs.writeFile(path.join(dir, TEAMMATE_TEMPLATE_RECORD), JSON.stringify({ version: 1, files: tracked ? { [skill]: sha(startedFrom) } : {} }));
    };
    const upgrade = (version: number, standard: string, readPrevious?: (relative: string, hash: string) => Promise<string | null>) =>
      applyTeammateTemplate(dir, 'Mimi', version, { [skill]: standard }, readPrevious);
    const read = () => fs.readFile(path.join(dir, skill), 'utf8');

    it('replaces an untouched copy with the new standard', async () => {
      await setUp(oldStandard, true);
      await upgrade(2, newStandard());
      expect(await read()).toBe(newStandard());
    });

    it('moves what the teammate changed into its own rules, using the version it started from', async () => {
      // Added one rule and dropped a standard line the new standard still has.
      await setUp(oldStandard.replace('- Read results against the ask.\n', '- Only report back when the owner names the task.\n'), true);
      const lookups: string[] = [];
      await upgrade(2, newStandard(), async (relative, hash) => { lookups.push(relative); return hash === sha(oldStandard) ? oldStandard : null; });
      const text = await read();
      expect(lookups).toEqual([skill]);
      expect(text.startsWith(newStandard().trimEnd())).toBe(true);
      const own = text.slice(text.indexOf(OWN_RULES_HEADING));
      expect(own).toContain('- Only report back when the owner names the task.');
      expect(own).toContain('Leave out from the standard above: Read results against the ask.');
      // The old default it never changed does not come back as an own rule.
      expect(own).not.toContain('Do not ask a task to send its result back');
    });

    // Review r4652356427: a heading the owner added scopes the rules under it; dropping it changes them.
    it('keeps a heading the teammate added, with the rules under it', async () => {
      await setUp(`${oldStandard}\n## Before starting work\n\n- Ask the owner first.\n`, true);
      await upgrade(2, newStandard(), async (_relative, hash) => hash === sha(oldStandard) ? oldStandard : null);
      const text = await read();
      const own = text.slice(text.indexOf(OWN_RULES_HEADING));
      expect(own).toContain('### Before starting work\n- Ask the owner first.');
      expect(text.match(/^## Before starting work$/m)).toBeNull();
    });

    // Review r4652379039: renaming a standard heading to carry a constraint is itself an own rule.
    it('keeps a standard heading the teammate reworded to add a constraint', async () => {
      const standard = oldStandard.replace('# Hand-off\n', '# Hand-off\n\n## Start a task\n');
      await setUp(standard.replace('## Start a task', '## Start a task only after the owner explicitly approves'), true);
      await upgrade(2, newStandard('\n## Start a task\n'), async (_relative, hash) => hash === sha(oldStandard) ? standard : null);
      const text = await read();
      expect(text.slice(text.indexOf(OWN_RULES_HEADING))).toContain('### Start a task only after the owner explicitly approves');
    });

    // Review r4652449180: deleting a plain paragraph rule is a customization too, not only a list item.
    it('keeps the removal of a plain paragraph the new standard still has', async () => {
      const paragraph = 'Answer whoever asked in the group.';
      const standard = oldStandard.replace('# Hand-off\n', `# Hand-off\n\n${paragraph}\n`);
      await setUp(oldStandard, true, standard);
      await upgrade(2, newStandard(`${paragraph}\n`), async (_relative, hash) => hash === sha(standard) ? standard : null);
      const text = await read();
      expect(text.slice(text.indexOf(OWN_RULES_HEADING))).toContain(`- Leave out from the standard above: ${paragraph}`);
    });

    it('keeps an own skill that predates the template, for the teammate to tidy', async () => {
      await setUp('---\nname: hand-off\n---\n\n# Hand-off\n\n- Pick the project.\n- Design reviews go straight to the owner.\n', false);
      await upgrade(2, newStandard());
      const own = (await read()).slice((await read()).indexOf(OWN_RULES_HEADING));
      expect(own).toContain('- Design reviews go straight to the owner.');
      expect(own).not.toContain('Pick the project');
    });

    it('carries the own rules through later standards without repeating them', async () => {
      await setUp(oldStandard, true);
      await upgrade(2, newStandard());
      await fs.appendFile(path.join(dir, skill), '- Weekly summaries on Fridays.\n');
      await upgrade(3, newStandard('- Check the task digest when asked.\n'));
      await expect(upgrade(3, newStandard('- Check the task digest when asked.\n'))).resolves.toBe(false);
      const text = await read();
      expect(text).toContain('- Check the task digest when asked.');
      expect(text.match(/Weekly summaries on Fridays/g)).toHaveLength(1);
      expect(text.match(new RegExp(OWN_RULES_HEADING, 'g'))).toHaveLength(1);
    });
  });
});
