/**
 * Orca 自由文本参数的 Code Mode 契约测试。
 *
 * 这些参数会被模型写入 exec 的 JavaScript 源码；schema 必须明确要求按 JSON
 * 字符串字面量规则转义，避免反引号、插值片段或代码块在工具调用前破坏解析。
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { registerCreateWorkerTool } from '../xdt-helper/create_worker.js';
import { registerSendToWorkerTool } from '../xdt-helper/send_to_worker.js';

const PARSER_HOSTILE_TEXT = [
  '检查 `inline_code`、${workspace} 与以下代码：',
  '```ts',
  'const doubleQuoted = "中文";',
  "const singleQuoted = 'text';",
  '```',
].join('\n');

function setupCreateWorkerTool() {
  const createWorker = vi.fn(async () => ({
    ok: true as const,
    workerId: 'worker-1',
    workerSessionId: 'worker-session-1',
  }));
  const registry = new XdtHelperToolRegistry();
  registerCreateWorkerTool(registry, { sessionId: 'lead-1', createWorker });
  return { registry, createWorker };
}

function setupSendToWorkerTool() {
  const sendToWorker = vi.fn(async () => ({
    ok: true as const,
    agentKind: 'codex' as const,
    wakeKind: 'already-active' as const,
    targetTitle: null,
    targetLastUserSendAt: null,
  }));
  const registry = new XdtHelperToolRegistry();
  registerSendToWorkerTool(registry, {
    getSessionContext: () => ({ sessionId: 'lead-1' }),
    sendToWorker,
  });
  return { registry, sendToWorker };
}

function modelVisibleFieldDescription(
  registry: XdtHelperToolRegistry,
  toolName: string,
  field: string,
): string | undefined {
  const tool = registry.get(toolName);
  if (!tool) throw new Error(`Missing tool: ${toolName}`);
  const schema = z.toJSONSchema(z.object(tool.inputShape)) as {
    properties?: Record<string, { description?: string }>;
  };
  return schema.properties?.[field]?.description;
}

async function callThroughGeneratedSource(
  registry: XdtHelperToolRegistry,
  toolName: string,
  args: Record<string, unknown>,
) {
  const nestedTool = vi.fn((input: Record<string, unknown>) => registry.call(toolName, input));
  const nestedName = `cindy_orca__${toolName}`;
  const source = `return tools.${nestedName}(${JSON.stringify(args)});`;
  const invoke = new Function('tools', source) as (
    tools: Record<string, typeof nestedTool>,
  ) => Promise<Awaited<ReturnType<typeof nestedTool>>>;

  const result = await invoke({ [nestedName]: nestedTool });
  expect(nestedTool).toHaveBeenCalledTimes(1);
  return result;
}

describe('Orca Code Mode free-text contract', () => {
  it.each([
    ['create_worker', setupCreateWorkerTool, 'initial_task'],
    ['send_to_worker', setupSendToWorkerTool, 'message'],
  ] as const)('%s 要求把自由文本编码为 JSON 字符串字面量', (_name, setup, field) => {
    const { registry } = setup();
    const description = modelVisibleFieldDescription(registry, _name, field);

    expect(description).toContain('JSON.stringify');
    expect(description).toContain('模板字符串');
    expect(description).toContain('工具调用前');
  });

  it('create_worker 原样透传包含解析敏感字符的 initial_task', async () => {
    const { registry, createWorker } = setupCreateWorkerTool();

    const result = await callThroughGeneratedSource(registry, 'create_worker', {
      role: 'developer',
      agent: 'codex',
      label: 'developer_1',
      initial_task: PARSER_HOSTILE_TEXT,
    });

    expect(result.isError).toBeUndefined();
    expect(createWorker).toHaveBeenCalledWith(expect.objectContaining({
      initialTask: PARSER_HOSTILE_TEXT,
    }));
  });

  it('send_to_worker 原样透传包含解析敏感字符的 message', async () => {
    const { registry, sendToWorker } = setupSendToWorkerTool();

    const result = await callThroughGeneratedSource(registry, 'send_to_worker', {
      target_session_id: 'worker-session-1',
      message: PARSER_HOSTILE_TEXT,
    });

    expect(result.isError).toBeUndefined();
    expect(sendToWorker).toHaveBeenCalledWith({
      callerLeadSessionId: 'lead-1',
      targetSessionId: 'worker-session-1',
      message: PARSER_HOSTILE_TEXT,
    });
  });
});
