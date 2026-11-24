import http from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  compactAcpInputSchema,
  compactAcpToolDescription,
  compactAcpToolsListPayload,
  isToolsListRpcBody,
  wrapResponseForAcpToolsListCompaction,
} from '../acpToolCompactor.js';

describe('acpToolCompactor (ACP-only MCP tools/list slimming)', () => {
  it('compacts long Chinese/English tool descriptions at sentence boundary without losing lead summary', () => {
    const longDesc =
      '创建单个 Worker 并加入当前协同 Team。后续有几千字详细说明：' + '重复参数说明。'.repeat(120);
    const compacted = compactAcpToolDescription(longDesc, 120);
    expect(compacted.length).toBeLessThanOrEqual(121);
    expect(compacted).toContain('创建单个 Worker 并加入当前协同 Team。');
  });

  it('preserves full inputSchema structure (types, enums, required, items) while stripping verbose descriptions', () => {
    const schema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      title: 'CreateWorkerInput',
      type: 'object',
      required: ['role', 'agent'],
      properties: {
        role: { type: 'string', description: '很长的角色字段说明'.repeat(40) },
        agent: { type: 'string', enum: ['claude-code', 'codex', 'pi', 'acp'], description: '引擎类型说明' },
        files: {
          type: 'array',
          items: { type: 'string', description: '路径说明' },
          description: '文件列表',
        },
      },
    };
    const compacted = compactAcpInputSchema(schema) as Record<string, unknown>;
    expect(compacted).toEqual({
      type: 'object',
      required: ['role', 'agent'],
      properties: {
        role: { type: 'string' },
        agent: { type: 'string', enum: ['claude-code', 'codex', 'pi', 'acp'] },
        files: {
          type: 'array',
          items: { type: 'string' },
        },
      },
    });
  });

  it('compacts JSON-RPC tools/list payloads while leaving non-tools/list payloads untouched', () => {
    expect(isToolsListRpcBody({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).toBe(true);
    expect(isToolsListRpcBody({ jsonrpc: '2.0', id: 2, method: 'tools/call' })).toBe(false);

    const payload = {
      jsonrpc: '2.0',
      id: 1,
      result: {
        tools: [
          {
            name: 'create_worker',
            description: '创建 Worker。' + '详细规则。'.repeat(100),
            inputSchema: {
              type: 'object',
              required: ['role'],
              properties: { role: { type: 'string', description: '角色名说明'.repeat(30) } },
            },
          },
        ],
      },
    };
    const compacted = compactAcpToolsListPayload(payload) as typeof payload;
    expect(compacted.result.tools[0]!.name).toBe('create_worker');
    expect(compacted.result.tools[0]!.description.length).toBeLessThanOrEqual(121);
    expect(compacted.result.tools[0]!.inputSchema).toEqual({
      type: 'object',
      required: ['role'],
      properties: { role: { type: 'string' } },
    });
  });

  it('rewrites both application/json and text/event-stream HTTP responses cleanly', async () => {
    const server = http.createServer((req, res) => {
      const wrapped = wrapResponseForAcpToolsListCompaction(res);
      const rpc = {
        jsonrpc: '2.0',
        id: 1,
        result: {
          tools: [
            {
              name: 'start_team',
              description: '开启协同团队。' + '很长的说明文案。'.repeat(60),
              inputSchema: {
                type: 'object',
                properties: {
                  title: { type: 'string', description: '团队标题说明'.repeat(20) },
                },
              },
            },
          ],
        },
      };
      if (req.url === '/sse') {
        wrapped.writeHead(200, { 'content-type': 'text/event-stream' });
        wrapped.write(`event: message\ndata: ${JSON.stringify(rpc)}\n\n`);
        wrapped.end();
      } else {
        const body = JSON.stringify(rpc);
        wrapped.writeHead(200, {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
        });
        wrapped.end(body);
      }
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    try {
      const jsonRes = await fetch(`http://127.0.0.1:${addr.port}/json`);
      const jsonBody = (await jsonRes.json()) as { result: { tools: Array<{ description: string; inputSchema: Record<string, unknown> }> } };
      expect(jsonBody.result.tools[0]!.description.length).toBeLessThanOrEqual(121);
      expect(jsonBody.result.tools[0]!.inputSchema).toEqual({
        type: 'object',
        properties: { title: { type: 'string' } },
      });

      const sseRes = await fetch(`http://127.0.0.1:${addr.port}/sse`);
      const sseText = await sseRes.text();
      const dataLine = sseText.split('\n').find((line) => line.startsWith('data: '))!;
      const sseJson = JSON.parse(dataLine.slice(6)) as { result: { tools: Array<{ description: string; inputSchema: Record<string, unknown> }> } };
      expect(sseJson.result.tools[0]!.description.length).toBeLessThanOrEqual(121);
      expect(sseJson.result.tools[0]!.inputSchema).toEqual({
        type: 'object',
        properties: { title: { type: 'string' } },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
