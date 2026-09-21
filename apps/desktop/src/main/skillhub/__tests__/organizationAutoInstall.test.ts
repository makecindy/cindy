import { describe, expect, it, vi } from 'vitest';
vi.mock('../hubApi', () => ({ skillhubApiFetch: vi.fn() }));
import { fetchOrganizationAutoInstallSkills } from '../organizationAutoInstall';

const skill = { name: 'department-skill', version: '1.0.0', catalogScope: 'team' };
describe('organization skill distribution', () => {
  it('loads every page without sending department identities', async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ skills: [skill], nextCursor: 'department-skill' })
      .mockResolvedValueOnce({ skills: [{ ...skill, name: 'second' }], nextCursor: null });
    expect(await fetchOrganizationAutoInstallSkills(fetch)).toEqual([skill, { ...skill, name: 'second' }]);
    expect(fetch.mock.calls).toEqual([['/api/skills-hub/auto-install'], ['/api/skills-hub/auto-install?cursor=department-skill']]);
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
