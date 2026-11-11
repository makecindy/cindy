import { skillhubApiFetch } from './hubApi';

export interface OrganizationAutoInstallSkill {
  name: string;
  version: string;
  catalogScope: 'team';
}

const DISTRIBUTION_TIMEOUT_MS = 5_000;
type FetchPage = (path: string, options: { timeoutMs: number }) => Promise<unknown>;

/** Bound the entire paginated lookup, including authentication refresh. */
export async function fetchOrganizationAutoInstallSkills(
  fetchPage: FetchPage = (path, options) => skillhubApiFetch(path, options),
): Promise<OrganizationAutoInstallSkill[]> {
  const deadline = Date.now() + DISTRIBUTION_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      loadPages(fetchPage, deadline),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Organization skill distribution timed out')), DISTRIBUTION_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Server owns the department decision; never send client-supplied department IDs. */
async function loadPages(fetchPage: FetchPage, deadline: number): Promise<OrganizationAutoInstallSkill[]> {
  const skills = new Map<string, OrganizationAutoInstallSkill>();
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const path = '/api/skills-hub/auto-install' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) throw new Error('Organization skill distribution timed out');
    const raw = await fetchPage(path, { timeoutMs });
    if (!raw || typeof raw !== 'object') throw new Error('Invalid organization skill distribution');
    const page = raw as Record<string, unknown>;
    if (!Array.isArray(page.skills) || page.skills.length > 100
      || !(page.nextCursor === null || (typeof page.nextCursor === 'string' && /^[a-z0-9][a-z0-9-]{0,127}$/.test(page.nextCursor)))) {
      throw new Error('Invalid organization skill distribution');
    }
    for (const value of page.skills) {
      if (!value || typeof value !== 'object') throw new Error('Invalid organization skill');
      const skill = value as Record<string, unknown>;
      if (typeof skill.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(skill.name)
        || typeof skill.version !== 'string' || skill.version.length > 32 || !/^\d+\.\d+\.\d+$/.test(skill.version)
        || skill.catalogScope !== 'team') throw new Error('Invalid organization skill');
      skills.set(skill.name, skill as unknown as OrganizationAutoInstallSkill);
    }
    cursor = page.nextCursor as string | null;
    if (cursor) {
      if (seen.has(cursor) || seen.size >= 100) throw new Error('Invalid organization skill pagination');
      seen.add(cursor);
    }
  } while (cursor);
  return [...skills.values()];
}
