import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { createXdtHelperMcpServer, type XdtHelperMcpDeps } from '../lizi_xdtHelperMcpServer.js';
import type { ListMachinesCallbacks } from '../xdt-helper/list_machines.js';

async function connect(list: ListMachinesCallbacks['list'], extra: Partial<XdtHelperMcpDeps> = {}) {
  const server = createXdtHelperMcpServer({ machines: { list }, ...extra }, { agentKind: 'claude-code', workingDir: '/fixture', sessionId: 's1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'list-machines-test', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    names: async () => (await client.listTools()).tools.map(tool => tool.name),
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args }) as { content: Array<{ text: string }> };
      return JSON.parse(result.content[0]!.text);
    },
  };
}

describe('list_machines', () => {
  it('is listed directly and returns what the host reports for the calling task', async () => {
    const machines = { computers: [{ name: 'Mac mini', availability: 'offline' }], ssh: [] };
    const list = vi.fn(async () => ({ ok: true as const, machines }));
    const { names, call } = await connect(list);
    expect(await names()).toContain('list_machines');
    const result = await call('list_machines');
    expect(list).toHaveBeenCalledWith({ callerSessionId: 's1' });
    expect(result).toMatchObject({ ok: true, machines });
  });

  it('passes a host refusal through instead of an empty list', async () => {
    const { call } = await connect(async () => ({ ok: false, errorCode: 'PERMISSION_DENIED', message: 'shared' }));
    expect(await call('list_machines')).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
  });

  it('is neither listed nor callable for a restricted identity', async () => {
    const list = vi.fn(async () => ({ ok: true as const, machines: {} }));
    const { names, call } = await connect(list, { resolveSurface: async () => 'restricted' });
    expect(await names()).not.toContain('list_machines');
    expect(await call('list_machines')).toMatchObject({ ok: false, errorCode: 'CAPABILITY_NOT_AVAILABLE' });
    expect(list).not.toHaveBeenCalled();
  });
  // New pre-control entry: the real MCP surface must bind the caller identity and
  // preserve a denial. Existing listing tests cannot cover this write-intent path (unit).
  it('lists the consent tool and returns the target decision without treating refusal as a grant', async () => {
    const list = vi.fn(async () => ({ ok: true as const, machines: {} }));
    const requestRemoteControl = vi.fn(async () => ({ ok: true as const, status: 'declined' }));
    const { names, call } = await connect(list, { machines: { list, requestRemoteControl } });
    expect(await names()).toContain('request_remote_control');
    const discovery = await call('list_tools', { key: 'devices.remote-consent' });
    const relay = await call('list_tools', { query: '中转' });
    expect(relay.items).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'devices.remote-settings' })]));
    expect(discovery.control.operations).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'request_remote_control' })]));
    expect(await call('request_remote_control', { device_id: 'target', purpose: 'Download source' }))
      .toMatchObject({ ok: true, device_id: 'target', status: 'declined' });
    expect(requestRemoteControl).toHaveBeenCalledWith({ callerSessionId: 's1', deviceId: 'target', purpose: 'Download source' });
    expect(await call('call_tool', { name: 'request_remote_control', args: { device_id: 'target', purpose: 'Download source' } }))
      .toMatchObject({ ok: true, status: 'declined' });
  });

  it('does not send consent requests from a restricted task', async () => {
    const list = vi.fn(async () => ({ ok: true as const, machines: {} }));
    const requestRemoteControl = vi.fn();
    const { names, call } = await connect(list, { machines: { list, requestRemoteControl }, resolveSurface: async () => 'restricted' });
    expect(await names()).not.toContain('request_remote_control');
    expect(await call('request_remote_control', { device_id: 'target', purpose: 'Download source' }))
      .toMatchObject({ ok: false, errorCode: 'CAPABILITY_NOT_AVAILABLE' });
    expect(requestRemoteControl).not.toHaveBeenCalled();
  });

});
