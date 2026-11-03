// Unit regression: Forge used the current organization and silently installed
// an enabled duplicate instead of updating an existing root instance.
import { expect, it } from 'vitest';
import type { InstalledGhost } from '../../../shared/ghost.js';
import {
  resolveForgeInstallTarget,
} from '../ghostInstallTarget.js';
const ghost = (namespace: string | null, instanceKey: string) =>
  ({
    manifest: { id: 'mail-test', name: 'Mail', version: '1.0.0' },
    namespace,
    instanceKey,
    enabled: true,
  }) as InstalledGhost;
it('defaults to a local copy without updating market instances after an organization login', () => {
  const root = ghost(null, '_root__mail-test');
  expect(resolveForgeInstallTarget([root], 'mail-test', 'team', {})).toEqual({
    namespace: 'local',
  });
  expect(
    resolveForgeInstallTarget(
      [root, ghost('team', '_ns__team__mail-test')],
      'mail-test',
      'team',
      {},
    ),
  ).toEqual({ namespace: 'local' });
  expect(
    resolveForgeInstallTarget([root], 'mail-test', 'team', { targetInstanceId: root.instanceKey }),
  ).toEqual({ namespace: null, installed: root });
  expect(
    resolveForgeInstallTarget([root], 'mail-test', 'team', {
      installCopy: true,
      namespace: 'team',
    }),
  ).toEqual({
    namespace: 'team',
  });
  expect(root.enabled).toBe(true);
});
it('retains normal installs and updates while rejecting stale, ambiguous or foreign targets', () => {
  const root = ghost(null, '_root__mail-test'),
    team = ghost('team', '_ns__team__mail-test'),
    foreign = ghost('other', '_ns__other__mail-test');
  expect(resolveForgeInstallTarget([], 'mail-test', 'team', {})).toEqual({ namespace: 'local' });
  expect(resolveForgeInstallTarget([], 'mail-test', 'team', { namespace: 'team' })).toEqual({
    namespace: 'team',
  });
  expect(resolveForgeInstallTarget([foreign], 'mail-test', 'team', {})).toEqual({ namespace: 'local' });
  expect(resolveForgeInstallTarget([team], 'mail-test', 'team', {})).toEqual({
    namespace: 'local',
  });
  for (const options of [
    { targetInstanceId: foreign.instanceKey },
    { targetInstanceId: 'mail-test' },
    { namespace: 'other' },
    { targetInstanceId: root.instanceKey, namespace: 'team' },
    { targetInstanceId: team.instanceKey, installCopy: true },
  ])
    expect(() =>
      resolveForgeInstallTarget([root, team, foreign], 'mail-test', 'team', options),
    ).toThrow();
});

it('updates the same local instance and permits an explicit current-enterprise self-test', () => {
  const local = ghost('local', '_ns__local__mail-test');
  const team = ghost('team', '_ns__team__mail-test');
  expect(resolveForgeInstallTarget([local, team], 'mail-test', 'team', {})).toEqual({ namespace: 'local', installed: local });
  expect(resolveForgeInstallTarget([local, team], 'mail-test', 'team', { namespace: 'team' }))
    .toEqual({ namespace: 'team', installed: team });
  expect(() => resolveForgeInstallTarget([local], 'mail-test', 'team', { installCopy: true })).toThrow();
});
