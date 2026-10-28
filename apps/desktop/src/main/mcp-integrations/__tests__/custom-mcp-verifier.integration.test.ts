/** 测试价值：integration；本机假 MCP 上游驱动真实 SDK 和受限 fetch，覆盖两种传输、跳转与响应限制。
 * 最小输入为 loopback 服务；不会连接外部服务或调用业务工具。 */
import http from 'node:http';
import dns from 'node:dns';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyCustomMcp } from '../custom-mcp-verifier.js';
import { createMcpFetch, isForbiddenMcpAddress, validateMcpEndpoint } from '../custom-mcp-fetch.js';
const servers: http.Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});
async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + (server.address() as { port: number }).port;
}
function config(url: string, transport: 'http' | 'sse' = 'http') {
  return {
    id: 'custom_test',
    name: 'Test',
    url,
    transport,
    headers: { 'X-Test-Key': 'test-invalid-header' },
  };
}
describe('custom MCP verification network boundary', () => {
  it.each(['http', 'sse'] as const)(
    'initializes and discovers tools over %s without a business call',
    async (transport) => {
      const methods: string[] = [];
      const auth: unknown[] = [];
      let stream: http.ServerResponse | undefined;
      const base = await serve(async (request, response) => {
        auth.push(request.headers.authorization);
        expect(request.headers['x-test-key']).toBe('test-invalid-header');
        if (request.method === 'GET' && transport === 'sse') {
          stream = response;
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.write('event: endpoint\ndata: /messages\n\n');
          return;
        }
        if (request.method !== 'POST') {
          response.writeHead(405).end();
          return;
        }
        let body = '';
        for await (const chunk of request) body += chunk;
        const rpc = JSON.parse(body);
        methods.push(rpc.method);
        if (rpc.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        const result =
          rpc.method === 'initialize'
            ? {
                protocolVersion: rpc.params.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: 'test-only', version: '1' },
              }
            : { tools: [] };
        const text = JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result });
        if (transport === 'sse') {
          response.writeHead(202).end();
          stream!.write('event: message\ndata: ' + text + '\n\n');
        } else {
          response.writeHead(200, { 'content-type': 'application/json' }).end(text);
        }
      });
      await verifyCustomMcp(
        config(base + '/mcp', transport),
        'test-invalid-token',
        new AbortController().signal,
      );
      expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
      expect(auth.every((value) => value === 'Bearer test-invalid-token')).toBe(true);
    },
  );
  it('does not forward credentials to a redirect destination or expose reflected response bodies', async () => {
    const sink = vi.fn((_request, response) => response.end());
    const other = await serve(sink);
    const endpoint = await serve((_request, response) =>
      response
        .writeHead(302, { location: other + '/test-invalid-token' })
        .end('test-invalid-header'),
    );
    await expect(
      verifyCustomMcp(config(endpoint), 'test-invalid-token', new AbortController().signal),
    ).rejects.toThrow('REDIRECT_REQUIRES_REVIEW');
    expect(sink).not.toHaveBeenCalled();
  });
  it('never follows an SSE POST endpoint on another origin', async () => {
    const sink = vi.fn((_request, response) => response.end());
    const other = await serve(sink);
    const endpoint = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('event: endpoint\ndata: ' + other + '/messages\n\n');
    });
    await expect(
      verifyCustomMcp(config(endpoint, 'sse'), 'test-invalid-token', new AbortController().signal),
    ).rejects.toThrow();
    expect(sink).not.toHaveBeenCalled();
  });
  it('maps auth rejection to a safe code instead of the server text', async () => {
    const endpoint = await serve((_request, response) =>
      response.writeHead(401).end('test-invalid-token'),
    );
    await expect(
      verifyCustomMcp(config(endpoint), 'test-invalid-token', new AbortController().signal),
    ).rejects.toThrow(/^AUTH_REJECTED$/);
  });
  it('bounds a streaming response even without Content-Length', async () => {
    const endpoint = await serve((_request, response) => {
      response.writeHead(200);
      response.write('x'.repeat(1024));
      response.end();
    });
    const network = createMcpFetch(endpoint, 100);
    try {
      const response = await network.fetch(endpoint);
      await expect(response.text()).rejects.toThrow('RESPONSE_LIMIT');
    } finally {
      await network.close();
    }
  });
  it('cancels a real connection whose initialize response never arrives', async () => {
    const endpoint = await serve(() => { /* Deliberately leave initialize pending. */ });
    const cancel = new AbortController();
    const job = verifyCustomMcp(config(endpoint), 'test-invalid-token', cancel.signal);
    const timer = setTimeout(() => cancel.abort(), 25);
    try { await expect(job).rejects.toThrow('PROTOCOL_MISMATCH'); }
    finally { clearTimeout(timer); }
  });
  it('validates the actual DNS answer used by the connection', async () => {
    vi.spyOn(dns, 'lookup').mockImplementation(
      (...args: unknown[]) => {
        (args.at(-1) as (error: null, addresses: Array<{ address: string; family: number }>) => void)(
          null,
          [{ address: '169.254.169.254', family: 4 }],
        );
      },
    );
    const network = createMcpFetch('https://test-only.invalid/mcp');
    try {
      await expect(network.fetch('https://test-only.invalid/mcp')).rejects.toThrow(
        'INSECURE_ENDPOINT',
      );
    } finally {
      await network.close();
    }
  });
  it.each([
    'http://example.test/mcp',
    'https://169.254.169.254/mcp',
    'https://[::ffff:169.254.169.254]/mcp',
    'https://example.test/mcp?token=test-invalid',
    'https://user:test-invalid@example.test/mcp',
  ])('rejects unsafe proposal %s', (url) => {
    expect(() => validateMcpEndpoint(url)).toThrow();
  });
  it('allows explicit LAN HTTPS, rejects metadata/unspecified/multicast, and retains legacy explicit HTTP when requested by Settings', () => {
    expect(validateMcpEndpoint('https://192.168.1.20/mcp').hostname).toBe('192.168.1.20');
    expect(validateMcpEndpoint('http://192.168.1.20/mcp', false).protocol).toBe('http:');
    for (const address of [
      '0.0.0.0',
      '169.254.169.254',
      '224.0.0.1',
      '::',
      'fe80::1',
      'ff02::1',
      '::ffff:a9fe:a9fe',
    ])
      expect(isForbiddenMcpAddress(address)).toBe(true);
  });
});
