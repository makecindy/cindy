import { describe, expect, it } from 'vitest';

import type { InstalledGhost } from '../../../shared/ghost.js';
import { classifyGhostVisibility, classifyInstalledGhostVisibility } from '../ghostVisibility.js';

function ghost(id: string, namespace?: string | null, enabled = true): InstalledGhost {
  return {
    manifest: { schemaVersion: 2, id, name: id, version: '1.0.0', kind: 'chip', entry: 'index.js', slots: [] },
    dir: namespace ? `/tmp/_ns/${namespace}/${id}` : `/tmp/${id}`,
    enabled,
    approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
    ...(namespace !== undefined ? { namespace } : {}),
  } as InstalledGhost;
}

describe('classifyGhostVisibility namespace', () => {
  const root = ghost('helper', null);
  const enterprise = ghost('helper', 'acme');
  const deps = {
    listGhosts: () => [root, enterprise],
    isAvailableForActiveSession: () => true,
    isDisabledForWorkdir: () => false,
  };

  it('returns GHOST_AMBIGUOUS when the same ghostId has two instances and namespace is omitted', () => {
    const result = classifyGhostVisibility('helper', null, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe('GHOST_AMBIGUOUS');
    expect(result.candidates).toEqual([
      { ghostId: 'helper', namespace: null },
      { ghostId: 'helper', namespace: 'acme' },
    ]);
  });

  it('selects the requested namespace when provided', () => {
    expect(classifyGhostVisibility('helper', null, deps, 'acme')).toMatchObject({
      ok: true,
      ghost: { dir: '/tmp/_ns/acme/helper' },
    });
    expect(classifyGhostVisibility('helper', null, deps, null)).toMatchObject({
      ok: true,
      ghost: { dir: '/tmp/helper' },
    });
  });

  it.each([
    { installed: root, requested: 'null', target: { ghost_id: 'helper', namespace: null } },
    { installed: enterprise, requested: null, target: { ghost_id: 'helper', namespace: 'acme' } },
  ])('reports an installed identity instead of absence for namespace $requested', ({ installed, requested, target }) => {
    const result = classifyGhostVisibility('helper', null, { ...deps, listGhosts: () => [installed] }, requested);
    expect(result).toMatchObject({ ok: false, errorCode: 'GHOST_NAMESPACE_MISMATCH' });
    if (result.ok) return;
    expect(result.message).toContain(JSON.stringify(target));
    expect(result.message).toContain('JSON null');
  });

  // PR #6434: an explicit wrong address must not disclose an unavailable owner's
  // identities. Existing namespace cases only exercised available installations.
  it.each([null, 'null'])('hides unavailable identities for namespace %s', (namespace) => {
    const unavailableDeps = {
      ...deps,
      listGhosts: () => [enterprise],
      isAvailableForActiveSession: () => false,
    };
    const result = classifyGhostVisibility('helper', null, unavailableDeps, namespace);
    expect(result).toEqual(classifyGhostVisibility('missing', null, unavailableDeps, namespace));
    expect(result).toMatchObject({ ok: false, errorCode: 'GHOST_NOT_FOUND' });
    expect(JSON.stringify(result)).not.toContain('acme');
  });

  it('only includes active-session identities in namespace mismatch guidance', () => {
    const result = classifyGhostVisibility('helper', null, {
      ...deps,
      isAvailableForActiveSession: (id) => id === 'helper',
    }, 'wrong');
    expect(result).toMatchObject({ ok: false, errorCode: 'GHOST_NAMESPACE_MISMATCH' });
    if (result.ok) return;
    expect(result.message).toContain('{"ghost_id":"helper","namespace":null}');
    expect(result.message).not.toContain('acme');
  });

  it('keeps the literal organization slug null distinct from JSON null', () => {
    const namedNull = ghost('helper', 'null');
    const stageDeps = { ...deps, listGhosts: () => [root, namedNull] };
    expect(classifyGhostVisibility('helper', null, stageDeps, 'null')).toMatchObject({ ok: true, ghost: namedNull });
    expect(classifyGhostVisibility('helper', null, stageDeps, null)).toMatchObject({ ok: true, ghost: root });
    expect(classifyGhostVisibility('missing', null, stageDeps, 'null')).toMatchObject({
      ok: false, errorCode: 'GHOST_NOT_FOUND',
    });
  });

  it('checks workdir disable against the physical storage part', () => {
    const org = ghost('helper', 'acme');
    const inPlace = { ...ghost('xd-feishu', 'xd'), dir: '/tmp/xd-feishu' };
    const disabled = new Set(['_ns__acme__helper', 'xd-feishu']);
    const workdirDeps = {
      listGhosts: () => [org, inPlace],
      isAvailableForActiveSession: () => true,
      isDisabledForWorkdir: (id: string) => disabled.has(id),
    };
    expect(classifyGhostVisibility('helper', '/proj', workdirDeps, 'acme')).toMatchObject({
      ok: false,
      errorCode: 'GHOST_DISABLED_IN_WORKDIR',
    });
    expect(classifyGhostVisibility('xd-feishu', '/proj', workdirDeps, 'xd')).toMatchObject({
      ok: false,
      errorCode: 'GHOST_DISABLED_IN_WORKDIR',
    });
  });

  it('addresses a pending legacy candidate when namespace null is retried', () => {
    const pending = { ...ghost('helper'), namespaceState: 'pending' as const };
    const stageDeps = { ...deps, listGhosts: () => [pending, enterprise] };
    expect(classifyGhostVisibility('helper', null, stageDeps)).toMatchObject({
      ok: false,
      errorCode: 'GHOST_AMBIGUOUS',
      candidates: [
        { ghostId: 'helper', namespace: null },
        { ghostId: 'helper', namespace: 'acme' },
      ],
    });
    expect(classifyGhostVisibility('helper', null, stageDeps, null)).toMatchObject({
      ok: true,
      ghost: pending,
    });
  });

  it('resolves a unique pending install only when namespace is omitted', () => {
    const pending = { ...ghost('xd-feishu'), namespaceState: 'pending' as const };
    const stageDeps = { ...deps, listGhosts: () => [pending] };
    expect(classifyGhostVisibility('xd-feishu', null, stageDeps)).toMatchObject({ ok: true, ghost: pending });
    expect(classifyGhostVisibility('xd-feishu', null, stageDeps, null)).toMatchObject({
      ok: false, errorCode: 'GHOST_NAMESPACE_MISMATCH',
    });
    const result = classifyGhostVisibility('xd-feishu', null, stageDeps, null);
    if (result.ok) return;
    expect(result.message).toContain('{"ghost_id":"xd-feishu"}');
  });


  it('resolves local mivo-canvas and enterprise xd-mivo-canvas as different plugins', () => {
    const local = ghost('mivo-canvas', null);
    const enterprise = ghost('xd-mivo-canvas', 'xd');
    const stageDeps = { ...deps, listGhosts: () => [local, enterprise] };
    expect(classifyGhostVisibility('mivo-canvas', null, stageDeps)).toMatchObject({
      ok: true,
      ghost: { dir: '/tmp/mivo-canvas' },
    });
    expect(classifyGhostVisibility('xd-mivo-canvas', null, stageDeps)).toMatchObject({
      ok: true,
      ghost: { dir: '/tmp/_ns/xd/xd-mivo-canvas' },
    });
  });

  it('resolves a storage-part instance id when namespace is omitted', () => {
    expect(classifyGhostVisibility('_ns__acme__helper', null, deps)).toMatchObject({
      ok: true,
      ghost: { dir: '/tmp/_ns/acme/helper' },
    });
  });

  it.each(['pending', 'root', 'in-place', 'canonical', 'coexist'] as const)(
    'revalidates the selected physical instance in %s without erasing delivery state', (stage) => {
      const selected = stage === 'pending'
        ? { ...ghost('helper'), namespaceState: 'pending' as const }
        : stage === 'root' ? root
        : stage === 'in-place' ? { ...enterprise, dir: root.dir } : enterprise;
      const others = stage === 'coexist' ? [root] : [];
      const stageDeps = { ...deps, listGhosts: () => [selected, ...others] };
      expect(classifyInstalledGhostVisibility(selected, null, stageDeps)).toMatchObject({ ok: true, ghost: selected });
      const replacement = { ...selected, namespace: selected.namespace === null ? 'acme' : null };
      expect(classifyInstalledGhostVisibility(selected, null, { ...stageDeps, listGhosts: () => [replacement] }))
        .toMatchObject({ ok: false, errorCode: 'GHOST_NOT_FOUND' });
    },
  );
});
