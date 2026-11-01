import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { createXdtHelperMcpServer } from '../lizi_xdtHelperMcpServer.js';
import type { ListMachinesCallbacks } from '../xdt-helper/list_machines.js';

async function connect(list: ListMachinesCallbacks['list']) {
  const server = createXdtHelperMcpServer({ machines: { list } }, { agentKind: 'claude-code', workingDir: '/fixture', sessionId: 's1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'list-machines-test', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args }) as { content: Array<{ text: string }> };
    return JSON.parse(result.content[0]!.text);
  };
}

describe('list_machines', () => {
  it('is discoverable in the first category and returns what the host reports for the calling task', async () => {
    const machines = { computers: [{ name: 'Mac mini', availability: 'offline' }], ssh: [] };
    const list = vi.fn(async () => ({ ok: true as const, machines }));
    const call = await connect(list);
    const listed = await call('list_tools', { category: 'cindy' });
    expect(listed.tools.map((tool: { name: string }) => tool.name)).toContain('list_machines');
    const result = await call('call_tool', { name: 'list_machines', args: {} });
    expect(list).toHaveBeenCalledWith({ callerSessionId: 's1' });
    expect(result).toMatchObject({ ok: true, machines });
    expect(result.ssh_note).toContain('ssh_exec');
  });

  it('passes a host refusal through instead of an empty list', async () => {
    const call = await connect(async () => ({ ok: false, errorCode: 'PERMISSION_DENIED', message: 'shared' }));
    expect(await call('call_tool', { name: 'list_machines', args: {} })).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
  });
});
