/** Unit: production directory reader with device-link responses, no accounts or network.
 * Protects the missing remote/share choices, model access and account-switch fence. */
import { afterEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ devices: [] as unknown[], shares: [] as unknown[], invoke: vi.fn(), api: vi.fn() }));
vi.mock('../../device-link/index.js', () => ({ deviceLinkApiBase: 'https://example.invalid', remoteBackgroundInvoke: mock.invoke }));
vi.mock('../../device-link/providerShareGuest.js', () => ({ getReceivedShares: () => mock.shares }));
vi.mock('../../device-link/settings-store.js', () => ({ readDeviceLinkSettings: () => ({ disabledControlDeviceIds: ['disabled'], lastKnownDeviceNames: {} }) }));
vi.mock('../../device-link/deviceLinkApi.js', () => ({ deviceLinkApiFetch: mock.api }));
vi.mock('../../i18n.js', () => ({ t: () => '来自 {{name}} 的分享' }));
import { remoteLocalAgentModels } from '../remoteCatalog.js';
import { LOCAL_AGENT_ROUTE, type LocalAgentModel } from '../catalog.js';
import { normalizeProviderGroupConfig } from '../../../shared/providerGroup.js';

const provider = { id: 'openai', name: 'OpenAI', source: 'user', connected: true, agents: ['pi', 'codex'],
  remoteInvocationEnabled: true, models: { pi: [{ id: 'm', name: 'M', efforts: [] }], codex: [{ id: 'm', name: 'M', efforts: [] }] } };
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); mock.devices = []; mock.shares = []; });
function setup() {
  mock.devices = ['self', 'device', 'disabled', 'offline'].map(deviceId => ({ deviceId, name: deviceId, isSelf: deviceId === 'self', online: deviceId !== 'offline', remoteControlEnabled: true }));
  mock.shares = ['active', 'paused'].map(status => ({ status, shareId: status, providerId: 'openai', owner: { displayName: 'LiZi' } }));
  mock.api.mockImplementation(async () => ({ devices: mock.devices }));
  mock.invoke.mockImplementation(async (_device, channel) => ({ ok: true, result: channel === 'maker:list-available-agents' ? ['pi'] : { providers: [provider, { ...provider, id: 'private', remoteInvocationEnabled: false }] } }));
}
describe('application remote catalog', () => {
  // PR #7697: /models must use the same group projection as the model picker.
  // One online group hides a device/share member; losing the owner exposes them.
  it('collapses online group members and restores them when their group is unavailable', async () => {
    setup();
    mock.devices.push({ deviceId: 'member', name: 'member', online: true, remoteControlEnabled: true });
    const group = { strategy: 'least', autoSwitch: true, members: [
      { kind: 'local' }, { kind: 'device', agentDeviceId: 'member', providerId: 'openai' },
      { kind: 'share', agentDeviceId: 'share:active', providerId: 'openai' },
    ] };
    const invoke = mock.invoke.getMockImplementation()!;
    mock.invoke.mockImplementation((device, channel, ...args) => device === 'device' && channel !== 'maker:list-available-agents'
      ? Promise.resolve({ ok: true, result: { providers: [{ ...provider, group }] } }) : invoke(device, channel, ...args));
    expect((await remoteLocalAgentModels(() => true)).map(m => m[LOCAL_AGENT_ROUTE]?.deviceId)).toEqual(['device']);
    mock.devices = mock.devices.filter(device => (device as { deviceId: string }).deviceId !== 'device');
    expect((await remoteLocalAgentModels(() => true)).map(m => m[LOCAL_AGENT_ROUTE]?.deviceId)).toEqual(['member', 'share:active']);
    const local = normalizeProviderGroupConfig(group, 'openai')!;
    const localModels: LocalAgentModel[] = [{ id: 'local', label: 'Local', provider: 'openai',
      engine: 'pi', model: 'm', efforts: [], images: false, isDefault: true }];
    expect(await remoteLocalAgentModels(() => true, { openai: local }, localModels)).toEqual([]);
  });
  // PR #7697 / 4401270755: a configured group is not necessarily a usable
  // /models entry. Existing tests only covered a reachable local group.
  // Unit: missing local connection, runtime, or model must retain remote choices.
  it.each(['disconnected', 'engine-missing', 'model-missing', 'available'] as const)(
    'only hides members represented by an available local choice (%s)', async state => {
      setup();
      const group = normalizeProviderGroupConfig({ strategy: 'least', autoSwitch: true,
        members: [{ kind: 'local' }, { kind: 'device', agentDeviceId: 'device', providerId: 'openai' },
          { kind: 'share', agentDeviceId: 'share:active', providerId: 'openai' }] }, 'openai')!;
      const localModels: LocalAgentModel[] = state === 'disconnected' ? [] : [{
        id: 'local', label: 'Local', provider: 'openai', engine: state === 'engine-missing' ? 'codex' : 'pi',
        model: state === 'model-missing' ? 'other' : 'm', efforts: [], images: false, isDefault: true,
      }];
      const models = await remoteLocalAgentModels(() => true, { openai: group }, localModels);
      expect(models.map(model => model[LOCAL_AGENT_ROUTE]?.deviceId)).toEqual(
        state === 'available' ? [] : ['device', 'share:active']);
    });
  it('uses remote runtime availability and keeps device/share identities and source names', async () => {
    setup();
    const models = await remoteLocalAgentModels(() => true);
    expect(models.map(m => m.providerLabel)).toEqual(['OpenAI · device', 'OpenAI · 来自 LiZi 的分享']);
    expect(models.map(m => m[LOCAL_AGENT_ROUTE])).toEqual([{ deviceId: 'device', providerId: 'openai' }, { deviceId: 'share:active', providerId: 'openai' }]);
    expect(models.every(m => m.engine === 'pi')).toBe(true);
    expect(new Set(mock.invoke.mock.calls.map(args => args[0]))).toEqual(new Set(['device', 'share:active']));
  });
  it('drops one unavailable peer without dropping healthy suppliers', async () => {
    setup();
    const invoke = mock.invoke.getMockImplementation()!;
    mock.invoke.mockImplementation((device, ...args) => device === 'device' ? Promise.reject(new Error('offline')) : invoke(device, ...args));
    expect((await remoteLocalAgentModels(() => true)).map(m => m.providerLabel)).toEqual(['OpenAI · 来自 LiZi 的分享']);
  });
  it('discards a directory response after an account change before contacting its peers', async () => {
    setup();
    expect(await remoteLocalAgentModels(() => false)).toEqual([]);
    expect(mock.invoke).not.toHaveBeenCalled();
  });
  it('bounds a sleeping peer without real-time sleeps', async () => {
    setup(); vi.useFakeTimers();
    mock.invoke.mockImplementation(() => new Promise(() => {}));
    const reading = remoteLocalAgentModels(() => true);
    await vi.advanceTimersByTimeAsync(6000);
    expect(await reading).toEqual([]);
  });
});
