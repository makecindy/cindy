import { describe, expect, it } from 'vitest';
import { extractPayloadToolResultMedia } from '@cindy/maker-shared/payload-summary';
import {
  MOBILE_HISTORY_PAGE_BYTES, MOBILE_TOOL_RESULT_BYTES,
  projectMobileMessagePage, projectMobileToolMessage, projectMobileToolPush, projectMobileToolResult,
} from '../mobileToolProjection';

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const tool = (toolName = 'Bash', input: unknown = { command: 'echo hello ' + 'x'.repeat(40_000) }) => ({
  id: 'row-1', clientId: 'persist-1', sessionId: 'session-1', rowid: 42,
  role: 'tool_use', toolUseId: 'use-1', createdAt: '2026-09-06T00:00:00.000Z',
  agentMeta: { parentUuid: 'parent', turnCompleted: false },
  content: { toolName, toolUseId: 'use-1', input, turnCompleted: false },
});

describe('mobile tool projection', () => {
  it('retains bounded plugin call identity while compacting large arguments', () => {
    const projected = projectMobileToolMessage(tool('mcp__cindy__ghost_call', { ghost_id: 'art', tool: 'generate', grant_only: false, args: { data: 'x'.repeat(40_000) } })) as ReturnType<typeof tool>;
    expect(projected.content.input).toEqual({ ghost_id: 'art', tool: 'generate', grant_only: false });
    expect(bytes(projected)).toBeLessThan(2000);
  });
  it('keeps stable identity and metadata, replacing a large input with a recoverable reference', () => {
    const original = tool();
    const projected = projectMobileToolMessage(original);
    expect(projected).toMatchObject({
      id: original.id, clientId: original.clientId, rowid: 42, agentMeta: original.agentMeta,
      content: { input: null, toolName: 'Bash', turnCompleted: false },
      mobileToolInputProjection: { projected: true, version: 1, toolUseId: 'use-1', toolUseMessageId: 'row-1', toolName: 'Bash' },
    });
    expect(bytes(projected)).toBeLessThan(1024);
    expect(original.content.input).toHaveProperty('command');
    expect(projectMobileToolMessage(projected)).toBe(projected);
  });

  it('budgets all fields and UTF-8, not each field separately', () => {
    expect(projectMobileToolMessage(tool('Bash', { command: '中😀'.repeat(1500) }))).toHaveProperty('mobileToolInputProjection');
    expect(projectMobileToolMessage(tool('WebFetch', Object.fromEntries(Array.from({ length: 100 }, (_, i) => [String(i), 'x'.repeat(100)])))))
      .toHaveProperty('mobileToolInputProjection');
  });

  it('does not mislabel small or unavailable inputs', () => {
    for (const row of [tool('Bash', { command: 'pwd' }), { ...tool(), id: '' },
      { ...tool(), agentMeta: { remoteContentTruncated: true } }]) {
      expect(projectMobileToolMessage(row)).toBe(row);
    }
  });

  it.each(['AskUserQuestion', 'ExitPlanMode', 'TodoWrite', 'update_plan', 'Agent', 'Task',
    'create_workers', 'mcp__orca__send_to_worker', 'mcp:orca:create_worker', 'Write', 'Edit', 'MultiEdit', 'edit', 'write'])
  ('keeps %s structural input intact', (name) => {
    const row = tool(name, { plan: [{ step: 'x'.repeat(50_000) }], content: 'x'.repeat(50_000) });
    expect(projectMobileToolMessage(row)).toBe(row);
    const push = { sessionId: 's', event: { type: 'tool_use', data: row.content } };
    expect(projectMobileToolPush('maker:event', push)).toBe(push);
  });

  it('bounds plain results on UTF-8 boundaries and marks shortened rows', () => {
    const text = '中文😀'.repeat(10_000);
    const result = projectMobileToolResult(text) as string;
    expect(new TextEncoder().encode(result).byteLength).toBeLessThanOrEqual(MOBILE_TOOL_RESULT_BYTES);
    expect(result).not.toContain('\uFFFD');
    expect(result).toContain('[remote content truncated');
    expect(projectMobileToolMessage({ ...tool(), role: 'tool_result', content: text })).toMatchObject({
      toolUseId: 'use-1', agentMeta: { parentUuid: 'parent', mobileToolResultProjected: true }, content: result,
    });
  });

  it('distinguishes current previews from transport fallback without clearing an existing fallback flag', () => {
    const row = { ...tool(), role: 'tool_result', content: '中文'.repeat(2000) };
    const preview = projectMobileToolMessage(row);
    expect(preview).not.toHaveProperty('agentMeta.remoteContentTruncated');
    expect(projectMobileToolMessage(preview)).toBe(preview);
    expect(projectMobileToolMessage({ ...row, agentMeta: { remoteContentTruncated: true } }))
      .toMatchObject({ agentMeta: { remoteContentTruncated: true, mobileToolResultProjected: true } });
    expect(row.agentMeta).toEqual({ parentUuid: 'parent', turnCompleted: false });
  });

  it('preserves media JSON, actions, audio and references beyond the preview boundary', () => {
    const content = JSON.stringify({
      text: 'x'.repeat(50_000), xdt_image_url: 'cindy-media://blobs/a.png',
      _xdt_actions: { jobId: 'job', buttons: [{ label: 'U1', customId: 'u1' }] },
      xdt_audio_tracks: [{ xdt_audio_url: 'cindy-media://blobs/a.mp3', title: 'track' }],
    });
    expect(new TextEncoder().encode(projectMobileToolResult(content) as string).byteLength).toBeLessThan(MOBILE_TOOL_RESULT_BYTES);
    expect(extractPayloadToolResultMedia(projectMobileToolResult(content) as string)).toEqual(extractPayloadToolResultMedia(content));
    for (const output of ['x'.repeat(9000) + '\nhttps://example.com/file.pdf',
      '<tool_use_error>' + 'error'.repeat(9000) + '</tool_use_error>',
      JSON.stringify({ _xdt_render_image: false, text: 'x'.repeat(9000) })]) {
      const projected = projectMobileToolResult(output) as string;
      expect(projected).not.toBe(output);
      expect(new TextEncoder().encode(projected).byteLength).toBeLessThanOrEqual(MOBILE_TOOL_RESULT_BYTES);
    }
  });

  it('preserves plugin fallback assets, nested card refs and summary after large provider output', () => {
    const url = `cindy-media://blobs/${'a'.repeat(64)}.png`;
    const content = JSON.stringify({ ok: true, result: { providerResponse: 'x'.repeat(50000), xdt_card_id: 'card', note: 'finished' }, xdt_media_produced: [url] });
    const projected = projectMobileToolResult(content) as string;
    expect(JSON.parse(projected)).toMatchObject({ xdt_card_id: 'card', note: 'finished', xdt_media_produced: [url] });
    expect(new TextEncoder().encode(projected).byteLength).toBeLessThan(MOBILE_TOOL_RESULT_BYTES);
    expect(extractPayloadToolResultMedia(projected)).toMatchObject([{ kind: 'image', url }]);
    const row = { ...tool(), role: 'tool_result', content };
    expect(projectMobileToolPush('local-db:messages:created', { message: row })).toEqual({ message: projectMobileMessagePage([row], {})[0] });
    expect(row.content).toBe(content);
  });

  it('bounds serialized media, tracks, files and actions without cutting references', () => {
    const image = (i: number) => `cindy-media://blobs/${i.toString(16).padStart(64, 'a')}.png`;
    for (const refs of [
      { xdt_image_urls: Array.from({ length: 3000 }, (_, i) => image(i)) },
      { xdt_audio_tracks: Array.from({ length: 1000 }, () => ({ xdt_audio_url: 'xdt-audio://local?path=/tmp/a.mp3', title: '音乐'.repeat(150) })) },
      { _xdt_model_files: Array.from({ length: 1000 }, (_, i) => ({ url: `xdt-file://open?path=/tmp/${i}.pdf`, name: '文档'.repeat(100) })) },
    ]) {
      const content = JSON.stringify({ ...refs, xdt_card_id: 'card',
        _xdt_actions: { buttons: [{ label: 'x'.repeat(50_000) }] }, note: '😀'.repeat(10_000) });
      const projected = projectMobileToolResult(content) as string;
      expect(new TextEncoder().encode(projected).byteLength).toBeLessThanOrEqual(MOBILE_TOOL_RESULT_BYTES);
      expect(JSON.parse(projected)).toMatchObject({ xdt_card_id: 'card', _remote_content_truncated: true });
      expect(JSON.parse(projected)).not.toHaveProperty('_xdt_actions');
      const values = Object.values(JSON.parse(projected)).filter(Array.isArray).flat();
      expect(values.length).toBeGreaterThan(0);
      expect(values.length).toBeLessThanOrEqual(64);
      const row = { ...tool(), role: 'tool_result', content };
      const pushed = projectMobileToolPush('local-db:messages:created', { message: row }) as { message: { content: string } };
      expect(pushed.message.content).toBe(projected);
    }
    const suppressed = projectMobileToolResult(JSON.stringify({ _xdt_render_image: false,
      xdt_image_urls: Array.from({ length: 1000 }, (_, i) => image(i)) })) as string;
    expect(JSON.parse(suppressed)._xdt_render_image).toBe(false);
    expect(extractPayloadToolResultMedia(suppressed)).toEqual([]);
  });

  it('removes duplicate result bodies while keeping correlation and failure flags', () => {
    const fullText = 'output '.repeat(30_000);
    const push = { sessionId: 's', persistId: 'p', resolvedContent: fullText,
      event: { type: 'tool_result_full', source: 'codex', data: { toolUseId: 'u', fullText, isError: true } } };
    const projected = projectMobileToolPush('maker:event', push);
    expect(projected).not.toHaveProperty('resolvedContent');
    expect(projected).toMatchObject({ persistId: 'p', event: { source: 'codex', data: { toolUseId: 'u', isError: true } } });
    expect(bytes(projected)).toBeLessThan(10_000);
    expect(push.resolvedContent).toBe(fullText);
    expect(push.event.data.fullText).toBe(fullText);
  });

  it('does not project assistant text, thinking, approvals or terminal events', () => {
    for (const type of ['text', 'thinking', 'done', 'error', 'agent_task_update']) {
      const push = { sessionId: 's', event: { type, data: { text: 'x'.repeat(100_000) } } };
      expect(projectMobileToolPush('maker:event', push)).toBe(push);
    }
    const request = { sessionId: 's', request: { input: 'x'.repeat(100_000) } };
    expect(projectMobileToolPush('maker:interaction-request', request)).toBe(request);
  });

  it('projects created rows identically to history, including early running tools', () => {
    const row = tool();
    expect(projectMobileToolPush('local-db:messages:created', { sessionId: 's', message: row }))
      .toEqual({ sessionId: 's', message: projectMobileMessagePage([row], {})[0] });
  });
});

