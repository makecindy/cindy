// @vitest-environment jsdom
// Unit: a created subscription provider must read its task binding, never the default pool.
import { act, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { SessionSubscriptionAccountProvider, useSessionSubscriptionAccount, sessionSubscriptionPoolProvider } from '../components/new-chat/SessionSubscriptionAccount';
import { getDataOwnerGeneration, setDataOwnerGeneration } from '../contexts/dataOwnerGeneration';
import type { ProviderView } from '@cindy/model-providers';
vi.mock('@/contexts/AuthContext', () => ({ useOptionalDataOwnerGeneration: () => getDataOwnerGeneration() }));
vi.mock('@/hooks/useWindowVisible', () => ({ useDocumentVisible: () => false }));
const connection = vi.hoisted(() => ({ epoch: 0 }));
vi.mock('@/features/device-link/useDeviceLinkReconnectEpoch', () => ({ useDeviceLinkReconnectEpoch: () => connection.epoch }));
const invoke = vi.fn();
beforeEach(() => {
  invoke.mockReset();
  connection.epoch = 0;
  setDataOwnerGeneration('owner-10111');
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

// #10111 (unit): the null route is only a probe of an already-established Codex task;
// other engines, SSH, explicit custom routes and named-source consumers keep their boundaries.
it('only probes old implicit Codex tasks when the task view explicitly opts in', () => {
  expect(sessionSubscriptionPoolProvider('codex', null)).toBeNull();
  expect(sessionSubscriptionPoolProvider('codex', null, null, undefined, true, { providers: [], catalogReady: true })).toBe('openai');
  expect(sessionSubscriptionPoolProvider('codex', null, 'ssh', undefined, true, { providers: [], catalogReady: true })).toBeNull();
  expect(sessionSubscriptionPoolProvider('cc', null, null, undefined, true, { providers: [], catalogReady: true })).toBeNull();
  expect(sessionSubscriptionPoolProvider('pi', null, null, undefined, true, { providers: [], catalogReady: true })).toBeNull();
  expect(sessionSubscriptionPoolProvider('codex', 'custom', null, undefined, true, { providers: [], catalogReady: true })).toBeNull();
});
function ImplicitProbe({ deviceId = 'peer' }: { deviceId?: string }) {
  const implicit = useSessionSubscriptionAccount(null, deviceId, true);
  const disabled = useSessionSubscriptionAccount(null, deviceId);
  const named = useSessionSubscriptionAccount('openai', deviceId);
  const otherComputer = useSessionSubscriptionAccount(null, 'other-peer', true);
  return <div data-testid="implicit-account">{JSON.stringify({ implicit, disabled, named, otherComputer })}</div>;
}
it('keeps the implicit task account separate from named sources and other computers', async () => {
  invoke.mockResolvedValue({ providerId: 'openai', state: 'bound',
    account: { isDefault: false, number: 2, identity: 'second@example.test', paused: false, status: 'ready' } });
  const { rerender } = render(<SessionSubscriptionAccountProvider providerId="openai" routeProviderId={null}
    deviceId="peer" sessionId="implicit-10111" nativeSessionId="native-10111"><ImplicitProbe /></SessionSubscriptionAccountProvider>);
  await act(async () => {});
  let output = screen.getByTestId('implicit-account').textContent!;
  expect(output).toContain('second@example.test');
  expect(output).toContain('"disabled":null,"named":null,"otherComputer":null');
  invoke.mockResolvedValue({ providerId: 'openai', state: 'unassigned' });
  rerender(<SessionSubscriptionAccountProvider providerId="openai" routeProviderId={null}
    deviceId="peer" sessionId="new-unassigned-10111" nativeSessionId={null}><ImplicitProbe /></SessionSubscriptionAccountProvider>);
  // No frame may reuse the previous task's second account.
  expect(screen.getByTestId('implicit-account').textContent).not.toContain('second@example.test');
  await act(async () => {});
  output = screen.getByTestId('implicit-account').textContent!;
  expect(output).toContain('unassigned');
  expect(output).not.toContain('second@example.test');
});

it('refreshes the implicit binding on reconnect and rejects late results across owners', async () => {
  const reply = (identity: string) => ({ providerId: 'openai', state: 'bound',
    account: { isDefault: false, number: 2, identity, paused: false, status: 'ready' } });
  invoke.mockResolvedValue(reply('before@example.test'));
  const view = () => <SessionSubscriptionAccountProvider providerId="openai" routeProviderId={null}
    deviceId="peer" sessionId="implicit-refresh-10111" nativeSessionId="native-refresh"><ImplicitProbe /></SessionSubscriptionAccountProvider>;
  const { rerender } = render(view());
  await act(async () => {});
  expect(screen.getByTestId('implicit-account').textContent).toContain('before@example.test');
  invoke.mockResolvedValue(reply('after@example.test'));
  connection.epoch++;
  rerender(view());
  await act(async () => {});
  expect(screen.getByTestId('implicit-account').textContent).toContain('after@example.test');
  let finish!: (value: unknown) => void;
  invoke.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  connection.epoch++;
  rerender(view());
  setDataOwnerGeneration('next-owner-10111');
  invoke.mockResolvedValue({ providerId: 'openai', state: 'unassigned' });
  rerender(view());
  expect(screen.getByTestId('implicit-account').textContent).not.toContain('after@example.test');
  await act(async () => { finish(reply('late-private@example.test')); });
  expect(screen.getByTestId('implicit-account').textContent).not.toContain('@example.test');
  expect(screen.getByTestId('implicit-account').textContent).toContain('unassigned');
});

it('updates the local implicit account after a pool change and unsubscribes on unmount', async () => {
  let onChange!: (event: { providerId: string }) => void;
  const off = vi.fn();
  const sessionAccount = vi.fn().mockResolvedValue({ providerId: 'openai', state: 'bound',
    account: { isDefault: false, number: 2, identity: 'original@example.test', paused: false, status: 'ready' } });
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { subscriptionAccounts: {
    sessionAccount, onChanged: (listener: typeof onChange) => { onChange = listener; return off; },
  } } });
  function LocalProbe() {
    const account = useSessionSubscriptionAccount(null, null, true);
    return <div data-testid="local-implicit">{JSON.stringify(account)}</div>;
  }
  const { unmount } = render(<SessionSubscriptionAccountProvider providerId="openai" routeProviderId={null}
    deviceId={null} sessionId="local-events-10111" nativeSessionId="native-events"><LocalProbe /></SessionSubscriptionAccountProvider>);
  await act(async () => {});
  expect(screen.getByTestId('local-implicit').textContent).toContain('original@example.test');
  sessionAccount.mockResolvedValue({ providerId: 'openai', state: 'bound',
    account: { isDefault: false, number: 3, identity: 'replacement@example.test', paused: false, status: 'ready' } });
  await act(async () => { onChange({ providerId: 'anthropic' }); });
  expect(sessionAccount).toHaveBeenCalledTimes(1);
  await act(async () => { onChange({ providerId: 'openai' }); });
  expect(screen.getByTestId('local-implicit').textContent).toContain('replacement@example.test');
  expect(sessionAccount).toHaveBeenCalledTimes(2);
  unmount();
  expect(off).toHaveBeenCalledOnce();
});

// #11192 review (unit): do not spend a task-account query on a route whose
// executor cannot consume the historical OAuth binding, including remote peers.
it.each([
  { modelId: 'codex/gpt-5.5', source: null, catalogReady: true },
  { modelId: 'openai-codex/gpt-5.5', source: null, catalogReady: true },
  { modelId: 'xai/grok-4.6', source: null, catalogReady: true },
  { modelId: 'chatgpt/gpt-6', source: null, catalogReady: true },
  { modelId: 'custom-model', source: 'custom', catalogReady: true },
  { modelId: 'custom-model[1m]', source: 'custom', catalogReady: true },
  { modelId: 'gpt-6', source: 'xd', catalogReady: true },
  { modelId: 'gpt-6', source: null, catalogReady: false },
])('review10111: skips implicit probes for $modelId/$source/ready=$catalogReady', async ({ modelId, source, catalogReady }) => {
  const providers = source ? [{ id: source, source: 'user', connected: true, agents: ['codex'],
    routing: { codex: { upstream: 'https://example.test', authStrategy: 'api-key-header' } },
    models: { codex: [{ id: modelId.replace(/\[1m\]$/, ''), name: 'model', contextWindow: 200000,
      efforts: [], defaultEffort: null }] } }] as unknown as ProviderView[] : [];
  invoke.mockResolvedValue({ providerId: 'openai', state: 'bound', account: {
    isDefault: false, number: 2, identity: 'wrong@example.test', paused: false, status: 'ready',
  } });
  const pool = sessionSubscriptionPoolProvider('codex', null, null, undefined, true,
    { modelId, providers, catalogReady });
  render(<SessionSubscriptionAccountProvider providerId={pool} routeProviderId={null}
    deviceId="peer" sessionId={'excluded-' + modelId + catalogReady} nativeSessionId="excluded-native"><ImplicitProbe /></SessionSubscriptionAccountProvider>);
  await act(async () => {});
  expect(invoke).not.toHaveBeenCalled();
  expect(screen.getByTestId('implicit-account').textContent).not.toContain('wrong@example.test');
});
