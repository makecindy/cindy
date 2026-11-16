/**
 * 测试价值(list_model_groups 的读取边界)
 * - 生产入口与可观察结果：registerModelGroupsTools 的 list_model_groups——是否调用宿主读取、返回的错误码。
 * - 规则依据：docs/product-rules/model-groups.md §6.2(只读本机当前账号；共享任务不读主人配置；SSH 任务不读)。
 * - 现有覆盖缺口：新工具；错误映射漏掉会把共享拒绝当成「读取失败」诱导重试，或让 SSH 任务读到本机配置。
 * - 最小失败输入：带 remoteHostId 的调用方；宿主抛 PERMISSION_DENIED。
 * - tier：unit，真实 registry。
 */
import { describe, expect, it, vi } from 'vitest';

import { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { XdtHelperToolResult } from '../lizi_xdtHelperToolRegistry.js';
import type { LiziMcpSessionContext } from '../types.js';
import { registerModelGroupsTools } from '../xdt-helper/model_groups.js';

function parse(result: XdtHelperToolResult) {
  const [block] = result.content;
  if (block?.type !== 'text') throw new Error('Expected text');
  return JSON.parse(block.text);
}

function setup(partial: Partial<LiziMcpSessionContext>, list = vi.fn(async () => ({ scope: 'local', routes: [{ id: 'r1', name: '主力编程' }] }))) {
  const registry = new XdtHelperToolRegistry();
  const context = { agentKind: 'codex', workingDir: '/repo', ...partial } as LiziMcpSessionContext;
  registerModelGroupsTools(registry, { list }, () => context);
  return { registry, list };
}

describe('list_model_groups', () => {
  it('reads the caller task account modes on this computer', async () => {
    const { registry, list } = setup({ sessionId: 'lead-1' });
    expect(parse(await registry.call('list_model_groups', {}))).toMatchObject({ routes: [{ id: 'r1', name: '主力编程' }] });
    expect(list).toHaveBeenCalledWith({ callerSessionId: 'lead-1' });
  });

  it.each([
    ['an SSH task', { sessionId: 'lead-1', remoteHostId: 'builder' }],
    ['a caller without a task', {}],
  ] as [string, Partial<LiziMcpSessionContext>][])('does not read for %s', async (_name, context) => {
    const { registry, list } = setup(context);
    expect(parse(await registry.call('list_model_groups', {}))).toMatchObject({ errorCode: 'CAPABILITY_NOT_AVAILABLE' });
    expect(list).not.toHaveBeenCalled();
  });

  it.each([
    [Object.assign(new Error('shared'), { code: 'PERMISSION_DENIED' }), 'PERMISSION_DENIED'],
    [new Error('disk'), 'MODEL_GROUP_READ_FAILED'],
  ])('maps host failure %s', async (error, code) => {
    const { registry } = setup({ sessionId: 'lead-1' }, vi.fn(async () => { throw error; }));
    const result = parse(await registry.call('list_model_groups', {}));
    expect(result).toMatchObject({ errorCode: code });
    expect(JSON.stringify(result)).not.toContain('disk');
  });
});
