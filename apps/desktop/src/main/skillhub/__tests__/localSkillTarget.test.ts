import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { inspectLocalSkillTarget, isLocalSkillTargetCurrent } from '../localSkillTarget';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-local-skill-target-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
function directory(...parts: string[]): string {
  const dir = path.join(root, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), 'test');
  return dir;
}

describe('local Skill removal targets', () => {
  it('accepts an unregistered local Skill and rejects its enclosing discovery root', () => {
    const dir = directory('.agents', 'skills', 'mine');
    const target = inspectLocalSkillTarget(dir, [dir]);
    expect(target?.operationPath).toBe(fs.realpathSync.native(dir));
    expect(target?.linkOnly).toBe(false);
    expect(isLocalSkillTargetCurrent(target!)).toBe(true);
    expect(inspectLocalSkillTarget(path.dirname(dir), [path.dirname(dir)])).toBeNull();
  });

  it.each([
    ['.Agents', 'Skills'], ['.Claude', 'Skills'], ['.Codex', 'Skills'],
    ['.Pi', 'Skills'], ['.Pi', 'Agent', 'Skills'], ['Codex-Home', 'Skills'], ['Pi-Agent-Home', 'Skills'],
  ])('accepts mixed-case discovery segments: %s', (...segments) => {
    const dir = directory(`case-${segments.join('-')}`, ...segments, 'mixed-case-skill');
    expect(inspectLocalSkillTarget(dir, [dir])).toMatchObject({
      operationPath: fs.realpathSync.native(dir), linkOnly: false,
    });
    expect(inspectLocalSkillTarget(path.dirname(dir), [path.dirname(dir)])).toBeNull();
    const system = directory(`case-${segments.join('-')}`, ...segments, '.System', 'builtin');
    expect(inspectLocalSkillTarget(system, [system])).toBeNull();
  });

  it('does not permit deleting a package root or a system Skill', () => {
    const packageRoot = directory('package');
    expect(inspectLocalSkillTarget(packageRoot, [packageRoot])).toBeNull();
    const system = directory('codex-home', 'skills', '.system', 'builtin');
    expect(inspectLocalSkillTarget(system, [system])).toBeNull();
  });

  it.each([
    ['.agents', 'skills'], ['.claude', 'skills'], ['.pi', 'agent', 'skills'], ['codex-home', 'skills'],
  ])('treats a linked source under a Skill-shaped checkout as an import (%s)', (...segments) => {
    const key = segments.join('-');
    const source = directory(`checkout-${key}`, ...segments, 'source');
    const alias = path.join(root, '.agents', 'skills', `import-${key}`);
    fs.mkdirSync(path.dirname(alias), { recursive: true });
    fs.symlinkSync(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(inspectLocalSkillTarget(source, [alias])).toMatchObject({ operationPath: alias, linkOnly: true });
    // Ownership is established only when this group also discovers the direct entry.
    expect(inspectLocalSkillTarget(source, [alias, source])).toMatchObject({
      operationPath: fs.realpathSync.native(source), linkOnly: false,
    });
  });

  it.each([
    ['.agents', 'skills'], ['.claude', 'skills'], ['.codex', 'skills'],
    ['.pi', 'skills'], ['.pi', 'agent', 'skills'], ['codex-home', 'skills'], ['pi-agent-home', 'skills'],
  ])('rejects symlinks in any discovery layout segment (%s)', (...segments) => {
    for (let linkedIndex = 0; linkedIndex < segments.length; linkedIndex += 1) {
      const key = `${segments.join('-')}-${linkedIndex}`;
      const source = directory(`root-checkout-${key}`, ...segments, 'source');
      const owner = path.join(root, `root-import-${key}`);
      const linkedAncestor = path.join(owner, ...segments.slice(0, linkedIndex + 1));
      const actualAncestor = path.join(root, `root-checkout-${key}`, ...segments.slice(0, linkedIndex + 1));
      fs.mkdirSync(path.dirname(linkedAncestor), { recursive: true });
      fs.symlinkSync(actualAncestor, linkedAncestor, process.platform === 'win32' ? 'junction' : 'dir');
      const entry = path.join(owner, ...segments, 'source');
      expect(fs.lstatSync(entry).isSymbolicLink()).toBe(false);
      expect(inspectLocalSkillTarget(source, [entry])).toBeNull();
      expect(fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8')).toBe('test');
    }
  });

  it('allows a tracked project alias above the discovery layout', () => {
    const source = directory('direct-project', '.agents', 'skills', 'source');
    const projectAlias = path.join(root, 'project-alias');
    fs.symlinkSync(path.join(root, 'direct-project'), projectAlias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(inspectLocalSkillTarget(source, [path.join(projectAlias, '.agents', 'skills', 'source')]))
      .toMatchObject({ operationPath: fs.realpathSync.native(source), linkOnly: false });
  });

  it('detects replacement of a directory after the confirmation snapshot', () => {
    const dir = directory('.claude', 'skills', 'replace');
    const target = inspectLocalSkillTarget(dir, [dir])!;
    fs.renameSync(dir, `${dir}-old`);
    directory('.claude', 'skills', 'replace');
    expect(isLocalSkillTargetCurrent(target)).toBe(false);
  });

  it('excludes plugin snapshots through direct and chained discovery links without blocking external imports', () => {
    const managedRoot = path.join(root, 'ghost-install-state');
    const source = directory('ghost-install-state', 'skill-snapshots', 'plugin', 'revision', 'skill');
    const alias = path.join(root, '.agents', 'skills', 'plugin--skill');
    const fanout = path.join(root, '.claude', 'skills', 'plugin--skill');
    fs.mkdirSync(path.dirname(fanout), { recursive: true });
    fs.symlinkSync(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
    fs.symlinkSync(alias, fanout, process.platform === 'win32' ? 'junction' : 'dir');
    expect(inspectLocalSkillTarget(source, [alias, fanout], [managedRoot])).toBeNull();
    expect(inspectLocalSkillTarget(fanout, [fanout], [managedRoot])).toBeNull();
    const external = directory('external', 'skill-snapshots', 'plugin', 'revision', 'skill');
    const externalAlias = path.join(root, '.agents', 'skills', 'external--skill');
    fs.symlinkSync(external, externalAlias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(inspectLocalSkillTarget(external, [externalAlias], [managedRoot])?.linkOnly).toBe(true);
  });

  it('treats a standalone Markdown Skill as one file', () => {
    const file = path.join(root, '.pi', 'skills', 'standalone.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '---\nname: standalone\n---\nSkill');
    expect(inspectLocalSkillTarget(file, [file])?.operationPath).toBe(fs.realpathSync.native(file));
  });

  it('removes only a link into an external checkout and detects retargeting', (ctx) => {
    const source = directory('external-source');
    const link = path.join(root, '.agents', 'skills', 'external');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    try { fs.symlinkSync(source, link, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch { ctx.skip(); return; }
    const target = inspectLocalSkillTarget(source, [link])!;
    expect(target.linkOnly).toBe(true);
    expect(target.operationPath).toBe(link);
    expect(target.sourcePath).toBe(fs.realpathSync.native(source));
    fs.unlinkSync(link);
    fs.symlinkSync(directory('other-external'), link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(isLocalSkillTargetCurrent(target)).toBe(false);
  });
});
