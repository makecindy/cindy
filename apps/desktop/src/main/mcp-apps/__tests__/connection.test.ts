import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { AppConnection } from '../connection.js';

afterEach(() => vi.restoreAllMocks());
const config = { id: 'example', url: 'https://mcp.example.invalid', transport: 'http' as const };

describe('MCP App connection recovery', () => {
  it('retries a failed connection only for a later independent request', async () => {
    const connect = vi.spyOn(Client.prototype, 'connect')
      .mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    vi.spyOn(Client.prototype, 'close').mockResolvedValue(undefined);
    const connection = new AppConnection(config);
    await expect(connection.getClient()).rejects.toThrow('offline');
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connection.isClosed).toBe(false);
    const [first, second] = await Promise.all([connection.getClient(), connection.getClient()]);
    expect(first).toBe(second);
    expect(connect).toHaveBeenCalledTimes(2);
    await connection.close();
    await expect(connection.getClient()).rejects.toThrow('MCP_APP_CONNECTION_CLOSED');
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('does not replay an in-flight tool when the transport closes, or retire its replacement', async () => {
    const connect = vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined);
    vi.spyOn(Client.prototype, 'close').mockResolvedValue(undefined);
    const connection = new AppConnection(config);
    const first = await connection.getClient();
    const call = vi.spyOn(first, 'callTool').mockImplementation(async () => {
      first.onclose?.();
      throw new Error('connection lost after send');
    });
    await expect(first.callTool({ name: 'submit' })).rejects.toThrow('connection lost');
    expect(call).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledOnce();
    const second = await connection.getClient();
    expect(second).not.toBe(first);
    first.onclose?.();
    expect(await connection.getClient()).toBe(second);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(call).toHaveBeenCalledOnce();
    await connection.close();
  });

  it('never revives a connection closed while initialization was pending', async () => {
    let finish!: () => void;
    vi.spyOn(Client.prototype, 'connect').mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    vi.spyOn(Client.prototype, 'close').mockResolvedValue(undefined);
    const connection = new AppConnection(config);
    const pending = connection.getClient();
    await connection.close();
    finish();
    await expect(pending).rejects.toThrow('MCP_APP_CONNECTION_CLOSED');
    await expect(connection.getClient()).rejects.toThrow('MCP_APP_CONNECTION_CLOSED');
  });
});

describe.each(['http', 'sse'] as const)('MCP App %s discovery cancellation', (transport) => {
  it('does not establish an authenticated connection for an already cancelled request', async () => {
    const connect = vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined);
    vi.spyOn(Client.prototype, 'close').mockResolvedValue(undefined);
    vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({ tools: [] });
    const connection = new AppConnection({ ...config, transport });
    const cancelled = new AbortController();
    const reason = new Error('discovery cancelled before connect');
    cancelled.abort(reason);
    try {
      await expect(connection.tools(cancelled.signal)).rejects.toBe(reason);
      expect(connect).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it.each([false, true])('cancels one initialization waiter without cancelling its peer (reconnect=%s)', async (reconnect) => {
    let finish!: () => void;
    const connect = vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined);
    vi.spyOn(Client.prototype, 'close').mockResolvedValue(undefined);
    const list = vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({ tools: [] });
    const connection = new AppConnection({ ...config, transport });
    if (reconnect) (await connection.getClient()).onclose?.();
    connect.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const cancelled = new AbortController();
    const reason = new Error('discovery cancelled during connect');
    const pending = connection.tools(cancelled.signal);
    const peer = connection.tools();
    try {
      const settled = pending.then(() => 'resolved', (error: unknown) => error);
      cancelled.abort(reason);
      // Initialization deliberately stays pending: no wall-clock timeout can mask it.
      for (let i = 0; i < 8; i++) await Promise.resolve();
      expect(await Promise.race([settled, Promise.resolve('still waiting')])).toBe(reason);
      expect(list).not.toHaveBeenCalled();
      finish();
      await expect(peer).resolves.toEqual([]);
      expect(list).toHaveBeenCalledOnce();
      expect(connect).toHaveBeenCalledTimes(reconnect ? 2 : 1);
      await expect(connection.tools()).resolves.toEqual([]);
      expect(connect).toHaveBeenCalledTimes(reconnect ? 2 : 1);
    } finally {
      finish();
      await Promise.allSettled([pending, peer]);
      await connection.close();
    }
  });
});
