import { describe, expect, it } from 'vitest';
import { validateGhostManifest as shared } from '@cindy/plugin-protocol';
import { ghostNetworkAuthorizationWithinCap, validateGhostManifest as desktop } from '../../../../shared/ghost.js';
const check = { url: 'https://api.example.com/check', bodyFormat: '{"apiKey":"{value}"}', validPath: 'status', validValue: 'active', expiresAtPath: 'expiresAt', expiresAtFormat: 'iso' };
const manifest = (patch: Record<string, unknown> = {}) => ({ schemaVersion: 2, id: 'test-plugin', name: 'Test', version: '1.0.0', kind: 'chip', entry: 'main.js', slots: ['network'], settingsHtml: 'settings.html', network: { hosts: ['api.example.com', 'other.example.com'], secrets: [{ key: 'api_key', label: 'Key', inject: { header: 'Authorization', format: 'Bearer {value}', hosts: ['api.example.com'] }, ...patch }] } });
for (const [name, validate] of [['protocol', shared], ['desktop', desktop]] as const) describe(name, () => {
  it('preserves old manifests without adding a check field', () => {
    const result = validate(manifest()); expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.network?.secrets?.[0]).not.toHaveProperty('check');
  });
  it('preserves the check through normalization', () => {
    const result = validate(manifest({ check })); expect(result.ok).toBe(true);
    if (result.ok) { expect(result.manifest.network?.secrets?.[0].check).toEqual(check); }
  });
  it.each([
    { url: 'https://other.example.com/check' }, { url: 'http://api.example.com/check' },
    { url: 'https://user:pass@api.example.com/check' }, { url: 'https://api.example.com:8443/check' },
    { bodyFormat: '{"key":{value}}' }, { bodyFormat: '{"key":"{value}","other":"{value}"}' },
    { validPath: '__proto__.valid' }, { validValue: {} }, { expiresAtFormat: 'raw' },
  ])('rejects invalid declarations %j', (patch) => expect(validate(manifest({ check: { ...check, ...patch } })).ok).toBe(false));
  it('rejects managed credentials', () => expect(validate(manifest({ source: 'login-email', check })).ok).toBe(false));
});

it('enforces the reviewed credential check declaration without affecting old manifests', () => {
  const old = desktop(manifest()), reviewed = desktop(manifest({ check }));
  const changed = desktop(manifest({ check: { ...check, url: 'https://api.example.com/other' } }));
  if (!old.ok || !reviewed.ok || !changed.ok) throw new Error('fixture invalid');
  expect(ghostNetworkAuthorizationWithinCap(old.manifest, old.manifest)).toBe(true);
  expect(ghostNetworkAuthorizationWithinCap(reviewed.manifest, reviewed.manifest)).toBe(true);
  expect(ghostNetworkAuthorizationWithinCap(old.manifest, reviewed.manifest)).toBe(false);
  expect(ghostNetworkAuthorizationWithinCap(reviewed.manifest, changed.manifest)).toBe(false);
});
