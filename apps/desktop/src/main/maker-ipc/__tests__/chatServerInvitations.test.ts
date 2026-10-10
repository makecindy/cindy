import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ download: vi.fn(), packaged: true, urls: [] as string[], wsUrls: [] as string[], exists: vi.fn(), config: '', handle: vi.fn(), refresh: vi.fn(async () => true), profiles: [] as unknown[], sockets: [] as import('ws').WebSocket[] }));
vi.mock('../../authManager.js', () => ({ getAccessToken: () => 'isolated-test-token', refresh: fixture.refresh }));
vi.mock('../../clientEndpointsService.js', () => ({ getClientEndpoint: () => 'https://chat.cindy.app' }));
vi.mock('../chatServerMedia.js', () => ({ createChatMedia: () => ({ upload: vi.fn(async () => []), download: fixture.download }) }));
vi.mock('../chatServerWorkspaces.js', () => ({ chatServerWorkspaces: () => ({ read: () => null, save: vi.fn() }) }));
vi.mock('../chatMigrationReceipts.js', () => ({ chatMigrationReceipts: () => ({ read: () => null, save: vi.fn() }) }));
vi.mock('electron', () => ({ app: { get isPackaged() { return fixture.packaged; }, getPath: () => '/isolated' } }));
vi.mock('node:fs', () => ({ existsSync: fixture.exists, readFileSync: () => fixture.config || '{"baseUrl":"https://example.com","token":"test"}' }));
vi.mock('../botGroupChatService.js', () => ({ readPersistedReplyText: vi.fn() }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ drizzle: {
  select: () => ({ from: () => ({ where: () => Object.assign(Promise.resolve(fixture.profiles), { limit: async () => [{ id: 'existing-local-group' }] }) }) }),
  insert: () => ({ values: () => ({ onConflictDoNothing: async () => undefined }) }),
} }) }));
vi.mock('node:http', async () => {
  const { EventEmitter } = await import('node:events');
  return { request: (url: string, options: { method: string; headers: Record<string, string> }, callback: (response: unknown) => void) => {
    fixture.urls.push(String(url));
    const req = Object.assign(new EventEmitter(), {
      end: (data?: string) => {
        void Promise.resolve().then(() => fixture.handle(new URL(url).pathname.slice(3) + new URL(url).search, options.method, data ? JSON.parse(data) : undefined, options.headers))
          .then(result => {
            const response = Object.assign(new EventEmitter(), { statusCode: result?.status ?? 200, headers: result?.headers ?? {} });
            callback(response);
            response.emit('data', Buffer.from(result?.raw ?? JSON.stringify(result?.body ?? {})));
            response.emit('end');
          }, error => req.emit('error', error));
      },
      destroy: (error: Error) => req.emit('error', error),
    });
    return req;
  } };
});
vi.mock('node:https', async () => ({ request: (await import('node:http')).request }));
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: class extends EventEmitter {
    static OPEN = 1; readyState = 0; send = vi.fn();
    constructor(url: URL) { super(); fixture.wsUrls.push(String(url)); fixture.sockets.push(this as unknown as import('ws').WebSocket); }
    close() { this.emit('close'); }
  } };
});
import { withChatServer } from '../chatServer.js';
import type { BotGroupChatService, BotGroupChatServiceDeps } from '../botGroupChatService.js';

