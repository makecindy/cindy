import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { scanCustomizationSources, type SourceDef } from './customization-scanner.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-customization-scanner-'));
  roots.push(root);
  return root;
}

function writeSkill(sourceDir: string, relativeDir: string, name: string): string {
  const skillDir = path.join(sourceDir, relativeDir);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: >-\n  ${name} description\n---\n`,
    'utf8',
  );
  return skillDir;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('scanCustomizationSources', () => {
  it('discovers direct Skills and one namespace level without recursing further', () => {
    const root = tempRoot();
    const sourceDir = path.join(root, 'skills');
    const direct = writeSkill(sourceDir, 'direct', 'direct');
    const nested = writeSkill(sourceDir, path.join('@scope', 'nested'), 'nested');
    const deeper = writeSkill(sourceDir, path.join('@scope', 'group', 'deeper'), 'deeper');
    const resourceDir = path.join(direct, 'references', 'looks-like-skill');
    fs.mkdirSync(resourceDir, { recursive: true });
    fs.writeFileSync(path.join(resourceDir, 'SKILL.md'), '---\nname: resource\n---\n');

    const source: SourceDef = {
      engine: 'pi',
      kind: 'skill',
      scope: 'user',
      dir: sourceDir,
    };
    const result = scanCustomizationSources([source]);

    expect(result.errors).toEqual([]);
    expect(result.items).toHaveLength(2);
    expect(result.items.map((item) => item.name).sort()).toEqual(['direct', 'nested']);
    expect(result.items.map((item) => item.absolutePath).sort()).toEqual([direct, nested].sort());
    expect(result.items.map((item) => item.absolutePath)).not.toContain(deeper);
    expect(result.items.every((item) => item.description)).toBe(true);
  });

  it('prunes generated dependency trees while still accepting direct Skills', () => {
    const root = tempRoot();
    const sourceDir = path.join(root, 'skills');
    const direct = writeSkill(sourceDir, 'direct', 'direct');
    const generatedDirs = [
      'node_modules',
      'dist',
      'build',
      'out',
      'coverage',
      'target',
      '__macosx',
      '__pycache__',
      'Node_Modules',
      'DIST',
    ];
    for (const generatedDir of generatedDirs) {
      writeSkill(sourceDir, path.join(generatedDir, 'ignored'), `${generatedDir}-ignored`);
    }

    const result = scanCustomizationSources([{
      engine: 'codex',
      kind: 'skill',
      scope: 'user',
      dir: sourceDir,
    }]);

    expect(result.errors).toEqual([]);
    expect(result.items.map((item) => item.absolutePath)).toEqual([direct]);
  });

  it('keeps a direct Skill whose folder name matches a pruned directory', () => {
    const root = tempRoot();
    const sourceDir = path.join(root, 'skills');
    const directDist = writeSkill(sourceDir, 'dist', 'dist-skill');
    writeSkill(sourceDir, path.join('node_modules', 'ignored'), 'ignored');

    const result = scanCustomizationSources([{
      engine: 'codex',
      kind: 'skill',
      scope: 'user',
      dir: sourceDir,
    }]);

    expect(result.errors).toEqual([]);
    expect(result.items.map((item) => item.absolutePath)).toEqual([directDist]);
  });

  it('keeps a direct symlinked Skill discoverable without walking symlinked namespaces', (ctx) => {
    const root = tempRoot();
    const sourceDir = path.join(root, 'skills');
    const directTarget = writeSkill(path.join(root, 'external'), 'linked', 'linked');
    fs.mkdirSync(sourceDir, { recursive: true });
    const link = path.join(sourceDir, 'linked');
    try {
      fs.symlinkSync(directTarget, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      ctx.skip();
      return;
    }

    const result = scanCustomizationSources([{
      engine: 'codex',
      kind: 'skill',
      scope: 'user',
      dir: sourceDir,
    }]);

    expect(result.errors).toEqual([]);
    expect(result.items.map((item) => item.absolutePath)).toEqual([link]);
  });

  it('does not descend through a symlinked namespace container', (ctx) => {
    const root = tempRoot();
    const sourceDir = path.join(root, 'skills');
    const externalScope = path.join(root, 'external', '@scope');
    const linkedSkill = writeSkill(path.join(root, 'external'), path.join('@scope', 'linked'), 'linked');
    fs.mkdirSync(sourceDir, { recursive: true });
    const direct = writeSkill(sourceDir, 'direct', 'direct');
    const namespaceLink = path.join(sourceDir, '@scope');
    try {
      fs.symlinkSync(externalScope, namespaceLink, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      ctx.skip();
      return;
    }

    const result = scanCustomizationSources([{
      engine: 'codex',
      kind: 'skill',
      scope: 'user',
      dir: sourceDir,
    }]);

    expect(result.errors).toEqual([]);
    expect(result.items.map((item) => item.absolutePath)).toEqual([direct]);
    expect(result.items.map((item) => item.absolutePath)).not.toContain(linkedSkill);
  });
});
