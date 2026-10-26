/**
 * 测试价值
 * - 生产入口与可观察结果:get_task_digest 经 registry.call 返回给模型的 JSON(字段、大小、错误码)。
 * - 规则依据:被程序叫醒的伙伴先读 ≤2KB 摘要再决定;每段文字 ≤300 字;只读调用方可读范围内的任务。
 * - 现有覆盖缺口:长助手回复只截开头,丢掉末尾结果;总预算收紧时也须保留结论。
 * - 最小失败输入:超过 300 字、末尾才写失败结论的回复,分别带有/不带其他长字段;受限范围外任务。
 * - tier:unit(纯工具层,宿主回调 mock)。
 */
import { describe, expect, it, vi } from 'vitest';

import { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import {
  boundTaskDigest,
  registerGetTaskDigestTool,
  TASK_DIGEST_MAX_BYTES,
  type TaskDigestWire,
} from '../xdt-helper/get_task_digest.js';
import type { XdtHelperHistoryDeps } from '../xdt-helper/_history_types.js';

function parse(result: { content: Array<{ type: string; text?: string }> }) {
  const block = result.content[0];
  if (block?.type !== 'text' || typeof block.text !== 'string') throw new Error('text expected');
  return { text: block.text, json: JSON.parse(block.text) as Record<string, unknown> };
}

const longText = '这件任务在等主人确认是否删除旧的数据表并迁移索引'.repeat(30);
const digest: TaskDigestWire = {
  session_id: 'laptop::s-9',
  device: 'MacBook',
  title: '修登录'.repeat(80),
  phase: 'waiting-answer',
  elapsed_minutes: 12,
  idle_minutes: 12,
  tool_in_flight: true,
  last_user_ask: longText,
  last_assistant_line: longText,
  pending_question: longText,
  error: longText,
  current_route: { harness: 'codex', provider_id: 'openai', model: 'gpt-5.5', effort: 'high', fast: false },
  runtime_generation: null,
  suggested_route: { harness: 'claude-code', provider_id: null, model: 'claude-opus-5-5', effort: 'high', fast: false },
  pr_status: longText,
  queued_count: 1,
  follower_bot_id: 'cindy-default',
  creator_bot_id: null,
};

function setup(history: Partial<XdtHelperHistoryDeps>) {
  const reg = new XdtHelperToolRegistry();
  registerGetTaskDigestTool(reg, {
    history: history as XdtHelperHistoryDeps,
    getSessionContext: () => ({ sessionId: 'bot-main', agentKind: 'claude-code', workingDir: '/w' }),
  });
  return reg;
}

describe('get_task_digest', () => {
  it('keeps every text field within 300 characters and the whole reply within 2KB', async () => {
    const taskDigest = vi.fn(async () => ({ ok: true as const, digest }));
    const sessionUrl = 'cindy://session/s-9?device=laptop';
    const buildUrl = vi.fn(() => sessionUrl);
    const reg = setup({ taskDigest, sessionUrl: buildUrl });
    const { text, json } = parse(await reg.call('get_task_digest', { session_id: 'laptop::s-9' }));
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(TASK_DIGEST_MAX_BYTES);
    expect(json).toMatchObject({ ok: true, session_id: 'laptop::s-9', phase: 'waiting-answer', queued_count: 1, tool_in_flight: true });
    for (const key of ['last_user_ask', 'last_assistant_line', 'pending_question', 'error', 'pr_status'] as const) {
      const value = json[key];
      if (value !== null) expect(Array.from(String(value)).length).toBeLessThanOrEqual(300);
    }
    expect(taskDigest).toHaveBeenCalledWith({ sessionId: 'laptop::s-9', callerSessionId: 'bot-main' });
    expect(json.sessionUrl).toBe(sessionUrl);
    expect(buildUrl).toHaveBeenCalledWith('laptop::s-9');
  });

  it('leaves a short digest untouched', () => {
    const short = { ...digest, title: '修登录', last_user_ask: '先修登录', last_assistant_line: '好', pending_question: null, error: null, pr_status: null };
    expect(boundTaskDigest(short)).toEqual(short);
  });

  it.each([false, true])('retains the opening and final blocker of a long reply (budget pressure=%s)', async (pressure) => {
    const opening = '构建进展：';
    const conclusion = '最终结果：部署失败，需要回滚。';
    const raw = {
      ...digest,
      title: '部署结果',
      last_user_ask: pressure ? longText : '检查部署结果',
      last_assistant_line: `${opening}${'正在检查日志与测试结果。'.repeat(80)}\n${conclusion}`,
      pending_question: pressure ? longText : null,
      error: pressure ? longText : null,
      pr_status: pressure ? longText : null,
    };
    const reg = setup({ taskDigest: async () => ({ ok: true as const, digest: raw }) });
    const { text, json } = parse(await reg.call('get_task_digest', { session_id: raw.session_id }));
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(TASK_DIGEST_MAX_BYTES);
    const reply = String(json.last_assistant_line);
    expect(reply.startsWith(opening)).toBe(true);
    expect(reply.endsWith(conclusion)).toBe(true);
    expect(Array.from(reply).length).toBeLessThanOrEqual(pressure ? 299 : 300);
  });

  it('refuses a task outside a scoped caller\'s readable history and passes host errors through', async () => {
    const taskDigest = vi.fn(async () => ({ ok: false as const, errorCode: 'NOT_FOUND' as const, message: 'gone' }));
    const scoped = setup({
      taskDigest,
      resolveSessionScope: async () => ({ ok: true as const, sessionIds: ['mine'] }),
    });
    expect(parse(await scoped.call('get_task_digest', { session_id: 'someone-else' })).json)
      .toMatchObject({ ok: false, errorCode: 'HISTORY_SCOPE_DENIED' });
    expect(taskDigest).not.toHaveBeenCalled();
    expect(parse(await scoped.call('get_task_digest', { session_id: 'mine' })).json)
      .toMatchObject({ ok: false, errorCode: 'NOT_FOUND' });
  });

  it('is not offered by hosts that cannot build a digest', () => {
    expect(setup({}).has('get_task_digest')).toBe(false);
  });
});
