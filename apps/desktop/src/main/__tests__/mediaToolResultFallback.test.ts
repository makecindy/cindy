/**
 * mediaToolResultFallback 单测:媒体结果暂存池的记录 / 按 args 确定性认领 /
 * 一次性消费语义。背景:tool_result 的 stdout echo 可能被日志污染损坏丢失,
 * 池子是 turn 末兜底落库的数据源(见实现文件头注释)。
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  clearMediaToolResultsForSession,
  discardMediaToolResultForToolUse,
  recordMediaToolResult,
  recordMediaToolResultForToolUse,
  takeMediaToolResult,
  __resetMediaToolResultPoolForTesting,
} from '../mcp-integrations/mediaToolResultFallback.js';

const MIVO_RESULT = '{"ok":true,"jobId":"6a47bf88","xdt_image_urls":["xdt-image://lizi-art-media-images/a.png"]}';
const ART_RESULT = '{"ok":true,"xdt_image_urls":["xdt-image://lizi-art-media-images/b.png"]}';

beforeEach(() => {
  __resetMediaToolResultPoolForTesting();
});

describe('mediaToolResultFallback', () => {
  it('mivo call_tool 形态:tool_use input.args.jobId 命中认领', () => {
    recordMediaToolResult({ args: { jobId: '6a47bf88' }, resultText: MIVO_RESULT });
    const got = takeMediaToolResult({
      name: 'poll_result',
      args: { jobId: '6a47bf88', timeout: 30 }, // 额外键(timeout)允许
    });
    expect(got).toBe(MIVO_RESULT);
  });

  it('art 直接参数形态:request 全键匹配 input', () => {
    const request = { model: 'gpt-image-2', prompt: '画一只猫', size: '1536x1024', quality: 'high', n: 1 };
    recordMediaToolResult({ args: request, resultText: ART_RESULT });
    // art 经 call_tool 包装:input.args 就是 request 同构对象
    expect(takeMediaToolResult({ name: 'image_generate', args: { ...request } })).toBe(ART_RESULT);
  });

  it('mivo_button_action 形态:按 {messageId, customId} 认领(prompt 等额外键允许)', () => {
    // 按钮动作的 tool_use args 没有 jobId 键 — 只能靠工具自己按
    // {messageId, customId} 二次登记的条目认领(2026-07 实踩回归)。
    const CUSTOM_ID = 'NANOBANANA::image::imgPrompt::0::6a47ef05b43f1554f668c562';
    recordMediaToolResult({
      args: { messageId: '6a47eeec1e560c75c5ba3f91', customId: CUSTOM_ID },
      resultText: MIVO_RESULT,
    });
    // drain 内部登记的 { jobId } 条目(新任务 id,与 messageId 不同)不该被误认领
    recordMediaToolResult({ args: { jobId: '6a47ef241f2ee905cdba417e' }, resultText: 'wrong' });
    const got = takeMediaToolResult({
      name: 'mivo_button_action',
      args: {
        messageId: '6a47eeec1e560c75c5ba3f91',
        customId: CUSTOM_ID,
        prompt: '变成男生',
      },
    });
    expect(got).toBe(MIVO_RESULT);
  });

  it('同键重复登记(同按钮 TTL 内二次触发)→ 认领最近一次的结果', () => {
    // 同一按钮 15 分钟内点两次、第二次 echo 丢失:认领必须拿到第二次的
    // 结果,不能命中第一次遗留的旧条目(greptile P1 / codex P2 场景)。
    const KEY = { messageId: 'msg-1', customId: 'MJ::image::reroll::0::abc' };
    recordMediaToolResult({ args: { ...KEY }, resultText: 'stale-first' });
    recordMediaToolResult({ args: { ...KEY }, resultText: MIVO_RESULT });
    expect(takeMediaToolResult({ name: 'mivo_button_action', args: { ...KEY } })).toBe(MIVO_RESULT);
  });

  it('imgPrompt 换提示词重复触发:登记键含 prompt 时按 prompt 区分,不认领旧条目', () => {
    const BASE = { messageId: 'msg-2', customId: 'NANOBANANA::image::imgPrompt::0::def' };
    recordMediaToolResult({ args: { ...BASE, prompt: '变成男生' }, resultText: 'stale-first' });
    recordMediaToolResult({ args: { ...BASE, prompt: '变成女生' }, resultText: MIVO_RESULT });
    // 第二次点击的 tool_use(prompt=变成女生)只能配上第二份条目
    expect(
      takeMediaToolResult({ name: 'mivo_button_action', args: { ...BASE, prompt: '变成女生' } }),
    ).toBe(MIVO_RESULT);
    // 旧条目仍在池中且只配得上旧 prompt 的 tool_use,不会串
    expect(
      takeMediaToolResult({ name: 'mivo_button_action', args: { ...BASE, prompt: '变成男生' } }),
    ).toBe('stale-first');
  });

  it('args 值不一致 → 不认领(不同 jobId 不串)', () => {
    recordMediaToolResult({ args: { jobId: 'job-A' }, resultText: MIVO_RESULT });
    expect(takeMediaToolResult({ name: 'poll_result', args: { jobId: 'job-B' } })).toBeNull();
  });

  it('ghost_call 按完整工具名和 input 精确认领，包括空 args', () => {
    const toolName = 'mcp__cindy__ghost_call';
    const toolUseInput = { ghost_id: 'cindy-art', tool: 'generate', args: {} };
    recordMediaToolResultForToolUse({
      sessionId: 'session-a',
      toolName,
      toolUseInput,
      resultText: ART_RESULT,
    });

    expect(takeMediaToolResult(toolUseInput, 'mcp__other__ghost_call')).toBeNull();
    expect(
      takeMediaToolResult(toolUseInput, 'mcp:cindy:ghost_call', undefined, 'session-b'),
    ).toBeNull();
    expect(
      takeMediaToolResult(
        { ...toolUseInput, args: {} },
        'mcp:cindy:ghost_call',
        undefined,
        'session-a',
      ),
    ).toBe(ART_RESULT);
  });

  it('ghost_call 有 toolUseId 时拒绝同 input 的其他调用认领', () => {
    const toolName = 'mcp:cindy:ghost_call';
    const toolUseInput = { ghost_id: 'cindy-art', tool: 'generate', args: {} };
    recordMediaToolResultForToolUse({
      sessionId: 'session-a',
      toolName: 'mcp__cindy__ghost_call',
      toolUseId: 'tu-media-1',
      toolUseInput,
      resultText: ART_RESULT,
    });

    expect(takeMediaToolResult(toolUseInput, toolName, 'tu-media-1', 'session-b')).toBeNull();
    expect(takeMediaToolResult(toolUseInput, toolName, 'tu-media-2', 'session-a')).toBeNull();
    expect(takeMediaToolResult(toolUseInput, toolName, 'tu-media-1', 'session-a')).toBe(
      ART_RESULT,
    );
  });

  it('ghost_call 正常 echo 只消费同 session 的对应 fallback', () => {
    const toolUseInput = { ghost_id: 'cindy-art', tool: 'generate', args: {} };
    recordMediaToolResultForToolUse({
      sessionId: 'session-a',
      toolName: 'mcp__cindy__ghost_call',
      toolUseInput,
      resultText: ART_RESULT,
    });

    discardMediaToolResultForToolUse(
      toolUseInput,
      'mcp:cindy:ghost_call',
      'tu-media-echoed',
      'session-b',
      ART_RESULT,
    );
    expect(
      takeMediaToolResult(toolUseInput, 'mcp:cindy:ghost_call', 'tu-media-retry', 'session-a'),
    ).toBe(ART_RESULT);

    recordMediaToolResultForToolUse({
      sessionId: 'session-a',
      toolName: 'mcp__cindy__ghost_call',
      toolUseInput,
      resultText: ART_RESULT,
    });
    discardMediaToolResultForToolUse(
      toolUseInput,
      'mcp:cindy:ghost_call',
      'tu-media-echoed',
      'session-a',
      ART_RESULT,
    );
    expect(
      takeMediaToolResult(toolUseInput, 'mcp:cindy:ghost_call', 'tu-media-retry', 'session-a'),
    ).toBeNull();
  });

  it('ghost_call 无 toolUseId 的并发同参结果必须先由 echo 正文消歧', () => {
    const toolUseInput = { ghost_id: 'cindy-art', tool: 'generate', args: {} };
    recordMediaToolResultForToolUse({
      sessionId: 'session-a',
      toolName: 'mcp:cindy:ghost_call',
      toolUseInput,
      resultText: 'first-result',
    });
    recordMediaToolResultForToolUse({
      sessionId: 'session-a',
      toolName: 'mcp:cindy:ghost_call',
      toolUseInput,
      resultText: 'second-result',
    });

    expect(
      takeMediaToolResult(toolUseInput, 'mcp:cindy:ghost_call', 'tu-2', 'session-a'),
    ).toBeNull();
    discardMediaToolResultForToolUse(
      toolUseInput,
      'mcp:cindy:ghost_call',
      'tu-1',
      'session-a',
      'first-result',
    );
    expect(
      takeMediaToolResult(toolUseInput, 'mcp:cindy:ghost_call', 'tu-2', 'session-a'),
    ).toBe('second-result');
  });

  it('turn 收口只清除指定 session 的 ghost_call fallback', () => {
    const toolUseInput = { ghost_id: 'cindy-art', tool: 'generate', args: {} };
    for (const sessionId of ['session-a', 'session-b']) {
      recordMediaToolResultForToolUse({
        sessionId,
        toolName: 'mcp:cindy:ghost_call',
        toolUseInput,
        resultText: `${sessionId}-result`,
      });
    }

    clearMediaToolResultsForSession('session-a');
    expect(
      takeMediaToolResult(toolUseInput, 'mcp:cindy:ghost_call', 'tu-a', 'session-a'),
    ).toBeNull();
    expect(
      takeMediaToolResult(toolUseInput, 'mcp:cindy:ghost_call', 'tu-b', 'session-b'),
    ).toBe('session-b-result');
  });

  it('一次性消费:同一条目不会被认领两次', () => {
    recordMediaToolResult({ args: { jobId: 'job-1' }, resultText: MIVO_RESULT });
    expect(takeMediaToolResult({ args: { jobId: 'job-1' } })).toBe(MIVO_RESULT);
    expect(takeMediaToolResult({ args: { jobId: 'job-1' } })).toBeNull();
  });

  it('无 args 交集 / 非对象 input → null,不 throw', () => {
    recordMediaToolResult({ args: { jobId: 'job-2' }, resultText: MIVO_RESULT });
    expect(takeMediaToolResult({ args: { other: 'x' } })).toBeNull();
    expect(takeMediaToolResult(null)).toBeNull();
    expect(takeMediaToolResult('str')).toBeNull();
  });
});
