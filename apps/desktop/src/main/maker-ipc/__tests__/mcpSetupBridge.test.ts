// Unit: the real bridge waits for the existing form, returns metadata only,
// and releases waiters on Stop/account changes without a continuation channel.
import { afterEach, expect, it, vi } from 'vitest';
import { McpSetupBridge } from '../mcpSetupBridge';
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
  expect(await result).toEqual({ status: 'cancelled' });
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
  expect(await result).toEqual({ status: 'cancelled' });
});
