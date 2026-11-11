/** Integration (unit tier): real Main metadata capture + real group continuity C client and M executor.
 * Rule: a fresh, online control-off ends that target's bounded routing retention without
 *       clearing a healthy neighbour or breaking the existing bounded offline fallback.
 * Gap: continuityRouting/continuityRuntime fixtures never observe the presence control-off,
 *      while device-link presence tests do not carry an acknowledged C/M route.
 * Minimal input: one O/M acknowledged row; O is unreachable after the control-off.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_GROUP_REMOTE_CHANNEL } from '@cindy/device-link';
import { normalizeProviderGroupConfig, parseProviderGroupRemotePick } from '../../../shared/providerGroup.js';
import type { GroupContinuityGrant } from '../../../shared/providerGroupContinuity.js';
import { createGroupContinuityClient } from '../../provider-group/continuityClient.js';
import { createGroupContinuityExecutor } from '../../provider-group/continuityExecutor.js';
import {
  applyControllerPresenceDirectorySnapshot,
  createControllerPresenceFreshnessTracker,
} from '../controllerPresenceDirectory.js';
import { retireControlOffRetention } from '../controlOffRetention.js';
import {
  captureProviderMetadataContinuityScope,
  invalidateProviderMetadataContinuity,
  isTemporaryProviderMetadataFailure,
  onProviderMetadataDenied,
} from '../providerMetadataContinuity.js';

const identity = vi.hoisted(() => ({ owner: 'owner-a:1', endpoint: 'https://a.invalid', pending: false }));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => identity.owner,
  isAppSessionBoundaryPending: () => identity.pending,
}));
vi.mock('../../clientEndpointsService.js', () => ({ getClientEndpoint: () => identity.endpoint }));

beforeEach(() => { invalidateProviderMetadataContinuity(); });

function applyDirectoryRow(deviceId: string, remoteControlEnabled: boolean, platform = 'win32'): void {
  const freshness = createControllerPresenceFreshnessTracker();
  applyControllerPresenceDirectorySnapshot({
    devices: [{ deviceId, online: true, remoteControlEnabled, platform }],
    requestEpoch: freshness.epoch,
    selfDeviceId: 'C',
    freshness,
    getOnline: () => undefined,
    setOnline: () => {},
    forgetOnline: () => {},
    setPlatform: () => {},
    setName: () => {},
    shouldNotifyPeerOnline: () => false,
    onPeerBecameOnline: () => {},
    onPeerControlDisabled: retireControlOffRetention,
  });
}

function fixture() {
  const clock = { wall: 0, mono: 0, current: true, ownerReachable: true };
  let grantSequence = 0;
  const config = normalizeProviderGroupConfig({ strategy: 'least', autoSwitch: true, allowFast: false,
    members: [{ kind: 'device', agentDeviceId: 'M', providerId: 'openai' }] }, 'openai')!;
  const member = config.members.find(candidate => candidate.kind === 'device')!;
  const inspect = vi.fn(async () => ({ running: 0, fastPolicyRequired: false }));
  const bindFast = vi.fn(async () => {});
  const executor = createGroupContinuityExecutor({ capture: () => () => clock.current,
    inspect, bindFast, wall: () => clock.wall, mono: () => clock.mono });
  const livePick = vi.fn(async () => {
    if (!clock.ownerReachable) {
      throw Object.assign(new Error('[NOT_CONNECTED] owner offline'), { code: 'NOT_CONNECTED' });
    }
    const grant: GroupContinuityGrant = { id: `grant-${++grantSequence}`, group: 'openai', controller: 'C',
      providerId: 'openai', agentKind: 'codex', model: 'model', fastPolicyRequired: true,
      remainingMs: 1_800_000 };
    const ack = await executor.handle('O', { action: 'continuity-prepare', grant });
    return parseProviderGroupRemotePick({ kind: 'member', member, label: 'M',
      continuity: { ...ack, config } }, 'openai');
  });
  const invoke = vi.fn(async (target: string, channel: string, args: unknown[],
    options?: { preSend?: () => void }) => {
    options?.preSend?.();
    if (target !== 'M' || channel !== PROVIDER_GROUP_REMOTE_CHANNEL) {
      return { ok: false, error: { code: 'CHANNEL_NOT_ALLOWED', message: 'unexpected target' } };
    }
    return { ok: true as const, result: await executor.handle('C', args[0]) };
  });
  const capture = (owner: string, executorDeviceId?: string) => {
    const ownerScope = captureProviderMetadataContinuityScope(owner);
    const executorScope = executorDeviceId
      ? captureProviderMetadataContinuityScope(executorDeviceId) : () => true;
    return () => ownerScope() && executorScope();
  };
  const client = createGroupContinuityClient({ livePick, invoke, capture,
    ownerMayRespond: () => clock.ownerReachable, retryable: isTemporaryProviderMetadataFailure,
    wall: () => clock.wall, mono: () => clock.mono });
  const pick = (sessionId: string) => client.pick('O', { providerId: 'openai', agentKind: 'codex',
    model: 'model', exclude: [], allowOffline: true, sessionId });
  return { clock, config, executor, client, bindFast, invoke, livePick, pick };
}

describe('explicit control-off continuity retention', () => {
  it('does not fall back to a healthy M after O reports an online control-off', async () => {
    const f = fixture();
    await expect(f.pick('task-1')).resolves.toMatchObject({ kind: 'member', member: { agentDeviceId: 'M' } });
    expect(f.bindFast).not.toHaveBeenCalled();
    const ownerScope = captureProviderMetadataContinuityScope('O');
    const neighbourScope = captureProviderMetadataContinuityScope('N');
    applyDirectoryRow('O', false);
    expect(ownerScope()).toBe(false);
    expect(neighbourScope()).toBe(true);
    f.clock.ownerReachable = false;
    await expect(f.pick('new-task')).rejects.toThrow('owner offline');
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.bindFast).not.toHaveBeenCalled();
  });

  it('retires the executor half of an acknowledged row when M reports control-off', async () => {
    const f = fixture();
    await f.pick('task-1');
    expect(f.client.readConfig('O', 'openai')).not.toBeNull();
    applyDirectoryRow('M', false);
    expect(f.client.readConfig('O', 'openai')).toBeNull();
    f.clock.ownerReachable = false;
    await expect(f.pick('new-task')).rejects.toThrow('owner offline');
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it('retires the same target through the WebSocket presence branch seam', () => {
    const scope = captureProviderMetadataContinuityScope('O');
    retireControlOffRetention('O');
    expect(scope()).toBe(false);
  });

  it('keeps the bounded same-task fallback when O is only unreachable', async () => {
    const f = fixture();
    await f.pick('task-1');
    f.clock.ownerReachable = false;
    await expect(f.pick('new-task')).resolves.toMatchObject({ kind: 'member', member: { agentDeviceId: 'M' } });
    expect(f.invoke).toHaveBeenCalled();
    expect(f.bindFast).toHaveBeenCalledTimes(1);
  });

  it('lets fresh online enabled authority create a new context without reviving the fenced one', async () => {
    const f = fixture();
    await f.pick('task-1');
    applyDirectoryRow('O', false);
    applyDirectoryRow('O', true);
    f.clock.ownerReachable = false;
    await expect(f.pick('task-2')).rejects.toThrow('owner offline');
    f.clock.ownerReachable = true;
    await expect(f.pick('task-3')).resolves.toMatchObject({ kind: 'member', member: { agentDeviceId: 'M' } });
    // task-2 still probed the owner once before failing; the fenced row itself was not used.
    expect(f.livePick).toHaveBeenCalledTimes(3);
    f.clock.ownerReachable = false;
    await expect(f.pick('task-4')).resolves.toMatchObject({ kind: 'member', member: { agentDeviceId: 'M' } });
    expect(f.bindFast).toHaveBeenCalledTimes(1);
  });

  it('stays closed on repeated control-off observations without a deny loop', async () => {
    const f = fixture();
    await f.pick('task-1');
    const denied = vi.fn();
    const off = onProviderMetadataDenied(denied);
    try {
      applyDirectoryRow('O', false);
      applyDirectoryRow('O', false);
      f.clock.ownerReachable = false;
      await expect(f.pick('task-2')).rejects.toThrow('owner offline');
      expect(denied).not.toHaveBeenCalled();
      expect(f.invoke).not.toHaveBeenCalled();
    } finally { off(); }
  });
});
