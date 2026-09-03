import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../index.ts'), 'utf8');

describe('piExtraDirsPrompt', () => {
  it('后续 prompt 只写 basename,不出现 /Users/.../libraries/', () => {
    const start = source.indexOf('function piExtraDirsPrompt(');
    const end = source.indexOf('interface FailedPiStartupCleanup');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const fn = source.slice(start, end);
    expect(fn).toContain('extraDirBasename');
    expect(fn).toContain('This task can read the plugin library');
    expect(fn).toContain('Do not modify them');
    expect(fn).not.toContain('${dir}');
    expect(fn).not.toContain('${readOnlyDirs');
    expect(fn).not.toMatch(/\/Users\/.*\/libraries\//);
    expect(fn).not.toContain('libraries/');
  });
});
