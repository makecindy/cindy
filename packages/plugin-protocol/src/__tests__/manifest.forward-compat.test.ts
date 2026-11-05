import { describe, expect, it } from 'vitest';
import { validateGhostManifest, validateStoredGhostManifest } from '../manifest.js';

const base = {
  schemaVersion: 3, minCindyVersion: '0.1.0', id: 'future-declarations',
  name: 'Future declarations', version: '1.0.0', entry: 'main.js',
};
const extension = { mode: 'future', options: [1, null, { enabled: true }] };

describe('declaration forward compatibility is not Host authorization', () => {
  // 4.1: named tabs need distinct identities and packaged entry pages. The
  // existing contribution matrix does not validate tab declarations. Tier: unit.
  it('validates named tab pages without changing stored or legacy declarations', () => {
    const view = { id: 'log', title: 'Log', scope: 'session', page: 'views/log.html' };
    expect(validateGhostManifest({ ...base, ui: { version: 1, tabViews: [view,
      { ...view, id: 'preview', scope: 'global' }] } })).toMatchObject({ ok: true });
    for (const tabViews of [[view, view], [{ ...view, page: '../outside.html' }],
      [{ ...view, page: 'views/log.js' }], [{ ...view, scope: 'message' }]]) {
      const raw = { ...base, ui: { version: 1, tabViews } };
      expect(validateGhostManifest(raw).ok).toBe(false);
      expect(validateStoredGhostManifest(raw)).toMatchObject({ ok: true, manifest: { ui: raw.ui } });
    }
  });
  it('preserves historical malformed UI without tolerating unrelated invalid package data', () => {
    const raw = { ...base, ui: { version: 1, contributions: 'old unknown data' } };
    expect(validateGhostManifest(raw).ok).toBe(false);
    expect(validateStoredGhostManifest(raw)).toMatchObject({ ok: true, manifest: { ui: raw.ui } });
    expect(validateStoredGhostManifest({ ...raw, entry: '../escape.js' }).ok).toBe(false);
  });
  // C1: these are package-parser outcomes, not evidence of runtime authority.
  it.each([
    { version: 1 },
    { version: 1, appearance: { fields: ['uiFont', 'future-field'], resources: [{ id: 'regular', kind: 'font', path: 'assets/regular.ttf' }] } },
    { version: 1, contributions: [{ id: 'format', point: 'composer.tools', scope: 'session' }] },
    { version: 1, contributions: [{ id: 'format', point: 'composer.tools', scope: 'session', context: ['session.summary', 'selection'], editor: ['append'] }] },
    { version: 1, contributions: [{ id: 'message', point: 'message.body', scope: 'message', match: { kind: 'self' } }] },
    { version: 1, contributions: [{ id: 'message', point: 'message.body', scope: 'message', page: 'ui/message.html' }] },
    { version: 1, contributions: [{ id: 'future', point: 'future.point', scope: 'future', page: { future: true } }] },
    { version: 1, contributions: [{ id: 'tool', point: 'tool.body', scope: 'tool', match: { kind: 'plugin', instanceId: '_root__writer', name: 'format' } }] },
    { version: 1, commands: [{ id: 'format', title: 'Format', points: ['composer.tools', 'session.header.actions'], scope: 'session', context: ['selection'], editor: ['append'], defaultShortcut: { code: 'KeyJ', meta: true } }] },
    { version: 1, commands: [{ id: 'keyboard-only', title: 'Keyboard command', scope: 'session' }] },
    { version: 1, contributions: [{ id: 'future', point: 'future.point', scope: 'future', future: extension }] },
    { version: 2, contributions: 'future representation', future: extension },
  ])('retains additive native UI declarations without changing their canonical bytes: %j', (ui) => {
    const result = validateGhostManifest({ ...base, ui });
    expect(result).toMatchObject({ ok: true, manifest: { ui } });
    if (result.ok) expect(validateGhostManifest(result.manifest)).toEqual(result);
  });

  it.each([
    null, [], {}, { version: 0 }, { version: '1' },
    { version: 1, contributions: null },
    { version: 1, commands: null },
    { version: 1, commands: [{ id: 'format', title: 'Format', points: ['composer.tools'], scope: 'session' }, { id: 'format', title: 'Other', points: ['composer.tools'], scope: 'session' }] },
    { version: 1, commands: [{ id: 'format', title: 'Format', points: ['composer.tools', 'composer.tools'], scope: 'session' }] },
    { version: 1, commands: [{ id: 'format', title: 'Format', points: ['composer.tools'], scope: 'session', defaultShortcut: { code: 'KeyJ', meta: 'yes' } }] },
    { version: 1, appearance: { fields: ['uiFont'], resources: [{ id: 'font', kind: 'font', path: '../secret.ttf' }] } },
    { version: 1, appearance: { fields: ['uiFont', 'uiFont'] } },
    { version: 1, contributions: [{ id: 'a', point: 'composer.tools' }] },
    { version: 1, contributions: [{ id: 'a', point: 'composer.tools', scope: 'session' }, { id: 'a', point: 'future', scope: 'session' }] },
    { version: 1, contributions: [{ id: 'a', point: 'x'.repeat(161), scope: 'session' }] },
    { version: 1, contributions: [{ id: 'a', point: 'composer.tools', scope: 'session', context: ['selection', 'selection'] }] },
    { version: 1, contributions: [{ id: 'a', point: 'composer.tools', scope: 'session', editor: true }] },
    { version: 1, contributions: [{ id: 'a', point: 'tool.body', scope: 'tool', match: { kind: 'plugin' } }] },
    { version: 1, contributions: [{ id: 'a', point: 'tool.body', scope: 'tool', match: { kind: 'tool', name: '' } }] },
    { version: 1, contributions: [{ id: 'a', point: 'message.body', scope: 'message', page: '../outside.html' }] },
    { version: 1, contributions: [{ id: 'a', point: 'tool.body', scope: 'tool', page: 'https://example.com/page.html' }] },
    { version: 1, contributions: [{ id: 'a', point: 'composer.tools', scope: 'session', page: 'page.js' }] },
    { version: 1, contributions: [{ id: 'a', point: 'message.body', scope: 'message', page: { path: 'page.html' } }] },
  ])('rejects malformed known native UI declarations: %j', (ui) => {
    expect(validateGhostManifest({ ...base, ui }).ok).toBe(false);
  });

  it.each([
    ['mobile', { channels: ['practice-ui'], panel: 'mobile/panel.html' }],
    ['mainView', { html: 'view.html' }],
    ['taskView', { html: 'task.html' }],
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

it('validates opt-in delegation while preserving unrelated future agent fields', () => {
  const agent = { tasks: true, targets: true, delegation: true, future: extension };
  expect(validateGhostManifest({ ...base, agent })).toMatchObject({ ok: true, manifest: { agent } });
  for (const invalid of [{ delegation: true }, { tasks: true, delegation: true }, { tasks: true, targets: true, delegation: 'yes' }]) {
    expect(validateGhostManifest({ ...base, agent: invalid }).ok).toBe(false);
  }
  expect(validateGhostManifest({ ...base, agent: { tasks: true, targets: true } })).toMatchObject({ ok: true });
});
