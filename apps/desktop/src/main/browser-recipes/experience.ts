import path from 'node:path';
import { BrowserExperienceSchema, type BrowserExperienceStore } from '@cindy/mcps';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';

/** Bounded local observations, alongside recipes; resetSiteRecipe removes both. */
export function browserExperienceStore(dir: string): BrowserExperienceStore {
  const file = (site: string) =>
    path.join(dir, BrowserExperienceSchema.shape.site.parse(site), 'experience.json');
  const read = (site: string) => {
    const raw = readAtomicFileSync(file(site));
    if (!raw) return [];
    const parsed = BrowserExperienceSchema.array().max(32).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.filter((item) => item.site === site) : [];
  };
  return {
    async list(site) {
      return read(site);
    },
    async record(input) {
      const next = BrowserExperienceSchema.parse({
        ...input,
        observations: 1,
        updatedAt: Date.now(),
      });
      const existing = read(next.site);
      const key = next.actions.join('/');
      const previous = existing.find((item) => item.actions.join('/') === key);
      next.observations = Math.min((previous?.observations ?? 0) + 1, 1_000_000);
      // No await in read-modify-write: desktop's shared event loop owns this
      // advisory cache. A separate app process can lose a count, never a recipe.
      const entries = [...existing.filter((item) => item.actions.join('/') !== key), next].slice(
        -32,
      );
      atomicWriteFileSync(file(next.site), JSON.stringify(entries));
      return next;
    },
  };
}
