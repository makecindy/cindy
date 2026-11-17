import { describe, expect, it, vi } from 'vitest';
import { HostStorageService, type HostStorageProvider } from '../storageService.js';
import type { InstalledGhost } from '../../../shared/ghost.js';

// §27 unit: installation approval covers declared snapshots without another
// confirmation, preserving provider ownership and never crossing revoked or
// organization scopes. Existing Library/handoff tests cover one instance only.
// Minimum: two approved same-owner plugins and one three-byte source resource.
function fixture() {
  let generation = 0;
  const ghost = (id: string): InstalledGhost => ({ enabled: true, dir: `/fixture/${id}`,
    approval: { state: 'approved', revision: id }, namespace: null, namespaceState: 'confirmed',
    manifest: { schemaVersion: 3, id, name: `Plugin ${id}`,
      version: '1.0.0', kind: 'chip', entry: 'main.js', agent: { hostTools: ['storage'] } } });
  const source = ghost('source'), target = ghost('target');
  const copies = new Map<string, unknown[]>();
  const snapshot = vi.fn(async (id: string) => ({ name: `${id}.json`, bytes: Buffer.from('123') }));
  const provider: HostStorageProvider = { id: 'fixture', operations: ['read'], available: () => true,
    call: async id => ({ ok: true, value: id }), snapshot };
  const importCopies = vi.fn(async (id: string, files: Array<{ name: string; bytes: Uint8Array }>, check: () => void, root: string) => {
    check(); const result = files.map(file => ({ ref: 'handoff:fixture', name: file.name, size: file.bytes.length }));
    copies.set(`${root}:${id}`, result); return result;
  });
  const handoff = { hold: vi.fn(() => () => {}), currentRoot: () => `root-${generation}`,
    assertQuota: vi.fn(async () => {}), import: importCopies,
    delete: vi.fn(async (id: string, _ref: string, root: string) => { copies.delete(`${root}:${id}`); return true; }) };
  const service = new HostStorageService({ ownerKey: () => `owner-${generation}`,
    getGhost: id => id === 'source' ? source : id === 'target' ? target : null,
    listGhosts: () => [source, target], providers: [provider], handoff: handoff as never });
  const share = () => service.request('source', { op: 'share', targetPluginId: 'target', source: { provider: 'fixture', key: 'data' } }, () => true);
  return { service, source, target, snapshot, importCopies, handoff, copies, share,
    changeOwner() { generation++; } };
}

describe('shared Host storage', () => {
  it('routes provider calls and shares declared storage without an additional confirmation', async () => {
    const f = fixture();
    expect(await f.service.request('source', { op: 'targets' }, () => true)).toEqual({ ok: true, targets: [{ id: 'target', name: 'Plugin target' }] });
    expect(await f.service.request('source', { op: 'call', provider: 'fixture', request: { op: 'read', pluginId: 'target' } }, () => true))
      .toEqual({ ok: true, value: 'source' });
    expect(await f.share()).toMatchObject({ ok: true, targetPluginId: 'target', files: [{ name: 'source.json', size: 3 }] });
    expect(f.snapshot.mock.calls[0][0]).toBe('source');
    expect(f.copies.get('root-0:target')).toHaveLength(1);
    expect(f.copies.has('root-0:source')).toBe(false);
  });

  it.each(['source-stop', 'target-stop', 'target-update', 'owner-change', 'other-organization', 'pending-namespace', 'undeclared'] as const)(
    'does not deliver a snapshot after %s', async scenario => {
      const f = fixture();
      if (scenario === 'other-organization') { f.source.namespace = 'first'; f.target.namespace = 'second'; }
      if (scenario === 'pending-namespace') f.target.namespaceState = 'pending';
      if (scenario === 'undeclared') f.target.manifest.agent!.hostTools = [];
      f.handoff.assertQuota.mockImplementation(async () => {
        if (scenario === 'source-stop') f.source.enabled = false;
        if (scenario === 'target-stop') f.target.enabled = false;
        if (scenario === 'target-update') f.target.approval = { state: 'approved', revision: 'updated' };
        if (scenario === 'owner-change') f.changeOwner();
      });
      expect(await f.share()).toMatchObject({ ok: false });
      expect(f.importCopies).not.toHaveBeenCalled();
      expect(f.copies.size).toBe(0);
      if (['other-organization', 'pending-namespace', 'undeclared'].includes(scenario)) {
        expect(f.snapshot).not.toHaveBeenCalled();
      }
    });

  it('keeps snapshot creation single-flight without holding installation mutations during provider IO', async () => {
    const f = fixture();
    let answer!: (value: Awaited<ReturnType<typeof f.snapshot>>) => void, shown!: () => void;
    const prompt = new Promise<void>(resolve => { shown = resolve; });
    f.snapshot.mockImplementationOnce(() => { shown(); return new Promise(resolve => { answer = resolve; }); });
    const pending = f.share(); await prompt;
    expect(await f.share()).toEqual({ ok: false, errorCode: 'BUSY' });
    expect(f.handoff.hold).not.toHaveBeenCalled();
    answer({ name: 'source.json', bytes: Buffer.from('123') });
    expect(await pending).toMatchObject({ ok: true });
    expect(f.importCopies).toHaveBeenCalledOnce();
  });

  it('does not hand off content replaced during snapshot preparation', async () => {
    const f = fixture();
    f.snapshot.mockResolvedValueOnce({ name: 'source.json', bytes: Buffer.from('123') })
      .mockResolvedValueOnce({ name: 'source.json', bytes: Buffer.from('456') });
    expect(await f.share()).toEqual({ ok: false, errorCode: 'STALE_RESOURCE' });
    expect(f.importCopies).not.toHaveBeenCalled();
  });

  it('compensates against the original owner root and reports an uncertain receipt after publication', async () => {
    const f = fixture();
    const original = f.importCopies.getMockImplementation()!;
    f.importCopies.mockImplementation(async (...args) => { const result = await original(...args); f.changeOwner(); return result; });
    expect(await f.share()).toMatchObject({ ok: false, errorCode: 'SHARE_RESULT_UNKNOWN', targetPluginId: 'target',
      file: { name: 'source.json', size: 3, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    expect(f.handoff.delete).toHaveBeenCalledExactlyOnceWith('target', 'handoff:fixture', 'root-0');
    expect(f.copies.size).toBe(0);
  });
});
