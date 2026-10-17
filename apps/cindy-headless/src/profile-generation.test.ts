import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { capabilityCatalog } from './compatibility.js';
import { generateProfileFromManifest, PROFILE_GENERATION_FEATURES } from './profile-generation.js';
import { readProfile, sha256 } from './profile.js';

const temporaryDirectories: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-profile-generate-'));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, 'bin', 'pi'), { recursive: true });
  const prompts = { 'prompt.md': 'claude prompt\n', 'codex-prompt.md': 'codex prompt\n', 'pi-prompt.md': 'pi prompt\n' };
  await Promise.all(Object.entries(prompts).map(([name, body]) => writeFile(path.join(root, name), body)));
  const catalog = capabilityCatalog();
  const models = {
    'claude-code': { supportedModelIds: ['claude-test'], defaultModel: { provider: 'anthropic', requestedId: 'claude-test' } },
    codex: { supportedModelIds: ['gpt-test'], defaultModel: { provider: 'openai', requestedId: 'gpt-test' } },
    pi: { supportedModelIds: ['pi-test'], defaultModel: { provider: 'cindy', requestedId: 'pi-test', contextLimit: 100_000, maxOutputTokens: 8_000 } },
  };
  for (const entry of catalog.harnesses) Object.assign(entry, models[entry.backend as keyof typeof models]);
  const manifest = {
    capabilityCatalog: catalog,
    claudeCodeVersion: '1.0.0', codexVersion: '2.0.0', piVersion: '3.0.0',
    systemPromptDigest: sha256(prompts['prompt.md']), codexSystemPromptDigest: sha256(prompts['codex-prompt.md']), piSystemPromptDigest: sha256(prompts['pi-prompt.md']),
  };
  const manifestPath = path.join(root, 'bundle-manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { root, manifest, manifestPath };
}

afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe('profile generation', () => {
  it('has an explicit implementation for every registered feature', () => {
    expect([...PROFILE_GENERATION_FEATURES].sort()).toEqual(Object.keys(capabilityCatalog().features).sort());
  });

  it('fails closed when a manifest advertises a feature without a generator implementation', async () => {
    const { manifest, manifestPath } = await fixture();
    manifest.capabilityCatalog.features.futureFeature = { type: 'boolean', control: 'profile', default: false };
    manifest.capabilityCatalog.defaultValues.futureFeature = false;
    manifest.capabilityCatalog.harnesses[0]!.features.push('futureFeature');
    expect(() => generateProfileFromManifest(manifest, { manifestPath, outputPath: 'unused.json', harness: 'claude-code', features: ['futureFeature'] })).toThrow('profile generator has no implementation');
  });
  for (const harness of ['claude-code', 'codex', 'pi'] as const) {
    it(`generates and validates a ${harness} profile using bundle-relative assets`, async () => {
      const { root, manifest, manifestPath } = await fixture();
      const outputPath = path.join(root, 'generated', harness, 'profile.json');
      const profile = generateProfileFromManifest(manifest, { manifestPath, outputPath, harness });
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, JSON.stringify(profile, null, 2) + '\n');
      const resolved = await readProfile(outputPath, root);
      expect(resolved.profile.agentBackend).toBe(harness);
      expect(resolved.profile.model.effort).toBe('high');
      expect(resolved.systemPromptDigest).toBe(profile.expectedSystemPromptDigest);
      expect(profile.agentBinaryPath).toBe(`bundle:bin/${harness === 'pi' ? 'pi/pi' : harness === 'claude-code' ? 'claude' : 'codex'}`);
      expect(path.isAbsolute(resolved.profile.agentBinaryPath)).toBe(true);
    });
  }

  it('generates a valid native provider for a custom Pi model', async () => {
    const { root, manifest, manifestPath } = await fixture();
    const outputPath = path.join(root, 'generated-pi.json');
    const profile = generateProfileFromManifest(manifest, {
      manifestPath, outputPath, harness: 'pi', modelId: 'custom-model', providerId: 'custom', providerBaseUrl: 'https://models.example.test',
      providerApi: 'openai-responses', contextLimit: 128_000, maxOutputTokens: 16_000,
    });
    expect(profile.nativeProviders?.[0]).toMatchObject({ id: 'custom', models: [{ id: 'custom-model', contextWindow: 128_000, maxTokens: 16_000 }] });
    expect(profile.supportedModelIds).toContain('custom-model');
  });

  it('allows an explicitly configured gateway model without weakening default validation', async () => {
    const { manifest, manifestPath } = await fixture();
    const outputPath = path.join(path.dirname(manifestPath), 'gateway.json');
    const options = { manifestPath, outputPath, harness: 'claude-code', modelId: 'deepseek/model' };
    expect(() => generateProfileFromManifest(manifest, options)).toThrow('is not supported');
    const profile = generateProfileFromManifest(manifest, {
      ...options, gatewayModel: true, providerId: 'deepseek', providerBaseUrl: 'https://gateway.example.test', providerApi: 'anthropic-messages',
    });
    expect(profile.model).toMatchObject({ provider: 'deepseek', requestedId: 'deepseek/model' });
    expect(profile.supportedModelIds).toContain('deepseek/model');
  });

  it('generates a validated remote HTTP MCP configuration', async () => {
    const { root, manifest, manifestPath } = await fixture();
    const outputPath = path.join(root, 'generated-claude.json');
    const profile = generateProfileFromManifest(manifest, {
      manifestPath,
      outputPath,
      harness: 'claude-code',
      mcpServers: [{ id: 'docs', transport: 'http', url: 'https://mcp.example.test', bearerTokenEnvVar: 'MCP_TOKEN' }],
    });
    expect(profile.mcpServers).toEqual([{ id: 'docs', transport: 'http', url: 'https://mcp.example.test', bearerTokenEnvVar: 'MCP_TOKEN' }]);
  });

  it('supports an exact empty feature selection instead of applying manifest defaults', async () => {
    const { manifest, manifestPath } = await fixture();
    const profile = generateProfileFromManifest(manifest, { manifestPath, outputPath: 'unused.json', harness: 'claude-code', features: [], exactFeatures: true });
    expect(profile).toMatchObject({ projectContext: false, makerMemory: false, nativeMemory: false });
  });

  it('rejects unsupported features, harnesses and unconfigured custom models', async () => {
    const { root, manifest, manifestPath } = await fixture();
    const outputPath = path.join(root, 'profile.json');
    expect(() => generateProfileFromManifest(manifest, { manifestPath, outputPath, harness: 'future' })).toThrow('bundle does not provide harness');
    expect(() => generateProfileFromManifest(manifest, { manifestPath, outputPath, harness: 'codex', features: ['piProjectSkills'] })).toThrow('DETECTED_BUT_UNSUPPORTED');
    expect(() => generateProfileFromManifest(manifest, { manifestPath, outputPath, harness: 'pi', modelId: 'custom' })).toThrow('custom Pi models require');
    expect(() => generateProfileFromManifest(manifest, { manifestPath, outputPath, harness: 'claude-code', features: ['remoteHttpMcp'] })).toThrow('DETECTED_BUT_UNSUPPORTED');
    expect(() => generateProfileFromManifest(manifest, { manifestPath, outputPath, harness: 'pi', effort: 'ultra' })).toThrow('ultra effort is not supported');
  });
});
