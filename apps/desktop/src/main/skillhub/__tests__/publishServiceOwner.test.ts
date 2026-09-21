import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ownerId: 'owner-a', generation: 1, boundaryPending: false,
  api: vi.fn(), snapshot: vi.fn(), getInstall: vi.fn(), addInstall: vi.fn(), updateInstall: vi.fn(),
  identity: vi.fn(), pack: vi.fn(),
}));

vi.mock('electron', () => ({ net: { fetch: vi.fn(async () => ({ ok: true, status: 200 })) } }));
vi.mock('../../logger', () => ({ createLogger: () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('../../authManager', () => ({
  getCurrentDataOwnerId: () => mocks.ownerId,
  getCurrentUserId: () => mocks.ownerId,
}));
vi.mock('../../appSessionState', () => ({
  activeOwnerScopeKey: () => `cloud:${mocks.ownerId}:${mocks.generation}`,
  isAppSessionBoundaryPending: () => mocks.boundaryPending,
}));
vi.mock('../../appCapabilities.js', () => ({ getAppCapabilities: () => ({ canUseSkillHubCloud: true }) }));
vi.mock('../identityPolicy', () => ({ currentSkillhubIdentityPolicy: mocks.identity }));
vi.mock('../hubApi', () => ({ skillhubApiFetch: mocks.api }));
vi.mock('../folderHash', () => ({ computeFolderHash: vi.fn(async () => 'folder-hash') }));
vi.mock('../zipPacker', () => ({ pack: mocks.pack }));
vi.mock('../snapshot', () => ({ writeSnapshot: mocks.snapshot }));
vi.mock('../registry', () => ({ registryService: {
  getInstall: mocks.getInstall, addInstall: mocks.addInstall, updateInstall: mocks.updateInstall,
} }));
vi.mock('../../serverApiClient', () => ({ ServerApiError: class extends Error {} }));

import { SkillPublishService } from '../publishService';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('publication owner across commit reconciliation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    Object.assign(mocks, { ownerId: 'owner-a', generation: 1, boundaryPending: false });
    mocks.identity.mockResolvedValue({ canWrite: true, allowedVisibilities: ['PUBLIC'] });
    mocks.pack.mockResolvedValue({ buffer: Buffer.from('zip'), size: 3, sha256: 'hash', manifest: { files: [] } });
    mocks.getInstall.mockResolvedValue(null);
    mocks.snapshot.mockResolvedValue(undefined);
    mocks.api.mockImplementation(async (apiPath: string) => {
      if (apiPath.endsWith('/publish/init')) {
        return { nextVersion: '1.0.0', ossKey: 'object', uploadUrl: 'https://upload.invalid/object' };
      }
      if (apiPath.endsWith('/publish/commit')) return {};
      if (apiPath.includes('/scan?')) return { status: 'pending', gates: [] };
      throw new Error(`Unexpected request: ${apiPath}`);
    });
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it.each((['commit', 'snapshot', 'registry'] as const).flatMap(stage =>
    (['unchanged', 'different-owner', 'new-generation', 'boundary-pending'] as const).map(transition => ({ stage, transition })),
  ))('preserves committed success during $stage / $transition', async ({ stage, transition }) => {
    const entered = deferred(); const resume = deferred();
    const pause = async () => { entered.resolve(); await resume.promise; };
    if (stage === 'commit') {
      const api = mocks.api.getMockImplementation()!;
      mocks.api.mockImplementation(async (...args) => {
        if (String(args[0]).endsWith('/publish/commit')) await pause();
        return api(...args);
      });
    } else if (stage === 'snapshot') mocks.snapshot.mockImplementationOnce(pause);
    else mocks.getInstall.mockImplementationOnce(async () => { await pause(); return null; });

    const globalProgress = vi.fn(); const localProgress = vi.fn();
    const service = new SkillPublishService({ onProgress: globalProgress, scanPollIntervalMs: 10 });
    const publishing = service.publish({ absolutePath: 'virtual-skill', name: 'review-helper', isFirstPublish: false }, localProgress);
    await entered.promise;
    localProgress.mockClear(); globalProgress.mockClear();
    if (transition === 'different-owner') mocks.ownerId = 'owner-b';
    if (transition === 'new-generation') mocks.generation++;
    if (transition === 'boundary-pending') mocks.boundaryPending = true;
    resume.resolve();

    await expect(publishing).resolves.toEqual({ success: true, result: { name: 'review-helper', version: '1.0.0' } });
    expect(mocks.addInstall).toHaveBeenCalledWith('review-helper', 'virtual-skill', expect.objectContaining({ authorId: 'owner-a', version: '1.0.0' }));
    if (transition === 'unchanged') {
      expect(localProgress).toHaveBeenCalledWith({ phase: 'done', name: 'review-helper', version: '1.0.0' });
      await vi.advanceTimersByTimeAsync(20);
      expect(globalProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'scan-result' }));
    } else {
      await vi.advanceTimersByTimeAsync(20);
      expect(localProgress).not.toHaveBeenCalled();
      expect(globalProgress).not.toHaveBeenCalled();
      expect(mocks.api.mock.calls.some(([apiPath]) => String(apiPath).includes('/scan?'))).toBe(false);
    }
    service.stopScanPoll();
  });

  it('keeps a newer owner poll when completion callbacks switch the active owner', async () => {
    const onProgress = vi.fn();
    const service = new SkillPublishService({ onProgress, scanPollIntervalMs: 10 });
    const result = await service.publish({ absolutePath: 'virtual-skill', name: 'review-helper', isFirstPublish: false }, event => {
      if (event.phase !== 'done') return;
      mocks.ownerId = 'owner-b';
      service.startScanPoll('review-helper', '2.0.0');
      onProgress.mockClear();
    });
    expect(result.success).toBe(true);
    expect(onProgress).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    const scanPaths = mocks.api.mock.calls.map(([apiPath]) => String(apiPath)).filter(apiPath => apiPath.includes('/scan?'));
    expect(scanPaths).toEqual(['/api/skills-hub/skills/review-helper/scan?version=2.0.0']);
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'scan-result', version: '2.0.0' }));
  });

  it('does not rebind a publication when identity lookup crosses an owner boundary', async () => {
    const policy = deferred();
    mocks.identity.mockImplementationOnce(async () => {
      await policy.promise;
      return { canWrite: true, allowedVisibilities: ['PUBLIC'] };
    });
    const onProgress = vi.fn();
    const service = new SkillPublishService({ onProgress });
    const publishing = service.publish({ absolutePath: 'virtual-skill', name: 'review-helper', isFirstPublish: false });
    mocks.ownerId = 'owner-b'; policy.resolve();
    await expect(publishing).resolves.toMatchObject({ success: false, errorCode: 'CANCELLED' });
    expect(mocks.pack).not.toHaveBeenCalled();
    expect(mocks.api).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
  });
});
