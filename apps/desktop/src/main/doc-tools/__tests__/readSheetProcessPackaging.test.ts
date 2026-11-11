import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it, onTestFinished } from 'vitest';

import { READ_SHEET_RUNTIME_PACKAGES } from '../../../../../../packages/lizi-mcps/src/cindy-docs/readSheetRuntimeDeps';

const desktopRoot = path.resolve(process.cwd());
const execFileAsync = promisify(execFile);

describe('read_sheet XLSX worker packaging contract', () => {
  it('copies the worker runtime dependency closures into packaged node_modules', () => {
    const forge = fs.readFileSync(path.join(desktopRoot, 'forge.config.ts'), 'utf8');
    expect(READ_SHEET_RUNTIME_PACKAGES).toEqual(['jszip', 'exceljs']);
    expect(forge).toContain('copyRuntimeDependencyTrees(READ_SHEET_RUNTIME_PACKAGES, destModules)');
    expect(forge).toContain('copyRuntimeTrees(deps, destModules, resolvePackageDir)');
  });

  it('loads ExcelJS and JSZip from an isolated staged dependency tree', async () => {
    const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-read-sheet-package-'));
    const controller = new AbortController();
    onTestFinished(() => controller.abort());
    try {
      // Copying/pruning the real dependency trees can block for >60s on Windows.
      // Await a child so Vitest can process RPC replies during that synchronous IO.
      const probe = await execFileAsync(
        process.execPath,
        [
          '--experimental-strip-types',
          path.join(__dirname, 'fixtures', 'readSheetPackageProbe.mjs'),
          desktopRoot,
          temp,
        ],
        { cwd: temp, encoding: 'utf8', signal: controller.signal },
      );
      expect(fs.existsSync(path.join(temp, 'node_modules', 'exceljs', 'dist'))).toBe(false);
      expect(probe.stdout).toBe('ok');
    } finally {
      await fs.promises.rm(temp, { recursive: true, force: true });
    }
  }, 120_000);
});
