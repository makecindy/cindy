// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast, type ToastOptions } from '@/lib/toast';

vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('@/lib/toast', () => ({ toast: {
  warning: vi.fn(() => 'cleanup-notice'), dismiss: vi.fn(), success: vi.fn(), error: vi.fn(),
} }));

vi.mock('../useSkillSync', () => ({
  registerSyncStoreSetters: vi.fn(),
  invalidateSkillSyncRequests: vi.fn(),
}));

import { bootstrapSkillhub, refresh, reset, setSkillhubDataOwner } from '../useSkillhub';

describe('SkillHub data-owner bootstrap', () => {
  const scan = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    scan.mockResolvedValue({ success: true, skills: [], sources: [] });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      skillhub: { scan },
    };
  });

  it('starts a fresh local scan when cloud auth switches to local mode', async () => {
    setSkillhubDataOwner('cloud-owner');
    bootstrapSkillhub();
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(1));

    setSkillhubDataOwner('local-v1');
    bootstrapSkillhub();
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(2));

    expect(scan).toHaveBeenLastCalledWith({ projects: [] });
  });

  it('restores cleanup notices from scanning and invalidates old actions across owner changes', async () => {
    reset();
    const retry = vi.fn(async () => ({ complete: true }));
    window.electronAPI.skillhub.retryUninstallCleanup = retry;
    scan.mockResolvedValue({ success: true, skills: [], sources: [], pendingCleanups: [{ token: 'receipt', name: 'example' }] });
    await refresh();
    await refresh();
    expect(toast.warning).toHaveBeenCalledOnce();
    const firstAction = (vi.mocked(toast.warning).mock.calls[0]![1] as ToastOptions).action!;
    setSkillhubDataOwner('another-owner');
    firstAction.onClick();
    expect(retry).not.toHaveBeenCalled();
    await refresh();
    const newAction = (vi.mocked(toast.warning).mock.calls.at(-1)![1] as ToastOptions).action!;
    newAction.onClick();
    await vi.waitFor(() => expect(retry).toHaveBeenCalledOnce());
    expect(retry).toHaveBeenCalledWith('receipt');
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalledWith('skillhub.management.cleanupComplete'));
    reset();
  });

  it('makes a stale refresh wait for and return the newest scan result', async () => {
    reset();
    let resolveFirst!: (value: { success: true; skills: SkillhubSkill[]; sources: [] }) => void;
    let resolveSecond!: (value: { success: true; skills: SkillhubSkill[]; sources: [] }) => void;
    scan
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
    const latestSkill = { id: 'skill:global:latest', name: 'latest' } as SkillhubSkill;

    const first = refresh();
    const second = refresh();
    let firstSettled = false;
    void first.then(() => { firstSettled = true; });

    resolveFirst({ success: true, skills: [], sources: [] });
    await Promise.resolve();
    expect(firstSettled).toBe(false);

    resolveSecond({ success: true, skills: [latestSkill], sources: [] });
    await expect(second).resolves.toEqual([latestSkill]);
    await expect(first).resolves.toEqual([latestSkill]);
  });
});
