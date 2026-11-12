// Unit: the real bridge waits for the existing form, returns metadata only,
// and releases waiters on Stop/account changes without a continuation channel.
import { afterEach, expect, it, vi } from 'vitest';
import { McpSetupBridge, completeMcpSetup } from '../mcpSetupBridge';
import { MAKER_PUSH } from '../channels';

afterEach(() => vi.useRealTimers());

it('shares one pending form and returns only the saved id, never form values', async () => {
  const broadcast = vi.fn();
  const bridge = new McpSetupBridge({ broadcast });
  const proposal = { name: 'Example', url: 'https://example.test/mcp', transport: 'sse' as const };
  const result = bridge.request('task', proposal, () => true);
  expect(bridge.request('task', proposal, () => true)).toBe(result);
  const [{ request }] = bridge.pendingSnapshots('task');
  expect(broadcast.mock.calls).toEqual([[MAKER_PUSH.INTERACTION_REQUEST, { sessionId: 'task', request }]]);
  expect(bridge.resolve(request.requestId, { kind: 'mcp_setup', status: 'saved',
    serverId: 'custom_example', token: 'test-invalid-token', headers: { X: 'test-invalid-header' } })).toBe(true);
  expect(await result).toEqual({ status: 'saved', serverId: 'custom_example' });
  expect(bridge.pendingSnapshots()).toEqual([]);
  expect(JSON.stringify(broadcast.mock.calls)).not.toContain('test-invalid');
  expect(bridge.resolve(request.requestId, { kind: 'mcp_setup', status: 'saved', serverId: 'custom_example' })).toBe(false);
});

it.each(['cancel', 'stop', 'account', 'timeout'] as const)('settles %s without saving or leaving an actionable request', async reason => {
  vi.useFakeTimers();
  const bridge = new McpSetupBridge({ broadcast: vi.fn(), timeoutMs: 100 });
  let current = true;
  const result = bridge.request('task', {}, () => current);
  const [{ request }] = bridge.pendingSnapshots();
  if (reason === 'cancel') bridge.resolve(request.requestId, { kind: 'mcp_setup', status: 'cancelled' });
  if (reason === 'stop') bridge.cleanupForSession('task');
  if (reason === 'account') { current = false; bridge.cleanupAll(); }
  if (reason === 'timeout') await vi.advanceTimersByTimeAsync(100);
  expect(await result).toEqual(reason === 'cancel' ? { status: 'cancelled' } :
    reason === 'timeout' ? { status: 'timed_out', formPresented: false } : { status: 'interrupted' });
  expect(bridge.has(request.requestId)).toBe(false);
});

it('rejects invalid decisions and an expired runtime cannot confirm a saved result', async () => {
  const bridge = new McpSetupBridge({ broadcast: vi.fn() });
  let current = true;
  const result = bridge.request('task', {}, () => current);
  const [{ request }] = bridge.pendingSnapshots();
  expect(bridge.resolve(request.requestId, { kind: 'mcp_setup', status: 'saved', serverId: 'cindy_helper' })).toBe(false);
  expect(bridge.has(request.requestId)).toBe(true);
  current = false;
  bridge.resolve(request.requestId, { kind: 'mcp_setup', status: 'saved', serverId: 'custom_example' });
  expect(await result).toEqual({ status: 'interrupted' });
});

// Regression: a missing form was reported as user cancellation. Exercise the public
// bridge with no renderer and with an acknowledged form; unit, fake clock only.
it('distinguishes a displayed form timing out from a request never presented', async () => {
  vi.useFakeTimers();
  const bridge = new McpSetupBridge({ broadcast: vi.fn(), timeoutMs: 100 });
  const result = bridge.request('task', {}, () => true);
  const [{ request }] = bridge.pendingSnapshots();
  expect(bridge.resolve(request.requestId, { kind: 'mcp_setup', status: 'presented' })).toBe(true);
  expect(bridge.has(request.requestId)).toBe(true);
  await vi.advanceTimersByTimeAsync(100);
  expect(await result).toEqual({ status: 'timed_out', formPresented: true });
});

it('does not return another server proposal as the requested installation', async () => {
  const bridge = new McpSetupBridge({ broadcast: vi.fn() });
  const first = bridge.request('task', { url: 'https://one.test/mcp' }, () => true);
  expect(await bridge.request('task', { url: 'https://two.test/mcp' }, () => true))
    .toEqual({ status: 'unavailable', reason: 'request_in_progress' });
  bridge.cleanupAll();
  await first;
});

it('settles unavailable even when both request and dismissal broadcasting fail', async () => {
  const bridge = new McpSetupBridge({ broadcast: () => { throw new Error('test-only unavailable renderer'); } });
  expect(await bridge.request('task', {}, () => true)).toEqual({ status: 'unavailable', reason: 'presentation_failed' });
  expect(bridge.pendingSnapshots()).toEqual([]);
});

// Saved is not connected: exercise the production completion path, including a
// runtime error and an owner change during inspection; previously no observation.
it.each(['connected', 'not-mounted', 'failed', 'unverified'] as const)(
  'preserves saved evidence with runtime state %s', async state => {
    const mount = vi.fn(async () => false);
    const read = vi.fn(async () => state === 'unverified' ? null : { state, tools: state === 'connected' ? [{}] : [] });
    expect(await completeMcpSetup({ status: 'saved', serverId: 'custom_example' }, {
      isCurrent: () => true, mount, read,
    })).toEqual({ status: 'saved', serverId: 'custom_example', runtimeState: state,
      ...(state !== 'unverified' ? { toolCount: state === 'connected' ? 1 : 0 } : { runtimeReason: 'status_unavailable' }) });
  });

it('does not lose a saved configuration on refresh error or leak it across owner changes', async () => {
  const saved = { status: 'saved' as const, serverId: 'custom_example' };
  const read = vi.fn();
  expect(await completeMcpSetup(saved, { isCurrent: () => true,
    mount: async () => { throw new Error('test-only runtime failure'); }, read,
  })).toEqual({ ...saved, runtimeState: 'unverified', runtimeReason: 'check_failed' });
  let current = true;
  expect(await completeMcpSetup(saved, { isCurrent: () => current,
    mount: async () => { current = false; return true; }, read,
  })).toEqual({ status: 'interrupted' });
  expect(read).not.toHaveBeenCalled();
});
