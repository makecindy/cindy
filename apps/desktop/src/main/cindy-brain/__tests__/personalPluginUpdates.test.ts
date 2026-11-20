import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstalledGhost } from '../../../shared/ghost.js';
import { applyPersonalPluginUpdates, personalPluginContentHash } from '../personalPluginUpdates.js';

// Unit regression through bundle preparation -> actual Host reader. Before this
// change local sources became public seeds and no local installation was updated.
// Temp directories only; injected updater is the existing install transaction
// boundary, not a second implementation of it. No credentials/network/Electron.
const { prepareLocalPlugins } = await import(pathToFileURL(path.resolve(import.meta.dirname, '../../../../../../scripts/personal-build.mjs')).href);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-plugins-')); roots.push(root);
  const source = path.join(root, 'source'), installed = path.join(root, 'installed'), bundle = path.join(root, 'bundle');
  fs.mkdirSync(source); fs.mkdirSync(installed);
  fs.writeFileSync(path.join(source, 'ghost.json'), JSON.stringify({ id: 'sample', version: '1.0.0' }));
  fs.writeFileSync(path.join(source, 'main.js'), 'new implementation');
  fs.writeFileSync(path.join(installed, 'ghost.json'), JSON.stringify({ id: 'sample', version: '1.0.0' }));
  fs.writeFileSync(path.join(installed, 'main.js'), 'old implementation');
  prepareLocalPlugins({ localPlugins: { sample: source } }, root, bundle);
  const target = { manifest: { id: 'sample', version: '1.0.0' }, namespace: 'local', namespaceState: 'confirmed',
    dir: installed, instanceKey: '_ns__local__sample', enabled: false,
    approval: { state: 'approved', revision: 'original' } } as InstalledGhost;
  const update = vi.fn(async () => {
    fs.cpSync(source, installed, { recursive: true });
    return { ...target, approval: { state: 'approved' as const, revision: 'new' } };
  });
  return { root, source, installed, bundle, target, update,
    deps: { isCurrent: () => true, findLocal: () => target, update } };
}
describe('personal local plugin application', () => {
  it('accepts the build fingerprint, updates same-version changes, preserves identity/disabled state, then becomes a no-op', async () => {
    const f = fixture();
    expect(await applyPersonalPluginUpdates(f.bundle, f.deps)).toMatchObject({ state: 'verified', plugins: [{ state: 'updated', version: '1.0.0' }] });
    expect(f.update).toHaveBeenCalledOnce();
    expect(await applyPersonalPluginUpdates(f.bundle, f.deps)).toMatchObject({ state: 'verified', plugins: [{ state: 'unchanged' }] });
    expect(f.update).toHaveBeenCalledOnce();
    expect(await personalPluginContentHash(f.installed)).toBe(await personalPluginContentHash(f.source));
  });
  it.each(['tampered', 'link', 'duplicate', 'namespace'] as const)('rejects %s bundle before touching the installed plugin', async reason => {
    const f = fixture(), index = path.join(f.bundle, 'index.json');
    const record = JSON.parse(fs.readFileSync(index, 'utf8'));
    if (reason === 'tampered') fs.writeFileSync(path.join(f.bundle, 'sample/main.js'), 'changed');
    if (reason === 'link') {
      fs.rmSync(path.join(f.bundle, 'sample/main.js'));
      fs.symlinkSync(path.join(f.source, 'main.js'), path.join(f.bundle, 'sample/main.js'));
    }
    if (reason === 'duplicate') record.plugins.push(record.plugins[0]);
    if (reason === 'namespace') record.plugins[0].namespace = null;
    fs.writeFileSync(index, JSON.stringify(record));
    await expect(applyPersonalPluginUpdates(f.bundle, f.deps)).rejects.toThrow();
    expect(f.update).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(f.installed, 'main.js'), 'utf8')).toBe('old implementation');
  });
  it.each(['newer', 'unapproved', 'public', 'missing'] as const)('defers %s installed state without first-installing or replacing another source', async reason => {
    const f = fixture();
    if (reason === 'newer') f.target.manifest.version = '2.0.0';
    if (reason === 'unapproved') f.target.approval = { state: 'legacy-unapproved' };
    if (reason === 'public') f.target.namespace = null;
    const report = await applyPersonalPluginUpdates(f.bundle, { ...f.deps, findLocal: () => reason === 'missing' ? undefined : f.target });
    expect(report).toMatchObject({ state: 'deferred', plugins: [{ state: 'deferred' }] });
    expect(f.update).not.toHaveBeenCalled();
  });
  it('reports an installer rejection without claiming success or replaying the mutation', async () => {
    const f = fixture(); f.update.mockRejectedValue(new Error('Permission increase requires confirmation'));
    expect(await applyPersonalPluginUpdates(f.bundle, f.deps)).toMatchObject({ state: 'incomplete', plugins: [{ state: 'failed' }] });
    expect(f.update).toHaveBeenCalledOnce();
    expect(fs.readFileSync(path.join(f.installed, 'main.js'), 'utf8')).toBe('old implementation');
  });
  it('refuses a changed data owner before any mutation', async () => {
    const f = fixture();
    await expect(applyPersonalPluginUpdates(f.bundle, { ...f.deps, isCurrent: () => false })).rejects.toThrow('owner changed');
    expect(f.update).not.toHaveBeenCalled();
  });
});
