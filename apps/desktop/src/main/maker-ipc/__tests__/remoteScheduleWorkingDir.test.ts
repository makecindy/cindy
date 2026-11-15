import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { remoteCreateWorkingDirError } from '../remoteScheduleWorkingDir.js';

describe('remote schedule workingDir', () => {
  it('accepts an omitted path and rejects a missing or non-directory path', async () => {
    expect(await remoteCreateWorkingDirError(undefined)).toBeNull();
    expect(await remoteCreateWorkingDirError('   ')).toContain('whitespace');
    const missing = await remoteCreateWorkingDirError('/tmp/cindy-missing-schedule-dir');
    expect(missing).toContain('does not exist');
    const root = await mkdtemp(path.join(tmpdir(), 'cindy-sched-'));
    const file = path.join(root, 'not-a-dir');
    await writeFile(file, 'x');
    expect(await remoteCreateWorkingDirError(file)).toContain('not a directory');
    expect(await remoteCreateWorkingDirError(root)).toBeNull();
    await rm(root, { recursive: true, force: true });
  });
});
