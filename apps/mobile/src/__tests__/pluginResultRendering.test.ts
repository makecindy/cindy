import { describe, expect, it } from 'vitest';
import { buildMobileMessageRenderItems } from '@/session/messageRenderModel';
import { getRemoteResource } from '@/device-link/remoteResources';
import { normalizeRemoteMessages } from '@/session/messageNormalize';
import type { RemoteMessage } from '@/session/types';
const url = `cindy-media://blobs/${'a'.repeat(64)}.png`;
function messages(content: unknown): RemoteMessage[] {
  return [
    { id: 'use', clientId: 'use', sessionId: 's', role: 'tool_use', toolUseId: 'u', content: { toolName: 'mcp__cindy__ghost_call', toolUseId: 'u', input: {} }, createdAt: '2026-01-01T00:00:00Z', agentMeta: null },
    { id: 'result', clientId: 'result', sessionId: 's', role: 'tool_result', toolUseId: 'u', content: JSON.stringify(content), createdAt: '2026-01-01T00:00:01Z', agentMeta: null },
  ];
}
describe('plugin results are visible outside collapsed tool details', () => {
  it.each([true, false])('keeps partner authorization and delivered assets as independent visible rows (streaming=%s)', (isSessionStreaming) => {
    const rows = messages({ ok: true, result: { xdt_image_url: url, xdt_card_id: 'card', _xdt_model_files: [{ url: url.replace('.png', '.glb') }] } });
    const user: RemoteMessage = { ...rows[0], id: 'user', clientId: 'user', role: 'user', toolUseId: null, content: 'Draw a cat', createdAt: '2025-12-31T23:59:58Z' };
    const authorization: RemoteMessage = { ...rows[0], id: 'auth', clientId: 'auth', role: 'assistant', toolUseId: null, content: '', createdAt: '2025-12-31T23:59:59Z', agentMeta: { botAuthorization: { v: 1, sessionId: 's', snapshot: { kind: 'plugin_setup', status: 'pending', ghostId: 'art' } } } };
    const items = buildMobileMessageRenderItems([user, authorization, ...rows], { isSessionStreaming });
    expect(items.some((item) => item.type === 'message' && item.message.authorization?.kind === 'plugin_setup')).toBe(true);
    expect(items.some((item) => item.type === 'message' && item.message.kind === 'user' && item.message.body === 'Draw a cat')).toBe(true);
    const deliveries = items.filter((item) => item.type === 'tool_media');
    expect(deliveries).toHaveLength(1);
    const normalized = normalizeRemoteMessages(rows).find((item) => item.kind === 'tool');
    expect(normalized?.media).toHaveLength(1);
    expect(normalized?.files).toHaveLength(1);
    expect(normalized?.cardIds).toEqual(['card']);
  });
  it.each([
    { ok: true, result: { xdt_image_url: url } },
    { ok: true, xdt_media_produced: [url] },
    { ok: true, result: { xdt_card_id: 'card' } },
    { ok: true, result: { _xdt_model_files: [{ url: url.replace('.png', '.glb') }] } },
  ])('preserves the result in the settled history render model: %j', (result) => {
    const rows = buildMobileMessageRenderItems(messages(result), { isSessionStreaming: false });
    expect(rows.some((row) => row.type === 'tool_media')).toBe(true);
  });
  it.each([true, false])('does not duplicate ledger images embedded in the reply (streaming=%s)', (isSessionStreaming) => {
    const rows = messages({ ok: true, xdt_media_produced: [url] });
    rows.push({ ...rows[1], id: 'reply', clientId: 'reply', role: 'assistant', toolUseId: null, content: `![result](${url})` });
    expect(buildMobileMessageRenderItems(rows, { isSessionStreaming }).some((row) => row.type === 'tool_media')).toBe(false);
  });
  it('shows a referenced card only once within a user turn', () => {
    const rows = messages({ ok: true, xdt_card_id: 'c' });
    rows.push(...messages({ ok: true, xdt_anchor_card_id: 'c' }).map((row) => ({ ...row, id: row.id + '2', clientId: row.clientId + '2', toolUseId: 'u2', content: row.role === 'tool_use' ? { toolName: 'mcp__cindy__ghost_call', toolUseId: 'u2', input: {} } : row.content })));
    expect(normalizeRemoteMessages(rows).flatMap((row) => row.cardIds ?? [])).toEqual(['c']);
  });
  it('decodes read-only resource blocks without forwarding arbitrary data or actions', async () => {
    const ref = { collectionId: 'plugin-results', kind: 'card', id: '["s","c"]' };
    const resource = await getRemoteResource(async () => ({ ref, display: { title: 'Art' }, revision: '1', links: [], actions: [{ id: 'delete' }], blocks: [
      { id: 'text', primitive: 'markdown', fallbackMarkdown: 'Done' },
      { id: 'image', primitive: 'image', fallbackMarkdown: url, data: { url, html: '<script/>', secret: 'do-not-forward' } },
    ] }) as never, { deviceId: 'mac', deviceName: 'Mac' }, ref);
    expect(resource.blocks?.[0].fallbackMarkdown).toBe('Done');
    expect(resource.blocks?.[1].data).toEqual({ url });
    expect(resource).not.toHaveProperty('actions');
  });
});
