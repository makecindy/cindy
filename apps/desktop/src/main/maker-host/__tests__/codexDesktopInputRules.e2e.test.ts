import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { prepareCodexDesktopInputRules } from '../codexDesktopInputRules.js';

const bundledCodex = path.resolve(__dirname, '../../../../../codex-package-bin',
  process.platform + '-' + process.arch, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');

let scratch: string | undefined;
afterEach(async () => {
  if (scratch) await fs.rm(scratch, { recursive: true, force: true });
});

// CU-013/014: the spawn-factory unit tests cover installation and isolation, but
// cannot detect a rule rejected or misinterpreted by the actual Codex parser.
// E2E tier: install through the production helper, then check a minimal direct
// driver call and read-only controls with the bundled native executable.
// No desktop input is executed.
describe.skipIf(!existsSync(bundledCodex))('native Codex desktop input rules', () => {
  it('rejects direct driver calls while preserving version, status and search', async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-codex-rules-e2e-'));
    const runtimeHome = path.join(scratch, 'codex-home');
    await prepareCodexDesktopInputRules(runtimeHome, runtimeHome);
    const rules = path.join(runtimeHome, 'rules', 'cindy-computer-use.rules');
    const check = (...argv: string[]) => JSON.parse(execFileSync(bundledCodex, [
      'execpolicy', 'check', '--rules', rules, '--resolve-host-executables', '--', ...argv,
    ], { encoding: 'utf8' }));
    expect(check('cua-driver', 'call', 'run_steps').decision).toBe('forbidden');
    for (const argv of [['cua-driver', '--version'], ['cua-driver', 'status'], ['rg', 'cua-driver call']]) {
      expect(check(...argv).matchedRules).toEqual([]);
    }
  });
});
