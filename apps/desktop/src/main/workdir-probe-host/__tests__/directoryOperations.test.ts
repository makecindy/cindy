import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { runDirectoryOperation } from '../workdirProbeHostProcess.js';

it('creates only directories, resolves aliases and retains similar-path diagnostics inside the worker', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cindy-directory-worker-'));
  try {
    const dir = path.join(root, 'nested', 'project');
    expect(await runDirectoryOperation({ kind: 'mkdir', id: 1, dir })).toEqual({ ok: true, isDirectory: true });
    expect(await runDirectoryOperation({ kind: 'realpath', id: 2, dir })).toMatchObject({ ok: true, path: await fsp.realpath(dir) });
    expect(await runDirectoryOperation({ kind: 'probe', id: 3, dir })).toMatchObject({ ok: true, isDirectory: true });
    expect(await runDirectoryOperation({ kind: 'similar', id: 4, dir: `${dir} ` })).toMatchObject({ ok: true, path: dir });
    const file = path.join(root, 'file');
    await fsp.writeFile(file, 'keep');
    expect(await runDirectoryOperation({ kind: 'mkdir', id: 5, dir: file })).toMatchObject({ ok: false, code: 'EEXIST' });
    expect(await fsp.readFile(file, 'utf8')).toBe('keep');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
