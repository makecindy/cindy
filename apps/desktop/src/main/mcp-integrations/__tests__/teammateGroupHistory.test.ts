import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '../../localDb/client/DbClient.js';
import { authorizeGroupTool, GroupToolAuthorizationError, registerGroupToolAuthority } from '../../maker-ipc/botGroupToolAuthorization.js';
import type { TeammateGroupHistoryQuery, TeammateGroupHistoryResult } from '../../maker-ipc/teammateGroupHistory.js';
import { createTeammateGroupHistoryProvider } from '../teammateGroupHistory.js';

// #8434 / bot-group-chat.md §3.2: production host boundary, unit tier. Registry and
// reader tests did not exercise caller lanes or requester revocation after a read.
// Minimal regression: valid tools grant, history read revokes its access revision,
// but the execution remains locally current. No history may escape in the result.
const releases: Array<() => void> = [];
afterEach(() => releases.splice(0).forEach(release => release()));
function setup(role = 'group') {
  const db = { queryOne: vi.fn(async () => ({ role })) } as unknown as Pick<DbClient, 'queryOne'>;
  let scope = 'owner';
  let pending = false;
  const read = vi.fn<(input: TeammateGroupHistoryQuery) => Promise<TeammateGroupHistoryResult>>(async () => history);
  const authorize = vi.fn(authorizeGroupTool);
  const provider = createTeammateGroupHistoryProvider({
    getDbClient: () => db, activeOwnerScopeKey: () => scope, isAppSessionBoundaryPending: () => pending,
    resolveBotHistoryScope: async () => ({ kind: 'bot', botId: 'bot' }), authorizeGroupTool: authorize,
    getReader: () => read,
  });
  return { provider, read, authorize, switchAccount: () => { scope = 'other'; }, beginBoundary: () => { pending = true; } };
}
function grant(mode: 'owner' | 'tools' | 'chat', validate = async () => {}) {
  releases.push(registerGroupToolAuthority('lane', { botId: 'bot', mode, validate,
    sourceGroup: { groupId: 'current-group', name: 'Current' }, isCurrent: () => true }));
}
const history: TeammateGroupHistoryResult = { messages: [{ id: 'message', sequence: '1', text: 'private history', author: 'Member',
  authorKind: 'human', createdAt: '2026-11-02T00:00:00Z', threadRootId: null, attachments: [] }], hasMore: false, nextCursor: null };
const call = { callerSessionId: 'lane', groupId: 'current-group' };

describe('companion group history host authorization', () => {
  it('discards history when requester access is revoked while its execution is still current', async () => {
    let revoked = false;
    grant('tools', async () => { if (revoked) throw new GroupToolAuthorizationError(); });
    const { provider, read } = setup();
    read.mockImplementationOnce(async () => { revoked = true; return history; });
    expect(await provider(call)).toEqual({ ok: false, errorCode: 'GROUP_AUTHORIZATION_REQUIRED' });
  });
  it('reports temporary verification failure without publishing already fetched history', async () => {
    let unavailable = false;
    grant('tools', async () => { if (unavailable) throw new Error('upstream private details'); });
    const { provider, read } = setup();
    read.mockImplementationOnce(async () => { unavailable = true; return { messages: [], hasMore: false, nextCursor: null }; });
    expect(await provider(call)).toEqual({ ok: false, errorCode: 'GROUP_AUTHORIZATION_UNAVAILABLE' });
  });
  it.each(['other-group'])('denies tools-granted cross-group read: %s', async groupId => {
    grant('tools');
    const { provider, read } = setup();
    expect(await provider({ ...call, groupId })).toEqual({ ok: false, errorCode: 'PERMISSION_DENIED' });
    expect(read).not.toHaveBeenCalled();
  });
  // #8433 review: the model only knows the group name; the live grant must
  // resolve an omitted ID without exposing a cross-group discovery route (unit).
  it('reads the verified current group when a tools-granted caller omits its ID', async () => {
    grant('tools');
    const { provider, read } = setup();
    expect(await provider({ callerSessionId: 'lane', query: 'older', before: '42' })).toMatchObject({ ok: true });
    expect(read).toHaveBeenCalledExactlyOnceWith({ callerSessionId: 'lane', botId: 'bot',
      groupId: 'current-group', query: 'older', before: '42' });
  });
  it('denies an omitted ID when the live tools grant has no source group', async () => {
    releases.push(registerGroupToolAuthority('lane', { botId: 'bot', mode: 'tools',
      validate: async () => {}, isCurrent: () => true }));
    const { provider, read } = setup();
    expect(await provider({ callerSessionId: 'lane' })).toEqual({ ok: false, errorCode: 'PERMISSION_DENIED' });
    expect(read).not.toHaveBeenCalled();
  });
  it('allows a live tools grant to read only its own group as the attributed companion', async () => {
    grant('tools');
    const { provider, read } = setup();
    expect(await provider(call)).toMatchObject({ ok: true, data: { messages: [{ text: 'private history' }] } });
    expect(read).toHaveBeenCalledExactlyOnceWith({ ...call, botId: 'bot' });
  });
  it.each(['chat', 'missing'] as const)('denies %s live authority before fetching', async mode => {
    if (mode === 'chat') grant(mode);
    const { provider, read } = setup();
    expect(await provider(call)).toEqual({ ok: false, errorCode: 'GROUP_AUTHORIZATION_REQUIRED' });
    expect(read).not.toHaveBeenCalled();
  });
  it('allows an owner-authorized group request to read another joined group', async () => {
    grant('owner');
    const { provider } = setup();
    expect(await provider({ ...call, groupId: 'other-group' })).toMatchObject({ ok: true });
  });
  it.each(['channel', 'delegation', 'history'])('denies the %s lane before fetching', async role => {
    const { provider, read } = setup(role);
    expect(await provider(call)).toEqual({ ok: false, errorCode: 'PERMISSION_DENIED' });
    expect(read).not.toHaveBeenCalled();
  });
  it.each(['canonical', 'thread', 'routine'])('allows companion-owned %s reads without a group execution', async role => {
    const { provider } = setup(role);
    expect(await provider(call)).toMatchObject({ ok: true });
  });
  it('does not start a history request when the account changes during initial authorization', async () => {
    grant('owner');
    const fixture = setup();
    fixture.authorize.mockImplementationOnce(async (...args) => {
      const authority = await authorizeGroupTool(...args);
      fixture.switchAccount();
      return authority;
    });
    expect(await fixture.provider(call)).toEqual({ ok: false, errorCode: 'OWNER_CHANGED' });
    expect(fixture.read).not.toHaveBeenCalled();
  });
  it.each(['switchAccount', 'beginBoundary'] as const)('discards fetched history at %s', async change => {
    const fixture = setup('canonical');
    fixture.read.mockImplementationOnce(async () => { fixture[change](); return { messages: [], hasMore: false, nextCursor: null }; });
    expect(await fixture.provider(call)).toEqual({ ok: false, errorCode: 'OWNER_CHANGED' });
  });
});
