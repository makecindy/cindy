import { describe, expect, it } from 'vitest';

import { AcpClient, AcpRequestTimeoutError } from '../acp-client.js';
import { ACP_JSONRPC_VERSION } from '../types.js';
import { FakeAcpTransport } from './fake-transport.js';

describe('AcpClient JSON-RPC 2.0', () => {
  it('sends initialize with jsonrpc 2.0 and resolves the result', async () => {
    const transport = new FakeAcpTransport();
    const client = new AcpClient({ transport });
    client.start();
    const pending = client.initialize({
      protocolVersion: 1,
      clientInfo: { name: 'cindy', version: '0' },
    });
    await Promise.resolve();
    const req = transport.lastRequest();
    expect(req.jsonrpc).toBe(ACP_JSONRPC_VERSION);
    expect(req.method).toBe('initialize');
    transport.pushLine({
      jsonrpc: '2.0',
      id: req.id,
      result: { protocolVersion: 1, authMethods: [] },
    });
    await expect(pending).resolves.toMatchObject({ protocolVersion: 1, authMethods: [] });
    await client.close();
  });

  it('routes session/update notifications', async () => {
    const transport = new FakeAcpTransport();
    const client = new AcpClient({ transport });
    const updates: unknown[] = [];
    client.onNotification((method, params) => {
      updates.push({ method, params });
    });
    client.start();
    transport.pushLine({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 's1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
      },
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ method: 'session/update' });
    await client.close();
  });

  it('answers session/request_permission from the request handler', async () => {
    const transport = new FakeAcpTransport();
    const client = new AcpClient({ transport });
    client.setRequestHandler(async (method, params) => {
      expect(method).toBe('session/request_permission');
      expect(params).toMatchObject({ toolCall: { toolCallId: 'tc-1' } });
      return { outcome: { outcome: 'selected', optionId: 'allow-once' } };
    });
    client.start();
    transport.pushLine({
      jsonrpc: '2.0',
      id: 99,
      method: 'session/request_permission',
      params: {
        sessionId: 's1',
        toolCall: { toolCallId: 'tc-1', kind: 'execute', title: 'bash' },
        options: [{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }],
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    const response = JSON.parse(transport.written.at(-1)!) as {
      jsonrpc: string;
      id: number;
      result: { outcome: { outcome: string; optionId: string } };
    };
    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe(99);
    expect(response.result.outcome).toEqual({ outcome: 'selected', optionId: 'allow-once' });
    await client.close();
  });

  it('times out initialize when the agent never replies', async () => {
    const transport = new FakeAcpTransport();
    const client = new AcpClient({ transport, defaultTimeoutMs: 20 });
    client.start();
    await expect(client.initialize({ protocolVersion: 1 }, 20)).rejects.toBeInstanceOf(AcpRequestTimeoutError);
    await client.close();
  });

  it('sends session/cancel as a notification (no id)', async () => {
    const transport = new FakeAcpTransport();
    const client = new AcpClient({ transport });
    client.start();
    await client.sessionCancel('s-9');
    const payload = JSON.parse(transport.written.at(-1)!) as Record<string, unknown>;
    expect(payload).toEqual({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's-9' } });
    expect(payload).not.toHaveProperty('id');
    await client.close();
  });
});
