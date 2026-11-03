import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import registry from '../capability-registry.json';
import { assertSafeExecutionProfile, capabilityCatalog, CINDY_HEADLESS_VERSION, CINDY_UPSTREAM_COMMIT, compatibilityReport, discoverCapabilityCatalog, validateCapabilityRegistry } from './compatibility.js';
import { validateProfile } from './profile.js';

const packageMetadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const base = {
  id: 'compatibility-test',
  version: 1,
  agentBackend: 'codex',
  agentBinaryPath: '/opt/codex',
  agentBinaryVersion: '1.2.3',
  supportedModelIds: ['gpt-test'],
  model: { provider: 'openai', requestedId: 'gpt-test' },
  permissionMode: 'auto',
  makerMemory: true,
  nativeMemory: false,
  projectContext: true,
} as const;

describe('headless compatibility contract', () => {
  it('validates the single-source capability registry and rejects dangling harness features', () => {
    expect(() => validateCapabilityRegistry(registry)).not.toThrow();
    const invalid = structuredClone(registry) as unknown as { harnesses: { codex: { features: string[] } } };
    invalid.harnesses.codex.features.push('unregisteredFeature');
    expect(() => validateCapabilityRegistry(invalid)).toThrow('invalid capability registry harness');
  });
  it('publishes a stable web-discovery capability catalog', () => {
    const catalog = capabilityCatalog('claude-code');
    expect(catalog.contractVersion).toBe(1);
    expect(catalog.harnesses).toEqual([{ id: 'cindy-claude', backend: 'claude-code', features: ['projectContext', 'makerMemory', 'nativeMemory', 'attachments'], adapterSupported: true }]);
    expect(catalog.features.projectContext).toMatchObject({ type: 'boolean', control: 'profile', default: false, label: 'Project Context' });
    expect(catalog.constraints).toEqual([{ type: 'mutuallyExclusive', features: ['makerMemory', 'nativeMemory'], harnesses: ['claude-code', 'codex'], offLabel: '关闭所有自动记忆' }]);
  });

  it('advertises Cindy memory controls for Pi while keeping the backend identity', () => {
    const catalog = capabilityCatalog('pi');
    expect(catalog.harnesses[0]).toMatchObject({ id: 'cindy-pi', backend: 'pi' });
    expect(catalog.harnesses[0].features).toEqual(['projectContext', 'makerMemory', 'nativeMemory', 'attachments', 'piProjectSkills']);
    expect(catalog.features.makerMemory).toBeDefined();
  });

  it('reports unknown features and harnesses instead of hiding them', () => {
    const catalog = capabilityCatalog();
    catalog.features.futureFeature = { type: 'boolean', control: 'profile', default: false };
    catalog.harnesses.push({ id: 'future', backend: 'future-agent', features: ['futureFeature'], adapterSupported: true });
    const discovered = discoverCapabilityCatalog(catalog);
    expect(discovered.support.futureFeature).toBe('DETECTED_BUT_UNSUPPORTED');
    expect(discovered.harnesses.at(-1)).toMatchObject({ backend: 'future-agent', adapterSupported: false, status: 'DETECTED_BUT_UNSUPPORTED' });
  });

  it('rejects a manifest without a capability catalog', () => {
    expect(() => discoverCapabilityCatalog(undefined)).toThrow('bundle manifest does not contain capabilityCatalog');
  });

  it('reflects explicit adapter support and profile feature coverage', () => {
    const catalog = capabilityCatalog();
    catalog.harnesses[1].adapterSupported = false;
    const discovered = discoverCapabilityCatalog(catalog);
    expect(discovered.harnesses.find((item) => item.backend === 'codex')?.status).toBe('DETECTED_BUT_UNSUPPORTED');
    for (const harness of discovered.harnesses.filter((item) => item.status === 'SUPPORTED')) {
      expect(harness.features.every((id) => discovered.support[id] === 'SUPPORTED')).toBe(true);
    }
  });

  it('keeps the runtime and package versions aligned', () => {
    expect(CINDY_HEADLESS_VERSION).toBe(packageMetadata.version);
    expect(CINDY_UPSTREAM_COMMIT).toBe(packageMetadata.cindyUpstreamCommit);
  });

  it('describes the backend transport and required capabilities', () => {
    expect(compatibilityReport(validateProfile(base))).toMatchObject({
      schemaVersion: 1,
      contractVersion: 1,
      cindyUpstreamCommit: CINDY_UPSTREAM_COMMIT,
      transport: 'codex-app-server-jsonrpc',
      requiredCapabilities: expect.arrayContaining(['multi-turn-session', 'mcp']),
    });
  });

  it('describes the Pi RPC transport', () => {
    const pi = validateProfile({
      ...base,
      agentBackend: 'pi',
      agentBinaryPath: '/opt/pi/pi',
      agentBinaryVersion: '0.83.0',
      model: { ...base.model, contextLimit: 200_000 },
      permissionMode: 'bypassPermissions',
      containerSandbox: true,
    });
    expect(compatibilityReport(pi).transport).toBe('pi-rpc-jsonl');
  });

  it('rejects unsandboxed permission bypass by default', () => {
    const profile = validateProfile({ ...base, permissionMode: 'bypassPermissions' });
    expect(() => assertSafeExecutionProfile(profile)).toThrow(/containerSandbox=true/);
  });

  it('accepts permission bypass inside an explicit container sandbox', () => {
    const profile = validateProfile({ ...base, permissionMode: 'bypassPermissions', containerSandbox: true });
    expect(() => assertSafeExecutionProfile(profile)).not.toThrow();
  });
});
