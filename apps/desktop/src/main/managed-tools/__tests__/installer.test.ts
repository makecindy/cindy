import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import JSZip from 'jszip';
import { installTool, installedTool } from '../installer';
import type { ToolArtifact } from '../types';
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-managed-tools-'));
  roots.push(root);
  const artifact: ToolArtifact = {
    id: 'gh',
    version: '1.2.3',
    host: 'darwin-arm64',
    url: 'https://publisher.test/gh.zip',
    sha256: 'a'.repeat(64),
    format: 'zip',
    executable: 'gh/bin/gh',
  };
  return {
    root,
    artifact,
    signal: new AbortController().signal,
    onProgress: vi.fn(),
    validate: vi.fn(async () => true),
  };
}
describe('shared tool installer', () => {
  it('installs a non-Make CLI to an absolute path and can rediscover it without PATH', async () => {
    const input = await setup();
    const archive = await new JSZip()
      .file('gh/bin/gh', 'executable')
      .generateAsync({ type: 'nodebuffer' });
    const executable = await installTool(input, {
      download: async (opts) => {
        await writeFile(opts.targetPath, archive);
      },
    });
    expect(path.isAbsolute(executable)).toBe(true);
    expect(await installedTool(input.root, input.artifact)).toBe(executable);
    expect(await readFile(executable, 'utf8')).toBe('executable');
    expect(input.validate).toHaveBeenCalledOnce();
  });
  it.each(['../outside', '/absolute', 'a/b'])(
    'rejects unsafe tool identity %s before downloading',
    async (id) => {
      const input = await setup();
      const download = vi.fn();
      await expect(
        installTool({ ...input, artifact: { ...input.artifact, id } }, { download }),
      ).rejects.toThrow('identity');
      expect(download).not.toHaveBeenCalled();
      expect(await readdir(input.root)).toEqual([]);
    },
  );
  it('rejects an executable outside the archive', async () => {
    const input = await setup();
    await expect(
      installTool({ ...input, artifact: { ...input.artifact, executable: '../outside' } }),
    ).rejects.toThrow('archive path');
  });
});
