import { describe, expect, it } from 'vitest';
import { validateGhostManifest } from '../manifest.js';

const base = {
  schemaVersion: 3, minCindyVersion: '0.1.0', id: 'future-declarations',
  name: 'Future declarations', version: '1.0.0', entry: 'main.js',
};
const extension = { mode: 'future', options: [1, null, { enabled: true }] };

describe('declaration forward compatibility is not Host authorization', () => {
  it.each([
    ['mainView', { html: 'view.html' }],
    ['panel', { html: 'panel.html' }],
    ['card', {}],
    ['agent', {}],
    ['node', { entry: 'node/worker.cjs', protocol: 'json-rpc-stdio' }],
    ['preview', { hosts: ['example.test'] }],
    ['skill', { items: [{ dir: 'skills/demo', name: 'demo', description: 'Demo', future: extension }] }],
    ['manual', { items: [{ dir: 'manual/demo', name: 'demo', description: 'Demo', future: extension }] }],
    ['subscribe', {}],
  ])('preserves unknown %s fields through repeated normalization', (field, declaration) => {
    const raw = { ...base, [field]: { ...declaration, future: extension } };
    const result = validateGhostManifest(raw);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.manifest[field]).toEqual(raw[field as keyof typeof raw]);
    expect(validateGhostManifest(result.manifest)).toEqual(result);
  });

  it('preserves future categories, actions, topics and hooks without requiring known hook lifecycle', () => {
    const raw = { ...base, cindy: { image: ['generate', 'future-action'], future: extension },
      subscribe: { topics: ['future-topic'], hooks: ['future-hook'] } };
    const result = validateGhostManifest(raw);
    expect(result).toMatchObject({ ok: true, manifest: { cindy: raw.cindy, subscribe: raw.subscribe } });
  });

  it('keeps prototype-like extension keys as own data without changing object prototypes', () => {
    const cindy = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"future":true}}');
    const result = validateGhostManifest({ ...base, cindy });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.hasOwn(result.manifest.cindy!, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(result.manifest.cindy!)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('preserves unresolved OAuth and future binding metadata for runtime resolution', () => {
    const binding = { key: 'access_token', label: 'Account', methods: ['run'],
      oauthSecret: 'future_account', future: extension };
    const result = validateGhostManifest({ ...base, settingsHtml: 'settings.html',
      node: { entry: 'node/worker.cjs', protocol: 'json-rpc-stdio', secretBindings: [binding] } });
    expect(result).toMatchObject({ ok: true, manifest: { node: { secretBindings: [binding] } } });
  });

  it.each([
    { mainView: { html: '../escape.html', future: extension } },
    { card: { externalLinks: 'yes', future: extension } },
    { agent: { background: 'yes', future: extension } },
    { node: { entry: '../worker.cjs', protocol: 'json-rpc-stdio', future: extension } },
    { preview: { hosts: ['https://example.test/path'], future: extension } },
    { skill: { items: [{ dir: '../escape', name: 'demo', description: 'Demo' }], future: extension } },
    { cindy: { image: [42], future: extension } },
    { cindy: { image: ['generate', 'generate'], future: extension } },
    { subscribe: { topics: [42], future: extension } },
    { subscribe: { hooks: ['will-user-message'], future: extension } },
  ])('still rejects malformed known fields and unsafe paths: %j', (fields) => {
    expect(validateGhostManifest({ ...base, ...fields }).ok).toBe(false);
  });
});
