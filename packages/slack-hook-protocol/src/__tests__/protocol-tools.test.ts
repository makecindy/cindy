/**
 * slack-hook-protocol 阶段 12(Slack 网关工具帧)测试:
 *   1. tool.request / tool.response 构造 -> 序列化 -> 解析 round-trip
 *   2. tool.response 的 ok/error 字段联动约束(失败必须结构化错误, 成功禁带)
 *   3. tool 名开放集合: 未知工具名通过 parse(业务层负责 UNKNOWN_TOOL)
 *   4. welcome.features 能力标识常量
 */

import { describe, it, expect } from 'vitest';

import {
  HOOK_FEATURE_SLACK_TOOLS,
  makeToolRequest,
  makeToolResponse,
  makeWelcome,
  parseHookMessage,
  serializeHookMessage,
  type HookMessage,
  type ToolResponsePayload,
} from '../index';

/** 构造 -> 序列化 -> 解析, 断言等价并返回解析结果。 */
function roundTrip(message: HookMessage): HookMessage {
  const parsed = parseHookMessage(serializeHookMessage(message));
  expect(parsed.ok, parsed.ok ? '' : parsed.error).toBe(true);
  if (!parsed.ok) throw new Error('unreachable');
  expect(parsed.message).toEqual(message);
  return parsed.message;
}

/** 基于合法消息改坏字段, 断言解析失败且错误信息含关键词。 */
function expectReject(mutated: unknown, keyword: string): void {
  const parsed = parseHookMessage(mutated);
  expect(parsed.ok).toBe(false);
  if (parsed.ok) throw new Error('unreachable');
  expect(parsed.error).toContain(keyword);
}

const OK_RESPONSE: ToolResponsePayload = {
  replyTo: 'tr-1',
  ok: true,
  result: { tools: [{ name: 'search', description: 'Search messages' }] },
};

const ERR_RESPONSE: ToolResponsePayload = {
  replyTo: 'tr-2',
  ok: false,
  error: { code: 'NO_USER_TOKEN', message: '需重新绑定以授予 Slack 工具权限' },
};

describe('tool.request', () => {
  it('全字段 round-trip(args 任意 JSON 对象)', () => {
    roundTrip(
      makeToolRequest({
        requestId: 'tr-1',
        tool: 'callTool',
        args: { name: 'search_messages', arguments: { query: 'release', limit: 5 } },
      }),
    );
  });

  it('省略 args round-trip(status 这类无参工具)', () => {
    roundTrip(makeToolRequest({ requestId: 'tr-1', tool: 'status' }));
  });

  it('tool 名是开放集合: 未知名字照常通过 parse', () => {
    roundTrip(makeToolRequest({ requestId: 'tr-x', tool: 'someFutureTool' }));
  });

  it('坏字段拒收: requestId / tool / args', () => {
    const base = makeToolRequest({ requestId: 'tr-1', tool: 'status' });
    expectReject(
      { ...base, payload: { ...base.payload, requestId: '' } },
      'tool.request.requestId',
    );
    expectReject({ ...base, payload: { tool: 'status' } }, 'tool.request.requestId');
    expectReject({ ...base, payload: { ...base.payload, tool: '' } }, 'tool.request.tool');
    expectReject(
      { ...base, payload: { ...base.payload, args: 'not-an-object' } },
      'tool.request.args',
    );
    expectReject({ ...base, payload: { ...base.payload, args: [] } }, 'tool.request.args');
  });
});

describe('tool.response', () => {
  it('成功应答 round-trip(result 任意 JSON)', () => {
    roundTrip(makeToolResponse(OK_RESPONSE));
  });

  it('成功应答 result 可缺席(如无返回值工具)', () => {
    roundTrip(makeToolResponse({ replyTo: 'tr-1', ok: true }));
  });

  it('成功应答 error 可为显式 null', () => {
    roundTrip(makeToolResponse({ replyTo: 'tr-1', ok: true, error: null }));
  });

  it('失败应答 round-trip(结构化错误)', () => {
    roundTrip(makeToolResponse(ERR_RESPONSE));
  });

  it('字段联动: ok=false 必须携带非空 {code, message}', () => {
    const base = makeToolResponse(ERR_RESPONSE);
    expectReject({ ...base, payload: { replyTo: 'tr-2', ok: false } }, 'tool.response.error');
    expectReject(
      { ...base, payload: { replyTo: 'tr-2', ok: false, error: null } },
      'tool.response.error',
    );
    expectReject(
      { ...base, payload: { replyTo: 'tr-2', ok: false, error: { code: '', message: 'x' } } },
      'tool.response.error.code',
    );
    expectReject(
      { ...base, payload: { replyTo: 'tr-2', ok: false, error: { code: 'X', message: '' } } },
      'tool.response.error.message',
    );
  });

  it('字段联动: ok=true 不得携带非 null error', () => {
    const base = makeToolResponse(OK_RESPONSE);
    expectReject(
      { ...base, payload: { ...OK_RESPONSE, error: { code: 'X', message: 'y' } } },
      'tool.response.error must be absent or null',
    );
  });

  it('坏字段拒收: replyTo / ok', () => {
    const base = makeToolResponse(OK_RESPONSE);
    expectReject({ ...base, payload: { ...OK_RESPONSE, replyTo: '' } }, 'tool.response.replyTo');
    expectReject({ ...base, payload: { ...OK_RESPONSE, ok: 'yes' } }, 'tool.response.ok');
  });
});

describe('能力协商', () => {
  it('HOOK_FEATURE_SLACK_TOOLS 常量进 welcome.features 后 round-trip', () => {
    expect(HOOK_FEATURE_SLACK_TOOLS).toBe('slack-tools');
    roundTrip(makeWelcome({ serverName: 'test', features: [HOOK_FEATURE_SLACK_TOOLS] }));
  });
});
