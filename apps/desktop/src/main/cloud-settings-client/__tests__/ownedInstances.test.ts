import { describe, expect, it } from 'vitest';
import { ownedInstanceOrdinal, parseOwnedInstances, projectOwnedInstances } from '../ownedInstances';

function owned(key: string, nameSequence: number, desiredState = 'running') {
  const ids = { instanceId: `instance-${key}`, deviceId: `cloud-device-${key.repeat(24)}` };
  return {
    ...ids,
    customLabel: null,
    nameSequence,
    status: {
      ...ids,
      desiredState,
      runtimeState: 'running',
      image: 'registry.example.test/cloud:0.1.126',
      readiness: { ready: true },
      updateAvailable: false,
      latestReleaseTag: null,
      upgrade: { state: 'idle' },
    },
  };
}

describe('default-name ordinal among the owner’s current instances', () => {
  it('gives a sole instance no number, however many instances were claimed before', () => {
    const [view] = projectOwnedInstances({ instances: [owned('a', 15)] });
    expect(view).toMatchObject({ nameSequence: 15, ordinal: null });
  });

  it('numbers current instances by claim order and closes gaps left by deletions', () => {
    const views = projectOwnedInstances({
      instances: [owned('b', 15), owned('c', 9, 'deleted'), owned('a', 3)],
    });
    expect(views.map((v) => [v.instanceId, v.ordinal])).toEqual([
      ['instance-b', 2],
      ['instance-a', 1],
    ]);
  });

  it('ignores deleted records when the raw list still carries them', () => {
    const raw = [owned('a', 3), owned('b', 15, 'deleted')];
    const target = parseOwnedInstances({ instances: raw })[0]!;
    expect(ownedInstanceOrdinal(raw as never, target)).toBeNull();
  });
});
