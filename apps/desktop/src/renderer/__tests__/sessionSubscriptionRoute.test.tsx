// @vitest-environment jsdom
// Unit: a created subscription provider must read its task binding, never the default pool.
import { act, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { SessionSubscriptionAccountProvider, useSessionSubscriptionAccount, sessionSubscriptionPoolProvider } from '../components/new-chat/SessionSubscriptionAccount';
import type { ProviderView } from '@cindy/model-providers';
vi.mock('@/contexts/AuthContext', () => ({ useOptionalDataOwnerGeneration: () => 0 }));
vi.mock('@/hooks/useWindowVisible', () => ({ useDocumentVisible: () => false }));
vi.mock('@/features/device-link/useDeviceLinkReconnectEpoch', () => ({ useDeviceLinkReconnectEpoch: () => 0 }));
const invoke = vi.fn();
beforeEach(() => {
  invoke.mockReset();
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { deviceLink: { invoke } } });
});
function Probe() {
  const own = useSessionSubscriptionAccount('openai-sub-own', 'peer');
  const other = useSessionSubscriptionAccount('openai', 'peer');
  return <div>{JSON.stringify({ own, other })}</div>;
}
it.each([true, false])('requires the host to confirm the independent route (confirmed=%s)', async confirmed => {
  invoke.mockResolvedValue({ providerId: 'openai', state: 'bound', ...(confirmed ? { routeProviderId: 'openai-sub-own' } : {}),
    account: { isDefault: false, number: 1, identity: 'right@example.test', paused: false, status: 'ready' } });
  render(<SessionSubscriptionAccountProvider providerId="openai" routeProviderId="openai-sub-own" deviceId="peer"
    sessionId={'task-' + confirmed} nativeSessionId="native"><Probe /></SessionSubscriptionAccountProvider>);
  await act(async () => {});
  expect(invoke).toHaveBeenCalledExactlyOnceWith('peer', 'maker:subscription-accounts', [{ action: 'session', providerId: 'openai', routeProviderId: 'openai-sub-own', sessionId: 'task-' + confirmed, nativeSessionId: 'native' }]);
  const output = screen.getByText(/"other":null/).textContent!;
  expect(output).toContain(confirmed ? 'right@example.test' : 'loading');
  if (!confirmed) expect(output).not.toContain('right@example.test');
});
it('uses pool metadata for independent sources, never another catalog entry or SSH', () => {
  const provider = { id: 'openai-sub-own', subscriptionAccountPool: 'openai' } as ProviderView;
  expect(sessionSubscriptionPoolProvider('codex', provider.id, null, provider)).toBe('openai');
  expect(sessionSubscriptionPoolProvider('codex', 'different', null, provider)).toBeNull();
  expect(sessionSubscriptionPoolProvider('codex', provider.id, 'ssh', provider)).toBeNull();
});
