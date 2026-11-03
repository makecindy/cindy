/**
 * L2 user-recipe writer (host side) — the self-grow persistence path.
 *
 * Writes an agent/user-authored recipe (and optional site guide) into
 * `userData/browser-recipes/<site>/recipes/`. Same id → overwrite; different
 * flows on the same site coexist. `resetSite` deletes a site's L2 files so it falls back to the
 * bundled L1 (the "restore default" semantics, like override-settings reset).
 *
 * The L2 `version` is content-derived (see loader.ts), so writing a file is
 * enough to invalidate the merged-registry cache on the next read — no counter.
 * Modeled on `apps/desktop/src/main/local-themes/writer.ts`.
 */
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';

import { shell } from 'electron';
import type { Recipe, SiteGuide } from '@cindy/mcps';

import { createLogger } from '../logger.js';
import { userRecipesDir } from './loader.js';
import { atomicWriteFileSync } from '../utils/atomicWriteFile.js';

const log = createLogger('browser-recipes');

/** A site dir name is used verbatim in the path; keep it a plain host token. */
function safeSiteSegment(site: string): string | null {
  const trimmed = site.trim();
  // Bound to a hostname's max length so a pathological input can't bloat the path.
  if (!trimmed || trimmed.length > 253) return null;
  // Must START with a letter/digit — this blocks both a leading '-' (which
  // downstream tooling could read as a flag) AND traversal segments ('.'/'..'/
  // '...'), since none of those begin with an alnum char. The remainder allows
  // letters/digits/dot/dash only (no separators).
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(trimmed)) return null;
  return trimmed;
}

export interface WriteUserRecipeResult {
  ok: boolean;
  path?: string;
  message?: string;
}

/** Write (overwrite) the L2 recipe + optional siteguide for a site. */
export async function writeUserRecipe(
  input: { site: string; recipe: Recipe; siteGuide?: SiteGuide },
  dir = userRecipesDir(),
): Promise<WriteUserRecipeResult> {
  const seg = safeSiteSegment(input.site);
  if (!seg) return { ok: false, message: `invalid site "${input.site}" (expected a host like "news.ycombinator.com")` };
  const siteDir = path.join(dir, seg);
  try {
    await fs.mkdir(siteDir, { recursive: true });
    // Hash arbitrary ids to a bounded, path-safe name on every platform.
    const name = crypto.createHash('sha256').update(input.recipe.id).digest('hex');
    const recipePath = path.join(siteDir, 'recipes', `${name}.json`);
    atomicWriteFileSync(recipePath, `${JSON.stringify(input.recipe, null, 2)}\n`);
    if (input.siteGuide) {
      atomicWriteFileSync(
        path.join(siteDir, 'siteguide.json'),
        `${JSON.stringify(input.siteGuide, null, 2)}\n`,
      );
    }
    return { ok: true, path: recipePath };
  } catch (err) {
    log.warn('failed to write user recipe', { site: input.site, error: String(err) });
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * "Restore default" for a site = delete its L2 dir → falls back to bundled L1.
 *
 * Intentionally not yet wired to a caller: the Settings "restore default" /
 * "open folder" affordances were deferred. Kept as a documented self-grow
 * primitive (the inverse of `saveRecipe`), not forgotten dead code.
 */
export async function resetSiteRecipe(site: string, dir = userRecipesDir()): Promise<{ ok: boolean; message?: string }> {
  const seg = safeSiteSegment(site);
  if (!seg) return { ok: false, message: `invalid site "${site}"` };
  try {
    await fs.rm(path.join(dir, seg), { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Open the L2 recipes folder in the OS file manager.
 *
 * Intentionally not yet wired to a caller: the Settings "open folder"
 * affordance was deferred. Kept as a documented self-grow primitive, not
 * forgotten dead code.
 */
export async function openUserRecipesDir(dir = userRecipesDir()): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await shell.openPath(dir);
}
