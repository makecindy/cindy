import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { READ_SHEET_RUNTIME_PACKAGES } from '../../../../../../packages/lizi-mcps/src/cindy-docs/readSheetRuntimeDeps';

const desktopRoot = path.resolve(process.cwd());
const workspaceRequire = createRequire(import.meta.url);

function packageDirectory(name: string, fromDirs?: string[]): string {
  const options = fromDirs ? { paths: fromDirs } : { paths: [desktopRoot] };
  try {
    return path.dirname(workspaceRequire.resolve(`${name}/package.json`, options));
  } catch {
    let current = path.dirname(workspaceRequire.resolve(name, options));
    while (current !== path.dirname(current)) {
      const packageJson = path.join(current, 'package.json');
      if (fs.existsSync(packageJson)) {
        const manifest = JSON.parse(fs.readFileSync(packageJson, 'utf8')) as { name?: string };
        if (manifest.name === name) return current;
      }
      current = path.dirname(current);
    }
    throw new Error(`cannot resolve package directory: ${name}`);
  }
}

function stageDependencyTree(
  name: string,
  destinationModules: string,
  fromDirs?: string[],
  seen = new Set<string>(),
): void {
  const source = packageDirectory(name, fromDirs);
  const destination = path.join(destinationModules, name);
  const key = `${destination}\0${source}`;
  if (seen.has(key)) return;
  seen.add(key);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: true,
    filter: (sourcePath) => path.basename(sourcePath) !== 'node_modules',
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
    stageDependencyTree(dependency, path.join(destination, 'node_modules'), [source], seen);
  }
}

describe('read_sheet XLSX worker packaging contract', () => {
  it('copies the worker runtime dependency closures into packaged node_modules', () => {
    const forge = fs.readFileSync(path.join(desktopRoot, 'forge.config.ts'), 'utf8');
    expect(READ_SHEET_RUNTIME_PACKAGES).toEqual(['jszip', 'exceljs']);
    expect(forge).toContain('copyRuntimeDependencyTrees(READ_SHEET_RUNTIME_PACKAGES, destModules)');
    expect(forge).toContain('copyDependencyTree(childDep, childDestModules, [src], seen)');
  });

  it('loads ExcelJS and JSZip from an isolated staged dependency tree', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-read-sheet-package-'));
    try {
      const stagedModules = path.join(temp, 'node_modules');
      const seen = new Set<string>();
      for (const runtimePackage of READ_SHEET_RUNTIME_PACKAGES) {
        stageDependencyTree(runtimePackage, stagedModules, undefined, seen);
      }
      const probeRequirePath = path.join(temp, 'probe.cjs');
      const probe = spawnSync(
        process.execPath,
        [
          '-e',
          `const { createRequire } = require('node:module');
const stagedRequire = createRequire(${JSON.stringify(probeRequirePath)});
const ExcelJS = stagedRequire('exceljs');
const JSZip = stagedRequire('jszip');
(async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Sheet1').addRow(['ok']);
  const bytes = await workbook.xlsx.writeBuffer();
  const zip = await JSZip.loadAsync(bytes);
  process.stdout.write(zip.file('xl/workbook.xml') ? 'ok' : 'missing');
})().catch((error) => { console.error(error); process.exitCode = 1; });`,
        ],
        { cwd: temp, encoding: 'utf8' },
      );
      expect(probe.status, probe.stderr || String(probe.error ?? '')).toBe(0);
      expect(probe.stdout).toBe('ok');
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
    // exceljs + jszip 整棵依赖树 cp 进 tmpdir + 子进程 require 探针,纯磁盘 IO;
    // 满载 Windows runner 上 60s 盖不住,放宽避免把环境慢误判为契约失败。
  }, 120_000);
});
