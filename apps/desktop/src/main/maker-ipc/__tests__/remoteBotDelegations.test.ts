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
  const result = projectRemoteBotDelegations({ ok: true, delegations: [{ id: 'task', title: 'Report', status: 'completed', resultSummary: 'Done', artifacts: [], pendingInteraction: null, permissionSnapshotJson: 'private', permissionSnapshot: { identity: 'private' }, contextRefs: ['private'], runtimeSnapshotJson: 'private' }] } as unknown as BotDelegationListResult);
  expect(result).toMatchObject({ ok: true, delegations: [{ id: 'task', resultSummary: 'Done', permissionSnapshot: {}, contextRefs: [] }] });
  expect(JSON.stringify(result)).not.toContain('private');
});
