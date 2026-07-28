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

/** `{{var}}` names a single step interpolates. */
function stepVarRefs(step: Recipe['steps'][number]): Set<string> {
  const refs = new Set<string>();
  const scan = (text: string | undefined) => {
    if (!text) return;
    for (const m of text.matchAll(new RegExp(VAR_RE.source, 'g'))) refs.add(m[1]);
  };
  scan(step.url);
  scan(step.selector);
  scan(step.fn);
  scan(step.value);
  scan(step.textGone);
  scan(step.filter);
  for (const v of step.values ?? []) scan(v);
  return refs;
}

/** All `{{var}}` names referenced anywhere a recipe interpolates. */
function referencedVars(recipe: Recipe): Set<string> {
  const refs = new Set<string>();
  for (const step of recipe.steps) for (const name of stepVarRefs(step)) refs.add(name);
  if (recipe.output) {
    for (const m of recipe.output.matchAll(new RegExp(VAR_RE.source, 'g'))) refs.add(m[1]);
  }
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

  it('every {{var}} reference is satisfied by a declared input or a PRECEDING `as`', () => {
    // Mirrors runRecipe's execution order: `as` lands in vars only AFTER its
    // step succeeds, so a step may only reference inputs and earlier steps'
    // `as` — a later producer would still throw "missing recipe variable".
    for (const [id, recipe] of recipes) {
      const available = new Set(Object.keys(recipe.inputs ?? {}));
      recipe.steps.forEach((step, i) => {
        for (const name of stepVarRefs(step)) {
          expect(
            available.has(name),
            `recipe ${id}: step ${i} (${step.action}) references {{${name}}} before any input/preceding-as provides it`,
          ).toBe(true);
        }
        if (step.as) available.add(step.as);
      });
      if (recipe.output) {
        for (const m of recipe.output.matchAll(new RegExp(VAR_RE.source, 'g'))) {
          expect(available.has(m[1]), `recipe ${id}: output references {{${m[1]}}} with no source`).toBe(true);
        }
      }
    }
  });

  it('every referenced input is declared required (the runner has no defaults)', () => {
    for (const [id, recipe] of recipes) {
      const inputs = recipe.inputs ?? {};
      const asNames = new Set(recipe.steps.map((s) => s.as).filter(Boolean));
      for (const name of referencedVars(recipe)) {
        if (asNames.has(name)) continue; // produced mid-run, not an input (ordering guarded above)
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
