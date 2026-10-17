import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { READ_SHEET_RUNTIME_PACKAGES } from '../../../../../../packages/lizi-mcps/src/cindy-docs/readSheetRuntimeDeps';
import { prunePackagedRuntime } from '../../../../forge-prune-runtime';
import { copyRuntimeDependencyTrees } from '../../../../forge-runtime-deps';

const desktopRoot = path.resolve(process.cwd());
const workspaceRequire = createRequire(import.meta.url);

function packageDirectory(name: string, fromDirs?: string[]): string {
  const options = fromDirs ? { paths: fromDirs } : { paths: [desktopRoot] };
  try {
    return path.dirname(workspaceRequire.resolve(`${name}/package.json`, options));
  } catch {
    try {
      return path.dirname(workspaceRequire.resolve(`${name}/package`, options));
    } catch {
      // Some packages export their manifest as ./package instead of ./package.json.
    }
    let entry: string;
    try {
      entry = workspaceRequire.resolve(name, options);
    } catch {
      const hoisted = path.resolve(desktopRoot, '../../node_modules', name);
      if (fs.existsSync(path.join(hoisted, 'package.json'))) return hoisted;
      throw new Error(`cannot resolve package directory: ${name}`);
    }
    let current = path.dirname(entry);
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

describe('read_sheet XLSX worker packaging contract', () => {
  it('copies the worker runtime dependency closures into packaged node_modules', () => {
    const forge = fs.readFileSync(path.join(desktopRoot, 'forge.config.ts'), 'utf8');
    expect(READ_SHEET_RUNTIME_PACKAGES).toEqual(['jszip', 'exceljs']);
    expect(forge).toContain('copyRuntimeDependencyTrees(READ_SHEET_RUNTIME_PACKAGES, destModules)');
    expect(forge).toContain('copyRuntimeTrees(deps, destModules, resolvePackageDir)');
  });

  it('loads ExcelJS and JSZip from an isolated staged dependency tree', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-read-sheet-package-'));
    try {
      const stagedModules = path.join(temp, 'node_modules');
      copyRuntimeDependencyTrees(
        [...READ_SHEET_RUNTIME_PACKAGES, 'discord.js'],
        stagedModules,
        packageDirectory,
      );
      prunePackagedRuntime(temp);
      expect(fs.existsSync(path.join(stagedModules, 'exceljs', 'dist'))).toBe(false);
      const probeRequirePath = path.join(temp, 'probe.cjs');
      const probe = spawnSync(
        process.execPath,
        [
          '-e',
          `const { createRequire } = require('node:module');
const stagedRequire = createRequire(${JSON.stringify(probeRequirePath)});
const ExcelJS = stagedRequire('exceljs');
const JSZip = stagedRequire('jszip');
const { Client, GatewayIntentBits, EmbedBuilder } = stagedRequire('discord.js');
(async () => {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  if (new EmbedBuilder().setTitle('ok').toJSON().title !== 'ok') throw Error('Discord builder');
  await client.destroy();
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
