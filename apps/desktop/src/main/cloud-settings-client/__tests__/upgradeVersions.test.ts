import { describe, expect, it } from 'vitest';
import { parseOwnedInstances, projectCloudInstance } from '../ownedInstances';
import {
  canRequestUpgrade,
  stableInstanceState,
} from '../../../renderer/features/cloud-settings/instanceState';

const image = (tag: string) => `registry.example.test:5000/runtime:${tag}@sha256:${'a'.repeat(64)}`;
function owned(current: string, latest: string | null, available = true) {
  return {
    instanceId: 'instance-a',
    deviceId: 'cloud-a',
    customLabel: null,
    nameSequence: 1,
    status: {
      instanceId: 'instance-a',
      deviceId: 'cloud-a',
      desiredState: 'running',
      runtimeState: 'running',
      readiness: { ready: true },
      image: image(current),
      updateAvailable: false,
      latestReleaseTag: '0.1.108',
      upgrade: { state: 'idle' },
    },
    maintenanceUpgrade: {
      instanceId: 'instance-a',
      currentImage: image(current),
      latestReleaseTag: latest,
      updateAvailable: available,
      manualUpgrade: true,
      operation: null,
    },
  };
}
const project = (value: unknown) => {
  const owned = parseOwnedInstances({ instances: [value] });
  return projectCloudInstance(owned[0]!, owned);
};
describe('native dual-version projection from CIS qualified releases', () => {
  it.each([
    ['0.1.108-cloud.2-cn-amd64', '0.1.108-cloud.10-cn-amd64'],
    ['0.1.108-cloud.99-cn-amd64', '0.1.109-cloud.1-cn-amd64'],
    ['0.1.108-custom.1', '0.1.108-cloud.2-cn-amd64'],
    ['0.1.108-cloud.2-global-arm64', '0.1.109-cloud.1-global-arm64'],
  ])('preserves %s → %s without truncating cloud or platform information', (current, latest) => {
    const view = project(owned(current, latest));
    expect(view).toMatchObject({
      version: current,
      latestVersion: latest,
      updateAvailable: true,
      manualUpgrade: true,
    });
    expect(canRequestUpgrade(view)).toBe(true);
    expect(JSON.stringify(view)).not.toContain('registry.example');
    expect(JSON.stringify(view)).not.toContain('currentImage');
  });
  it('does not reinterpret cached registry status as a qualified update', () => {
    const raw = owned('0.1.108-cloud.10-cn-amd64', null, false);
    raw.status.updateAvailable = true;
    raw.status.latestReleaseTag = '0.1.109-cloud.1-cn-amd64';
    expect(project(raw)).toMatchObject({ updateAvailable: false, latestVersion: null });
    expect(canRequestUpgrade(project(raw))).toBe(false);
  });
  it('older CIS retains version display but cannot offer a manual upgrade', () => {
    const raw: Partial<ReturnType<typeof owned>> & Omit<ReturnType<typeof owned>, 'maintenanceUpgrade'> = owned('0.1.108', '0.1.109');
    delete raw.maintenanceUpgrade;
    raw.status.updateAvailable = true;
    const view = project(raw);
    expect(view.version).toBe('0.1.108');
    expect(view.manualUpgrade).toBeUndefined();
    expect(canRequestUpgrade(view)).toBe(false);
  });
  it('rejects an upgrade projection for another instance', () => {
    const raw = owned('0.1.108', null);
    raw.maintenanceUpgrade.instanceId = 'other';
    expect(() => project(raw)).toThrow('INVALID_RESPONSE');
  });
  it.each(['requested', 'backup-running', 'recovery-hold'])(
    'restores durable %s state after reopening',
    (phase) => {
      const raw = owned('0.1.108-cloud.2-cn-amd64', '0.1.108-cloud.3-cn-amd64');
      const view = project({
        ...raw,
        maintenanceUpgrade: {
          ...raw.maintenanceUpgrade,
          operation: { operationId: 'user-example', phase, active: true, updatedAtMs: 100 },
        },
      });
      expect(view.upgradeOperation?.phase).toBe(phase);
      expect(canRequestUpgrade(view)).toBe(false);
      expect(stableInstanceState(view)).toBe(false);
    },
  );
  it('waits for resource refresh to be observed even after its template is applied', () => {
    const raw = owned('0.1.108-cloud.2-cn-amd64', '0.1.108-cloud.3-cn-amd64');
    expect(
      canRequestUpgrade(
        project({
          ...raw,
          resourceChange: { phase: 'applied' },
          status: { ...raw.status, updatedAtMs: 200, observedAtMs: 100 },
        }),
      ),
    ).toBe(false);
  });
});
