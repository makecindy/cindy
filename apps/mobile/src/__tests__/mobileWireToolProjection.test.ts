import { describe, expect, it, vi } from 'vitest';
import { MOBILE_TOOL_RESULT_BYTES, projectMobileMessagePage, projectMobileToolMessage, projectMobileToolPush } from '../../../desktop/src/main/device-link/mobileToolProjection';
import { normalizeRemoteMessages } from '@/session/messageNormalize';
import { fetchMobileToolInputDetail } from '@/session/messageToolPayloadProjection';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import type { RemoteMessage } from '@/session/types';

describe('Desktop tool projection consumed by Mobile', () => {
  const tool: RemoteMessage = {
    id: 'wire-input', clientId: 'wire-client', sessionId: 'wire-projection-session',
    role: 'tool_use', toolUseId: 'wire-use', agentMeta: null,
    content: { toolName: 'Bash', toolUseId: 'wire-use', input: { command: 'echo ' + 'input'.repeat(10_000) } },
    createdAt: '2026-09-06T00:00:00.000Z',
  };

  const resultUpdates = [
    ['history merge', (row: RemoteMessage) => remoteSessionStore.mergeMessages(
      row.sessionId, projectMobileMessagePage([row], {}) as RemoteMessage[],
    )],
    ['latest window', (row: RemoteMessage) => remoteSessionStore.setLatestMessageWindow(
      row.sessionId, projectMobileMessagePage([row], {}) as RemoteMessage[],
    )],
    ['created push', (row: RemoteMessage) => remoteSessionStore.applyRemotePush(
      'wire-device', 'local-db:messages:created',
      projectMobileToolPush('local-db:messages:created', { sessionId: row.sessionId, message: row }),
    )],
  ] as const;

  it.each(resultUpdates)('replaces an earlier summary with the newer result preview via %s', (_name, update) => {
    const summary: RemoteMessage = {
      ...tool, id: 'wire-result', clientId: 'wire-result', role: 'tool_result', content: 'initial short summary',
    };
    // Below the Desktop 8192-character DB cap, but above the 8 KiB wire budget.
    const full = { ...summary, content: '中文'.repeat(2000) };
    const preview = projectMobileToolMessage(full) as RemoteMessage;
    remoteSessionStore.setMessages(tool.sessionId, [summary]);

    update(full);

    const rows = remoteSessionStore.getMessages(tool.sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(summary.id);
    expect(rows[0].content).toBe(preview.content);
    expect(rows[0].content).toContain('中文');
    expect(rows[0].content).toContain('[remote content truncated');
    expect(new TextEncoder().encode(rows[0].content as string).byteLength).toBeLessThanOrEqual(MOBILE_TOOL_RESULT_BYTES);

    // A later authoritative full read must still replace the preview.
    remoteSessionStore.mergeMessages(tool.sessionId, [full]);
    expect(remoteSessionStore.getMessages(tool.sessionId)[0].content).toBe(full.content);
  });

  it.each(resultUpdates)('keeps a usable preview when a transport fallback arrives via %s', (_name, update) => {
    const result: RemoteMessage = {
      ...tool, id: 'wire-result', clientId: 'wire-result', role: 'tool_result', content: '中文'.repeat(2000),
    };
    const preview = projectMobileToolMessage(result) as RemoteMessage;
    remoteSessionStore.setMessages(tool.sessionId, [preview]);

    update({
      ...result, content: '[remote content truncated: payload too large]',
      agentMeta: { remoteContentTruncated: true },
    });

    expect(remoteSessionStore.getMessages(tool.sessionId)[0].content).toBe(preview.content);
  });

  it('shows the same summary and completion, and expands authoritative input via radius-0', async () => {
    const projected = projectMobileToolMessage(tool) as RemoteMessage;
    const result: RemoteMessage = { ...tool, id: 'wire-result', clientId: 'result', role: 'tool_result', content: 'done' };
    const normalized = normalizeRemoteMessages([projected, result]);
    expect(normalized[0].body).toBe(normalizeRemoteMessages([tool, result])[0].body);
    expect(normalized[0].toolSettled).toBe(true);
    expect(normalized[0].toolInputProjection).toBeDefined();
    const load = vi.fn(async () => [tool]);
    const detail = await fetchMobileToolInputDetail(projected.mobileToolInputProjection!, load);
    expect(load).toHaveBeenCalledWith(tool.id, { radius: 0 });
    expect(detail.body).toContain('input'.repeat(10_000));
  });

  it('keeps created-row detail references through the real store and result events', () => {
    remoteSessionStore.setMessages(tool.sessionId, []);
    const push = projectMobileToolPush('local-db:messages:created', { sessionId: tool.sessionId, message: tool });
    remoteSessionStore.applyRemotePush('wire-device', 'local-db:messages:created', push);
    remoteSessionStore.applyRemotePush('wire-device', 'maker:event', projectMobileToolPush('maker:event', {
      sessionId: tool.sessionId, persistId: 'result', resolvedContent: 'x'.repeat(50_000),
      event: { type: 'tool_result_full', data: { toolUseId: tool.toolUseId, fullText: 'x'.repeat(50_000), isError: false } },
    }));
    expect(remoteSessionStore.getMessages(tool.sessionId).find((m) => m.id === tool.id)?.mobileToolInputProjection)
      .toEqual((projectMobileToolMessage(tool) as RemoteMessage).mobileToolInputProjection);
  });
});
