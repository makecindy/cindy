import { describe, expect, it, vi } from 'vitest';
import { REMOTE_RESOURCE_GET_CHANNEL } from '@cindy/device-link';
import { fetchRemoteGhostCard } from '../remoteCardFetch';
import { renderMailCard } from '../mailCards';

// Unit (security boundary): a controlled computer's markup is not trusted here. This computer's
// sanitizer runs again, an older host is recognised so the task keeps its tool rows, and mail cards
// (which rely on host-only markers) are never shown from markup.
const reply = (data: Record<string, unknown> | undefined) => async () =>
  ({ ok: true, result: { blocks: data ? [{ id: 'actions', primitive: 'plugin-card-actions', fallbackMarkdown: '', data }] : [] } });

describe('fetchRemoteGhostCard', () => {
  it('asks for the markup on the task card and sanitizes it again on this computer', async () => {
    const invoke = vi.fn(reply({ pluginId: 'cindy-github', revision: 'r1',
      card: { html: '<div onclick="steal()">PR<script>steal()</script><button data-ghost-action="merge">Merge</button></div>', height: 5000, externalLinks: true } }));
    const result = await fetchRemoteGhostCard(invoke, 'host', 'session', 'call');
    expect(invoke).toHaveBeenCalledWith('host', REMOTE_RESOURCE_GET_CHANNEL, [expect.objectContaining({
      client: expect.objectContaining({ primitives: expect.arrayContaining(['plugin-card-html', 'plugin-card-actions']) }),
      ref: { collectionId: 'plugin-results', kind: 'card', id: JSON.stringify(['session', 'call']) },
    })]);
    expect(result.card).toMatchObject({ ghostId: 'cindy-github', revision: 'r1', externalLinks: true, height: 900 });
    expect(result.card?.html).toContain('data-ghost-action="merge"');
    expect(result.card?.html).not.toMatch(/onclick|<script|steal\(\)<\/script>/i);
  });

  // Regression #10734: the real main-process invoke wraps resources, including failures.
  // Existing fixtures returned bare blocks; unit tier, minimal input is a failed invoke envelope.
  it('does not mark transport failures as an unsupported host', async () => {
    expect(await fetchRemoteGhostCard(async () => ({ ok: false, error: 'OFFLINE' }), 'host', 's', 'c'))
      .toEqual({ card: null, failed: true });
  });

  it('recognises older hosts and keeps mail cards and invalid owners out', async () => {
    expect(await fetchRemoteGhostCard(reply({ pluginId: 'p', revision: 'r', items: [] }), 'host', 's', 'c')).toEqual({ card: null, unsupported: true });
    expect(await fetchRemoteGhostCard(reply(undefined), 'host', 's', 'c')).toEqual({ card: null, unsupported: true });
    expect(await fetchRemoteGhostCard(reply({ pluginId: 'p', revision: 'r', mail: { key: 'k' } }), 'host', 's', 'c')).toEqual({ card: null });
    const mail = renderMailCard({ accountId: 'a', draftId: 'd', key: '12345678-1234-1234-1234-123456789abc', from: 'self@example.test',
      state: 'draft', status: 'Ready', sendLabel: 'Send', fromLabel: 'From', attachments: [],
      fields: ['to', 'subject', 'body'].map(name => ({ name, label: name, value: name })) });
    expect((await fetchRemoteGhostCard(reply({ pluginId: 'p', revision: 'r', card: { html: mail, height: 100 } }), 'host', 's', 'c')).card).toBeNull();
    expect((await fetchRemoteGhostCard(reply({ pluginId: '../x', revision: 'r', card: { html: '<p>x</p>', height: 100 } }), 'host', 's', 'c')).card).toBeNull();
    const invoke = vi.fn();
    expect(await fetchRemoteGhostCard(invoke, 'host', '', 'c')).toEqual({ card: null });
    expect(invoke).not.toHaveBeenCalled();
  });
});
