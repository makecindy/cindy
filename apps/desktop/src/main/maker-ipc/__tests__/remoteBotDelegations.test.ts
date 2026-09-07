import { expect, it } from 'vitest';
import { REMOTE_INVOKE_ALLOWLIST, PUSH_FORWARD_ALLOWLIST } from '@cindy/device-link';
import type { BotDelegationListResult } from '../../../shared/botDelegation';
import { projectRemoteBotDelegations } from '../remoteBotDelegations';
it('exports task controls while keeping profile mutations local', () => {
  for (const channel of ['maker:bot-delegations:list', 'maker:bot-delegation:cancel', 'maker:bot-direct-message-thread:get']) expect(REMOTE_INVOKE_ALLOWLIST.has(channel)).toBe(true);
  expect(REMOTE_INVOKE_ALLOWLIST.has('local-db:bots:update')).toBe(false);
  expect(PUSH_FORWARD_ALLOWLIST.has('maker:bot-delegation:changed')).toBe(true);
  expect(PUSH_FORWARD_ALLOWLIST.has('maker:bot-direct-message:changed')).toBe(true);
});
it('returns useful task results without leaking database or frozen runtime fields', () => {
  const artifacts = [
    { path: 'report.md', absolutePath: '/Users/owner/work/report.md', status: 'added' },
    { path: 'chart.svg', absolutePath: 'C:\\Users\\owner\\work\\chart.svg', status: 'modified' },
  ];
  const input = { ok: true, delegations: [{ id: 'task', title: 'Report', status: 'completed', resultSummary: 'Done', artifacts, pendingInteraction: null, permissionSnapshotJson: 'private', permissionSnapshot: { identity: 'private' }, contextRefs: ['private'], runtimeSnapshotJson: 'private' }] } as unknown as BotDelegationListResult;
  const result = projectRemoteBotDelegations(input);
  expect(result).toMatchObject({ ok: true, delegations: [{ id: 'task', resultSummary: 'Done', permissionSnapshot: {}, contextRefs: [] }] });
  if (!result.ok) throw new Error('expected successful projection');
  expect(result.delegations[0].artifacts).toEqual([
    { path: 'report.md', status: 'added' }, { path: 'chart.svg', status: 'modified' },
  ]);
  expect(JSON.stringify(result)).not.toContain('absolutePath');
  for (const artifact of artifacts) expect(JSON.stringify(result)).not.toContain(JSON.stringify(artifact.absolutePath).slice(1, -1));
  if (!input.ok) throw new Error('expected successful input');
  expect(input.delegations[0].artifacts[0].absolutePath).toBe('/Users/owner/work/report.md');
  expect(JSON.stringify(result)).not.toContain('private');
});
