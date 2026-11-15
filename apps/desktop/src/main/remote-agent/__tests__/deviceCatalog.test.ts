/**
 * 运行 Agent 的另一台电脑的模型目录：经设备互联读取，只做最小校验。
 */
import { CONTROLLER_CAPABILITY_PROVIDER_LOGO_KINDS_V2 } from '@cindy/device-link';
import { describe, expect, it, vi } from 'vitest';

import { parseDeviceProviderViews, readDeviceProviderViews, readRemoteProviderRoute } from '../controller/deviceCatalog';

const deviceLink = vi.hoisted(() => ({ remoteBackgroundInvoke: vi.fn() }));
vi.mock('../../device-link', () => deviceLink);

const provider = (overrides: Record<string, unknown> = {}) => ({
  id: 'spark',
  name: 'Spark',
  agents: ['claude-code', 'pi'],
  connected: true,
  models: { pi: [{ id: 'spark/qwen', name: 'Qwen' }, { id: '' }, { name: 'no id' }] },
  ...overrides,
});

describe('parseDeviceProviderViews', () => {
  it('keeps valid providers, drops models without an id and fills defaults', () => {
    const [view] = parseDeviceProviderViews({ providers: [provider()] });
    expect(view.models.pi).toEqual([{ id: 'spark/qwen', name: 'Qwen', efforts: [], defaultEffort: null }]);
    expect(view.routing).toEqual({ 'claude-code': {}, pi: {} });
  });

  it('keeps routing the other computer sent and the model tuning it reported', () => {
    const [view] = parseDeviceProviderViews({ providers: [provider({
      routing: { pi: { kind: 'native' } },
      models: { pi: [{ id: 'm', name: 'M', efforts: ['low'], defaultEffort: 'low' }] },
    })] });
    expect(view.routing).toEqual({ pi: { kind: 'native' }, 'claude-code': {} });
    expect(view.models.pi?.[0]).toMatchObject({ efforts: ['low'], defaultEffort: 'low' });
  });

  it('skips malformed providers instead of failing the whole list', () => {
    expect(parseDeviceProviderViews({ providers: [
      provider({ id: '' }),
      provider({ agents: 'pi' }),
      provider({ connected: 'yes' }),
      provider({ models: { pi: 'nope' } }),
      null,
      provider({ id: 'ok' }),
    ] }).map((view) => view.id)).toEqual(['ok']);
  });

  it('rejects responses that are not a provider list', () => {
    expect(() => parseDeviceProviderViews(null)).toThrow(/Invalid provider list/);
    expect(() => parseDeviceProviderViews({ providers: {} })).toThrow(/Invalid provider list/);
  });
});

describe('readDeviceProviderViews', () => {
  it('asks the other computer for its provider list with the controller capabilities', async () => {
    const invoke = vi.fn(async () => ({ ok: true, result: { providers: [provider({ remoteInvocationEnabled: true })] } }));
    expect((await readDeviceProviderViews(invoke, 'device-b')).map((view) => view.id)).toEqual(['spark']);
    expect(invoke).toHaveBeenCalledWith('device-b', 'maker:provider:list', [
      { capabilities: [CONTROLLER_CAPABILITY_PROVIDER_LOGO_KINDS_V2] },
    ]);
  });

  it('keeps only the providers that computer allows for remote use', async () => {
    const invoke = vi.fn(async () => ({ ok: true, result: { providers: [
      provider({ id: 'shared', remoteInvocationEnabled: true }),
      provider({ id: 'private', remoteInvocationEnabled: false }),
      provider({ id: 'legacy' }),
    ] } }));
    expect((await readDeviceProviderViews(invoke, 'device-b')).map((view) => view.id)).toEqual(['shared']);
  });

  it('keeps the error code when the other computer cannot answer', async () => {
    const invoke = vi.fn(async () => ({ ok: false, error: { code: 'DEVICE_OFFLINE', message: 'offline' } }));
    await expect(readDeviceProviderViews(invoke, 'device-b')).rejects.toMatchObject({ message: 'offline', code: 'DEVICE_OFFLINE' });
  });

  // provider-sharing.md §5.1 / provider-groups.md §6 (2026-11-02): a directly chosen shared group is judged by the
  // group, so Worker and plugin catalogs built on this read keep it. A guest's own group keeps the member's raw state
  // because a group-assigned task runs on that computer directly and would fail on its signed-out copy.
  it.each([
    ['share:s1', {}, true],
    ['share:s1', { groupMember: true }, false],
    ['device-b', {}, false],
  ] as const)('reads a signed-out group on %s %o (connected=%s)', async (deviceId, options, connected) => {
    const invoke = vi.fn(async () => ({ ok: true, result: { providers: [
      provider({ remoteInvocationEnabled: true, connected: false, groupSize: 3 }),
    ] } }));
    const [view] = await readDeviceProviderViews(invoke, deviceId, options);
    expect(view).toMatchObject({ id: 'spark', connected });
  });

  it.each([
    ['share:s1', { groupSize: 3 }, true],
    ['share:s1', {}, false],
    ['device-b', { groupSize: 3 }, false],
  ] as const)('checks a signed-out route on %s %o (accepted=%s)', async (agentDeviceId, extra, accepted) => {
    deviceLink.remoteBackgroundInvoke.mockResolvedValueOnce({ ok: true, result: { providers: [
      provider({ remoteInvocationEnabled: true, connected: false, ...extra }),
    ] } });
    const route = readRemoteProviderRoute({ agentDeviceId, agentKind: 'pi', providerId: 'spark', model: 'spark/qwen' });
    if (accepted) await expect(route).resolves.toMatchObject({ provider: { id: 'spark' }, model: { id: 'spark/qwen' } });
    else await expect(route).rejects.toThrow('REMOTE_AGENT_UNAVAILABLE');
  });
});
