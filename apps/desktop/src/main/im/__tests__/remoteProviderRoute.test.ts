import { beforeEach, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('../../device-link', () => ({ remoteBackgroundInvoke: invoke }));
import { readImRemoteAutomaticDefaults, readImRemotePermissionModes, readImRemoteProviderRoute } from '../remoteProviderRoute';
import { IM_DEFAULT_SETTINGS } from '../../../shared/imDefaultSettings';

const route = { agentDeviceId: 'share:owner', agentKind: 'codex' as const, providerId: 'openai', model: 'shared-model' };
const provider = {
  id: 'openai', name: 'OpenAI', agents: ['codex'], connected: true,
  remoteInvocationEnabled: true, source: 'builtin',
  models: { codex: [{ id: 'shared-model', name: 'Shared model', efforts: ['high'], defaultEffort: 'high' }] },
};
beforeEach(() => invoke.mockReset());
// PR #7291 unit: remote workspace with no model used to resolve an empty ID locally.
// Exercise its real authorized catalog read, including visibility and unavailable sharing.
it('resolves automatic defaults only from visible, authorized remote models', async () => {
  invoke.mockResolvedValue({ ok: true, result: { providers: [
    { ...provider, id: 'private', remoteInvocationEnabled: false },
    { ...provider, auth: { method: 'managed' }, models: { codex: [
      { id: 'hidden', efforts: ['high'] }, ...provider.models.codex,
    ] } },
  ], modelVisibilityOverrides: { 'codex:openai:hidden': false } } });
  const options = { agentDeviceId: 'share:owner', providerId: 'openai' };
  await expect(readImRemoteAutomaticDefaults(IM_DEFAULT_SETTINGS, options)).resolves.toMatchObject({
    agentKind: 'codex', agents: { codex: { agentDeviceId: 'share:owner', providerId: 'openai', model: 'shared-model' } },
  });
  await expect(readImRemoteAutomaticDefaults(IM_DEFAULT_SETTINGS, { ...options, providerId: 'private' })).resolves.toBeNull();
  invoke.mockResolvedValue({ ok: false, error: { message: '[REMOTE_AGENT_SHARE_REMOVED] removed' } });
  await expect(readImRemoteAutomaticDefaults(IM_DEFAULT_SETTINGS, options)).rejects.toThrow('REMOTE_AGENT_SHARE_REMOVED');
});
it('reads permission modes from the execution host', async () => {
  invoke.mockResolvedValue({ ok: true, result: { permissionModes: [{ id: 'ask' }, { id: 'auto' }] } });
  await expect(readImRemotePermissionModes('share:owner', 'pi')).resolves.toEqual(['ask', 'auto']);
  expect(invoke).toHaveBeenCalledWith('share:owner', 'maker:get-capabilities', ['pi']);
});
it('rejects missing remote permission modes instead of broadening access', async () => {
  invoke.mockResolvedValue({ ok: true, result: {} });
  await expect(readImRemotePermissionModes('share:owner', 'pi')).rejects.toThrow('Invalid remote agent permission modes');
});
it('uses the authorized sharing catalog', async () => {
  invoke.mockResolvedValue({ ok: true, result: { providers: [provider] } });
  await expect(readImRemoteProviderRoute(route)).resolves.toMatchObject({ provider: { id: 'openai' }, model: { id: 'shared-model' } });
  expect(invoke).toHaveBeenCalledWith('share:owner', 'maker:provider:list', expect.any(Array));
});
it('resolves an existing task without an explicit provider using only the authorized remote catalog', async () => {
  invoke.mockResolvedValue({ ok: true, result: { providers: [
    { ...provider, id: 'not-shared', remoteInvocationEnabled: false }, provider,
  ] } });
  await expect(readImRemoteProviderRoute({ ...route, agentDeviceId: 'remote-device', providerId: null }))
    .resolves.toMatchObject({ provider: { id: 'openai' } });
  expect(invoke).toHaveBeenCalledWith('remote-device', 'maker:provider:list', expect.any(Array));
});
it('does not replace an explicitly selected missing provider with the remote default', async () => {
  invoke.mockResolvedValue({ ok: true, result: { providers: [provider] } });
  await expect(readImRemoteProviderRoute({ ...route, providerId: 'missing' }))
    .rejects.toThrow('REMOTE_AGENT_UNAVAILABLE');
});
it('rejects an implicit route when no authorized remote provider offers the model', async () => {
  invoke.mockResolvedValue({ ok: true, result: { providers: [
    { ...provider, remoteInvocationEnabled: false },
  ] } });
  await expect(readImRemoteProviderRoute({ ...route, providerId: null }))
    .rejects.toThrow('REMOTE_AGENT_UNAVAILABLE');
});
it.each([
  { connected: false }, { suspended: true }, { remoteInvocationEnabled: false },
  { models: { codex: [{ id: 'shared-model', disabled: true }] } },
  { models: { codex: [{ id: 'shared-model', mode: 'image_generation' }] } },
])('rejects an unavailable or non-chat shared route: %j', async (patch) => {
  invoke.mockResolvedValue({ ok: true, result: { providers: [{ ...provider, ...patch }] } });
  await expect(readImRemoteProviderRoute(route)).rejects.toThrow('REMOTE_AGENT_UNAVAILABLE');
});
it('preserves the sharing failure reason', async () => {
  invoke.mockResolvedValue({ ok: false, error: { message: '[REMOTE_AGENT_SHARE_REMOVED] removed' } });
  await expect(readImRemoteProviderRoute(route)).rejects.toThrow('REMOTE_AGENT_SHARE_REMOVED');
});
