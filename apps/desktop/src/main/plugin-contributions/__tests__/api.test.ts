import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerApiError } from '../../serverApiClient';

const harness = vi.hoisted(() => ({
  owner: 'A:1',
  token: '',
  membershipKind: 'personal' as 'personal' | 'org',
  fetch: vi.fn(),
  discover: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0' },
  net: { fetch: harness.discover },
}));
vi.mock('../../authManager', () => ({
  getAccessToken: () => harness.token,
  getActiveAuthRealm: () => 'cn',
  getAuthState: () => ({ user: { id: 'member-A', membershipKind: harness.membershipKind } }),
  refresh: harness.refresh,
}));
vi.mock('../../clientEndpointsService', () => ({
  getClientEndpoint: () => 'https://plugin.test',
  getClientEndpointForRealm: () => 'https://auth.test',
}));
vi.mock('../../serverApiClient', () => ({
  serverApiFetch: harness.fetch,
  ServerApiError: class extends Error {
    constructor(
      readonly code: string,
      readonly statusCode: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock('../prepared', () => ({
  contributionOwnerKey: () => harness.owner,
  assertContributionOwner: (owner: string) => {
    if (owner !== harness.owner) throw new Error('[OWNER_CHANGED] changed');
  },
}));

const issuer = 'https://trusted-issuer.test';
const subject = { authority: issuer, membershipId: 'member-A' };
const page = () => ({
  subject,
  queriedAt: '2026-10-15T00:00:00.000Z',
  plugins: [],
  nextCursor: null,
});
const listInput = { query: '', filter: 'all' };
import { ContributionApi as Api } from '../api';
let testClock = 0;
beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 21) + ++testClock * 360_000);
  harness.owner = 'A:1';
  harness.membershipKind = 'personal';
  harness.token = `unused.${Buffer.from(JSON.stringify({ iss: issuer, sub: 'member-A', ctx: 'personal' })).toString('base64url')}.unused`;
  harness.discover.mockResolvedValue({ ok: true, json: async () => ({ issuer }) });
  harness.fetch.mockResolvedValue(page());
});
afterEach(() => vi.restoreAllMocks());

describe('personal contribution authority', () => {
  it('uses the organization member’s current token for their own public contributions', async () => {
    harness.membershipKind = 'org';
    harness.token = `unused.${Buffer.from(JSON.stringify({ iss: issuer, sub: 'member-A', ctx: 'org' })).toString('base64url')}.unused`;
    await expect(new Api().list(listInput)).resolves.toEqual(page());
    expect(harness.fetch.mock.calls[0][1].token).toBe(harness.token);
  });
  it('rejects a token for another membership kind before HTTP dispatch', async () => {
    harness.membershipKind = 'org';
    await expect(new Api().list(listInput)).rejects.toThrow('ACCOUNT_REAUTH_REQUIRED');
    expect(harness.fetch).not.toHaveBeenCalled();
  });
  it('rechecks a write guard after awaited discovery, before dispatching the original commit', async () => {
    let allowed = true;
    harness.discover.mockImplementationOnce(async () => {
      allowed = false;
      return { ok: true, json: async () => ({ issuer }) };
    });
    const api = new Api(async () => { if (!allowed) throw new Error('[PRECONDITION_FAILED] installation or task changed'); });
    await expect(api.commit('original-operation')).rejects.toThrow('PRECONDITION_FAILED');
    expect(harness.fetch).not.toHaveBeenCalled();
  });
  it('reads version pages without losing the existing prepare version filter or subject fence', async () => {
    const result = { subject, queriedAt: page().queriedAt, releases: [], nextCursor: 'more' };
    harness.fetch.mockResolvedValue(result);
    const api = new Api();
    await expect(api.releases('plugin/one', undefined, 'page+2')).resolves.toEqual(result);
    const path = harness.fetch.mock.calls[0][0] as string;
    expect(path).toContain('/plugins/plugin%2Fone/releases?');
    expect(new URL(path, 'https://plugin.test').searchParams.get('cursor')).toBe('page+2');
    expect(new URL(path, 'https://plugin.test').searchParams.get('limit')).toBe('50');
    await api.releases('plugin/one', '1.0.0');
    expect(harness.fetch.mock.calls[1][0]).toContain('version=1.0.0');
    harness.fetch.mockResolvedValueOnce({
      ...result,
      subject: { ...subject, membershipId: 'other' },
    });
    await expect(api.releases('plugin/one')).rejects.toThrow(
      'Contribution response subject mismatch',
    );
  });
  it('uses the trusted issuer rather than equating the cn realm with authority', async () => {
    await expect(new Api().list(listInput)).resolves.toEqual(page());
    expect(harness.discover.mock.calls[0][0]).toBe(
      'https://auth.test/.well-known/openid-configuration',
    );
    expect(harness.fetch.mock.calls[0][1]).toMatchObject({
      token: harness.token,
      skipAutoRefresh: true,
      skipSessionInvalidation: true,
    });
    harness.fetch.mockResolvedValueOnce({ ...page(), subject: { ...subject, authority: 'cn' } });
    await expect(new Api().list(listInput)).rejects.toThrow();
  });
  it('rejects a validly shaped response for another member', async () => {
    harness.fetch.mockResolvedValueOnce({
      ...page(),
      subject: { ...subject, membershipId: 'member-B' },
    });
    await expect(new Api().list(listInput)).rejects.toThrow(
      'Contribution response subject mismatch',
    );
  });
  it('rejects a late response after A to B to A, without refreshing a new account', async () => {
    harness.fetch.mockImplementationOnce(async () => {
      harness.owner = 'A:3';
      return page();
    });
    await expect(new Api().list(listInput)).rejects.toThrow('OWNER_CHANGED');
    expect(harness.refresh).not.toHaveBeenCalled();
  });
  it('rechecks the captured owner after refresh and does not send a retry under another identity', async () => {
    harness.fetch.mockRejectedValueOnce(new ServerApiError('TOKEN_EXPIRED', 401, 'expired'));
    harness.refresh.mockImplementationOnce(async () => {
      harness.owner = 'B:2';
    });
    await expect(new Api().list(listInput)).rejects.toThrow('OWNER_CHANGED');
    expect(harness.fetch).toHaveBeenCalledTimes(1);
  });
});


it('stops before HTTP when the requesting AI session loses its write permission', async () => {
  const api = new Api(async () => { throw new Error('[PERMISSION_DENIED] session changed'); });
  await expect(api.cancelReview('plugin', { releaseId: 'release', sha256: 'a'.repeat(64), displayUpdatedAt: '2026-10-16T00:00:00.000Z' })).rejects.toThrow('PERMISSION_DENIED');
  expect(harness.fetch).not.toHaveBeenCalled();
});
