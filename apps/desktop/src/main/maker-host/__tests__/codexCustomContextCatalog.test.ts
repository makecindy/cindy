import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import nativeFallbackPrompt from '../codex-native-fallback-prompt.md?raw';

import {
  extractBundledCodexModelCatalog,
  prepareCodexCustomContextCatalog,
  patchCodexModelMaxContextWindow,
  nativeCodexFallbackModel,
} from '../codex-custom-context-catalog.js';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function createFixtureBinary(
  catalog: unknown,
  lineEnding: '\n' | '\r\n' = '\n',
): Promise<{ root: string; binaryPath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-codex-catalog-'));
  tempRoots.push(root);
  const binaryPath = path.join(root, process.platform === 'win32' ? 'codex.exe' : 'codex');
  const invalidCandidate = Buffer.from('{\n  "models": [invalid]}', 'utf8');
  const bundled = Buffer.from(JSON.stringify(catalog, null, 2).replace(/\n/g, lineEnding), 'utf8');
  await fs.writeFile(binaryPath, Buffer.concat([
    Buffer.alloc(61, 0x41),
    invalidCandidate,
    Buffer.alloc(47, 0x42),
    bundled,
    Buffer.alloc(37, 0x43),
  ]));
  return { root, binaryPath };
}

describe('Codex custom context model catalog', () => {
  it('extracts the complete embedded catalog across chunk boundaries', async () => {
    const catalog = {
      models: [
        {
          slug: 'gpt-5.6-sol',
          context_window: 272_000,
          max_context_window: 272_000,
          base_instructions: 'keep braces { and } plus an escaped quote " intact',
        },
      ],
    };
    const { binaryPath } = await createFixtureBinary(catalog);

    await expect(
      extractBundledCodexModelCatalog(binaryPath, { scanChunkBytes: 64 }),
    ).resolves.toEqual(catalog);
  });

  it('extracts the CRLF catalog embedded by the Windows build', async () => {
    const catalog = {
      models: [{ slug: 'gpt-5.6-sol', context_window: 272_000, max_context_window: 272_000 }],
    };
    const { binaryPath } = await createFixtureBinary(catalog, '\r\n');

    await expect(
      extractBundledCodexModelCatalog(binaryPath, { scanChunkBytes: 64 }),
    ).resolves.toEqual(catalog);
  });

  it('keeps context_window at 272K and only raises the selected model maximum', async () => {
    const otherModel = {
      slug: 'gpt-5.4-mini',
      context_window: 128_000,
      max_context_window: 128_000,
    };
    const { root, binaryPath } = await createFixtureBinary({
      models: [
        {
          slug: 'gpt-5.6-sol',
          context_window: 272_000,
          max_context_window: 272_000,
          base_instructions: 'preserve the full descriptor',
        },
        otherModel,
      ],
    });
    const codexHome = path.join(root, 'codex-home');

    const prepared = await prepareCodexCustomContextCatalog({
      binaryPath,
      codexHome,
      modelId: 'gpt-5.6-sol',
      contextWindow: 700_000,
      scanChunkBytes: 64,
    });
    const written = JSON.parse(await fs.readFile(prepared.catalogPath, 'utf8')) as {
      models: Array<Record<string, unknown>>;
    };

    expect(written.models[0]).toMatchObject({
      slug: 'gpt-5.6-sol',
      context_window: 272_000,
      max_context_window: 700_000,
      base_instructions: 'preserve the full descriptor',
    });
    expect(written.models[1]).toEqual(otherModel);
    expect(prepared.extraArgs).toEqual([
      '-c',
      `model_catalog_json=${JSON.stringify(prepared.catalogPath)}`,
    ]);
  });

  it('patches an in-memory smart catalog while preserving routed models and the exact bundled root descriptor', async () => {
    const bundledRoot = {
      slug: 'gpt-5.6-sol',
      context_window: 272_000,
      max_context_window: 272_000,
      base_instructions: 'bundled root instructions',
    };
    const { root, binaryPath } = await createFixtureBinary({
      models: [bundledRoot, { slug: 'gpt-5.6-terra', multi_agent_version: 'v2' }],
    });
    const smartModel = {
      slug: 'deepseek/deepseek-v4-flash',
      multi_agent_version: 'v2',
      base_instructions: 'smart routed instructions',
    };

    const prepared = await prepareCodexCustomContextCatalog({
      binaryPath,
      codexHome: path.join(root, 'codex-home'),
      modelId: 'gpt-5.6-sol',
      contextWindow: 1_050_000,
      scanChunkBytes: 64,
      baseCatalog: {
        models: [
          { slug: 'gpt-5.6-terra', multi_agent_version: 'v2' },
          smartModel,
        ],
      },
    });
    const written = JSON.parse(await fs.readFile(prepared.catalogPath, 'utf8')) as {
      models: Array<Record<string, unknown>>;
    };

    expect(written.models).toContainEqual(smartModel);
    expect(written.models).toContainEqual({
      ...bundledRoot,
      max_context_window: 1_050_000,
    });
  });

  it('fails visibly if an unknown model fallback cannot be verified against this binary', async () => {
    const { root, binaryPath } = await createFixtureBinary({
      models: [{ slug: 'gpt-5.4', context_window: 272_000, max_context_window: 272_000 }],
    });

    await expect(prepareCodexCustomContextCatalog({
      binaryPath,
      codexHome: path.join(root, 'codex-home'),
      modelId: 'gpt-5.6-sol',
      contextWindow: 700_000,
      scanChunkBytes: 64,
    })).rejects.toThrow('native fallback metadata changed');
  });

  it('uses a newly discovered GPT model absent from the installed binary', async () => {
    const { root, binaryPath } = await createFixtureBinary({ models: [{ slug: 'gpt-5.4' }] });
    const native = { slug: 'gpt-6-astra', context_window: 272_000, max_context_window: 872_000,
      model_messages: { instructions_template: 'latest native prompt' }, comp_hash: 'native-compaction-id' };
    await fs.writeFile(path.join(root, 'models_cache.json'), JSON.stringify({ models: [native] }));
    const result = await prepareCodexCustomContextCatalog({ binaryPath, codexHome: root,
      modelId: 'codex/gpt-6-astra', contextWindow: 1_000_000, scanChunkBytes: 64 });
    const catalog = JSON.parse(await fs.readFile(result.catalogPath, 'utf8'));
    expect(catalog.models).toContainEqual({ ...native, slug: 'codex/gpt-6-astra', max_context_window: 1_000_000 });
    expect(catalog.models).toContainEqual(native);
  });

  it.each(['\n', '\r\n'] as const)('preserves verified native unknown-model behavior with %j line endings', async (lineEnding) => {
    const { root, binaryPath } = await createFixtureBinary({ models: [{ slug: 'gpt-5.4' }] }, lineEnding);
    const instructions = nativeFallbackPrompt.replace(/\r?\n/g, lineEnding);
    await fs.appendFile(binaryPath, instructions);
    const result = await prepareCodexCustomContextCatalog({ binaryPath, codexHome: root,
      modelId: 'glm-5.3', contextWindow: 500_000, scanChunkBytes: 64 });
    const catalog = JSON.parse(await fs.readFile(result.catalogPath, 'utf8'));
    expect(catalog.models[1]).toEqual({ ...nativeCodexFallbackModel('glm-5.3', instructions), max_context_window: 500_000 });
  });

  it('keeps user-owned catalog instructions untouched', async () => {
    const { root, binaryPath } = await createFixtureBinary({ models: [{ slug: 'gpt-5.4' }] });
    const native = { slug: 'glm', base_instructions: '## Planning\nYou have access to an `update_plan` tool\nUser-owned text.\n' };
    await fs.writeFile(path.join(root, 'custom.json'), JSON.stringify({ models: [native] }));
    await fs.writeFile(path.join(root, 'config.toml'), 'model_catalog_json = "custom.json"');
    const result = await prepareCodexCustomContextCatalog({ binaryPath, codexHome: root,
      modelId: 'glm', contextWindow: 500_000, scanChunkBytes: 64 });
    const catalog = JSON.parse(await fs.readFile(result.catalogPath, 'utf8'));
    expect(catalog.models[0]).toEqual({ ...native, max_context_window: 500_000 });
  });

  it('keeps wire aliases independent and preserves native instructions and tools', () => {
    const native = { slug: 'gpt-6-astra', context_window: 272_000, max_context_window: 872_000,
      model_messages: { instructions_template: 'native prompt' }, shell_type: 'unified_exec', comp_hash: 'opaque' };
    const result = patchCodexModelMaxContextWindow({ models: [native] }, 'codex/gpt-6-astra', 1_000_000);
    expect(result.models[0]).toEqual(native);
    expect(result.models[1]).toEqual({ ...native, slug: 'codex/gpt-6-astra', max_context_window: 1_000_000 });
  });

  it('uses native unknown-model defaults for GLM instead of cloning GPT behavior', () => {
    const result = patchCodexModelMaxContextWindow({ models: [{ slug: 'gpt-5.4', multi_agent_version: 'v2' }] }, 'glm-5.3', 500_000);
    expect(result.models[1]).toEqual({ ...nativeCodexFallbackModel('glm-5.3'), max_context_window: 500_000 });
    expect(result.models[1].multi_agent_version).toBeUndefined();
  });

  it('reuses one immutable catalog across concurrent session starts', async () => {
    const { root, binaryPath } = await createFixtureBinary({
      models: [{ slug: 'gpt-5.6-sol', context_window: 272_000, max_context_window: 272_000 }],
    });
    const codexHome = path.join(root, 'codex-home');

    const prepared = await Promise.all(Array.from({ length: 8 }, () =>
      prepareCodexCustomContextCatalog({
        binaryPath,
        codexHome,
        modelId: 'gpt-5.6-sol',
        contextWindow: 700_000,
        scanChunkBytes: 64,
      })));

    expect(new Set(prepared.map((entry) => entry.catalogPath))).toHaveLength(1);
    await expect(fs.readFile(prepared[0].catalogPath, 'utf8')).resolves.toContain(
      '"max_context_window":700000',
    );
  });
});
