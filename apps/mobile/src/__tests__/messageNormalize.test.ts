import { beforeAll, describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import {
  CONTINUE_AFTER_ERROR_PROMPT,
  UI_ACTION_TRIGGER_PREFIX,
} from '@cindy/maker-shared/synthetic-trigger';
import { composerDocumentFromSerializedMessage } from '@/session/composerDocument';
import { buildMobileMessageCopyText } from '@/session/messageActions';
import { normalizeRemoteMessages } from '@/session/messageNormalize';
import { buildMobileMessageRenderItems } from '@/session/messageRenderModel';
import {
  MOBILE_TOOL_INPUT_PROJECTION_THRESHOLD_BYTES,
  projectLargeSettledToolInputs,
} from '@/session/messageToolPayloadProjection';
import type { RemoteMessage } from '@/session/types';

function message(patch: Partial<RemoteMessage> & Pick<RemoteMessage, 'id' | 'role' | 'content'>): RemoteMessage {
  return {
    clientId: patch.id,
    sessionId: 's1',
    toolUseId: null,
    agentMeta: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

describe('normalizeRemoteMessages', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('zh-CN');
  });

  it('renders a projected large tool input from its bounded summary and keeps its result', () => {
    const projected = projectLargeSettledToolInputs([
      message({
        id: 'large-tool',
        role: 'tool_use',
        toolUseId: 'toolu-large',
        content: {
          input: { payload: 'x'.repeat(MOBILE_TOOL_INPUT_PROJECTION_THRESHOLD_BYTES + 1) },
          toolName: 'WebFetch',
          toolUseId: 'toolu-large',
        },
      }),
      message({
        id: 'large-result',
        role: 'tool_result',
        toolUseId: 'toolu-large',
        content: 'finished',
        createdAt: '2026-01-01T00:00:01.000Z',
      }),
    ]);

    const [item] = normalizeRemoteMessages(projected);
    expect(item).toMatchObject({
      kind: 'tool',
      label: 'WebFetch',
      secondaryBody: 'finished',
      toolSettled: true,
      toolInputProjection: {
        projected: true,
        toolUseMessageId: 'large-tool',
      },
    });
    expect(item.body.length).toBeLessThanOrEqual(480);
  });

  it('projects a persisted agent task terminal state from tool_use metadata', () => {
    const [item] = normalizeRemoteMessages([
      message({
        id: 'agent-tool',
        role: 'tool_use',
        toolUseId: 'toolu-agent',
        content: { toolUseId: 'toolu-agent', toolName: 'Agent', input: { prompt: 'Inspect auth' } },
        agentMeta: { agentTaskStatus: 'stopped' },
      }),
    ]);

    expect(item).toMatchObject({
      kind: 'tool',
      label: 'Agent',
      agentTaskStatus: 'stopped',
    });
  });

  it('sorts messages and extracts user/assistant text from desktop content shapes', () => {
    const items = normalizeRemoteMessages([
      message({
        id: 'm2',
        role: 'assistant',
        content: [{ type: 'text', text: 'answer' }],
        createdAt: '2026-01-01T00:00:02.000Z',
      }),
      message({
        id: 'm1',
        role: 'user',
        content: { text: 'question', images: [] },
        createdAt: '2026-01-01T00:00:01.000Z',
      }),
    ]);

    expect(items.map((item) => [item.kind, item.body, item.align])).toEqual([
      ['user', 'question', 'user'],
      ['assistant', 'answer', 'agent'],
    ]);
  });

  it('extracts assistant turn cost from desktop agentMeta', () => {
    const items = normalizeRemoteMessages([
      message({
        id: 'with-cost',
        role: 'assistant',
        content: 'answer',
        agentMeta: { turnCostUsd: 0.05, turnCostIsEstimate: true },
      }),
      message({
        id: 'zero-cost',
        role: 'assistant',
        content: 'free',
        agentMeta: { turnCostUsd: 0 },
      }),
      message({
        id: 'user-cost-ignored',
        role: 'user',
        content: 'question',
        agentMeta: { turnCostUsd: 0.07 },
      }),
      message({
        id: 'with-cny-cost',
        role: 'assistant',
        content: '人民币费用',
        agentMeta: {
          turnCost: {
            amount: 0.29,
            currency: 'CNY',
            approximate: false,
            kind: 'actual-cost',
          },
        },
      }),
    ]);

    expect(items[0]).toMatchObject({
      kind: 'assistant',
      turnCostUsd: 0.05,
      turnMoney: {
        approximate: true,
        kind: 'value-estimate',
      },
    });
    expect(items[1].turnCostUsd).toBeUndefined();
    expect(items[2].turnCostUsd).toBeUndefined();
    expect(items[3]).toMatchObject({
      turnMoney: {
        amount: 0.29,
        currency: 'CNY',
        approximate: false,
        kind: 'actual-cost',
      },
    });
    expect(items[3].turnCostUsd).toBeUndefined();
  });

  // 桌面算不出模型报价的轮次只落 turnUsageDetails:操作行据此退回显示本轮 token,
  // 且它同样是 turn 收尾信号(否则那条消息挂不出操作行)。
  it('extracts assistant turn tokens when desktop could not price the turn', () => {
    const items = normalizeRemoteMessages([
      message({
        id: 'usage-only',
        role: 'assistant',
        content: 'answer',
        agentMeta: {
          turnUsageDetails: {
            inputTokens: 12_400,
            outputTokens: 8_900,
            cacheReadTokens: 2_000_000,
            cacheCreateTokens: 86_400,
            totalTokens: 2_107_700,
            cacheHitRate: 0.95,
          },
        },
      }),
      message({
        id: 'usage-and-cost',
        role: 'assistant',
        content: 'answer',
        agentMeta: {
          turnCostUsd: 0.42,
          turnUsageDetails: { totalTokens: 1_000 },
        },
      }),
      message({
        id: 'zero-tokens',
        role: 'assistant',
        content: 'answer',
        agentMeta: { turnUsageDetails: { totalTokens: 0 } },
      }),
      message({
        id: 'malformed-usage',
        role: 'assistant',
        content: 'answer',
        agentMeta: { turnUsageDetails: 'not-an-object' },
      }),
    ]);

    expect(items[0]).toMatchObject({
      kind: 'assistant',
      turnTotalTokens: 2_107_700,
      // 无报价轮也必须被认成收尾,否则操作行整条不出现。
      turnCompleted: true,
    });
    expect(items[0].turnMoney).toBeUndefined();
    // 有钱的轮次两者并存:金额优先展示,token 明细留给 tooltip / 回退判定。
    expect(items[1]).toMatchObject({ turnCostUsd: 0.42, turnTotalTokens: 1_000 });
    expect(items[2].turnTotalTokens).toBeUndefined();
    expect(items[3].turnTotalTokens).toBeUndefined();
  });

  // 整轮累计与当前 segment 是两个独立事实(不变量正本见
  // apps/desktop/src/shared/turnCostPayload.ts):操作行只挂在收尾正文上,它要承载整轮
  // 总额;收尾 segment 缺报价的轮次更是只有 userTurnCost —— 不读它就会用 token 把已经
  // 花掉的钱顶掉。
  it('prefers the user-round total over the trailing segment cost', () => {
    const items = normalizeRemoteMessages([
      message({
        id: 'usage-only-with-total',
        role: 'assistant',
        content: 'answer',
        agentMeta: {
          userTurnCost: { amount: 1.25, currency: 'USD', approximate: false, kind: 'actual-cost' },
          userTurnCostUsd: 1.25,
          userTurnCostIsEstimate: true,
          turnUsageDetails: { totalTokens: 2_100_000 },
        },
      }),
      message({
        id: 'total-wins-over-segment',
        role: 'assistant',
        content: 'answer',
        agentMeta: {
          turnCostUsd: 0.3,
          userTurnCostUsd: 1.8,
          userTurnCostIsEstimate: false,
        },
      }),
    ]);

    // 无当前分段金额,但整轮已经花过钱 → 显示金额,不回退 token。
    expect(items[0]).toMatchObject({
      turnCostUsd: 1.25,
      turnTotalTokens: 2_100_000,
      turnCompleted: true,
    });
    expect(items[0].turnMoney).toMatchObject({
      amount: 1.25,
      currency: 'USD',
      approximate: true,
      kind: 'value-estimate',
    });
    // 两者都有时取整轮累计(与桌面 displayedMoney 同口径)。
    expect(items[1].turnCostUsd).toBe(1.8);
  });

  it('preserves assistant streaming state from desktop message metadata and content', () => {
    const items = normalizeRemoteMessages([
      message({
        id: 'agent-meta-streaming',
        role: 'assistant',
        content: 'partial from agent meta',
        agentMeta: { isStreaming: true },
      }),
      message({
        id: 'content-streaming',
        role: 'assistant',
        content: { text: 'partial from content', streaming: true },
      }),
      message({
        id: 'finished',
        role: 'assistant',
        content: 'done',
      }),
    ]);

    expect(items.map((item) => item.isStreaming)).toEqual([true, true, undefined]);
  });

  it('extracts user image and file attachments from persisted content JSON', () => {
    const items = normalizeRemoteMessages([
      message({
        id: 'm1',
        role: 'user',
        content: JSON.stringify({
          text: 'check these',
          images: [
            { url: 'https://example.com/a.png', originalName: 'a.png', mimeType: 'image/png' },
            { url: 'xdt-image://local/b.png', originalName: 'b.png', mimeType: 'image/png' },
          ],
          files: [
            { name: 'spec.md', path: '/repo/spec.md' },
            {
              name: 'voice.ogg',
              path: 'cindy-media://blobs/aa11bb22.ogg',
              mimeType: 'audio/ogg',
            },
          ],
        }),
      }),
    ]);

    expect(items[0].body).toBe('check these');
    expect(items[0].attachments).toEqual([
      {
        kind: 'image',
        name: 'a.png',
        uri: 'https://example.com/a.png',
        mimeType: 'image/png',
        previewable: true,
      },
      {
        kind: 'image',
        name: 'b.png',
        uri: 'xdt-image://local/b.png',
        mimeType: 'image/png',
        previewable: false,
      },
      {
        kind: 'file',
        name: 'spec.md',
        path: '/repo/spec.md',
        mimeType: undefined,
        previewable: false,
      },
      {
        kind: 'file',
        name: 'voice.ogg',
        path: 'cindy-media://blobs/aa11bb22.ogg',
        mimeType: 'audio/ogg',
        previewable: false,
      },
    ]);
  });

  it('preserves the desktop-compatible quote encoding flag', () => {
    const [item] = normalizeRemoteMessages([
      message({
        id: 'quoted-user',
        role: 'user',
        content: JSON.stringify({
          text: '> <!-- cindy-composer-quote -->\n> selected\n\nreply',
          images: [],
          files: [],
          quotesEncoded: true,
        }),
      }),
    ]);

    expect(item).toMatchObject({
      kind: 'user',
      quotesEncoded: true,
    });
  });

  it('keeps only display-safe persisted session-reference metadata', () => {
    const [valid, invalid] = normalizeRemoteMessages([
      message({
        id: 'valid-reference',
        role: 'user',
        content: JSON.stringify({
          text: 'cindy://session/source?message=anchor',
          images: [],
          files: [],
          sessionReferences: [{
            sessionId: 'source',
            messageClientId: 'anchor',
            range: 'around-anchor',
            messageCount: 3,
            truncated: true,
          }],
        }),
      }),
      message({
        id: 'invalid-reference',
        role: 'user',
        createdAt: '2026-01-01T00:00:01.000Z',
        content: JSON.stringify({
          text: 'cindy://session/source',
          sessionReferences: [{
            sessionId: 'source',
            range: 'recent',
            messageCount: 999,
            truncated: false,
            messages: [{ role: 'user', content: 'must never enter UI metadata' }],
          }],
        }),
      }),
    ]);

    expect(valid.sessionReferences).toEqual([{
      sessionId: 'source',
      messageClientId: 'anchor',
      range: 'around-anchor',
      messageCount: 3,
      truncated: true,
    }]);
    expect(invalid.sessionReferences).toEqual([]);
  });

  it('preserves valid pasted-text and exact slash presentation ranges', () => {
    const text = '/help before long text after';
    const [item] = normalizeRemoteMessages([
      message({
        id: 'atomic-user',
        role: 'user',
        content: JSON.stringify({
          text,
          images: [],
          files: [],
          pastedTextRanges: [{ start: 13, end: 22, display: 'Pasted text (1 line)' }],
          slashCommandRanges: [{ start: 0, end: 5 }],
        }),
      }),
    ]);

    expect(item).toMatchObject({
      pastedTextRanges: [{ start: 13, end: 22, display: 'Pasted text (1 line)' }],
      slashCommandRanges: [{ start: 0, end: 5 }],
    });
  });

  it('preserves message reference semantics when fork or rewind rebuilds the composer', () => {
    const href = 'cindy://session/session-a?message=message-a';
    const text = `inspect ${href}`;
    const reference = {
      kind: 'message' as const,
      start: text.indexOf(href),
      end: text.length,
      href,
      sessionId: 'session-a',
      messageClientId: 'message-a',
      text: 'Target message body',
    };
    const [item] = normalizeRemoteMessages([
      message({
        id: 'referenced-user',
        role: 'user',
        content: JSON.stringify({
          text,
          images: [],
          files: [],
          agentReferences: [reference],
        }),
      }),
    ]);

    expect(item.agentReferences).toEqual([reference]);
    expect(composerDocumentFromSerializedMessage(item.body, {
      agentReferences: item.agentReferences,
    }).nodes).toEqual([
      { type: 'text', text: 'inspect ' },
      {
        type: 'session-link',
        href,
        label: 'Target message body',
        messageClientId: 'message-a',
        titled: true,
        agentText: 'Target message body',
      },
    ]);
  });

  it('drops malformed atom ranges as whole sets while preserving explicit empty slash metadata', () => {
    const [item] = normalizeRemoteMessages([
      message({
        id: 'malformed-atomic-user',
        role: 'user',
        content: {
          text: 'abcdef',
          images: [],
          files: [],
          pastedTextRanges: [{ start: 1, end: 4, display: 'first' }, { start: 3, end: 5, display: 'overlap' }],
          slashCommandRanges: [],
        },
      }),
    ]);

    expect(item.pastedTextRanges).toBeUndefined();
    expect(item.slashCommandRanges).toEqual([]);
  });

  it('summarizes tool_use, attaches matching tool_result, and hides standalone tool_result', () => {
    const items = normalizeRemoteMessages([
      message({
        id: 'tool-1',
        role: 'tool_use',
        content: { toolUseId: 'tu_1', toolName: 'Read', input: { file_path: '/repo/src/app.ts' } },
      }),
      message({
        id: 'result-1',
        role: 'tool_result',
        toolUseId: 'tu_1',
        content: 'file contents',
      }),
      message({
        id: 'orphan-result',
        role: 'tool_result',
        content: 'orphan',
      }),
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'tool',
      label: 'Read',
      body: 'Read(/repo/src/app.ts)',
      secondaryBody: 'file contents',
      toolSettled: true,
    });
  });

  it('renders and copies compacted tool results without exposing the internal marker', () => {
    const [item] = normalizeRemoteMessages([
      message({
        id: 'tool-compacted',
        role: 'tool_use',
        content: {
          toolUseId: 'tu_compacted',
          toolName: 'Read',
          input: { file_path: '/repo/a.ts' },
        },
      }),
      message({
        id: 'result-compacted',
        role: 'tool_result',
        toolUseId: 'tu_compacted',
        content: {
          type: 'tool_result_compacted',
          version: 1,
          originalBytes: 128 * 1024,
          compactedAt: 500,
        },
      }),
    ]);

    expect(item.secondaryBody).toBe('Full tool output was released (original size 128 KB)');
    expect(buildMobileMessageCopyText(item)).toContain(
      'Full tool output was released (original size 128 KB)',
    );
    expect(buildMobileMessageCopyText(item)).not.toContain('tool_result_compacted');
  });

  it('marks tools settled by result arrival, including hidden orca empty results', () => {
    const items = normalizeRemoteMessages([
      message({
        id: 'tool-pending',
        role: 'tool_use',
        content: { toolUseId: 'tu_pending', toolName: 'Bash', input: { command: 'sleep 10' } },
        createdAt: '2026-01-01T00:00:01.000Z',
      }),
      message({
        id: 'orca-tool',
        role: 'tool_use',
        content: { toolUseId: 'tu_orca', toolName: 'mcp__orca_worker_bridge__send_to_lead', input: {} },
        createdAt: '2026-01-01T00:00:02.000Z',
      }),
      message({
        id: 'orca-result',
        role: 'tool_result',
        toolUseId: 'tu_orca',
        content: JSON.stringify({ ok: true }),
        createdAt: '2026-01-01T00:00:03.000Z',
      }),
    ]);

    expect(items).toHaveLength(2);
    // 结果未到:未 settled(流式中渲染层显示进行中)。
    expect(items[0]).toMatchObject({ kind: 'tool', toolSettled: false });
    // orca 空结果内容被隐藏,但工具已完成 —— settled 必须为 true,防永久转圈。
    expect(items[1]).toMatchObject({ kind: 'tool', secondaryBody: undefined, toolSettled: true });
  });

  it('uses adjacent tool_result as legacy fallback when toolUseId is missing', () => {
    const items = normalizeRemoteMessages([
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
      message({
        id: 'unrelated',
        role: 'assistant',
        content: 'done',
        createdAt: '2026-01-01T00:00:03.000Z',
      }),
    ]);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      kind: 'tool',
      label: 'Read',
      body: 'Read(/repo/legacy.ts)',
      secondaryBody: 'legacy file contents',
    });
    expect(items[1]).toMatchObject({ kind: 'assistant', body: 'done' });
  });

  it('hides empty Orca communication results while preserving user-facing details', () => {
    const items = normalizeRemoteMessages([
      message({
        id: 'orca-tool-empty',
        role: 'tool_use',
        toolUseId: 'orca-empty',
        content: {
          toolUseId: 'orca-empty',
          toolName: 'mcp__orca_worker_bridge__send_to_lead',
          input: { message: 'please inspect the diff' },
        },
      }),
      message({
        id: 'orca-result-empty',
        role: 'tool_result',
        toolUseId: 'orca-empty',
        content: JSON.stringify({ ok: true }),
      }),
      message({
        id: 'orca-tool-detail',
        role: 'tool_use',
        toolUseId: 'orca-detail',
        content: {
          toolUseId: 'orca-detail',
          toolName: 'read_lead',
          input: {},
        },
      }),
      message({
        id: 'orca-result-detail',
        role: 'tool_result',
        toolUseId: 'orca-detail',
        content: JSON.stringify({ ok: true, message: 'Lead replied: go ahead' }),
      }),
    ]);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      kind: 'tool',
      label: 'mcp__orca_worker_bridge__send_to_lead',
      secondaryBody: undefined,
    });
    expect(items[1]).toMatchObject({
      kind: 'tool',
      label: 'read_lead',
      secondaryBody: JSON.stringify({ ok: true, message: 'Lead replied: go ahead' }),
    });
  });

  it('extracts tool result media and edit diff payloads', () => {
    const items = normalizeRemoteMessages([
      message({
        id: 'edit',
        role: 'tool_use',
        content: {
          toolUseId: 'tu_edit',
          toolName: 'Edit',
          input: { file_path: '/repo/app.ts', old_string: 'old line', new_string: 'new line' },
        },
      }),
      message({
        id: 'edit-result',
        role: 'tool_result',
        toolUseId: 'tu_edit',
        content: JSON.stringify({
          ok: true,
          xdt_image_urls: ['xdt-image://lizi-art-media-images/a.png'],
          xdt_video_urls: ['xdt-video://lizi-art-media-videos/v.mp4'],
        }),
      }),
    ]);

    expect(items[0].diff).toEqual({
      filePath: '/repo/app.ts',
      segments: [{ key: 'edit:0', oldString: 'old line', newString: 'new line' }],
      insertions: 1,
      deletions: 1,
    });
    expect(items[0].media).toEqual([
      {
        kind: 'image',
        url: 'xdt-image://lizi-art-media-images/a.png',
        title: undefined,
        previewable: false,
      },
      {
        kind: 'video',
        url: 'xdt-video://lizi-art-media-videos/v.mp4',
        title: undefined,
        previewable: false,
      },
    ]);
  });

  it('keeps tool image fallback unless the same turn embeds that URL as Markdown', () => {
    const url = `cindy-media://blobs/${'a'.repeat(64)}.png`;
    const items = normalizeRemoteMessages([
      message({ id: 'u1', role: 'user', content: 'draw one', createdAt: '2026-01-01T00:00:01.000Z' }),
      message({
        id: 'tool-1',
        role: 'tool_use',
        toolUseId: 'tu-1',
        content: { toolUseId: 'tu-1', toolName: 'image_generate', input: {} },
        createdAt: '2026-01-01T00:00:02.000Z',
      }),
      message({
        id: 'result-1',
        role: 'tool_result',
        toolUseId: 'tu-1',
        content: JSON.stringify({ xdt_image_url: url }),
        createdAt: '2026-01-01T00:00:03.000Z',
      }),
      message({
        id: 'steer-1',
        role: 'user',
        content: 'make it warmer',
        agentMeta: { delivery: 'steer' },
        createdAt: '2026-01-01T00:00:03.500Z',
      }),
      message({
        id: 'a1',
        role: 'assistant',
        content: `![生成结果](${url})`,
        createdAt: '2026-01-01T00:00:04.000Z',
      }),
      message({ id: 'u2', role: 'user', content: 'draw again', createdAt: '2026-01-01T00:00:05.000Z' }),
      message({
        id: 'tool-2',
        role: 'tool_use',
        toolUseId: 'tu-2',
        content: { toolUseId: 'tu-2', toolName: 'image_generate', input: {} },
        createdAt: '2026-01-01T00:00:06.000Z',
      }),
      message({
        id: 'result-2',
        role: 'tool_result',
        toolUseId: 'tu-2',
        content: JSON.stringify({ xdt_image_url: url }),
        createdAt: '2026-01-01T00:00:07.000Z',
      }),
      message({
        id: 'a2',
        role: 'assistant',
        content: `文件地址：${url}`,
        createdAt: '2026-01-01T00:00:08.000Z',
      }),
    ]);

    expect(items.find((item) => item.source.id === 'tool-1')?.media).toEqual([]);
    expect(items.find((item) => item.source.id === 'tool-2')?.media).toMatchObject([{ url }]);
  });

  it('keeps desktop media action metadata as mobile read-only actions', () => {
    const items = normalizeRemoteMessages([
      message({
        id: 'mivo',
        role: 'tool_use',
        content: {
          toolUseId: 'mivo',
          toolName: 'mivo_poll_result',
          input: {},
        },
      }),
      message({
        id: 'mivo-result',
        role: 'tool_result',
        toolUseId: 'mivo',
        content: JSON.stringify({
          xdt_image_urls: ['xdt-image://lizi-art-media-images/a.png'],
          _xdt_actions: {
            provider: 'mivo',
            jobId: 'job-1',
            buttons: [
              { customId: 'MJ::JOB::upsample::1::abc', label: 'U1' },
              { customId: 'MJ::JOB::variation::2::abc', emoji: 'V2' },
            ],
          },
        }),
      }),
    ]);

    expect(items[0].media).toEqual([
      {
        kind: 'image',
        url: 'xdt-image://lizi-art-media-images/a.png',
        title: undefined,
        previewable: false,
        actions: {
          provider: 'mivo',
          jobId: 'job-1',
          buttons: [
            { customId: 'MJ::JOB::upsample::1::abc', label: 'U1', emoji: undefined },
            { customId: 'MJ::JOB::variation::2::abc', label: undefined, emoji: 'V2' },
          ],
        },
      },
    ]);
  });

  it('filters interaction tool calls because pending interactions own those controls', () => {
    const items = normalizeRemoteMessages([
      message({
        id: 'ask-tool',
        role: 'tool_use',
        content: { toolUseId: 'tu_ask', toolName: 'AskUserQuestion', input: {} },
      }),
      message({
        id: 'plan-tool',
        role: 'tool_use',
        content: { toolUseId: 'tu_plan', toolName: 'ExitPlanMode', input: {} },
      }),
    ]);

    expect(items).toEqual([]);
  });

  it('renders only answered ask_user history as question and answer pairs', () => {
    const items = normalizeRemoteMessages([
      message({
        id: 'pending',
        role: 'ask_user',
        content: { status: 'pending', questions: [{ question: 'Choose?' }] },
      }),
      message({
        id: 'answered',
        role: 'ask_user',
        content: {
          status: 'answered',
          questions: [{ question: 'Deploy?' }, { question: 'Notify?' }],
          answers: { 'Deploy?': 'yes', 'Notify?': '' },
        },
      }),
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'ask_user',
      body: 'Q: Deploy?\nA: yes\n\nQ: Notify?\nA: (skipped)',
    });
  });

  it('restores persisted thinking and plan review messages', () => {
    const items = normalizeRemoteMessages([
      message({
        id: 'thinking',
        role: 'thinking',
        content: { kind: 'thinking', text: 'checking files', durationMs: 1500, isRedacted: false },
      }),
      message({
        id: 'plan',
        role: 'plan_review',
        content: {
          status: 'revised',
          plan: '1. Inspect\n2. Patch\n3. Test\n4. Ship',
          feedback: 'Add rollback plan',
        },
      }),
    ]);

    expect(items.map((item) => item.kind)).toEqual(['thinking', 'plan_review']);
    expect(items[0]).toMatchObject({ label: 'thinking 2s', body: 'checking files' });
    // 已完成的 thinking 无流式标记。
    expect(items[0].isStreaming).toBeUndefined();
    expect(items[1]).toMatchObject({
      label: 'plan_review:revised',
      body: 'Add rollback plan',
      secondaryBody: '1. Inspect\n2. Patch\n3. Test\n...',
    });
  });

  it('carries the streaming flag through thinking normalization (live thinking timer depends on it)', () => {
    const items = normalizeRemoteMessages([
      message({
        id: 'thinking-live',
        role: 'thinking',
        content: { kind: 'thinking', text: '正在分析…', durationMs: 0, isRedacted: false, isStreaming: true },
      }),
    ]);

    expect(items.map((item) => item.kind)).toEqual(['thinking']);
    // ThinkingCard 的「思考中 Xs」实时计时以 message.isStreaming 为运行判定,
    // normalizeThinking 丢掉该标记会让计时器永远不启动(PR #643 review 实锤)。
    expect(items[0].isStreaming).toBe(true);
  });

  it('drops omitted thinking placeholders (empty text + zero duration) from both live and restored paths', () => {
    const items = normalizeRemoteMessages([
      // Opus 4.8+ / Fable 5 的 omitted 占位块:空文本 + 零时长 → 不渲染(对齐桌面 #467)。
      message({
        id: 'omitted',
        role: 'thinking',
        content: { kind: 'thinking', text: '', durationMs: 0, isRedacted: false },
        createdAt: '2026-01-01T00:00:01.000Z',
      }),
      // 字段缺失的 legacy 行同样命中判定(text/durationMs 双缺省)。
      message({
        id: 'legacy-empty',
        role: 'thinking',
        content: { kind: 'thinking' },
        createdAt: '2026-01-01T00:00:02.000Z',
      }),
      // 有真实时长的空文本块保留(时长是真实信息)。
      message({
        id: 'timed-empty',
        role: 'thinking',
        content: { kind: 'thinking', text: '', durationMs: 2000, isRedacted: false },
        createdAt: '2026-01-01T00:00:03.000Z',
      }),
      // redacted 块保留(走「思考内容已隐藏」展示)。
      message({
        id: 'redacted',
        role: 'thinking',
        content: { kind: 'thinking', text: '', durationMs: 0, isRedacted: true },
        createdAt: '2026-01-01T00:00:04.000Z',
      }),
      // 有内容的块照常保留。
      message({
        id: 'real',
        role: 'thinking',
        content: { kind: 'thinking', text: 'checking', durationMs: 0, isRedacted: false },
        createdAt: '2026-01-01T00:00:05.000Z',
      }),
    ]);

    expect(items.map((item) => item.key)).toEqual(['timed-empty', 'redacted', 'real']);
  });

  it('normalizes persisted thinking createdAt back to its start time', () => {
    const items = normalizeRemoteMessages([
      message({
        id: 'thinking',
        role: 'thinking',
        content: { kind: 'thinking', text: 'checking files', durationMs: 15_000, isRedacted: false },
        createdAt: '2026-01-01T00:00:17.000Z',
      }),
    ]);

    expect(items[0]).toMatchObject({
      kind: 'thinking',
      createdAt: '2026-01-01T00:00:02.000Z',
    });
  });

  it('preserves desktop and mobile-local system card metadata', () => {
    const items = normalizeRemoteMessages([
      message({
        id: 'local-pwd',
        role: 'system',
        content: '',
        systemCardType: 'pwd',
        systemCardData: { workingDir: '/repo' },
      }),
      message({
        id: 'desktop-compact',
        role: 'system',
        content: '',
        systemCardType: 'compact',
        systemCardData: { detail: 'Compacted 20 messages' },
      }),
      message({
        id: 'desktop-cmd',
        role: 'system',
        content: '',
        systemCardType: 'cmd',
        systemCardData: { command: '/context', output: 'Context ok' },
      }),
      // 回归(#96 review):learn 卡必须在重新归一化后仍被识别为 system 卡,
      // 否则 /learn 的启动结果卡在消息合并/重拉后会退化成空气泡。
      message({
        id: 'local-learn',
        role: 'system',
        content: '',
        systemCardType: 'learn',
        systemCardData: { runId: 'r-1' },
      }),
    ]);

    expect(items).toEqual([
      expect.objectContaining({
        kind: 'system',
        label: 'system:pwd',
        body: '',
        systemCardType: 'pwd',
        systemCardData: { workingDir: '/repo' },
      }),
      expect.objectContaining({
        kind: 'system',
        label: 'system:compact',
        systemCardType: 'compact',
        systemCardData: { detail: 'Compacted 20 messages' },
      }),
      expect.objectContaining({
        kind: 'system',
        label: 'system:cmd',
        systemCardType: 'cmd',
        systemCardData: { command: '/context', output: 'Context ok' },
      }),
      expect.objectContaining({
        kind: 'system',
        label: 'system:learn',
        systemCardType: 'learn',
        systemCardData: { runId: 'r-1' },
      }),
    ]);
  });

  it('renders persisted error rows and localizes agent auth failures with guidance', () => {
    const items = normalizeRemoteMessages([
      message({
        id: 'auth-error',
        role: 'error',
        content: JSON.stringify({ message: 'claude-code not authenticated: no_key' }),
      }),
      message({
        id: 'other-error',
        role: 'error',
        content: JSON.stringify({ message: 'something exploded' }),
        createdAt: '2026-01-01T00:00:01.000Z',
      }),
    ]);

    expect(items[0]).toMatchObject({ kind: 'system', label: 'error' });
    expect(items[0].body).toContain('还没有配置可用的 API Key');
    expect(items[0].body).toContain('设置 → 模型供应商');
    // 非鉴权错误维持原文
    expect(items[1].body).toBe('something exploded');
  });

  it('localizes persisted tool-loop errors from reason and bounded details', () => {
    const items = normalizeRemoteMessages([
      message({
        id: 'tool-loop-generic',
        role: 'error',
        content: JSON.stringify({
          message: '上游模型疑似陷入死循环，category=missing_required_field',
          reason: 'tool_use_loop_detected',
        }),
      }),
      message({
        id: 'tool-loop-contract',
        role: 'error',
        content: JSON.stringify({
          message: 'internal contract failure: missing_required_field',
          reason: 'tool_use_loop_detected',
          toolLoop: { kind: 'contract', count: 3 },
        }),
        createdAt: '2026-01-01T00:00:01.000Z',
      }),
      message({
        id: 'tool-loop-invalid-details',
        role: 'error',
        content: JSON.stringify({
          message: 'raw malformed loop category=missing_required_field',
          reason: 'tool_use_loop_detected',
          toolLoop: { kind: 'unknown', count: 999999999 },
        }),
        createdAt: '2026-01-01T00:00:02.000Z',
      }),
    ]);

    expect(items[0].body).toBe(i18n.t('session.tail.toolUseLoopDetected'));
    expect(items[0].body).not.toContain('missing_required_field');
    expect(items[1].body).toBe(
      i18n.t('session.tail.toolUseLoopDetectedWithCount', { count: 3 }),
    );
    expect(items[1].body).not.toContain('missing_required_field');
    expect(items[2].body).toBe(i18n.t('session.tail.toolUseLoopDetected'));
  });

  it('extracts scheduler automation origin from user agentMeta', () => {
    const items = normalizeRemoteMessages([
      message({
        id: 'scheduled',
        role: 'user',
        content: 'run the heartbeat checklist',
        agentMeta: { origin: { kind: 'scheduler', scheduleId: 'sch-1', scheduleName: 'PR 心跳' } },
      }),
      message({
        id: 'scheduled-unnamed',
        role: 'user',
        content: 'nameless',
        agentMeta: { origin: { kind: 'scheduler', scheduleId: 'sch-2' } },
      }),
      message({
        id: 'other-origin',
        role: 'user',
        content: 'not automation',
        agentMeta: { origin: { kind: 'something-else', scheduleId: 'sch-3' } },
      }),
      message({
        id: 'missing-id',
        role: 'user',
        content: 'broken origin',
        agentMeta: { origin: { kind: 'scheduler' } },
      }),
      message({
        id: 'assistant-ignored',
        role: 'assistant',
        content: 'reply',
        agentMeta: { origin: { kind: 'scheduler', scheduleId: 'sch-4' } },
      }),
    ]);

    expect(items.map((item) => [item.source.id, item.automationOrigin])).toEqual([
      ['scheduled', { scheduleId: 'sch-1', scheduleName: 'PR 心跳' }],
      ['scheduled-unnamed', { scheduleId: 'sch-2' }],
      ['other-origin', undefined],
      ['missing-id', undefined],
      ['assistant-ignored', undefined],
    ]);
  });

  it('normalizes Telegram hook source into a left-aligned Cindy card payload', () => {
    const [item, unknown] = normalizeRemoteMessages([
      message({
        id: 'telegram-hook',
        role: 'user',
        content: 'internal prompt with thread instructions',
        agentMeta: {
          hookSource: {
            im: 'telegram',
            channelName: 'Release topic',
            userText: 'Please ship the release',
            threadContext: [
              { author: 'Chris', text: 'Use the staging checklist' },
              { author: 'Cindy', text: 'Ready', isBot: true },
            ],
          },
        },
      }),
      message({
        id: 'unknown-hook',
        role: 'user',
        content: 'plain message',
        agentMeta: { hookSource: { im: 'untrusted-provider', userText: 'spoofed' } },
      }),
    ]);

    expect(item).toMatchObject({
      body: 'Please ship the release',
      align: 'agent',
      hookSource: {
        im: 'telegram',
        channelName: 'Release topic',
        userText: 'Please ship the release',
        threadContext: [
          { author: 'Chris', text: 'Use the staging checklist' },
          { author: 'Cindy', text: 'Ready', isBot: true },
        ],
      },
    });
    expect(unknown).toMatchObject({ body: 'plain message', align: 'user' });
    expect(unknown.hookSource).toBeUndefined();
  });

  it('bounds the fallback hook body when an older source omits userText', () => {
    const [item] = normalizeRemoteMessages([
      message({
        id: 'telegram-hook-without-user-text',
        role: 'user',
        content: 'x'.repeat(20_100),
        agentMeta: {
          hookSource: {
            im: 'telegram',
            channelName: 'Release topic',
          },
        },
      }),
    ]);

    expect(item.body).toHaveLength(20_000);
    expect(item.hookSource?.userText).toHaveLength(20_000);
  });

  it('marks synthetic trigger user rows (hidden continuation prompts) with an empty body', () => {
    // 桌面「失败后继续」发出的隐藏续跑 prompt:保留为 turn 边界(label='user'),
    // 但打标 + body 置空,渲染层据此剔除,用户永远看不到裸英文指令。
    const items = normalizeRemoteMessages([
      message({
        id: 'synthetic-json',
        role: 'user',
        content: { text: CONTINUE_AFTER_ERROR_PROMPT, images: [], files: [] },
        createdAt: '2026-01-01T00:00:01.000Z',
      }),
      message({
        id: 'synthetic-raw',
        role: 'user',
        content: `${UI_ACTION_TRIGGER_PREFIX} regenerate the image`,
        createdAt: '2026-01-01T00:00:02.000Z',
      }),
      message({
        id: 'normal',
        role: 'user',
        content: { text: '正常消息', images: [] },
        createdAt: '2026-01-01T00:00:03.000Z',
      }),
    ]);

    expect(items.map((item) => [item.source.id, item.isSyntheticTrigger ?? false, item.body])).toEqual([
      ['synthetic-json', true, ''],
      ['synthetic-raw', true, ''],
      ['normal', false, '正常消息'],
    ]);
    // turn 边界语义:仍是 kind='user' + label='user'(markTurnFinalAssistants 依赖)
    expect(items[0].kind).toBe('user');
    expect(items[0].label).toBe('user');
  });

  it('projects the host SDK-turn seal onto assistant messages only', () => {
    const items = normalizeRemoteMessages([
      message({
        id: 'assistant-sealed',
        role: 'assistant',
        content: '正式总结',
        agentMeta: { turnCompleted: true },
      }),
      message({
        id: 'user-ignored',
        role: 'user',
        content: '继续',
        agentMeta: { turnCompleted: true },
      }),
    ]);

    expect(items[0].turnCompleted).toBe(true);
    expect(items[1].turnCompleted).toBeUndefined();
  });

  it('renders auto-resume rows as system cards with interruption outcome metadata', () => {
    const items = normalizeRemoteMessages([
      message({
        id: 'auto-resume',
        role: 'user',
        content: '继续',
        agentMeta: { delivery: 'turn', autoResume: true, autoResumeInfo: {
          error: 'socket hang up', attempt: 2, maxAttempts: 5, sessionTotal: 3,
        }, autoResumeOutcome: 'failed' },
      }),
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'user',
      label: 'user',
      body: '',
      systemCardType: 'auto-resume',
      systemCardData: { error: 'socket hang up', attempt: 2, maxAttempts: 5, sessionTotal: 3, outcome: 'failed' },
      align: 'agent',
    });
  });
});

