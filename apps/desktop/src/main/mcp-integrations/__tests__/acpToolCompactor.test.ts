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

  it('compacts JSON-RPC tools/list payloads: strips gateway param descriptions while keeping brief hints on core direct tools', () => {
    expect(isToolsListRpcBody({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).toBe(true);
    expect(isToolsListRpcBody({ jsonrpc: '2.0', id: 2, method: 'tools/call' })).toBe(false);

    const payload = {
      jsonrpc: '2.0',
      id: 1,
      result: {
        tools: [
          {
            name: 'ghost_call',
            description: '调用插件工具。' + '详细规则。'.repeat(100),
            inputSchema: {
              type: 'object',
              required: ['ghost_id', 'tool'],
              properties: {
                ghost_id: { type: 'string', description: '插件 id 说明'.repeat(30) },
                tool: { type: 'string', description: '工具名说明'.repeat(30) },
              },
            },
          },
          {
            name: 'create_worker',
            description: '在当前 workflow 内创建新 worker session。' + '详细规则。'.repeat(100),
            inputSchema: {
              type: 'object',
              required: ['role', 'label'],
              properties: {
                role: { type: 'string', description: 'worker 角色: developer / reviewer / tester / merger 或自定义 string' },
                label: { type: 'string', description: 'worker 短标识, 1-32 chars, 只能含字母、数字、-、_, 同 workflow 内唯一' },
                working_dir: {
                  type: 'string',
                  description:
                    '可选，Worker 所在主机上已存在的绝对目录。省略时继承 Lead 任务记录的工作目录（启动时的目录），不会跟随之后 cd 进入的 worktree。',
                },
                initial_task: {
                  type: 'string',
                  description:
                    '可选, 创建后立即派给 worker 的第一条消息。正文要自包含：目标、背景、边界与交付要求直接写在这里，文件只作补充并给绝对路径。',
                },
              },
            },
          },
        ],
      },
    };
    const compacted = compactAcpToolsListPayload(payload) as {
      result: {
        tools: Array<{
          name: string;
          description: string;
          inputSchema: {
            type: string;
            required?: string[];
            properties: Record<string, { type: string; description?: string }>;
          };
        }>;
      };
    };

    const ghostCall = compacted.result.tools[0]!;
    expect(ghostCall.name).toBe('ghost_call');
    expect(ghostCall.description.length).toBeLessThanOrEqual(121);
    expect(ghostCall.inputSchema).toEqual({
      type: 'object',
      required: ['ghost_id', 'tool'],
      properties: {
        ghost_id: { type: 'string' },
        tool: { type: 'string' },
      },
    });

    const createWorker = compacted.result.tools[1]!;
    expect(createWorker.name).toBe('create_worker');
    expect(createWorker.description.length).toBeLessThanOrEqual(121);
    expect(createWorker.inputSchema.properties.working_dir?.description).toContain('绝对目录');
    expect(createWorker.inputSchema.properties.working_dir?.description).toContain('省略时继承 Lead');
    expect(createWorker.inputSchema.properties.working_dir!.description!.length).toBeLessThanOrEqual(57);
    expect(createWorker.inputSchema.properties.initial_task?.description).toBe('可选, 创建后立即派给 worker 的第一条消息。');
    expect(createWorker.inputSchema.properties.initial_task!.description!.length).toBeLessThanOrEqual(57);
    // Single compacted core tool must stay far below agy's single-tool eager threshold & 52 KB global budget.
    expect(Buffer.byteLength(JSON.stringify(createWorker), 'utf8')).toBeLessThan(2000);
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
              name: 'ghost_info',
              description: '查询单个插件详情。' + '很长的说明文案。'.repeat(60),
              inputSchema: {
                type: 'object',
                properties: {
                  ghost_id: { type: 'string', description: '插件 id 说明'.repeat(20) },
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
        properties: { ghost_id: { type: 'string' } },
      });

      const sseRes = await fetch(`http://127.0.0.1:${addr.port}/sse`);
      const sseText = await sseRes.text();
      const dataLine = sseText.split('\n').find((line) => line.startsWith('data: '))!;
      const sseJson = JSON.parse(dataLine.slice(6)) as { result: { tools: Array<{ description: string; inputSchema: Record<string, unknown> }> } };
      expect(sseJson.result.tools[0]!.description.length).toBeLessThanOrEqual(121);
      expect(sseJson.result.tools[0]!.inputSchema).toEqual({
        type: 'object',
        properties: { ghost_id: { type: 'string' } },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
