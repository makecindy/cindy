import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  reviews: vi.fn(),
  markRead: vi.fn(),
  handlers: new Map<string, (event: unknown, raw?: unknown) => Promise<unknown>>(),
  trusted: vi.fn(),
  prepare: vi.fn(),
  cancelReview: vi.fn(),
  setAnonymity: vi.fn(),
  detail: vi.fn(),
  releases: vi.fn(),
  failure: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, raw?: unknown) => Promise<unknown>) =>
      harness.handlers.set(name, handler),
  },
}));
vi.mock('../../security/trustedAppRenderer', () => ({
  assertTrustedAppRendererEvent: harness.trusted,
}));
vi.mock('../reviewUpdates', () => ({ reviewUpdates: harness.reviews, markReviewRead: harness.markRead }));
vi.mock('../host', () => ({
  prepareContribution: harness.prepare,
  cancelPluginReview: harness.cancelReview,
  setPluginAnonymity: harness.setAnonymity,
  myPluginDetail: harness.detail,
  mapContributionError: harness.failure,
  submitContribution: vi.fn(),
  contributionTransferStatus: vi.fn(),
  cancelContribution: vi.fn(),
  discardContribution: vi.fn(),
  listMyPlugins: vi.fn(),
  myPluginSubmission: vi.fn(),
  myPluginReleases: harness.releases,
}));
beforeAll(async () => {
  (await import('../registerIpc')).registerPluginContributionsIpc();
});
beforeEach(() => {
  vi.resetAllMocks();
});
describe('personal contribution IPC', () => {
  it('reads versions through the trusted renderer with bounded pagination and no authority override', async () => {
    const handler = harness.handlers.get('plugin-contributions:releases')!;
    const result = { releases: [], nextCursor: null, queriedAt: '2026-10-16T00:00:00.000Z' };
    harness.releases.mockResolvedValue(result);
    await expect(handler({}, { pluginId: 'plugin', cursor: 'page-2' })).resolves.toEqual(result);
    expect(harness.releases).toHaveBeenCalledWith('plugin', 'page-2');
    for (const invalid of [
      { pluginId: 'plugin', membershipId: 'other' },
      { pluginId: 'plugin', cursor: 'x'.repeat(4097) },
      { pluginId: '' },
    ])
      await expect(handler({}, invalid)).rejects.toThrow('INVALID_PARAMS');
    harness.trusted.mockImplementationOnce(() => {
      throw new Error('[PERMISSION_DENIED] untrusted');
    });
    await expect(handler({}, { pluginId: 'plugin' })).rejects.toThrow('PERMISSION_DENIED');
    expect(harness.releases).toHaveBeenCalledTimes(1);
  });
  it('passes only the exact instance identifier and a Host-owned manual source', async () => {
    harness.prepare.mockResolvedValue({ preparedId: 'prepared' });
    await expect(
      harness.handlers.get('plugin-contributions:prepare')!(
        {},
        { instanceId: 'physical-instance' },
      ),
    ).resolves.toEqual({ preparedId: 'prepared' });
    expect(harness.prepare).toHaveBeenCalledWith('physical-instance', 'manual', undefined);
    await expect(
      harness.handlers.get('plugin-contributions:prepare')!(
        {},
        { instanceId: 'physical-instance', path: '/private/package.cindy' },
      ),
    ).rejects.toThrow('INVALID_PARAMS');
    expect(harness.prepare).toHaveBeenCalledTimes(1);
  });
  it('rejects an untrusted renderer before accessing personal author data', async () => {
    harness.trusted.mockImplementationOnce(() => {
      throw new Error('[PERMISSION_DENIED] untrusted');
    });
    await expect(
      harness.handlers.get('plugin-contributions:detail')!({}, { pluginId: 'plugin' }),
    ).rejects.toThrow('PERMISSION_DENIED');
    expect(harness.detail).not.toHaveBeenCalled();
  });
  it('rejects extra authority fields and forwards failures to the redaction boundary', async () => {
    const handler = harness.handlers.get('plugin-contributions:detail')!;
    await expect(
      handler({}, { pluginId: 'plugin', membershipId: 'another-member' }),
    ).rejects.toThrow('INVALID_PARAMS');
    expect(harness.detail).not.toHaveBeenCalled();
    const failure = new Error('private transport detail');
    harness.detail.mockRejectedValueOnce(failure);
    harness.failure.mockImplementationOnce(() => {
      throw new Error('[INTERNAL] Community contribution request failed');
    });
    await expect(handler({}, { pluginId: 'plugin' })).rejects.toThrow(
      '[INTERNAL] Community contribution request failed',
    );
    expect(harness.failure).toHaveBeenCalledWith(failure);
  });
});


