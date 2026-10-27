import { describe, expect, it } from 'vitest';
import {
  validateGhostManifest,
  validateNormalizedGhostManifest,
  hasGhostHarnessPermission,
  ghostPermissionItems,
  type InstalledGhost,
} from '../ghost.js';
import { evaluateGhostInstallConsent } from '../ghostInstallConsent.js';

function fixture() {
  const validation = validateGhostManifest({
    schemaVersion: 3,
    minCindyVersion: '0.1.0',
    id: 'runtime-observer',
    name: 'Runtime observer',
    version: '1.0.0',
    entry: 'main.js',
    harness: { read: ['runtime'], events: ['tool'], future: true },
  });
  if (!validation.ok) throw new Error(validation.reason);
  return {
    manifest: validation.manifest,
    dir: '/unused',
    enabled: true,
    approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
  } as InstalledGhost;
}

describe('explicit Harness authorization', () => {
  it.each([null, 7, ['future'], { hooks: 'future' }, { hooks: ['permission.request'] }, { hooks: ['tool.before'] }, { hooks: ['compaction.before'] }])(
    'retains historical unknown data without disabling the entire install or granting access',
    (harness) => {
      const raw = {
        schemaVersion: 3,
        minCindyVersion: '0.1.0',
        id: 'runtime-observer',
        name: 'Runtime observer',
        version: '1.0.0',
        entry: 'main.js',
        harness,
      };
      expect(validateGhostManifest(raw).ok).toBe(false);
      const legacy = validateNormalizedGhostManifest(raw);
      expect(legacy).toMatchObject({ ok: true, manifest: { harness } });
      if (!legacy.ok) return;
      const ghost = { ...fixture(), manifest: legacy.manifest };
      expect(hasGhostHarnessPermission(ghost, 'hooks', 'permission.request')).toBe(false);
      expect(() => ghostPermissionItems(legacy.manifest)).not.toThrow();
      expect(() => evaluateGhostInstallConsent(ghost, fixture().manifest)).not.toThrow();
    },
  );

  it('does not grant a previously unknown preserved field and keeps the old Plugin enabled', () => {
    const ghost = fixture();
    expect(hasGhostHarnessPermission(ghost, 'read', 'runtime')).toBe(false);
    expect(ghost.enabled).toBe(true);
    expect(evaluateGhostInstallConsent(ghost, ghost.manifest)).toMatchObject({
      kind: 'update',
      added: [{ key: 'harness:read:runtime' }, { key: 'harness:events:tool' }],
    });
  });

  it('only approves named capabilities and detects newly recognized permissions', () => {
    const ghost = fixture();
    ghost.harnessCapabilityApproved = ['harness:read:runtime'];
    expect(hasGhostHarnessPermission(ghost, 'read', 'runtime')).toBe(true);
    expect(hasGhostHarnessPermission(ghost, 'events', 'tool')).toBe(false);
    expect(evaluateGhostInstallConsent(ghost, ghost.manifest)).toMatchObject({
      added: [{ key: 'harness:events:tool' }],
    });
    ghost.harnessCapabilityApproved.push('harness:events:tool');
    expect(evaluateGhostInstallConsent(ghost, ghost.manifest)).toBeNull();
    ghost.enabled = false;
    expect(hasGhostHarnessPermission(ghost, 'read', 'runtime')).toBe(false);
  });

  it('does not project unknown names as permissions', () => {
    const ghost = fixture();
    ghost.manifest.harness!.read!.push('future.state');
    expect(
      ghostPermissionItems(ghost.manifest).some((item) => item.key.includes('future.state')),
    ).toBe(false);
  });

  it('keeps newly recognized content and control declarations unapproved on an existing install', () => {
    const ghost = fixture();
    ghost.manifest.harness!.read!.push('messages', 'tool-content');
    ghost.manifest.harness!.actions = ['context.compact', 'turn.interrupt'];
    ghost.harnessCapabilityApproved = ['harness:read:runtime'];
    expect(hasGhostHarnessPermission(ghost, 'read', 'messages')).toBe(false);
    expect(hasGhostHarnessPermission(ghost, 'read', 'tool-content')).toBe(false);
    expect(hasGhostHarnessPermission(ghost, 'actions', 'turn.interrupt')).toBe(false);
    expect(ghostPermissionItems(ghost.manifest).find(item => item.key === 'harness:read:messages'))
      .toMatchObject({ labelKey: 'harnessMessages', detailKey: 'harnessMessagesDetail' });
    expect(ghost.enabled).toBe(true);
  });
});
