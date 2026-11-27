import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createHash } from 'node:crypto';

import { botSkillRootDir, setBotProjectSkillsDir, setBotSkillEnabled } from '../botSkillStore.js';
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

  // Tier 1: a current template receipt used to suppress repair after a role change.
  // The disabled copy and unrelated deleted records must survive both repair and upgrade.
  it('repairs a missing standard at the same version and respects the disabled shelf', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'buddy-settings-'));
    const profile = botSkillRootDir(dir, 'Test');
    const workspace = path.join(profile, 'workspace');
    setBotProjectSkillsDir(dir, 'Test', true);
    const relative = '.agents/skills/hand-off/SKILL.md';
    const active = path.join(workspace, relative);
    const guide = path.join(workspace, '.cindy/settings/README.md');
    await applyTeammateTemplate(workspace, 'Test');
    await fs.rm(active);
    await fs.rm(guide);
    expect(await applyTeammateTemplate(workspace, 'Test')).toBe(true);
    expect(await fs.readFile(active, 'utf8')).toBe(teammateTemplateFiles('Test')[relative]);
    expect(await fs.readFile(guide, 'utf8')).toContain('profile.json');
    expect(await applyTeammateTemplate(workspace, 'Test')).toBe(false);
    const disabled = path.join(profile, 'disabled-skills', 'hand-off');
    await fs.mkdir(path.dirname(disabled), { recursive: true });
    await fs.rename(path.dirname(active), disabled);
    await fs.appendFile(path.join(disabled, 'SKILL.md'), 'Keep my rule.\n');
    expect(await applyTeammateTemplate(workspace, 'Test')).toBe(false);
    const updated = teammateTemplateFiles('Test')[relative]!.replace('## Scheduled work', '## Updated scheduling standard');
    // A previous host advanced the receipt and put its stock file back in the native scan.
    await fs.mkdir(path.dirname(active), { recursive: true });
    await fs.writeFile(active, updated);
    await fs.writeFile(path.join(path.dirname(active), 'attachment.txt'), 'kept asset');
    await fs.writeFile(path.join(workspace, TEAMMATE_TEMPLATE_RECORD), JSON.stringify({
      version: TEAMMATE_TEMPLATE_VERSION + 1, files: { [relative]: createHash('sha256').update(updated).digest('hex') },
    }));
    const apply = () => applyTeammateTemplate(workspace, 'Test', TEAMMATE_TEMPLATE_VERSION + 1, { [relative]: updated });
    expect(await apply()).toBe(true);
    await expect(fs.stat(active)).rejects.toMatchObject({ code: 'ENOENT' });
    const saved = await fs.readFile(path.join(disabled, 'SKILL.md'), 'utf8');
    expect(saved).toContain('Keep my rule.');
    expect(saved).toContain('## Updated scheduling standard');
    const backups = path.join(profile, 'disabled-skill-backups');
    const [backup] = await fs.readdir(backups);
    await expect(fs.readFile(path.join(backups, backup!, 'attachment.txt'), 'utf8')).resolves.toBe('kept asset');
    expect(await apply()).toBe(false);
    await setBotSkillEnabled(dir, 'Test', 'hand-off', true);
    await expect(fs.readFile(active, 'utf8')).resolves.toBe(saved);
  });

  // 2026-11-22 owner decision: standard skills are two layers in one file. A new standard replaces
  // the standard text; the teammate's own rules stay, and what it had changed in the old standard
  // text is kept exactly (a diff against the standard it started from, or its whole earlier text)
  // for the teammate to fold in, so older teammates get the new default report-back too.
  // Reviews r4652356427 … r4652692367 showed that inferring the change line by line loses headings,
  // nested sections, list parents, moves and removals; an exact diff keeps all of them.
  describe('a layered standard skill', () => {
    const skill = '.agents/skills/hand-off/SKILL.md';
    const sha = (text: string) => createHash('sha256').update(text).digest('hex');
    const oldStandard = '---\nname: hand-off\n---\n\n# Hand-off\n\n## In a group\n\n- Answer whoever asked.\n\n## Report back\n\n- Do not ask a task to send its result back.\n- For long work, create a one-time check.\n';
    const newStandard = (extra = '') => `---\nname: hand-off\n---\n\n# Hand-off\n\n## In a group\n\n- Answer whoever asked.\n\n## Report back\n\n- Ask every task to report back.\n- For long work, create a one-time check.\n${extra}\n${OWN_RULES_HEADING}\n\nRules go here.\n`;
    const setUp = async (current: string, tracked: boolean) => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teammate-layered-'));
      await fs.mkdir(path.join(dir, '.agents/skills/hand-off'), { recursive: true });
      await fs.mkdir(path.join(dir, '.cindy'), { recursive: true });
      await fs.writeFile(path.join(dir, skill), current);
      await fs.writeFile(path.join(dir, TEAMMATE_TEMPLATE_RECORD), JSON.stringify({ version: 1, files: tracked ? { [skill]: sha(oldStandard) } : {} }));
    };
    const fromHistory = async (_relative: string, hash?: string) => hash === sha(oldStandard) ? oldStandard : null;
    const upgrade = (version: number, standard: string) => applyTeammateTemplate(dir, 'Mimi', version, { [skill]: standard }, fromHistory);
    const read = () => fs.readFile(path.join(dir, skill), 'utf8');
    const ownOf = (text: string) => text.slice(text.indexOf(OWN_RULES_HEADING));
    // What the upgrade kept stays in the skill's own section: it syncs with the skill text (r4653236761).
    const carried = async () => ownOf(await read());

    it('replaces an untouched copy with the new standard', async () => {
      await setUp(oldStandard, true);
      await upgrade(2, newStandard());
      expect(await read()).toBe(newStandard());
    });

    it('keeps the exact changes against the standard it started from, in their sections', async () => {
      // A rule added under "In a group" > a new "When idle" section, a rule nested under a list item,
      // a line moved between sections and a line removed: all scope-bearing edits.
      const mine = oldStandard
        .replace('- For long work, create a one-time check.\n', '')
        .replace('- Answer whoever asked.\n', '- Answer whoever asked.\n- For long work, create a one-time check.\n\n### When idle\n\n- Never create a task.\n')
        .replace('- Do not ask a task to send its result back.\n', '- Do not ask a task to send its result back.\n  - Only after the owner approves.\n');
      await setUp(mine, true);
      await upgrade(2, newStandard());
      const text = await read();
      expect(text.startsWith(newStandard().trimEnd())).toBe(true);
      const own = await carried();
      expect(own).toContain('````diff\n');
      // Every change, with the earlier standard around it as context, in file order (a removal is
      // listed before the addition at the same place, as in any diff).
      const diff = own.slice(own.indexOf('````diff\n'));
      const order = [' ## In a group', '+- For long work, create a one-time check.', '+### When idle', '+- Never create a task.',
        ' ## Report back', '-- For long work, create a one-time check.', '+  - Only after the owner approves.'];
      const at = order.map(line => diff.indexOf(`\n${line}\n`));
      expect(at.every(index => index > 0)).toBe(true);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
      // The unchanged old default is context, not an added rule.
      expect(diff).toContain('\n - Do not ask a task to send its result back.\n');
      expect(diff).not.toContain('\n+- Do not ask a task to send its result back.');
    });

    it('keeps a fenced code block intact inside the kept changes', async () => {
      const block = '```sh\n# Ask the owner before executing\npnpm release\n```';
      await setUp(`${oldStandard}\n## Owner-approved commands\n\n${block}\n`, true);
      await upgrade(2, newStandard());
      const own = await carried();
      expect(own).toContain('+## Owner-approved commands\n+\n+```sh\n+# Ask the owner before executing\n+pnpm release\n+```');
      expect(own).toContain('````diff\n');
    });

    it('keeps frontmatter fields the teammate added, also from a CRLF file', async () => {
      const mine = oldStandard.replace('name: hand-off\n', 'name: hand-off\ndisable-model-invocation: true\nmetadata:\n  displayName: Handover\n').replace(/\n/g, '\r\n');
      await setUp(mine, true);
      await upgrade(2, newStandard());
      const text = await read();
      expect(/^---\n([\s\S]*?)\n---\n/.exec(text)![1]).toBe('name: hand-off\ndisable-model-invocation: true\nmetadata:\n  displayName: Handover');
      // Only the header changed: no body changes to carry.
      expect(text).toBe(newStandard().replace('name: hand-off\n', 'name: hand-off\ndisable-model-invocation: true\nmetadata:\n  displayName: Handover\n'));
    });

    // Review r4652956774: a quoted key is a field of its own; any header line the merge does not
    // carry (here a changed standard field) is kept for the teammate instead of dropped.
    it('keeps quoted frontmatter keys and hands over header lines it cannot merge', async () => {
      const mine = oldStandard.replace('name: hand-off\n', 'name: handover\n"disable-model-invocation": true\n');
      await setUp(mine, true);
      await upgrade(2, newStandard());
      const text = await read();
      expect(/^---\n([\s\S]*?)\n---\n/.exec(text)![1]).toContain('"disable-model-invocation": true');
      expect(/^---\n([\s\S]*?)\n---\n/.exec(text)![1]).toMatch(/^name: hand-off$/m);
      await expect(carried()).resolves.toContain('````yaml\nname: handover\n````');
    });

    // Reviews r4653079186, r4653079196: an own-rules heading inside a fenced example is not the
    // boundary, and a hunk line like `+++ attempts;` is content.
    it('keeps fenced examples and diff content intact', async () => {
      const example = `\`\`\`markdown\n${OWN_RULES_HEADING}\n- An example rule.\n\`\`\``;
      const cpp = '```cpp\n++ attempts;\n```';
      await setUp(`${oldStandard}\n## Examples\n\n${example}\n\n${cpp}\n`, true);
      await upgrade(2, newStandard());
      const text = await read();
      expect(text.match(new RegExp(`^${OWN_RULES_HEADING}$`, 'gm'))).toHaveLength(1);
      const kept = await carried();
      expect(kept).toContain(`+${OWN_RULES_HEADING}\n+- An example rule.`);
      expect(kept).toContain('\n+++ attempts;\n');
    });

    // Reviews r4653079206, r4653236761: kept material stays in the skill (a side file may not reach
    // another computer), and an upgrade that would push the body past the size editors and cloud
    // restore accept leaves the skill as it is and offers the new standard beside it instead.
    it('leaves a skill alone when keeping its changes would exceed the body size limit', async () => {
      // Just under the 64 KiB body limit before the upgrade, over it once the changes are kept.
      const filler = `- ${'x'.repeat(200)}\n`.repeat(319);
      const mine = `${oldStandard}\n## Notes\n\n${filler}`;
      expect(Buffer.byteLength(mine, 'utf8')).toBeLessThan(64 * 1024);
      await setUp(mine, true);
      await upgrade(2, newStandard());
      expect(await read()).toBe(mine);
      await expect(fs.readFile(path.join(dir, '.cindy/template', skill), 'utf8')).resolves.toBe(newStandard());
      expect(JSON.parse(await fs.readFile(path.join(dir, TEAMMATE_TEMPLATE_RECORD), 'utf8'))).toMatchObject({
        files: { [skill]: sha(oldStandard) }, pending: [skill],
      });
    });

    // Review r4653328718: only the standard's intro at the top of the own section goes; a fenced
    // example in the teammate's own rules that repeats the heading stays as it was.
    it('keeps the own section exactly, apart from the standard intro at its top', async () => {
      const own = `- Never deploy production.\n\n\`\`\`markdown\n${OWN_RULES_HEADING}\n- An example rule.\n\`\`\``;
      await setUp(oldStandard, true);
      await upgrade(2, newStandard());
      await fs.appendFile(path.join(dir, skill), `${own}\n`);
      await upgrade(3, newStandard());
      const text = await read();
      expect(ownOf(text)).toBe(`${OWN_RULES_HEADING}\n\nRules go here.\n\n${own}\n`);
    });

    // Review r4653328714: the cloud sync carries the whole skill as one value (60 KiB without a file
    // store); an upgrade that would push it past that also leaves the skill as it is.
    it('leaves a skill alone when the kept changes would exceed what the cloud sync carries', async () => {
      const filler = `- ${'x'.repeat(200)}\n`.repeat(300);
      const mine = `${oldStandard}\n## Notes\n\n${filler}`;
      await setUp(mine, true);
      await upgrade(2, newStandard());
      expect(await read()).toBe(mine);
      await expect(fs.readFile(path.join(dir, '.cindy/template', skill), 'utf8')).resolves.toBe(newStandard());
    });

    it('keeps an own skill that predates the template whole, for the teammate to tidy', async () => {
      const mine = '---\nname: hand-off\n---\n\n# Hand-off\n\n- Design reviews go straight to the owner.\n';
      await setUp(mine, false);
      await upgrade(2, newStandard());
      const own = await carried();
      expect(own).toContain('````markdown\n# Hand-off\n\n- Design reviews go straight to the owner.\n````');
    });

    // User feedback 2026-11-22: automations a teammate set up for the owner never reported back.
    // The rule lives in this layered skill so teammates already on template 9 get it too (unit, the
    // real v9 hand-off as installed, with an own rule the owner gave).
    it('gives a teammate on template 9 the scheduled-work standard and keeps its own rules', async () => {
      const v9 = await fs.readFile(new URL('./fixtures/hand-off-v9.md', import.meta.url), 'utf8');
      const installed = `${v9}- Always copy Bob on summaries.\n`;
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teammate-layered-'));
      await fs.mkdir(path.join(dir, '.agents/skills/hand-off'), { recursive: true });
      await fs.mkdir(path.join(dir, '.cindy'), { recursive: true });
      await fs.writeFile(path.join(dir, skill), installed);
      await fs.writeFile(path.join(dir, TEAMMATE_TEMPLATE_RECORD), JSON.stringify({ version: 9, files: { [skill]: sha(v9) } }));
      await expect(applyTeammateTemplate(dir, 'Mimi', TEAMMATE_TEMPLATE_VERSION,
        { [skill]: teammateTemplateFiles('Mimi')[skill]! }, async (_relative, hash) => hash === sha(v9) ? v9 : null)).resolves.toBe(true);
      const text = await read();
      expect(text).toContain('## Scheduled work');
      expect(text).toContain('`bindToCurrentSession=true`');
      expect(text.match(/Always copy Bob on summaries\./g)).toHaveLength(1);
      expect(text.indexOf('Always copy Bob')).toBeGreaterThan(text.indexOf(OWN_RULES_HEADING));
    });

    it('carries the own rules through later standards without repeating them', async () => {
      await setUp(oldStandard.replace('- Answer whoever asked.\n', '- Answer whoever asked.\n- Never create a task.\n'), true);
      await upgrade(2, newStandard());
      await fs.appendFile(path.join(dir, skill), '- Weekly summaries on Fridays.\n');
      await upgrade(3, newStandard('- Check the task digest when asked.\n'));
      await expect(upgrade(3, newStandard('- Check the task digest when asked.\n'))).resolves.toBe(false);
      const text = await read();
      expect(text).toContain('- Check the task digest when asked.');
      expect(text.match(/Weekly summaries on Fridays/g)).toHaveLength(1);
      expect((await carried()).match(/\+- Never create a task\./g)).toHaveLength(1);
      expect(text.match(new RegExp(OWN_RULES_HEADING, 'g'))).toHaveLength(1);
      expect(text.match(/Rules go here\./g)).toHaveLength(1);
    });
  });
});
