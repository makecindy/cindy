import { describe, expect, it, vi } from 'vitest';

import { createAsyncQueue } from '../../shared/async-queue.js';
import { UsageTracker } from '../../shared/usage-tracker.js';
import { detectLeakedToolCallMarkup } from '../../shared/leaked-tool-markup.js';
import {
  newRuntimeState,
  translateSdkMessage,
  type TurnState,
} from '../translator.js';
import type { AgentEvent } from '../../../types/events.js';

function createTurnState(): TurnState {
  return {
    text: '',
    toolUses: 0,
    apiCalls: 0,
    sawCompactBoundary: false,
    hasEmittedText: false,
    uiEmittedText: '',
    pendingApiError: null,
    interruptRequested: false,
    generation: 0,
    interruptGeneration: 0,
    lastAssistantMsgHadSubstance: true,
  };
}

function createCtx(tracker: UsageTracker) {
  return {
    rt: newRuntimeState(),
    turn: createTurnState(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    getModel: () => 'codex/gpt-5.5',
    getEffort: () => 'high' as const,
    getPermissionMode: () => 'auto' as const,
    onSessionId: vi.fn(),
    getSdkSessionId: () => undefined,
    getLogTitle: () => undefined,
    tracker,
    getModelContextWindow: () => 272_000,
  };
}

async function drain(queue: ReturnType<typeof createAsyncQueue<AgentEvent>>): Promise<AgentEvent[]> {
  queue.end();
  const events: AgentEvent[] = [];
  for await (const event of queue) events.push(event);
  return events;
}

/** issue #2518 实测的类 B 形态:invoke 开标签缺失前导 `<`,parameter 标签完好。 */
const CLASS_B_LEAK =
  'invoke name="Bash">\n<parameter name="command">python -c "import re; print(re.sub(r\'(\\d{4})\', lambda m: m.group(1), \'x\'))"</parameter>\n';

const NON_EMPTY_USAGE = { input_tokens: 1200, output_tokens: 340 };

function pushMessageStart(queue: ReturnType<typeof createAsyncQueue<AgentEvent>>, ctx: ReturnType<typeof createCtx>): void {
  translateSdkMessage(
    {
      type: 'stream_event',
      event: { type: 'message_start', message: { model: 'codex/gpt-5.5', usage: { input_tokens: 1200 } } },
    },
    queue,
    ctx,
  );
}

function pushResult(
  queue: ReturnType<typeof createAsyncQueue<AgentEvent>>,
  ctx: ReturnType<typeof createCtx>,
  resultText?: string,
): void {
  translateSdkMessage(
    {
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0.01,
      usage: NON_EMPTY_USAGE,
      modelUsage: {
        'codex/gpt-5.5': { inputTokens: 1200, outputTokens: 340, costUSD: 0.01, contextWindow: 272_000 },
      },
      ...(resultText !== undefined ? { result: resultText } : {}),
    },
    queue,
    ctx,
  );
}

// 收窄版检测器(维护者 2026-08-13 review 方向):只认已观测协议特征 ——
// 行首裸 invoke 开标记(缺失前导 `<`,即损坏签名)+ 其后的行首 parameter
// 开标记;不做任何 Markdown 结构解析。触发限定(零 tool_use 轮)由
// translator 层测试覆盖。
describe('detectLeakedToolCallMarkup (#2518, narrowed)', () => {
  it('hits on class B: line-start bare invoke opener followed by a parameter line', () => {
    expect(detectLeakedToolCallMarkup(CLASS_B_LEAK)).toEqual({ category: 'invoke-with-parameter' });
  });

  it('hits when the parameter opener also lost its "<"', () => {
    expect(
      detectLeakedToolCallMarkup('invoke name="Bash">\nparameter name="command">ls</parameter>'),
    ).toEqual({ category: 'invoke-with-parameter' });
  });

  it('does not hit on the complete "<invoke" form (SDK-parseable, outside observed class B)', () => {
    // 收窄:完整的 `<invoke …>` 是 SDK 能正常解析的形态,不属于已观测的
    // 损坏签名,不再纳入检测。
    expect(
      detectLeakedToolCallMarkup('<invoke name="Bash">\n<parameter name="command">ls</parameter>'),
    ).toBeNull();
  });

  it('does not hit on plain English discussion of invoke/parameter', () => {
    expect(
      detectLeakedToolCallMarkup(
        'You can invoke the function with a parameter name of your choosing; invoke it twice.',
      ),
    ).toBeNull();
  });

  it('does not hit on a lone bare invoke line without any parameter line after it', () => {
    expect(detectLeakedToolCallMarkup('invoke name="Bash"> and nothing else here')).toBeNull();
  });

  it('does not hit on a lone parameter line without a preceding bare invoke line', () => {
    expect(detectLeakedToolCallMarkup('<parameter name="command">ls</parameter> appears alone')).toBeNull();
  });

  it('does not hit when the parameter line precedes the bare invoke line', () => {
    expect(
      detectLeakedToolCallMarkup('<parameter name="command">ls</parameter>\ninvoke name="Bash">'),
    ).toBeNull();
  });

  it('does not hit on mid-line mentions (inline code span demos)', () => {
    // 行首要求:反引号 / 正文里的 `invoke name="…">` 不在行首,不构成命中。
    expect(
      detectLeakedToolCallMarkup(
        '标记形如 `invoke name="Bash">` 与 `<parameter name="command">`,注意顺序。',
      ),
    ).toBeNull();
    expect(
      detectLeakedToolCallMarkup(
        '标记语法是 `invoke name="Bash">\n<parameter name="command">ls</parameter>` 这样的形状。',
      ),
    ).toBeNull();
  });

  it('does not hit on escaped demonstrations (\\invoke / &lt;invoke)', () => {
    // 行首要求天然排除转义演示:这些行以 `\` / `&` 开头。
    expect(
      detectLeakedToolCallMarkup('\\invoke name="Bash">\n<parameter name="command">ls</parameter>'),
    ).toBeNull();
    expect(
      detectLeakedToolCallMarkup('&lt;invoke name="Bash">\n<parameter name="command">ls</parameter>'),
    ).toBeNull();
  });

  it('does not hit on uppercase variants (canonical wire markup is lowercase)', () => {
    expect(
      detectLeakedToolCallMarkup('INVOKE NAME="Bash">\n<PARAMETER NAME="command">ls</PARAMETER>'),
    ).toBeNull();
  });

  it('hits when the bare markers start lines mid-response', () => {
    expect(
      detectLeakedToolCallMarkup(`我来执行:\n${CLASS_B_LEAK}以上。`),
    ).toEqual({ category: 'invoke-with-parameter' });
  });

  it('does not hit on very short text', () => {
    expect(detectLeakedToolCallMarkup('invoke n')).toBeNull();
  });
});

describe('Claude Code translator leaked tool markup guard (#2518)', () => {
  it('emits a terminal malformed-tool-markup error but keeps Done + done for usage accounting', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    pushMessageStart(queue, ctx);
    translateSdkMessage(
      { type: 'assistant', message: { content: [{ type: 'text', text: CLASS_B_LEAK }] } },
      queue,
      ctx,
    );
    pushResult(queue, ctx);

    const events = await drain(queue);
    const err = events.find((e) => e.type === 'error');
    expect(err?.data).toMatchObject({ reason: 'malformed-tool-markup', isTerminal: true });
    // 与 empty-response 不同:本轮有真实用量,必须保留 status Done + done 保住记账
    // (is_error 失败序列同构:error → status Done → done)。
    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(
      events.some((e) => e.type === 'status' && (e.data as { status?: string }).status === 'Done'),
    ).toBe(true);
    // 匿名命中统计:日志不携带正文,只有类别与长度。
    const warn = (ctx.log.warn as ReturnType<typeof vi.fn>).mock.calls.find(([m]) =>
      String(m).includes('leaked malformed tool-call markup'),
    );
    expect(warn).toBeDefined();
    expect(JSON.stringify(warn?.[1])).not.toContain('parameter name=');
  });

  it('aggregates streaming text deltas for detection', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    pushMessageStart(queue, ctx);
    const half = Math.floor(CLASS_B_LEAK.length / 2);
    for (const chunk of [CLASS_B_LEAK.slice(0, half), CLASS_B_LEAK.slice(half)]) {
      translateSdkMessage(
        {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: chunk } },
        },
        queue,
        ctx,
      );
    }
    pushResult(queue, ctx);

    const events = await drain(queue);
    expect(events.find((e) => e.type === 'error')?.data).toMatchObject({
      reason: 'malformed-tool-markup',
      isTerminal: true,
    });
  });

  it('does not flag a normal text turn', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    pushMessageStart(queue, ctx);
    translateSdkMessage(
      { type: 'assistant', message: { content: [{ type: 'text', text: '正常回答:用 `(\\d{4})` 匹配年份即可。' }] } },
      queue,
      ctx,
    );
    pushResult(queue, ctx);

    const events = await drain(queue);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('does not flag any turn that carried a structured tool_use (narrowed trigger)', async () => {
    // 收窄(维护者 review 方向):只在没有任何结构化 tool_use 事件的回合触发。
    // 即使 tool_use 前后出现泄漏形状的文本,有 tool_use 的回合一律不判 ——
    // 已执行过工具的回合按成功收口,重发风险大于漏检代价。
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    pushMessageStart(queue, ctx);
    translateSdkMessage(
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: CLASS_B_LEAK },
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/a' } },
          ],
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      { type: 'assistant', message: { content: [{ type: 'text', text: `读完了。\n${CLASS_B_LEAK}` }] } },
      queue,
      ctx,
    );
    pushResult(queue, ctx);

    const events = await drain(queue);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('does not flag fenced markup discussion before a structured tool call', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    pushMessageStart(queue, ctx);
    translateSdkMessage(
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: `先解释一下这条被截断的调用长什么样:\n\`\`\`\n${CLASS_B_LEAK}\`\`\`\n现在实际执行。`,
            },
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/a' } },
          ],
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      { type: 'assistant', message: { content: [{ type: 'text', text: '读完了,内容正常。' }] } },
      queue,
      ctx,
    );
    pushResult(queue, ctx);

    const events = await drain(queue);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('flags a leak only present in a mismatched result body on a zero-tool turn (Greptile review)', async () => {
    // mismatch 分支:result.result 与已流式正文前缀对不上(fallbackTail 为空、
    // full 不展示),但泄漏只在 full 里时「工具没执行却按成功收口」的伤害不变
    // —— 零 tool 轮补扫 full。
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    pushMessageStart(queue, ctx);
    translateSdkMessage(
      { type: 'assistant', message: { content: [{ type: 'text', text: '我马上执行。' }] } },
      queue,
      ctx,
    );
    pushResult(queue, ctx, `完全错位的最终正文:\n${CLASS_B_LEAK}`);

    const events = await drain(queue);
    // mismatch 保守不补推正文(既有截断兜底语义不变)。
    expect(
      events.some((e) => e.type === 'text' && String((e.data as { text?: string }).text).includes('invoke')),
    ).toBe(false);
    expect(events.find((e) => e.type === 'error')?.data).toMatchObject({
      reason: 'malformed-tool-markup',
      isTerminal: true,
    });
  });

  it('flags a leak that only exists in the unstreamed result tail (Greptile review)', async () => {
    // 流式只推过正常旁白,泄漏标记只在 result.result 兜出的尾段里(该尾段上方
    // 刚补推给 UI)—— 检测必须覆盖「用户实际看到的全文」,不能只扫 emitted。
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    pushMessageStart(queue, ctx);
    const preamble = '我来执行这一步。\n';
    translateSdkMessage(
      { type: 'assistant', message: { content: [{ type: 'text', text: preamble }] } },
      queue,
      ctx,
    );
    pushResult(queue, ctx, `${preamble}${CLASS_B_LEAK}`);

    const events = await drain(queue);
    // 尾段先按流式截断兜底补推给 UI,再触发泄漏判定。
    expect(
      events.some((e) => e.type === 'text' && (e.data as { text?: string }).text === CLASS_B_LEAK),
    ).toBe(true);
    expect(events.find((e) => e.type === 'error')?.data).toMatchObject({
      reason: 'malformed-tool-markup',
      isTerminal: true,
    });
  });

  it('does not flag when the user interrupted the turn', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    pushMessageStart(queue, ctx);
    translateSdkMessage(
      { type: 'assistant', message: { content: [{ type: 'text', text: CLASS_B_LEAK }] } },
      queue,
      ctx,
    );
    ctx.turn.interruptRequested = true;
    pushResult(queue, ctx);

    const events = await drain(queue);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });
});
