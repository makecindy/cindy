import { describe, expect, it } from 'vitest';

import { formatFileLocation } from '../lib/fileLocation';
import { splitLocalLineSuffix } from '../lib/markdownTarget';

describe('file reference clipboard locations', () => {
  // These are logical paths belonging to the source machine, not the test host.
  it.each([
    ['/repo', '/repo/src/example.ts', 42, undefined, 'src/example.ts:42'],
    ['/repo/', '/repo/./src/example.ts', 42, 7, 'src/example.ts:42:7'],
    ['C:\\Repo', 'c:\\repo\\src\\example.ts', 42, 7, 'src/example.ts:42:7'],
    ['D:/Repo/', 'D:/Repo/src/中文 文件.ts', 1, undefined, 'src/中文 文件.ts:1'],
    ['/remote/project', '/remote/project/src/main.ts', 12, 3, 'src/main.ts:12:3'],
  ])('formats %s / %s without using host path semantics', (workingDir, absPath, line, column, expected) => {
    expect(formatFileLocation(workingDir, { absPath, line, column })).toBe(expected);
  });

  it.each([
    ['', '/repo/a.ts'],
    ['/repo', '/other/a.ts'],
    ['/repo', '/repo-other/a.ts'],
    ['/repo', '/repo'],
    ['/repo', '/repo/../other/a.ts'],
    ['/repo', 'src/a.ts'],
    ['C:/repo', 'D:/repo/a.ts'],
    ['C:/repo', '/repo/a.ts'],
  ])('does not invent a relative location for %s / %s', (workingDir, absPath) => {
    expect(formatFileLocation(workingDir, { absPath, line: 1 })).toBeNull();
  });

  it.each([undefined, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'requires a valid line number: %s', (line) => {
      expect(formatFileLocation('/repo', { absPath: '/repo/a.ts', line })).toBeNull();
    },
  );

  it.each([0, -1, 1.5, NaN, Infinity])('rejects an invalid column: %s', (column) => {
    expect(formatFileLocation('/repo', { absPath: '/repo/a.ts', line: 1, column })).toBeNull();
  });

  it('preserves the existing start-line semantics for a line range', () => {
    const { href, line, column } = splitLocalLineSuffix('/repo/src/a.ts:42-50');
    expect(formatFileLocation('/repo', { absPath: href, line, column })).toBe('src/a.ts:42');
  });
});
