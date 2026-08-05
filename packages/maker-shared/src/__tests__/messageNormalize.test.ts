import { describe, expect, it } from 'vitest';
import {
  buildMessageToolResultPairing,
  messageContentToPreview,
  messageNormalizeKey,
  parseMessageToolUse,
  sortMessagesByCreatedAt,
} from '../messageNormalize.js';

interface FixtureMessage {
  id: string;
  clientId: string;
  role: string;
  content: unknown;
  toolUseId: string | null;
  createdAt: string;
}

function message(patch: Partial<FixtureMessage> & Pick<FixtureMessage, 'id' | 'role' | 'content'>): FixtureMessage {
  return {
    clientId: patch.id,
    toolUseId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

describe('message normalize shared model', () => {
  it('builds text previews from desktop content shapes', () => {
    expect(messageContentToPreview('plain')).toBe('plain');
    expect(messageContentToPreview([
      { type: 'text', text: 'answer' },
      { type: 'thinking', thinking: 'inspect' },
      { text: 'tail' },
    ])).toBe('answer\ninspect\ntail');
    expect(messageContentToPreview({ content: 'from content' })).toBe('from content');
    expect(messageContentToPreview({ value: 1 })).toBe(JSON.stringify({ value: 1 }, null, 2));
    expect(messageContentToPreview(null)).toBe('');
  });

  it('sorts raw messages by createdAt while preserving equal-time input order', () => {
    const sameTimeA = message({ id: 'a', role: 'assistant', content: 'a', createdAt: '2026-01-01T00:00:02.000Z' });
    const older = message({ id: 'older', role: 'user', content: 'q', createdAt: '2026-01-01T00:00:01.000Z' });
    const sameTimeB = message({ id: 'b', role: 'assistant', content: 'b', createdAt: '2026-01-01T00:00:02.000Z' });

    expect(sortMessagesByCreatedAt([sameTimeA, older, sameTimeB]).map((item) => item.id)).toEqual([
      'older',
      'a',
      'b',
    ]);
  });

  it('reads stable keys and tool_use payloads from desktop-like messages', () => {
    const tool = message({
      id: '',
      clientId: 'client-tool',
      role: 'tool_use',
      toolUseId: null,
      content: { toolUseId: 'tu_1', toolName: 'Read', input: { file_path: '/repo/app.ts' } },
    });

    expect(messageNormalizeKey(tool)).toBe('client-tool');
    expect(parseMessageToolUse(tool)).toEqual({
      toolUseId: 'tu_1',
      toolName: 'Read',
      input: { file_path: '/repo/app.ts' },
    });
  });

  it('pairs tool_result by toolUseId and hides standalone results from render adapters', () => {
    const sorted = sortMessagesByCreatedAt([
      message({
        id: 'tool',
        role: 'tool_use',
        content: { toolUseId: 'tu_1', toolName: 'Read', input: { file_path: '/repo/app.ts' } },
      }),
      message({
        id: 'result',
        role: 'tool_result',
        toolUseId: 'tu_1',
        content: 'file contents',
      }),
      message({
        id: 'orphan',
        role: 'tool_result',
        content: 'orphan',
      }),
    ]);

    const pairing = buildMessageToolResultPairing(sorted);
    const tool = parseMessageToolUse(sorted[0]);

    expect(pairing.resultContentFor(sorted[0], tool)).toBe('file contents');
    expect(pairing.resultByToolUseId.get('tu_1')).toBe('file contents');
    expect(pairing.resultByToolUseId.has('missing')).toBe(false);
  });

  it('uses adjacent legacy tool_result when toolUseId is missing', () => {
    const sorted = sortMessagesByCreatedAt([
      message({
        id: 'legacy-tool',
        role: 'tool_use',
        content: { toolName: 'Read', input: { file_path: '/repo/legacy.ts' } },
        createdAt: '2026-01-01T00:00:01.000Z',
      }),
      message({
        id: 'legacy-result',
        role: 'tool_result',
        content: 'legacy file contents',
        createdAt: '2026-01-01T00:00:02.000Z',
      }),
    ]);

    const pairing = buildMessageToolResultPairing(sorted);
    expect(pairing.resultContentFor(sorted[0], parseMessageToolUse(sorted[0]))).toBe('legacy file contents');
  });

  it('suppresses empty Orca communication results but keeps user-facing details', () => {
    const sorted = sortMessagesByCreatedAt([
      message({
        id: 'orca-empty-tool',
        role: 'tool_use',
        content: { toolUseId: 'orca-empty', toolName: 'mcp__orca_worker_bridge__send_to_lead', input: {} },
      }),
      message({
        id: 'orca-empty-result',
        role: 'tool_result',
        toolUseId: 'orca-empty',
        content: JSON.stringify({ ok: true }),
      }),
      message({
        id: 'orca-detail-tool',
        role: 'tool_use',
        content: { toolUseId: 'orca-detail', toolName: 'read_lead', input: {} },
      }),
      message({
        id: 'orca-detail-result',
        role: 'tool_result',
        toolUseId: 'orca-detail',
        content: JSON.stringify({ ok: true, message: 'Lead replied: continue' }),
      }),
    ]);

    const pairing = buildMessageToolResultPairing(sorted);

    expect(pairing.resultContentFor(sorted[0], parseMessageToolUse(sorted[0]))).toBeUndefined();
    expect(pairing.resultContentFor(sorted[2], parseMessageToolUse(sorted[2]))).toBe(
      JSON.stringify({ ok: true, message: 'Lead replied: continue' }),
    );
    // 内容被隐藏 ≠ 未完成:状态判定(hasResultFor)必须计入被隐藏的 orca 空结果,
    // 否则这类工具行会永久显示进行中(桌面 #454 settledIds 的同款回归)。
    expect(pairing.hasResultFor(sorted[0], parseMessageToolUse(sorted[0]))).toBe(true);
  });

  it('reports settled state via hasResultFor for id, adjacency and pending tools', () => {
    const sorted = sortMessagesByCreatedAt([
      message({
        id: 'tool-done',
        role: 'tool_use',
        content: { toolUseId: 'tu_done', toolName: 'Read', input: { file_path: '/repo/a.ts' } },
        createdAt: '2026-01-01T00:00:01.000Z',
      }),
      message({
        id: 'result-done',
        role: 'tool_result',
        toolUseId: 'tu_done',
        content: 'contents',
        createdAt: '2026-01-01T00:00:02.000Z',
      }),
      message({
        id: 'legacy-tool',
        role: 'tool_use',
        content: { toolName: 'Read', input: { file_path: '/repo/b.ts' } },
        createdAt: '2026-01-01T00:00:03.000Z',
      }),
      message({
        id: 'legacy-result',
        role: 'tool_result',
        content: 'legacy contents',
        createdAt: '2026-01-01T00:00:04.000Z',
      }),
      message({
        id: 'tool-pending',
        role: 'tool_use',
        content: { toolUseId: 'tu_pending', toolName: 'Bash', input: { command: 'sleep 10' } },
        createdAt: '2026-01-01T00:00:05.000Z',
      }),
    ]);

    const pairing = buildMessageToolResultPairing(sorted);

    expect(pairing.hasResultFor(sorted[0], parseMessageToolUse(sorted[0]))).toBe(true);
    expect(pairing.hasResultFor(sorted[2], parseMessageToolUse(sorted[2]))).toBe(true);
    expect(pairing.hasResultFor(sorted[4], parseMessageToolUse(sorted[4]))).toBe(false);
  });

  it('adjacency-pairs secondary tools of a merged multi-id result (PR #495 review)', () => {
    // desktop 持久层把一条 tool_result 归并多个 toolUseId 时只存 primary id:
    // secondary 工具(带自己的 id、byId 配不到)靠邻接兜底拿共享结果与 settled,
    // 与 desktop MessageStream Pass 2 口径一致。
    const sorted = sortMessagesByCreatedAt([
      message({
        id: 'use-a',
        role: 'tool_use',
        content: { toolUseId: 'tu_a', toolName: 'Read', input: { file_path: '/repo/a.ts' } },
        createdAt: '2026-01-01T00:00:01.000Z',
      }),
      message({
        id: 'use-b',
        role: 'tool_use',
        content: { toolUseId: 'tu_b', toolName: 'Read', input: { file_path: '/repo/b.ts' } },
        createdAt: '2026-01-01T00:00:02.000Z',
      }),
      // 合并行:代表 tu_a + tu_b,持久层只写 primary id tu_a。
      message({
        id: 'merged-result',
        role: 'tool_result',
        toolUseId: 'tu_a',
        content: 'merged contents of a and b',
        createdAt: '2026-01-01T00:00:03.000Z',
      }),
    ]);

    const pairing = buildMessageToolResultPairing(sorted);
    const secondaryB = parseMessageToolUse(sorted[1]);

    // primary 按 id 配对。
    expect(pairing.resultContentFor(sorted[0], parseMessageToolUse(sorted[0]))).toBe('merged contents of a and b');
    // secondary 靠邻接兜底:拿到共享内容,且计入 settled(不转圈)。
    expect(pairing.resultContentFor(sorted[1], secondaryB)).toBe('merged contents of a and b');
    expect(pairing.hasResultFor(sorted[1], secondaryB)).toBe(true);
  });

  it('does not let adjacency override a tool already settled by id, including hidden results', () => {
    // byId 已 settled(结果被 orca 空结果滤网隐藏)的工具,不得再被相邻其它
    // 工具的 result 邻接覆盖 —— 否则会展示别人的内容。
    const sorted = sortMessagesByCreatedAt([
      message({
        id: 'orca-tool',
        role: 'tool_use',
        content: { toolUseId: 'tu_orca', toolName: 'send_to_lead', input: {} },
        createdAt: '2026-01-01T00:00:01.000Z',
      }),
      message({
        id: 'orca-result',
        role: 'tool_result',
        toolUseId: 'tu_orca',
        content: JSON.stringify({ ok: true }),
        createdAt: '2026-01-01T00:00:02.000Z',
      }),
      message({
        id: 'other-result',
        role: 'tool_result',
        toolUseId: 'tu_other',
        content: 'someone else result',
        createdAt: '2026-01-01T00:00:03.000Z',
      }),
    ]);

    const pairing = buildMessageToolResultPairing(sorted);
    const orcaTool = parseMessageToolUse(sorted[0]);

    // 内容保持隐藏(不借用相邻行),settled 仍成立。
    expect(pairing.resultContentFor(sorted[0], orcaTool)).toBeUndefined();
    expect(pairing.hasResultFor(sorted[0], orcaTool)).toBe(true);
  });
});