describe('Chat Server invitation contract', () => {
  const groupId = '10000000-0000-4000-8000-000000000001';
  const selfId = '30000000-0000-4000-8000-000000000001';
  const token = 'a'.repeat(43);
  const link = `cindy://chat-invite/${token}`;
  const clientId = '40000000-0000-4000-8000-000000000001';
  let service: BotGroupChatService;
  let expiresAt: unknown;
  let reusable: boolean | undefined;
  let members: unknown[];
  beforeEach(() => {
    fixture.packaged = true; fixture.profiles = []; fixture.sockets = [];
    expiresAt = null; reusable = true;
    members = [{ id: selfId, ownerActorId: selfId, state: 'joined', role: 'owner' }];
    fixture.handle.mockImplementation(route => {
      if (route === '/me') return { body: { actor: { id: selfId } } };
      if (route.endsWith('/snapshot')) return { body: { members } };
      if (route === `/conversations/${groupId}/invite-links`) return { body: { token, expiresAt, ...(reusable !== undefined ? { reusable } : {}) } };
      if (route === '/invite-links/preview') return { body: { groupId, name: 'Group', inviterName: 'Host', expiresAt, ...(reusable !== undefined ? { reusable } : {}), joined: false } };
      if (route.endsWith('/invite-links/revoke')) return { body: { revoked: true } };
      return { body: [] };
    });
    service = withChatServer({ dispose: vi.fn() } as unknown as BotGroupChatService, {} as BotGroupChatServiceDeps);
  });
  afterEach(() => { service.dispose(); vi.clearAllMocks(); });
  it.each([[null, true], ['2026-10-10T12:00:00.000Z', false], ['2026-10-10T12:00:00.000Z', undefined]] as const)('preserves expiry %s / reusable %s across creation and preview', async (value, reuse) => {
    expiresAt = value; reusable = reuse;
    expect(await service.chatServer!.createInvite({ groupId, clientId })).toEqual({ ok: true, link, expiresAt, ...(reusable !== undefined ? { reusable } : {}) });
    expect(await service.chatServer!.previewInvite({ link })).toEqual({ ok: true, groupId, name: 'Group', inviterName: 'Host', expiresAt, ...(reusable !== undefined ? { reusable } : {}), joined: false });
    expect(fixture.handle).toHaveBeenCalledWith(`/conversations/${groupId}/invite-links`, 'POST', { operationId: clientId }, expect.objectContaining({ 'X-Chat-Actor': selfId }));
  });
  it.each([undefined, '', 'bad-date', 123])('rejects invalid expiry %s instead of calling it permanent', async value => {
    expiresAt = value;
    expect((await service.chatServer!.createInvite({ groupId, clientId })).ok).toBe(false);
    expect((await service.chatServer!.previewInvite({ link })).ok).toBe(false);
  });
  it.each([undefined, false])('does not accept a null expiry without reusable=true (%s)', async flag => {
    reusable = flag;
    expect(await service.chatServer!.createInvite({ groupId, clientId })).toEqual({ ok: false, errorCode: 'CHAT_RESPONSE_INVALID' });
  });
  it('preserves server denial and never accepts an invitation during preview', async () => {
    fixture.handle.mockImplementation(route => route === '/invite-links/preview'
      ? { status: 404, body: { error: { code: 'INVITATION_NOT_FOUND' } } } : { body: [] });
    expect(await service.chatServer!.previewInvite({ link })).toEqual({ ok: false, errorCode: 'INVITATION_NOT_FOUND' });
    expect(fixture.handle.mock.calls.some(([route]) => route === '/invite-links/accept')).toBe(false);
  });
  it('sends only the current token and group under the management actor, preserving retry id', async () => {
    const input = { groupId, link, clientId };
    expect(await service.chatServer!.revokeInvite(input)).toEqual({ ok: true, revoked: true });
    expect(await service.chatServer!.revokeInvite(input)).toEqual({ ok: true, revoked: true });
    const calls = fixture.handle.mock.calls.filter(([route]) => route.endsWith('/invite-links/revoke'));
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual([`/conversations/${groupId}/invite-links/revoke`, 'POST', { token, operationId: clientId }, expect.objectContaining({ 'X-Chat-Actor': selfId })]);
    expect(calls[1]).toEqual(calls[0]);
  });
  it.each(['member', 'left', 'foreign'])('does not send a revoke request without management rights: %s', async kind => {
    members = [{ id: selfId, ownerActorId: kind === 'foreign' ? groupId : selfId, state: kind === 'left' ? 'left' : 'joined', role: kind === 'member' ? 'member' : 'owner' }];
    expect(await service.chatServer!.revokeInvite({ groupId, link, clientId })).toEqual({ ok: false, errorCode: 'ROLE_REQUIRED' });
    expect(fixture.handle.mock.calls.some(([route]) => route.endsWith('/revoke'))).toBe(false);
  });
  it('allows the account to manage through its owner teammate actor', async () => {
    members = [{ id: groupId, ownerActorId: selfId, state: 'joined', role: 'admin' }];
    expect((await service.chatServer!.revokeInvite({ groupId, link, clientId })).ok).toBe(true);
    expect(fixture.handle.mock.calls.find(([route]) => route.endsWith('/revoke'))?.[3]).toMatchObject({ 'X-Chat-Actor': groupId });
  });
  it.each([
    [403, { error: { code: 'ROLE_REQUIRED' } }, 'ROLE_REQUIRED'],
    [404, { error: { code: 'INVITATION_NOT_FOUND' } }, 'INVITATION_NOT_FOUND'],
    [404, {}, 'INVITE_REVOKE_UNSUPPORTED'],
    [200, {}, 'CHAT_RESPONSE_INVALID'],
    [200, { revoked: false }, 'CHAT_RESPONSE_INVALID'],
    [201, { revoked: true }, 'CHAT_RESPONSE_INVALID'],
  ])('keeps rejection at status %s as failure (%s)', async (status, body, errorCode) => {
    const original = fixture.handle.getMockImplementation()!;
    fixture.handle.mockImplementation((route, ...args) => route.endsWith('/revoke') ? { status, body } : original(route, ...args));
    expect(await service.chatServer!.revokeInvite({ groupId, link, clientId })).toEqual({ ok: false, errorCode });
  });
  it('recognizes the old server non-JSON 404 without claiming success', async () => {
    const original = fixture.handle.getMockImplementation()!;
    fixture.handle.mockImplementation((route, ...args) => route.endsWith('/revoke') ? { status: 404, raw: '<html>Not found</html>' } : original(route, ...args));
    expect(await service.chatServer!.revokeInvite({ groupId, link, clientId })).toEqual({ ok: false, errorCode: 'INVITE_REVOKE_UNSUPPORTED' });
  });
  it.each([200, 201])('keeps the exact revocation success status after refreshing an expired token (status %s)', async status => {
    const original = fixture.handle.getMockImplementation()!;
    let attempts = 0;
    fixture.handle.mockImplementation((route, ...args) => {
      if (!route.endsWith('/revoke')) return original(route, ...args);
      return ++attempts === 1 ? { status: 401, body: { error: { code: 'TOKEN_EXPIRED' } } } : { status, body: { revoked: true } };
    });
    expect(await service.chatServer!.revokeInvite({ groupId, link, clientId })).toEqual(status === 200
      ? { ok: true, revoked: true } : { ok: false, errorCode: 'CHAT_RESPONSE_INVALID' });
    expect(fixture.refresh).toHaveBeenCalledOnce();
    const calls = fixture.handle.mock.calls.filter(([route]) => route.endsWith('/revoke'));
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
  });
  it('shares the authentication refresh cooldown across repeated invitation failures', async () => {
    const original = fixture.handle.getMockImplementation()!;
    fixture.handle.mockImplementation((route, ...args) => route === '/invite-links/preview'
      ? { status: 401, body: { error: { code: 'TOKEN_EXPIRED' } } } : original(route, ...args));
    for (let i = 0; i < 2; i++) {
      expect(await service.chatServer!.previewInvite({ link })).toEqual({ ok: false, errorCode: 'TOKEN_EXPIRED' });
    }
    expect(fixture.refresh).toHaveBeenCalledOnce();
  });
  it.each(['ACCOUNT_INACTIVE', 'ROLE_REQUIRED'])('does not refresh a non-refreshable invitation rejection (%s)', async errorCode => {
    fixture.handle.mockResolvedValue({ status: 401, body: { error: { code: errorCode } } });
    expect(await service.chatServer!.previewInvite({ link })).toEqual({ ok: false, errorCode });
    expect(fixture.refresh).not.toHaveBeenCalled();
  });
  it('does not refresh a malformed 401 invitation response', async () => {
    fixture.handle.mockResolvedValue({ status: 401, raw: '<html>auth challenge fixture</html>' });
    expect(await service.chatServer!.previewInvite({ link })).toEqual({ ok: false, errorCode: 'REQUEST_FAILED' });
    expect(fixture.refresh).not.toHaveBeenCalled();
  });
  it('returns a sanitized failure for malformed invite responses', async () => {
    fixture.handle.mockResolvedValue({ raw: 'not-json-containing-an-invitation-token' });
    expect(await service.chatServer!.previewInvite({ link })).toEqual({ ok: false, errorCode: 'CHAT_RESPONSE_INVALID' });
  });

});
