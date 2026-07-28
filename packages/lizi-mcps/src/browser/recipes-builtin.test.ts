/**
 * Guards over the bundled L1 recipe catalog (`./recipes/<site>/{recipe,siteguide}.json`).
 *
 * The unit tests in recipe-loader.test.ts cover the parsers with hand-written
 * fixtures; nothing so far validated the *shipped* JSON itself. These tests run
 * the real `loadRecipes()` / `loadSiteGuides()` glob so a malformed bundled
 * recipe (bad JSON, schema violation, duplicate id, unsafe `fn` interpolation,
 * or a `{{var}}` that no input/`as` provides) fails CI instead of surfacing as
 * a runtime "missing recipe variable" / injection hazard.
 */
import { describe, expect, it } from 'vitest';

import { loadRecipes, loadSiteGuides, type Recipe } from './recipe-loader.js';
import { findUnsafeEvaluateInterpolations } from './recipe-runner.js';

const recipes = loadRecipes();
const siteGuides = loadSiteGuides();

// Same shape as recipe-runner's VAR_RE (kept local: the runner does not export it).
const VAR_RE = /\{\{\s*([\w-]+)\s*(?:\|\s*([a-z]+)\s*)?\}\}/g;

/** All `{{var}}` names referenced anywhere a recipe interpolates. */
function referencedVars(recipe: Recipe): Map<string, string[]> {
  const refs = new Map<string, string[]>();
  const scan = (text: string | undefined, where: string) => {
    if (!text) return;
    for (const m of text.matchAll(new RegExp(VAR_RE.source, 'g'))) {
      const list = refs.get(m[1]) ?? [];
      list.push(where);
      refs.set(m[1], list);
    }
  };
  recipe.steps.forEach((step, i) => {
    scan(step.url, `step ${i} url`);
    scan(step.selector, `step ${i} selector`);
    scan(step.fn, `step ${i} fn`);
    scan(step.value, `step ${i} value`);
    scan(step.textGone, `step ${i} textGone`);
    scan(step.filter, `step ${i} filter`);
    for (const v of step.values ?? []) scan(v, `step ${i} values`);
  });
  scan(recipe.output, 'output');
  return refs;
}

describe('bundled recipe catalog', () => {
  it('loads at least the known catalog size', () => {
    // Loading itself already enforces valid JSON / schema / unique ids (loadRecipes throws).
    expect(recipes.size).toBeGreaterThanOrEqual(50);
    expect(siteGuides.size).toBeGreaterThanOrEqual(50);
  });

  it('every recipe passes the unsafe-fn-interpolation lint (|js required inside fn)', () => {
    for (const [id, recipe] of recipes) {
      expect(findUnsafeEvaluateInterpolations(recipe), `recipe ${id}`).toEqual([]);
    }
  });

  it('every {{var}} reference is satisfied by a declared input or an earlier `as`', () => {
    for (const [id, recipe] of recipes) {
      const declared = new Set(Object.keys(recipe.inputs ?? {}));
      for (const step of recipe.steps) if (step.as) declared.add(step.as);
      for (const [name, wheres] of referencedVars(recipe)) {
        expect(declared.has(name), `recipe ${id}: {{${name}}} (${wheres.join(', ')}) has no input/as source`).toBe(
          true,
        );
      }
    }
  });

  it('every referenced input is declared required (the runner has no defaults)', () => {
    for (const [id, recipe] of recipes) {
      const inputs = recipe.inputs ?? {};
      const asNames = new Set(recipe.steps.map((s) => s.as).filter(Boolean));
      for (const name of referencedVars(recipe).keys()) {
        if (asNames.has(name)) continue; // produced mid-run, not an input
        expect(inputs[name]?.required, `recipe ${id}: input "${name}" must be required:true`).toBe(true);
      }
    }
  });

  it('every siteguide `recipes` entry points at an existing recipe id', () => {
    for (const [site, guide] of siteGuides) {
      for (const rid of guide.recipes ?? []) {
        expect(recipes.has(rid), `siteguide ${site} references unknown recipe "${rid}"`).toBe(true);
      }
    }
  });

  it('every recipe is listed by some siteguide (discoverable via siteguide action)', () => {
    const listed = new Set([...siteGuides.values()].flatMap((g) => g.recipes ?? []));
    for (const id of recipes.keys()) {
      expect(listed.has(id), `recipe ${id} is not referenced by any siteguide`).toBe(true);
    }
  });
});
