/**
 * #8359 guest confinement for Claude Code. Rule: a bound guest's built-in file
 * tools stay inside the project, including through `..`, absolute paths,
 * glob prefixes and symlinks. Minimal failing inputs before the guard: any
 * Read/Glob outside workingDir was allowed. Tier: unit (real filesystem).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { guestConfinementDenial, isConfinedShellTool } from './guest-confinement.js';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'guest-confine-'));
const projectA = path.join(base, 'client-a');
const projectB = path.join(base, 'client-b');
fs.mkdirSync(projectA); fs.mkdirSync(projectB);
fs.writeFileSync(path.join(projectA, 'infoA.txt'), 'a');
fs.writeFileSync(path.join(projectB, 'infoB.txt'), 'b');
fs.symlinkSync(projectB, path.join(projectA, 'link-to-b'));

afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

describe('guestConfinementDenial', () => {
  it('allows project files and new files inside the project', async () => {
    expect(await guestConfinementDenial('Read', { file_path: path.join(projectA, 'infoA.txt') }, projectA)).toBeNull();
    expect(await guestConfinementDenial('Write', { file_path: 'notes/new.md' }, projectA)).toBeNull();
    expect(await guestConfinementDenial('Glob', { pattern: '**/*.txt' }, projectA)).toBeNull();
  });

  it('denies other directories however they are named', async () => {
    for (const [tool, input] of [
      ['Read', { file_path: path.join(projectB, 'infoB.txt') }],
      ['Read', { file_path: '../client-b/infoB.txt' }],
      ['Read', { file_path: 'link-to-b/infoB.txt' }],
      ['Grep', { pattern: 'b', path: projectB }],
      ['Glob', { pattern: '../client-b/**' }],
      ['Glob', { pattern: `${projectB}/*` }],
      ['Edit', { file_path: path.join(base, 'outside.txt') }],
    ] as const) {
      expect(await guestConfinementDenial(tool, input as Record<string, unknown>, projectA)).toMatch(/own project/);
    }
  });

  it('leaves shell tools to the owner confirmation and other tools to their own checks', async () => {
    expect(isConfinedShellTool('Bash')).toBe(true);
    expect(await guestConfinementDenial('Bash', { command: 'cat ../client-b/infoB.txt' }, projectA)).toBeNull();
    expect(await guestConfinementDenial('mcp__cindy__thing', { path: '/etc' }, projectA)).toBeNull();
  });
});