describe('context rebuild boundaries', () => {
  it.each(['context-overflow', 'pi-prompt-timeout', 'codex-history-strip'])('restores %s as a visible standalone boundary', (reason) => {
    const rows = [
      message({ id: 'before', role: 'assistant', content: 'Before' }),
      message({ id: 'rebuild', role: 'assistant', content: '', agentMeta: { contextRebuild: { reason, handoff: 'Private handoff' } } }),
      message({ id: 'after', role: 'assistant', content: 'After' }),
    ];
    const items = buildMobileMessageRenderItems(rows);
    const boundary = items.find((item) => item.type === 'message' && item.message.systemCardType === 'context-rebuild');
    expect(boundary).toMatchObject({ type: 'message', message: {
      kind: 'system', body: '', systemCardData: { reason, handoff: 'Private handoff' },
    } });
    // Intermediate assistant work can be folded; the following answer stays outside the marker.
    expect(items.at(-1)).toMatchObject({ type: 'message', message: { body: 'After' } });
  });

  it('accepts projected cards and defaults incomplete persisted metadata', () => {
    expect(normalizeRemoteMessages([
      message({ id: 'projected', role: 'assistant', content: '', systemCardType: 'context-rebuild', systemCardData: { handoff: 'Summary' } }),
      message({ id: 'legacy', role: 'assistant', content: '', agentMeta: { contextRebuild: { reason: 12, handoff: false } } }),
    ])).toMatchObject([
      { systemCardType: 'context-rebuild', systemCardData: { handoff: 'Summary' } },
      { systemCardType: 'context-rebuild', systemCardData: { reason: 'context-overflow', handoff: '' } },
    ]);
  });

  it.each([null, 'invalid', []])('keeps ordinary assistant text when metadata is invalid: %j', (contextRebuild) => {
    const [item] = normalizeRemoteMessages([message({ id: 'ordinary', role: 'assistant', content: 'Keep this text', agentMeta: { contextRebuild } })]);
    expect(item.body).toBe('Keep this text');
    expect(item.systemCardType).toBeUndefined();
  });
});

