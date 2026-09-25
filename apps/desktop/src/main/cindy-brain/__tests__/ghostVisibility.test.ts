import { describe, expect, it } from 'vitest';

import type { InstalledGhost } from '../../../shared/ghost.js';
import { classifyGhostVisibility } from '../ghostVisibility.js';

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

  it('resolves a storage-part instance id when namespace is omitted', () => {
    expect(classifyGhostVisibility('_ns__acme__helper', null, deps)).toMatchObject({
      ok: true,
      ghost: { dir: '/tmp/_ns/acme/helper' },
    });
  });
});
