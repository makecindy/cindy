import { describe, expect, it, vi } from 'vitest';

// loader.ts top-level imports `app` from electron; stub it so the pure
// `buildUserRecipes` is importable in the node test env.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/xdt-test-userdata' } }));

const { buildUserRecipes } = await import('../loader.desktop.js');

const recipeJson = (id: string, url = 'https://u/') =>
  JSON.stringify({ id, steps: [{ action: 'navigate', url }] });
const guideJson = (site: string, notes: string) => JSON.stringify({ site, notes });

describe('buildUserRecipes', () => {
  it('parses valid recipe + siteguide entries and fingerprints a version', () => {
    const res = buildUserRecipes(
      { '/u/a/recipe.json': recipeJson('a') },
      { '/u/a/siteguide.json': guideJson('a.com', 'note') },
    );
    expect(res.recipes.get('a')?.id).toBe('a');
    expect(res.siteGuides.get('a.com')?.notes).toBe('note');
    expect(res.version).not.toBe('');
    expect(res.diagnostics).toEqual([]);
  });

  it('isolates a bad file: a malformed entry is dropped with a diagnostic, others survive', () => {
    const res = buildUserRecipes(
      { '/u/a/recipe.json': recipeJson('a'), '/u/bad/recipe.json': '{ not json' },
      {},
    );
    expect(res.recipes.get('a')?.id).toBe('a'); // good one survives
    expect(res.recipes.has('bad')).toBe(false);
    expect(res.diagnostics.length).toBe(1);
    expect(res.diagnostics[0]).toMatch(/invalid JSON/);
  });

  it('keeps the first on a duplicate recipe id and records a diagnostic', () => {
    const res = buildUserRecipes(
      { '/u/a/recipe.json': recipeJson('dup', 'https://first/'), '/u/b/recipe.json': recipeJson('dup', 'https://second/') },
      {},
    );
    expect((res.recipes.get('dup')?.steps[0] as { url: string }).url).toBe('https://first/');
    expect(res.diagnostics.some((d) => /duplicate user recipe id "dup"/.test(d))).toBe(true);
  });

  it('empty layer → version "" (so the registry stays on bundled-only baseline)', () => {
    const res = buildUserRecipes({}, {});
    expect(res.version).toBe('');
    expect(res.recipes.size).toBe(0);
  });

  it('version changes when content changes (drives cache invalidation)', () => {
    const v1 = buildUserRecipes({ '/u/a/recipe.json': recipeJson('a', 'https://one/') }, {}).version;
    const v2 = buildUserRecipes({ '/u/a/recipe.json': recipeJson('a', 'https://two/') }, {}).version;
    expect(v1).not.toBe(v2);
  });
});