describe('normalizeRemoteMessages — /goal 持久记录与 plan_review 状态', () => {
  it('renders goal completion records as goal-complete system cards instead of empty assistant bubbles', () => {
    const items = normalizeRemoteMessages([
      message({
        id: 'g1',
        role: 'assistant',
        content: '',
        agentMeta: { goalCompletion: { turnsUsed: 3, tokensUsed: 1200, elapsedMs: 65000, reason: null } },
      }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('system');
    expect(items[0].systemCardType).toBe('goal-complete');
    expect(items[0].systemCardData).toMatchObject({ turnsUsed: 3, elapsedMs: 65000 });
  });

  it('renders goal usage-resumed notices as goal-resumed system cards', () => {
    const items = normalizeRemoteMessages([
      message({
        id: 'g2',
        role: 'assistant',
        content: '',
        agentMeta: { goalNotice: 'usage-resumed' },
      }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].systemCardType).toBe('goal-resumed');
    expect(items[0].systemCardData).toEqual({ kind: 'usage-resumed' });
  });

  it('keeps plan_review cancelled status instead of mislabeling it as expired', () => {
    const items = normalizeRemoteMessages([
      message({
        id: 'p1',
        role: 'plan_review',
        content: { status: 'cancelled', plan: '# 计划\n步骤一' },
      }),
    ]);
    expect(items[0].label).toBe('plan_review:cancelled');
  });
});
