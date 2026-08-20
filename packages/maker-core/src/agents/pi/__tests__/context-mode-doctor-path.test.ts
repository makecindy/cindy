import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CONTEXT_MODE_STALE_EXTENSION_PATH,
  findContextModePackageRoot,
  rewriteContextModeDoctorPath,
} from '../context-mode-doctor-path.js';

const DOCTOR = [
  'context-mode doctor',
  '',
  `[OK] Hook support: Pi hooks are wired via the context-mode Pi extension (${CONTEXT_MODE_STALE_EXTENSION_PATH}/), not via JSON-stdio.`,
].join('\n');

describe('rewriteContextModeDoctorPath', () => {
  it('replaces the stale extension path with the managed package root', () => {
    const root = '/tmp/cindy/managed-packages/0/node_modules/context-mode';
    expect(rewriteContextModeDoctorPath(DOCTOR, root)).toBe(
      [
        'context-mode doctor',
        '',
        `[OK] Hook support: Pi hooks are wired via the context-mode Pi extension (${root}/), not via JSON-stdio.`,
      ].join('\n'),
    );
  });

  it('leaves text unchanged when context-mode is not loaded', () => {
    expect(rewriteContextModeDoctorPath(DOCTOR, undefined)).toBe(DOCTOR);
    expect(rewriteContextModeDoctorPath(DOCTOR, '')).toBe(DOCTOR);
  });

  it('does not rewrite unrelated ~/.pi mentions', () => {
    const other = 'sessions live under ~/.pi/context-mode/sessions';
    expect(rewriteContextModeDoctorPath(other, '/tmp/context-mode')).toBe(other);
  });

  it('inserts dollar sequences in the managed root as literals', () => {
    const root = '/tmp/cindy/$&/$1/user-dir/node_modules/context-mode';
    const rewritten = rewriteContextModeDoctorPath(DOCTOR, root);
    expect(rewritten).toContain(`(${root}/)`);
    expect(rewritten).not.toContain(CONTEXT_MODE_STALE_EXTENSION_PATH);
  });
});

describe('findContextModePackageRoot', () => {
  it('finds a direct package root and a node_modules snapshot', () => {
    const tmp = path.join(os.tmpdir(), `cm-doctor-${process.pid}-${Date.now()}`);
    const direct = path.join(tmp, 'direct');
    const snapshot = path.join(tmp, 'snapshot');
    const nested = path.join(snapshot, 'node_modules', 'context-mode');
    mkdirSync(direct, { recursive: true });
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(direct, 'package.json'), JSON.stringify({ name: 'context-mode' }));
    writeFileSync(path.join(nested, 'package.json'), JSON.stringify({ name: 'context-mode' }));
    writeFileSync(
      path.join(snapshot, 'package.json'),
      JSON.stringify({ name: 'pi-extensions', private: true }),
    );

    expect(findContextModePackageRoot([direct])).toBe(direct);
    expect(findContextModePackageRoot([snapshot])).toBe(nested);
    expect(findContextModePackageRoot(['/no/such/root', snapshot])).toBe(nested);
  });

  it('returns undefined when no context-mode package is present', () => {
    expect(findContextModePackageRoot([])).toBeUndefined();
    expect(findContextModePackageRoot(['/definitely/missing'])).toBeUndefined();
  });
});
