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

  it('every {{var}} reference resolves in execution order (preceding `as` or required input)', () => {
    // Mirrors runRecipe exactly: `as` lands in vars only AFTER its step
    // succeeds, and the runner has no input defaults. So at each reference
    // point the variable must come from a PRECEDING step's `as`, or be a
    // `required:true` input — a later producer, an undeclared name, or an
    // optional input referenced before its producer would all throw
    // "missing recipe variable" at runtime.
    for (const [id, recipe] of recipes) {
      const inputs = recipe.inputs ?? {};
      const produced = new Set<string>();
      const checkRef = (name: string, where: string) => {
        if (produced.has(name)) return; // satisfied by a preceding step's `as`
        expect(
          inputs[name]?.required,
          `recipe ${id}: ${where} references {{${name}}}, which is neither a preceding step's \`as\` nor a required:true input`,
        ).toBe(true);
      };
      recipe.steps.forEach((step, i) => {
        for (const name of stepVarRefs(step)) checkRef(name, `step ${i} (${step.action})`);
        if (step.as) produced.add(step.as);
      });
      if (recipe.output) {
        for (const m of recipe.output.matchAll(new RegExp(VAR_RE.source, 'g'))) checkRef(m[1], 'output');
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
