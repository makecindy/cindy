import { describe, expect, it } from 'vitest';

import {
  validateGhostManifest,
  type GhostInstallApproval,
  type GhostManifest,
  type InstalledGhost,
} from '../ghost';
import {
  evaluateGhostInstallConsent,
  ghostInstallConsentKey,
  ghostUpdateNeedsConsent,
} from '../ghostInstallConsent';

function manifest(overrides: Record<string, unknown> = {}): GhostManifest {
  const result = validateGhostManifest({
    schemaVersion: 3,
    minCindyVersion: '0.1.61',
    id: 'weather-chip',
    name: 'Weather',
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    network: { hosts: ['api.weather.test'] },
    tools: [{ name: 'forecast', description: 'Read the forecast' }],
    ...overrides,
  });
  if (!result.ok) throw new Error(`invalid fixture: ${JSON.stringify(result)}`);
  return result.manifest;
}

function installed(
  base: GhostManifest,
  approval: GhostInstallApproval = { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
): InstalledGhost {
  return { manifest: base, dir: '/userData/cindy-brain/weather-chip', enabled: true, approval };
}

describe('plugin install consent', () => {
  it('always asks on first install and lists every non-tool permission', () => {
    const facts = evaluateGhostInstallConsent(null, manifest());
    expect(facts).toMatchObject({ kind: 'install', ghostId: 'weather-chip', version: '1.0.0' });
    if (facts?.kind !== 'install') throw new Error('expected install facts');
    expect(facts.permissions.map((item) => item.key)).toContain('network:host:api.weather.test');
    expect(facts.permissions.some((item) => item.kind === 'tool')).toBe(false);
  });

  it('keeps an update silent when permissions are unchanged', () => {
    const current = installed(manifest());
    expect(evaluateGhostInstallConsent(current, manifest({ version: '1.1.0' }))).toBeNull();
    expect(ghostUpdateNeedsConsent(current, manifest({ version: '1.1.0' }))).toBe(false);
  });

  it('keeps an update silent when it only removes permissions or changes tools', () => {
    const current = installed(manifest({ network: { hosts: ['api.weather.test', 'maps.weather.test'] } }));
    expect(evaluateGhostInstallConsent(current, manifest({ version: '1.1.0' }))).toBeNull();
    const withMoreTools = manifest({
      version: '1.2.0',
      network: { hosts: ['api.weather.test', 'maps.weather.test'] },
      tools: [
        { name: 'forecast', description: 'Read the forecast' },
        { name: 'radar', description: 'Show the radar' },
      ],
    });
    expect(evaluateGhostInstallConsent(current, withMoreTools)).toBeNull();
  });

  it('asks when an update adds a permission and reports the diff', () => {
    const facts = evaluateGhostInstallConsent(
      installed(manifest()),
      manifest({ version: '2.0.0', network: { hosts: ['api.weather.test', 'upload.weather.test'] } }),
    );
    expect(facts).toMatchObject({
      kind: 'update',
      previousVersion: '1.0.0',
      version: '2.0.0',
      builtinOauthClientChanged: false,
    });
    if (facts?.kind !== 'update') throw new Error('expected update facts');
    expect(facts.added.map((item) => item.key)).toEqual(['network:host:upload.weather.test']);
    expect(facts.removed).toEqual([]);
    expect(facts.unchangedCount).toBeGreaterThan(0);
  });

  it('treats an install without an approved baseline as all-new permissions', () => {
    const facts = evaluateGhostInstallConsent(
      installed(manifest(), { state: 'legacy-unapproved' }),
      manifest({ version: '1.1.0' }),
    );
    expect(facts?.kind).toBe('update');
    if (facts?.kind !== 'update') throw new Error('expected update facts');
    expect(facts.added.map((item) => item.key)).toContain('network:host:api.weather.test');
  });

  it('binds the consent key to the exact permission change that was shown', () => {
    const current = installed(manifest());
    const next = manifest({ version: '2.0.0', network: { hosts: ['api.weather.test', 'upload.weather.test'] } });
    const shown = evaluateGhostInstallConsent(current, next)!;
    const digest = 'a'.repeat(64);
    const receiver = 'approved:00000000-0000-4000-8000-000000000001';
    expect(ghostInstallConsentKey(evaluateGhostInstallConsent(current, next)!, digest, receiver)).toBe(
      ghostInstallConsentKey(shown, digest, receiver),
    );
    const widened = manifest({
      version: '2.0.0',
      network: { hosts: ['api.weather.test', 'upload.weather.test', 'extra.weather.test'] },
    });
    expect(
      ghostInstallConsentKey(evaluateGhostInstallConsent(current, widened)!, digest, receiver),
    ).not.toBe(ghostInstallConsentKey(shown, digest, receiver));
  });

  it('binds the consent key to the reviewed package digest, not just identity and permissions', () => {
    const facts = evaluateGhostInstallConsent(null, manifest())!;
    const reviewed = 'a'.repeat(64);
    const replaced = 'b'.repeat(64);
    expect(ghostInstallConsentKey(facts, reviewed, null)).toBe(
      ghostInstallConsentKey(facts, reviewed, null),
    );
    expect(ghostInstallConsentKey(facts, reviewed, null)).not.toBe(
      ghostInstallConsentKey(facts, replaced, null),
    );
  });

  it('binds update consent to the reviewed receiver receipt, not just version and permissions', () => {
    const facts = evaluateGhostInstallConsent(
      installed(manifest()),
      manifest({ version: '2.0.0', network: { hosts: ['api.weather.test', 'upload.weather.test'] } }),
    )!;
    const digest = 'a'.repeat(64);
    const reviewed = 'approved:00000000-0000-4000-8000-000000000001';
    const replaced = 'approved:00000000-0000-4000-8000-000000000002';
    expect(ghostInstallConsentKey(facts, digest, reviewed)).not.toBe(
      ghostInstallConsentKey(facts, digest, replaced),
    );
  });
});