describe('mobile history byte budget', () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({ ...tool(), id: String(8 - i), role: 'assistant', content: 'x'.repeat(80_000) }));
  it('returns newest rows and a continuation marker for backward reads', () => {
    const page = projectMobileMessagePage(rows, { before: '9' }) as typeof rows;
    expect(page.map((r) => r.id)).toEqual(['8', '7', '6']);
    expect(bytes(page)).toBeLessThan(MOBILE_HISTORY_PAGE_BYTES);
    expect(page[0].agentMeta).toMatchObject({ remoteRowsTrimmed: true, remoteOriginalRowCount: 8 });
    expect(page[0].content).toBe(rows[0].content);
  });
  it('keeps the oldest delta for after reads so advancing the cursor skips no rows', () => {
    const page = projectMobileMessagePage(rows, { after: '0' }) as typeof rows;
    expect(page.map((r) => r.id)).toEqual(['3', '2', '1']);
  });
  it('always progresses with one intact large assistant row', () => {
    const large = { ...rows[0], content: 'x'.repeat(MOBILE_HISTORY_PAGE_BYTES * 2) };
    const page = projectMobileMessagePage([large, ...rows], {}) as typeof rows;
    expect(page).toHaveLength(1);
    expect(page[0].content).toBe(large.content);
    expect(projectMobileMessagePage([], {})).toEqual([]);
  });
});
