import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { it, expect } from 'vitest';
import { copyRuntimeDependencyTrees } from '../forge-runtime-deps';
import { prunePackagedMigrationSnapshots } from '../forge-prune-runtime';
import { createMigrationRuntimeManifest } from '../src/main/localDb/migrationRunner';

it('reuses exact visible packages, preserves shadowed versions and terminates cycles', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-dependency-layout-'));
  try {
    const sources = path.join(root, 'sources');
    const make = (id, name, dependencies, code) => {
      const dir = path.join(sources, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name, main: 'index.js', dependencies }),
      );
      fs.writeFileSync(path.join(dir, 'index.js'), code);
      return fs.realpathSync(dir);
    };
    const common1 = make('common1', 'common', {}, "module.exports = 'v1'");
    const common2 = make('common2', 'common', {}, "module.exports = 'v2'");
    const child = make(
      'child',
      'child',
      { common: '*', leaf: '*' },
      "module.exports = [require('common'), require('leaf')]",
    );
    const leaf = make(
      'leaf',
      'leaf',
      { common: '*', parent: '*' },
      "module.exports = require('common')",
    );
    const parent = make(
      'parent',
      'parent',
      { common: '*', child: '*' },
      "module.exports = [require('common'), require('child')]",
    );
    const resolve = (name, from) => {
      if (name === 'common') return from?.[0] === child ? common2 : common1;
      return { parent, child, leaf }[name];
    };
    const modules = path.join(root, 'output', 'node_modules');
    copyRuntimeDependencyTrees(['parent', 'common'], modules, resolve);
    const require = createRequire(path.join(root, 'output', 'probe.cjs'));
    expect(require('parent')).toEqual(['v1', ['v2', 'v1']]);
    expect(fs.existsSync(path.join(modules, 'parent', 'node_modules', 'common'))).toBe(false);
    const childModules = path.join(modules, 'parent', 'node_modules', 'child', 'node_modules');
    expect(fs.existsSync(path.join(childModules, 'common'))).toBe(true);
    // A nearer v2 shadows root v1, so leaf needs its own v1 even though root has it.
    expect(fs.existsSync(path.join(childModules, 'leaf', 'node_modules', 'common'))).toBe(true);
    expect(fs.existsSync(path.join(childModules, 'leaf', 'node_modules', 'parent'))).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('removes only generated snapshots from the packaged migration metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-migration-package-'));
  try {
    const source = path.resolve('drizzle');
    const target = path.join(root, 'drizzle');
    fs.cpSync(source, target, { recursive: true });
    const original = new Map();
    function collect(dir, relative = '') {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const key = path.join(relative, entry.name);
        if (entry.isDirectory()) collect(path.join(dir, entry.name), key);
        else original.set(key, fs.readFileSync(path.join(dir, entry.name)));
      }
    }
    collect(source);
    prunePackagedMigrationSnapshots(root);
    prunePackagedMigrationSnapshots(root);
    let removed = 0;
    for (const [relative, bytes] of original) {
      if (
        path.dirname(relative) === 'meta' &&
        /^\d{4}_snapshot\.json$/.test(path.basename(relative))
      ) {
        expect(fs.existsSync(path.join(target, relative))).toBe(false);
        removed++;
      } else expect(fs.readFileSync(path.join(target, relative)).equals(bytes)).toBe(true);
      expect(fs.readFileSync(path.join(source, relative)).equals(bytes)).toBe(true);
    }
    expect(removed).toBeGreaterThan(0);
    expect(createMigrationRuntimeManifest(target)).toEqual(createMigrationRuntimeManifest(source));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
