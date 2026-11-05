import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// writer.ts imports `shell` from electron (for openUserRecipesDir) and the
// loader (which imports `app`); stub both so the module is importable in node.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/xdt-test-userdata' },
  shell: { openPath: async () => '' },
}));

const { writeUserRecipe, resetSiteRecipe } = await import('../writer.js');
const { loadUserBrowserRecipes } = await import('../loader.js');
const { browserExperienceStore } = await import('../experience.js');

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xdt-recipes-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** Read a site's L2 files back the way the loader would. */
async function readBack(_site: string) {
  return loadUserBrowserRecipes(dir);
}

describe('writeUserRecipe / resetSiteRecipe', () => {
  // New local experience persistence, unit: a fresh host sees repetition without
  // storing script/input values, and the existing site reset removes it too.
  it('persists bounded structural observations across host instances and resets with the site', async () => {
    const first = browserExperienceStore(dir);
    const input = { site: 'experience.test', actions: ['navigate', 'extract'] as ['navigate', 'extract'] };
    await first.record(input);
    const second = browserExperienceStore(dir);
    expect(await second.record(input)).toMatchObject({ ...input, observations: 2 });
    expect(await second.list(input.site)).toHaveLength(1);
    const raw = JSON.parse(await fs.readFile(path.join(dir, input.site, 'experience.json'), 'utf8'));
    expect(Object.keys(raw[0]).sort()).toEqual(['actions', 'observations', 'site', 'updatedAt']);
    await expect(second.record({ ...input, site: '../escape' })).rejects.toBeTruthy();
    await resetSiteRecipe(input.site, dir);
    expect(await second.list(input.site)).toEqual([]);
  });
  it('writes a recipe that reads back as a valid L2 entry', async () => {
    const res = await writeUserRecipe(
      { site: 'x.com', recipe: { id: 'x-search', steps: [{ action: 'navigate', url: 'https://x.com/' }] } },
      dir,
    );
    expect(res.ok).toBe(true);
    const back = await readBack('x.com');
    expect(back.recipes.get('x-search')?.id).toBe('x-search');
    expect(back.diagnostics).toEqual([]);
  });

  it('overwrites the same site on re-save (no auto-rename — preserves by-id override)', async () => {
    await writeUserRecipe({ site: 'x.com', recipe: { id: 'r', steps: [{ action: 'navigate', url: 'https://one/' }] } }, dir);
    await writeUserRecipe({ site: 'x.com', recipe: { id: 'r', steps: [{ action: 'navigate', url: 'https://two/' }] } }, dir);
    const files = await fs.readdir(path.join(dir, 'x.com'));
    expect(files).toEqual(['recipes']);
    expect(await fs.readdir(path.join(dir, 'x.com', 'recipes'))).toHaveLength(1);
    const back = await readBack('x.com');
    expect((back.recipes.get('r')?.steps[0] as { url: string }).url).toBe('https://two/');
  });

  it('loads a legacy recipe with its owning site so a future failure can suspend it', async () => {
    await fs.mkdir(path.join(dir, 'legacy.example'));
    await fs.writeFile(path.join(dir, 'legacy.example', 'recipe.json'), JSON.stringify({ id: 'legacy', steps: [{ action: 'navigate', url: 'https://legacy.example/' }] }));
    const back = await loadUserBrowserRecipes(dir);
    expect(back.recipes.get('legacy')?.validation).toEqual({ site: 'legacy.example', state: 'active' });
  });

  it('keeps multiple flows and suspended state across reload, shadowing the legacy id', async () => {
    await fs.mkdir(path.join(dir, 'x.com'));
    await fs.writeFile(path.join(dir, 'x.com', 'recipe.json'), JSON.stringify({ id: 'first', steps: [{ action: 'navigate', url: 'https://old/' }] }));
    await writeUserRecipe({ site: 'x.com', recipe: { id: 'first', validation: { site: 'x.com', state: 'suspended' }, steps: [{ action: 'navigate', url: 'https://new/' }] } }, dir);
    await writeUserRecipe({ site: 'x.com', recipe: { id: '../second', steps: [{ action: 'navigate', url: 'https://x.com/' }] } }, dir);
    const back = await loadUserBrowserRecipes(dir);
    expect(back.recipes.size).toBe(2);
    expect(back.recipes.get('first')?.validation?.state).toBe('suspended');
    expect(back.recipes.get('first')?.steps[0].url).toBe('https://new/');
    expect(back.recipes.has('../second')).toBe(true);
  });

  it('rejects a path-unsafe site segment', async () => {
    const res = await writeUserRecipe(
      { site: '../evil', recipe: { id: 'r', steps: [{ action: 'navigate', url: 'https://x/' }] } },
      dir,
    );
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/invalid site/);
  });

  it('rejects dots-only segments that pass the char allowlist (.,..,...)', async () => {
    // `.` / `..` / `...` all match `^[a-zA-Z0-9.-]+$` but `path.join` would use
    // them to escape the recipes dir — they must be rejected explicitly.
    for (const site of ['.', '..', '...']) {
      const res = await writeUserRecipe(
        { site, recipe: { id: 'r', steps: [{ action: 'navigate', url: 'https://x/' }] } },
        dir,
      );
      expect(res.ok).toBe(false);
      expect(res.message).toMatch(/invalid site/);
    }
  });

  it('rejects a leading-dash segment and an over-length segment', async () => {
    for (const site of ['-rf', '-flag.com', `${'a'.repeat(254)}.com`]) {
      const res = await writeUserRecipe(
        { site, recipe: { id: 'r', steps: [{ action: 'navigate', url: 'https://x/' }] } },
        dir,
      );
      expect(res.ok).toBe(false);
      expect(res.message).toMatch(/invalid site/);
    }
  });

  it('resetSiteRecipe deletes the site dir (restore default = fall back to L1)', async () => {
    await writeUserRecipe({ site: 'x.com', recipe: { id: 'r', steps: [{ action: 'navigate', url: 'https://x/' }] } }, dir);
    const reset = await resetSiteRecipe('x.com', dir);
    expect(reset.ok).toBe(true);
    await expect(fs.readdir(path.join(dir, 'x.com'))).rejects.toBeTruthy(); // gone
  });
});
