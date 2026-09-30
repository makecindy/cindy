import { describe, expect, it, vi } from 'vitest';
vi.mock('../hubApi', () => ({ skillhubApiFetch: vi.fn() }));
import { fetchOrganizationAutoInstallSkills } from '../organizationAutoInstall';

const skill = { name: 'department-skill', version: '1.0.0', catalogScope: 'team' };
describe('organization skill distribution', () => {
  it('bounds a stalled lookup and does not fetch further pages after its deadline', async () => {
    vi.useFakeTimers();
    try {
      let resolve!: (value: unknown) => void;
      const fetch = vi.fn((_path: string, _options: { timeoutMs: number }) => new Promise<unknown>((done) => { resolve = done; }));
      const pending = fetchOrganizationAutoInstallSkills(fetch);
      const rejected = expect(pending).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(5_000);
      await rejected;
      resolve({ skills: [skill], nextCursor: skill.name });
      await vi.advanceTimersByTimeAsync(1);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0][1]).toEqual({ timeoutMs: 5_000 });
    } finally { vi.useRealTimers(); }
  });
  it('loads every page without sending department identities', async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ skills: [skill], nextCursor: 'department-skill' })
      .mockResolvedValueOnce({ skills: [{ ...skill, name: 'second' }], nextCursor: null });
    expect(await fetchOrganizationAutoInstallSkills(fetch)).toEqual([skill, { ...skill, name: 'second' }]);
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(['/api/skills-hub/auto-install', '/api/skills-hub/auto-install?cursor=department-skill']);
    for (const [, options] of fetch.mock.calls) expect(options.timeoutMs).toBeGreaterThan(0);
  });
  it.each([{ ...skill, name: '../unsafe' }, { ...skill, version: 'bad' }, { ...skill, catalogScope: 'market' }])(
    'rejects invalid entries atomically', async (bad) => {
      await expect(fetchOrganizationAutoInstallSkills(vi.fn().mockResolvedValue({ skills: [skill, bad], nextCursor: null })))
        .rejects.toThrow();
    });
  it('stops cyclic pagination', async () => {
    const fetch = vi.fn().mockResolvedValue({ skills: [skill], nextCursor: 'same' });
    await expect(fetchOrganizationAutoInstallSkills(fetch)).rejects.toThrow('pagination');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('returns no candidates for an empty or personal audience', async () => {
    expect(await fetchOrganizationAutoInstallSkills(vi.fn().mockResolvedValue({ skills: [], nextCursor: null }))).toEqual([]);
  });
  it('does not return partial candidates if a later page fails', async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ skills: [skill], nextCursor: skill.name }).mockRejectedValueOnce(new Error('offline'));
    await expect(fetchOrganizationAutoInstallSkills(fetch)).rejects.toThrow('offline');
  });
});
