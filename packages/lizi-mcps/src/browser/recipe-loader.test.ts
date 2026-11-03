import { describe, expect, it } from 'vitest';

import {
  mergeRecipes,
  mergeSiteGuides,
  parseRecipes,
  parseSiteGuides,
  type Recipe,
  type SiteGuide,
} from './recipe-loader.js';

const recipe = (id: string): Recipe => ({ id, steps: [{ action: 'navigate', url: 'https://x/' }] });
const guide = (site: string, note: string): SiteGuide => ({ site, notes: note });

const VALID_RECIPE = JSON.stringify({
  id: 'r1',
  match: ['example.com'],
  steps: [
    { action: 'navigate', url: 'https://example.com/{{q}}' },
    { action: 'extract', as: 'out', extract: { from: '.row', multiple: true, fields: { t: '.t' } } },
  ],
  output: '{{out}}',
});

describe('parseRecipes', () => {
  it('parses valid recipes keyed by id', () => {
    const map = parseRecipes({ './recipes/example.com/recipe.json': VALID_RECIPE });
    expect(map.has('r1')).toBe(true);
    expect(map.get('r1')?.steps).toHaveLength(2);
  });

  it('throws on invalid JSON', () => {
    expect(() => parseRecipes({ a: '{ not json' })).toThrow(/invalid JSON/);
  });

  it('throws on schema-invalid recipe (missing steps)', () => {
    expect(() => parseRecipes({ a: JSON.stringify({ id: 'x' }) })).toThrow(/steps/);
  });

  it('throws on unknown step action', () => {
    const bad = JSON.stringify({ id: 'x', steps: [{ action: 'teleport' }] });
    expect(() => parseRecipes({ a: bad })).toThrow();
  });

  // #6822: the production parser must reject result checks that can verify an
  // absent result. Existing shape tests did not cover expectation semantics (unit).
  it.each([{ minCount: 0 }, {}])('rejects a vacuous result expectation: %j', (expectation) => {
    expect(() => parseRecipes({ a: JSON.stringify({ id: 'empty-check',
      steps: [{ action: 'evaluate', fn: '() => undefined', expect: expectation }] }) })).toThrow(/expect/);
  });

  it('throws on duplicate recipe id', () => {
    expect(() =>
      parseRecipes({ a: VALID_RECIPE, b: VALID_RECIPE }),
    ).toThrow(/duplicate recipe id/);
  });
});

describe('parseSiteGuides', () => {
  it('parses siteguides keyed by site', () => {
    const sm = JSON.stringify({ site: 'example.com', entry: { home: 'https://example.com/' }, recipes: ['r1'] });
    const map = parseSiteGuides({ './recipes/example.com/siteguide.json': sm });
    expect(map.get('example.com')?.recipes).toEqual(['r1']);
  });

  it('throws when site is missing', () => {
    expect(() => parseSiteGuides({ a: JSON.stringify({ entry: {} }) })).toThrow(/site/);
  });
});

describe('mergeRecipes (L1 builtin + L2 user)', () => {
  it('marks provenance builtin / user / overridden by id', () => {
    const builtin = new Map([
      ['a', recipe('a')],
      ['b', recipe('b')],
    ]);
    const user = new Map([
      ['b', recipe('b')], // overrides builtin
      ['c', recipe('c')], // new user-only
    ]);
    const merged = mergeRecipes(builtin, user);
    expect(merged.get('a')?.provenance).toBe('builtin');
    expect(merged.get('b')?.provenance).toBe('overridden');
    expect(merged.get('c')?.provenance).toBe('user');
  });

  it('the user version wins wholesale for an overridden id', () => {
    const builtin = new Map([['a', { ...recipe('a'), description: 'builtin' }]]);
    const user = new Map([['a', { ...recipe('a'), description: 'user' }]]);
    const merged = mergeRecipes(builtin, user);
    expect(merged.get('a')?.recipe.description).toBe('user');
  });

  it('empty user layer == bundled only (regression: current behavior)', () => {
    const builtin = new Map([['a', recipe('a')]]);
    const merged = mergeRecipes(builtin, new Map());
    expect([...merged.keys()]).toEqual(['a']);
    expect(merged.get('a')?.provenance).toBe('builtin');
  });
});

describe('mergeSiteGuides', () => {
  it('marks provenance by site and user shadows builtin', () => {
    const builtin = new Map([['x.com', guide('x.com', 'builtin')]]);
    const user = new Map([
      ['x.com', guide('x.com', 'user')],
      ['y.com', guide('y.com', 'user')],
    ]);
    const merged = mergeSiteGuides(builtin, user);
    expect(merged.get('x.com')?.provenance).toBe('overridden');
    expect(merged.get('x.com')?.guide.notes).toBe('user');
    expect(merged.get('y.com')?.provenance).toBe('user');
  });
});
