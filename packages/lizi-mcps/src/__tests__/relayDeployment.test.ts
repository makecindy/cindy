import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { createXdtHelperMcpServer } from '../lizi_xdtHelperMcpServer.js';
import type { LiziMcpSessionContext } from '../types.js';

// Test value: real progressive MCP entry protects account/SSH scope and request-time
// caller identity. Existing helper tests do not cover the new relay transfer/registration
// surface. Minimal failures: a stale caller, restricted surface, or denied write reaching
// the Host callback. Unit tier; in-memory MCP transport, no server/network/filesystem.
const relayId = '471a202f-51e9-49cf-bb61-d86d22bfb365';
const parse = (result: unknown) => JSON.parse((result as { content: { text: string }[] }).content[0].text);

describe('Agent relay deployment MCP', () => {
  it.each(['codex', 'claude-code', 'pi'] as const)('discovers, validates and dispatches the shared workflow for %s', async agentKind => {
    let context: LiziMcpSessionContext = { agentKind, workingDir: '/task', sessionId: 'first' };
    let surface: 'default' | 'restricted' = 'default';
    let denied = false;
    const host = vi.fn(async () => ({ state: { deployments: [] } }));
    const authorize = vi.fn(async () => denied
      ? { ok: false as const, errorCode: 'DENIED', message: 'Not authorized' }
      : { ok: true as const });
    const server = createXdtHelperMcpServer({
      relayDeployment: { call: host }, resolveSurface: async () => surface, authorizeCall: authorize,
    }, { agentKind, workingDir: '/task', getSessionContext: () => context });
    const client = new Client({ name: 'relay-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), server.connect(b)]);
    const call = async (name: string, args: object = {}) => parse(await client.callTool({ name: 'call_tool', arguments: { name, args } }));
    const list = async (args: Record<string, unknown> = {}) => parse(await client.callTool({ name: 'list_tools', arguments: args }));
    try {
      expect((await list()).categories).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'relay', tool_count: 7 })]));
      const discovery = await list({ category: 'relay' });
      expect(discovery.tools.every((tool: { inputSchema?: unknown }) => tool.inputSchema)).toBe(true);
      const cases = [
        ['get_relay_deployments', {}, { operation: 'list' }],
        ['prepare_relay_deployment', { deployment_key: 'my-server', name: 'My relay' }, { operation: 'prepare', deploymentKey: 'my-server', name: 'My relay' }],
        ['upload_relay_deployment', { relay_id: relayId, ssh_host_id: 'vps', remote_dir: '/home/me/relay' }, { operation: 'upload', relayId, sshHostId: 'vps', remoteDir: '/home/me/relay' }],
        ['complete_relay_deployment', { relay_id: relayId, base_url: 'https://relay.example:8443', tls_port: 443, node_path: '/opt/node', metadata: { service: 'user service' } }, { operation: 'complete', relayId, baseUrl: 'https://relay.example:8443', tlsPort: 443, nodePath: '/opt/node', metadata: { service: 'user service' } }],
        ['use_relay_deployment', { relay_id: relayId }, { operation: 'use', relayId }],
        // #8779: switching back must have its own non-destructive operation, without a relay ID.
        ['use_official_relay', {}, { operation: 'use-official' }],
        ['forget_relay_deployment', { relay_id: relayId }, { operation: 'forget', relayId }],
      ] as const;
      context = { ...context, sessionId: 'current' };
      for (const [tool, args, expected] of cases) {
        expect(await call(tool, args)).toMatchObject({ ok: true, state: { deployments: [] } });
        expect(host).toHaveBeenLastCalledWith({ ...expected, callerSessionId: 'current' });
      }
      host.mockClear();
      expect(await call('complete_relay_deployment', { relay_id: relayId, base_url: 'https://relay.example', tls_port: 443, metadata: { command: 'arbitrary command' } }))
        .toMatchObject({ errorCode: 'INVALID_ARGS' });
      expect(host).not.toHaveBeenCalled();
      expect(await call('complete_relay_deployment', { relay_id: relayId, base_url: 'https://relay.example' }))
        .toMatchObject({ errorCode: 'INVALID_ARGS' });
      expect(host).not.toHaveBeenCalled();
      denied = true;
      expect(await call('prepare_relay_deployment', { deployment_key: 'new', name: 'New' })).toMatchObject({ ok: false });
      expect(await call('use_official_relay')).toMatchObject({ ok: false });
      expect(host).not.toHaveBeenCalled();
      denied = false;
      context = { ...context, remoteHostId: 'remote' };
      expect(await call('get_relay_deployments')).toMatchObject({ errorCode: 'CAPABILITY_NOT_AVAILABLE' });
      expect(await call('use_official_relay')).toMatchObject({ errorCode: 'CAPABILITY_NOT_AVAILABLE' });
      expect((await list()).categories.some((item: { name: string }) => item.name === 'relay')).toBe(false);
      context = { ...context, remoteHostId: undefined, sessionId: undefined };
      expect(await call('get_relay_deployments')).toMatchObject({ errorCode: 'CAPABILITY_NOT_AVAILABLE' });
      expect(await call('use_official_relay')).toMatchObject({ errorCode: 'CAPABILITY_NOT_AVAILABLE' });
      context = { ...context, sessionId: 'current' };
      surface = 'restricted';
      expect(await call('get_relay_deployments')).toMatchObject({ errorCode: 'CAPABILITY_NOT_AVAILABLE' });
      expect(await call('use_official_relay')).toMatchObject({ errorCode: 'CAPABILITY_NOT_AVAILABLE' });
      expect(host).not.toHaveBeenCalled();
    } finally {
      await client.close(); await server.close();
    }
  });

  it('does not expose a failed Host exception as an Agent result', async () => {
    const server = createXdtHelperMcpServer({ relayDeployment: { call: async () => { throw new Error('secret-response'); } } },
      { agentKind: 'codex', workingDir: '/task', sessionId: 'caller' });
    const client = new Client({ name: 'relay-error-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), server.connect(b)]);
    try {
      const result = await client.callTool({ name: 'call_tool', arguments: { name: 'get_relay_deployments', args: {} } });
      expect(parse(result)).toMatchObject({ ok: false, errorCode: 'RELAY_OPERATION_FAILED' });
      expect(JSON.stringify(result)).not.toContain('secret-response');
    } finally { await client.close(); await server.close(); }
  });
});