it('cancels only the exact displayed release and rejects extra caller identity', async () => {
  const input = { pluginId: 'plugin', release: { releaseId: 'release', sha256: 'a'.repeat(64), revision: '2026-10-16T00:00:00.000Z' } };
  harness.cancelReview.mockResolvedValue({ reviewStatus: 'cancelled' });
  const cancel = harness.handlers.get('plugin-contributions:cancel-review')!;
  await expect(cancel({}, input)).resolves.toMatchObject({ reviewStatus: 'cancelled' });
  expect(harness.cancelReview).toHaveBeenCalledWith(input.pluginId, input.release);
  await expect(cancel({}, { ...input, membershipId: 'other' })).rejects.toThrow('INVALID_PARAMS');
  await expect(cancel({}, { ...input, release: { ...input.release, revision: 'bad' } })).rejects.toThrow('INVALID_PARAMS');
  expect(harness.cancelReview).toHaveBeenCalledTimes(1);
});

it('validates review-read receipts and rejects remote subject overrides before reading or acknowledging', async () => {
  const list = harness.handlers.get('plugin-contributions:review-updates')!;
  harness.reviews.mockResolvedValue([]);
  await expect(list({}, undefined)).resolves.toEqual([]);
  await expect(list({}, { membershipId: 'other' })).rejects.toThrow('INVALID_PARAMS');
  const mark = harness.handlers.get('plugin-contributions:mark-review-read')!;
  await mark({}, { pluginId: 'plugin', key: 'exact-decision' });
  expect(harness.markRead).toHaveBeenCalledExactlyOnceWith('plugin', 'exact-decision');
  await expect(mark({}, { pluginId: 'plugin', key: 'exact', authority: 'other' })).rejects.toThrow('INVALID_PARAMS');
  await expect(mark({}, { pluginId: 'plugin', key: 'x'.repeat(1025) })).rejects.toThrow('INVALID_PARAMS');
  harness.trusted.mockImplementationOnce(() => { throw new Error('PERMISSION_DENIED'); });
  await expect(mark({}, { pluginId: 'plugin', key: 'exact' })).rejects.toThrow('PERMISSION_DENIED');
  expect(harness.markRead).toHaveBeenCalledTimes(1);
});


it('validates anonymity preferences without accepting a caller-supplied author identity', async () => {
  const handler = harness.handlers.get('plugin-contributions:set-anonymity')!;
  await handler({}, { pluginId: 'plugin', anonymous: false });
  expect(harness.setAnonymity).toHaveBeenCalledExactlyOnceWith('plugin', false);
  for (const input of [{ pluginId: 'plugin', anonymous: 'false' }, { pluginId: 'plugin', anonymous: false, membershipId: 'other' }])
    await expect(handler({}, input)).rejects.toThrow('INVALID_PARAMS');
  expect(harness.setAnonymity).toHaveBeenCalledTimes(1);
  harness.trusted.mockImplementationOnce(() => { throw new Error('PERMISSION_DENIED'); });
  await expect(handler({}, { pluginId: 'plugin', anonymous: true })).rejects.toThrow('PERMISSION_DENIED');
  expect(harness.setAnonymity).toHaveBeenCalledTimes(1);
});
