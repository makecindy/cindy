import { mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { purgeCancelledOllamaPull } from '../ollamaPurge.js';

describe('purgeCancelledOllamaPull', () => {
  it('deletes unused blobs and the cancelled manifest, keeps shared blobs', async () => {
    const root = path.join(os.tmpdir(), `ollama-purge-${Date.now()}`);
    await mkdir(root, { recursive: true });
    const blobs = path.join(root, 'blobs');
    const manifests = path.join(root, 'manifests', 'registry.ollama.ai', 'library');
    await mkdir(blobs, { recursive: true });
    await mkdir(path.join(manifests, 'qwen3.8'), { recursive: true });
    await mkdir(path.join(manifests, 'other'), { recursive: true });
    await writeFile(path.join(blobs, 'sha256-aaa'), 'partial-a');
    await writeFile(path.join(blobs, 'sha256-bbb'), 'shared');
    await writeFile(path.join(blobs, 'sha256-aaa-partial'), 'tmp');
    await writeFile(
      path.join(manifests, 'other', 'latest'),
      JSON.stringify({
        config: { digest: 'sha256:bbb' },
        layers: [{ digest: 'sha256:bbb' }],
      }),
    );
    await writeFile(
      path.join(manifests, 'qwen3.8', '27b-mxfp8'),
      JSON.stringify({ layers: [{ digest: 'sha256:aaa' }] }),
    );

    const result = await purgeCancelledOllamaPull({
      modelsDir: root,
      name: 'qwen3.8:27b-mxfp8',
      digests: ['sha256:aaa', 'sha256:bbb'],
    });
    expect(result.deleted.some((item) => item.includes('27b-mxfp8'))).toBe(true);
    await expect(readFile(path.join(blobs, 'sha256-bbb'), 'utf8')).resolves.toBe('shared');
    await expect(readFile(path.join(blobs, 'sha256-aaa'), 'utf8')).rejects.toThrow();
  });

  it('deletes Ollama .tmp leftovers and hf.co manifests', async () => {
    const root = path.join(os.tmpdir(), `ollama-purge-tmp-${Date.now()}`);
    const blobs = path.join(root, 'blobs');
    const manifestDir = path.join(root, 'manifests', 'hf.co', 'unsloth', 'Qwen3.8-27B-GGUF');
    await mkdir(blobs, { recursive: true });
    await mkdir(manifestDir, { recursive: true });
    await writeFile(path.join(blobs, 'sha256-ccc.tmp'), 'downloading');
    await writeFile(
      path.join(manifestDir, 'UD-Q4_K_XL'),
      JSON.stringify({ layers: [{ digest: 'sha256:ccc' }] }),
    );

    const result = await purgeCancelledOllamaPull({
      modelsDir: root,
      name: 'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL',
      digests: [],
    });
    expect(result.deleted.some((item) => item.endsWith('sha256-ccc.tmp'))).toBe(true);
    await expect(readFile(path.join(blobs, 'sha256-ccc.tmp'), 'utf8')).rejects.toThrow();
  });

  it('deletes every incomplete blob even when no digest was recorded', async () => {
    const root = path.join(os.tmpdir(), `ollama-purge-all-tmp-${Date.now()}`);
    const blobs = path.join(root, 'blobs');
    await mkdir(blobs, { recursive: true });
    await writeFile(path.join(blobs, 'sha256-orphan.tmp'), 'leftover');
    await writeFile(path.join(blobs, 'sha256-keep'), 'complete');

    const result = await purgeCancelledOllamaPull({
      modelsDir: root,
      name: 'qwen3.8:27b-mxfp8',
      digests: [],
      deleteAllIncomplete: true,
    });
    expect(result.deleted).toContain('sha256-orphan.tmp');
    await expect(readFile(path.join(blobs, 'sha256-keep'), 'utf8')).resolves.toBe('complete');
    await expect(readFile(path.join(blobs, 'sha256-orphan.tmp'), 'utf8')).rejects.toThrow();
  });

  it('prunes complete blobs that no remaining manifest references', async () => {
    const root = path.join(os.tmpdir(), `ollama-purge-unref-${Date.now()}`);
    const blobs = path.join(root, 'blobs');
    const manifests = path.join(root, 'manifests', 'registry.ollama.ai', 'library');
    await mkdir(blobs, { recursive: true });
    await mkdir(path.join(manifests, 'kept'), { recursive: true });
    await writeFile(path.join(blobs, 'sha256-keep'), 'installed');
    await writeFile(path.join(blobs, 'sha256-orphan'), 'leftover-layer');
    await writeFile(
      path.join(manifests, 'kept', 'latest'),
      JSON.stringify({ layers: [{ digest: 'sha256:keep' }] }),
    );

    const result = await purgeCancelledOllamaPull({
      modelsDir: root,
      name: 'qwen3.8:27b-mxfp8',
      digests: [],
      pruneUnreferenced: true,
    });
    expect(result.deleted).toContain('sha256-orphan');
    await expect(readFile(path.join(blobs, 'sha256-keep'), 'utf8')).resolves.toBe('installed');
    await expect(readFile(path.join(blobs, 'sha256-orphan'), 'utf8')).rejects.toThrow();
  });

  it('does not sweep unrelated incomplete blobs when only attributed digests are given', async () => {
    const root = path.join(os.tmpdir(), `ollama-purge-scoped-${Date.now()}`);
    const blobs = path.join(root, 'blobs');
    await mkdir(blobs, { recursive: true });
    await writeFile(path.join(blobs, 'sha256-aaa'), 'ours');
    await writeFile(path.join(blobs, 'sha256-other.tmp'), 'someone-else');

    const result = await purgeCancelledOllamaPull({
      modelsDir: root,
      name: 'qwen3.8:27b-mxfp8',
      digests: ['sha256:aaa'],
    });
    expect(result.deleted).toContain('sha256-aaa');
    expect(result.deleted).not.toContain('sha256-other.tmp');
    await expect(readFile(path.join(blobs, 'sha256-other.tmp'), 'utf8')).resolves.toBe(
      'someone-else',
    );
  });

  it('keeps the installed manifest when deleteManifest is false', async () => {
    const root = path.join(os.tmpdir(), `ollama-purge-keep-${Date.now()}`);
    const blobs = path.join(root, 'blobs');
    const manifests = path.join(root, 'manifests', 'registry.ollama.ai', 'library');
    await mkdir(blobs, { recursive: true });
    await mkdir(path.join(manifests, 'gpt-oss'), { recursive: true });
    await writeFile(path.join(blobs, 'sha256-keep'), 'installed');
    await writeFile(
      path.join(manifests, 'gpt-oss', '20b'),
      JSON.stringify({ layers: [{ digest: 'sha256:keep' }] }),
    );

    const result = await purgeCancelledOllamaPull({
      modelsDir: root,
      name: 'gpt-oss:20b',
      digests: ['sha256:keep'],
      deleteManifest: false,
    });
    expect(result.deleted).not.toContain(path.join(manifests, 'gpt-oss', '20b'));
    await expect(readFile(path.join(blobs, 'sha256-keep'), 'utf8')).resolves.toBe('installed');
    await expect(readFile(path.join(manifests, 'gpt-oss', '20b'), 'utf8')).resolves.toContain(
      'sha256:keep',
    );
  });

  it('does not delete a layer still used by another in-flight pull', async () => {
    const root = path.join(os.tmpdir(), `ollama-purge-keep-digest-${Date.now()}`);
    const blobs = path.join(root, 'blobs');
    await mkdir(blobs, { recursive: true });
    await writeFile(path.join(blobs, 'sha256-shared'), 'layer');
    await writeFile(path.join(blobs, 'sha256-ours'), 'ours');

    const result = await purgeCancelledOllamaPull({
      modelsDir: root,
      name: 'gpt-oss:20b',
      digests: ['sha256:shared', 'sha256:ours'],
      keepDigests: ['sha256:shared'],
    });
    expect(result.deleted).toContain('sha256-ours');
    expect(result.deleted).not.toContain('sha256-shared');
    await expect(readFile(path.join(blobs, 'sha256-shared'), 'utf8')).resolves.toBe('layer');
  });
});
