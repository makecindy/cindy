// @vitest-environment node
// Unit: exercise the sidebar's production projection and exact-subset ancestor reader.
// A capped list, a pinned grandchild or a same-ID peer used to lose the real navigation
// target. Existing overflow and sorting tests never construct fork families.
import { expect, it } from 'vitest';
import { sharedTaskHostPeer } from '@cindy/device-link';
import type { Session } from '@/lib/ccAgent.types';
import { buildSessionDagIndex, projectSessionDagRows, readSessionDagAncestors } from '../sessionDagRows';

const row = (id: string, parentSessionId: string | null = null, extra?: Partial<Session>) =>
  ({ id, parentSessionId, userId: '', status: 'active', ...extra } as Session);
const local = () => undefined;

it('recovers real ancestors beyond the page, once per ID, without moving the pin or changing the deep-link target', async () => {
  const child = row('fork', 'middle', { pinnedAt: 'now' });
  const sibling = row('side', 'middle', { source: 'side-chat' });
  const middle = row('middle', 'root');
  const root = row('root');
  const rows = [child, sibling];
  const calls: string[][] = [];
  const ancestors = await readSessionDagAncestors(rows, async ids => {
    calls.push(ids);
    return [root, middle].filter(s => ids.includes(s.id));
  }, local, () => true);
  expect(calls).toEqual([['middle'], ['root']]);
  const index = buildSessionDagIndex([...rows, ...ancestors], 'active', local);
  expect(projectSessionDagRows(rows, index)).toEqual([root]);
  expect(index.branches.get('root')?.map(s => s.id)).toEqual(['fork', 'side', 'middle']);
  expect(child.pinnedAt).toBe('now');
  expect(projectSessionDagRows(rows, buildSessionDagIndex([], 'all', local))).toBe(rows);
});

it('keeps a promoted side chat as an independent task even when its origin is on the same page', async () => {
  const origin = row('origin');
  const promoted = row('promoted', 'origin', { source: 'desktop', sideChatPromoted: true });
  const fork = row('fork', 'promoted');
  const rows = [origin, promoted, fork];
  expect(projectSessionDagRows(rows, buildSessionDagIndex(rows, 'all', local))).toEqual([origin, promoted]);
  const reads: string[][] = [];
  await readSessionDagAncestors([promoted], async ids => { reads.push(ids); return [origin]; }, local, () => true);
  expect(reads).toEqual([]);
});

it('preserves missing-parent and cyclic entries, folds only the reachable part of a broken chain', () => {
  const rows = [row('orphan', 'missing'), row('leaf', 'orphan'), row('self', 'self'), row('a', 'b'), row('b', 'a'), row('c', 'b')];
  expect(projectSessionDagRows(rows, buildSessionDagIndex(rows, 'all', local)).map(s => s.id))
    .toEqual(['orphan', 'self', 'a', 'b', 'c']);
});

it.each<Partial<Session>>([{ deviceLinkDeviceId: 'peer' }, { orcaRole: 'lead' }, { orcaRole: 'worker' },
  { orcaRemoteLead: {} as Session['orcaRemoteLead'] }, { companion: { id: 'buddy', role: 'bot' } },
  { source: 'scheduler' }, { hiddenAt: 'now' }, { status: 'deleted' }, { remoteHostId: 'ssh' }, { userId: 'other' }])(
  'never folds across an excluded endpoint or identity boundary: %j', extra => {
    for (const rows of [[row('r', null, extra), row('c', 'r')], [row('r'), row('c', 'r', extra)]]) {
      expect(projectSessionDagRows(rows, buildSessionDagIndex(rows, 'all', local))).toBe(rows);
    }
  });

it('keeps ambiguous device origins and status-filtered orphans accessible', () => {
  const r = row('r', null, { status: 'archived' });
  const rows = [row('c', 'r'), row('d', 'c'), r];
  expect(projectSessionDagRows(rows.slice(0, 2), buildSessionDagIndex(rows, 'active', local)).map(s => s.id)).toEqual(['c']);
  expect(projectSessionDagRows(rows, buildSessionDagIndex(rows, 'all', local))).toEqual([r]);
  const shadowed = [row('c', 'r'), row('r'), row('r', null, { deviceLinkDeviceId: 'shared-task:guest' })];
  expect(projectSessionDagRows(shadowed, buildSessionDagIndex(shadowed, 'all', local))).toBe(shadowed);
});

it('uses only a connected same-device family, never a shared-task peer or a disconnected mirror', () => {
  for (const device of ['host', sharedTaskHostPeer('share', 'host')]) {
    for (const connection of ['connected', 'disconnected'] as const) {
      const scope = { deviceLinkDeviceId: device, deviceLinkConnectionStatus: connection };
      const rows = [row('r', null, scope), row('c', 'r', scope)];
      const index = buildSessionDagIndex(rows, 'all', () => device);
      expect(projectSessionDagRows(rows, index)).toEqual(device === 'host' && connection === 'connected' ? [rows[0]] : rows);
    }
  }
});

it('keeps the native entries for a failed batch while recovering other families', async () => {
  const rows = Array.from({ length: 101 }, (_, i) => row(`child${i}`, `parent${i}`));
  const ancestors = await readSessionDagAncestors(rows, async ids => {
    if (ids.includes('parent0')) throw new Error('unavailable');
    return ids.map(id => row(id));
  }, local, () => true);
  expect(projectSessionDagRows(rows, buildSessionDagIndex([...rows, ...ancestors], 'all', local)))
    .toEqual([...rows.slice(0, 100), row('parent100')]);
});

it('does not read remote parents, follow an unrequested/foreign result, or publish after cancellation', async () => {
  const rows = [row('c', 'parent'), row('remote', 'remote-parent', { deviceLinkDeviceId: 'peer' }), row('x', 'shadowed')];
  const reads: string[][] = [];
  const result = await readSessionDagAncestors(rows, async ids => {
    reads.push(ids);
    return [row('parent', 'foreign-parent', { userId: 'other' }), row('unrequested')];
  }, id => id === 'shadowed' ? 'peer' : undefined, () => true);
  expect(reads).toEqual([['parent']]);
  expect(result).toEqual([]);
  let current = true;
  expect(await readSessionDagAncestors(rows, async () => { current = false; return [row('parent')]; }, local, () => current)).toEqual([]);
});
