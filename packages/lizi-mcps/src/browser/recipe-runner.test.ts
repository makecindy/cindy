import type { BrowserControlRequest, BrowserControlResult } from '@cindy/browser-control-runtime';
import { describe, expect, it } from 'vitest';

import type { Recipe } from './recipe-loader.js';
import {
  interpolate,
  runRecipe,
  stepToRequest,
  findUnsafeEvaluateInterpolations,
} from './recipe-runner.js';

/** Mock `call` that records requests and returns a scripted result per index. */
function mockCall(results?: Array<Partial<BrowserControlResult>>) {
  const calls: BrowserControlRequest[] = [];
  const call = async (req: BrowserControlRequest): Promise<BrowserControlResult> => {
    const i = calls.length;
    calls.push(req);
    const scripted = results?.[i];
    return { ok: true, action: req.action, data: { i }, ...scripted } as BrowserControlResult;
  };
  return { call, calls };
}

describe('interpolate', () => {
  it('substitutes string vars', () => {
    expect(interpolate('a/{{q}}/b', { q: 'x' })).toBe('a/x/b');
  });
  it('JSON-stringifies non-string vars', () => {
    expect(interpolate('{{n}}', { n: 3 })).toBe('3');
  });
  it('throws on a missing var', () => {
    expect(() => interpolate('{{missing}}', {})).toThrow(/missing recipe variable: missing/);
  });
  it('url-encodes with the |url modifier (for URL query values)', () => {
    expect(interpolate('?q={{q|url}}', { q: 'react hooks & C#' })).toBe('?q=react%20hooks%20%26%20C%23');
  });
  it('escapes for a JS string literal with the |js modifier', () => {
    expect(interpolate("fetch('{{q|js}}')", { q: "a'b\\c" })).toBe("fetch('a\\'b\\\\c')");
  });
  it('escapes ${ so a |js value cannot break out of a template literal', () => {
    // Inside a back-quoted string an unescaped `${...}` is interpolated by JS;
    // |js must neutralize it (\$) so a value carrying `${` stays inert data.
    expect(interpolate('`hot/{{q|js}}`', { q: '${process.env.SECRET}' })).toBe(
      '`hot/\\${process.env.SECRET}`',
    );
  });
  it('throws on an unknown modifier', () => {
    expect(() => interpolate('{{q|bogus}}', { q: 'x' })).toThrow(/unknown interpolation modifier "bogus"/);
  });
});

describe('stepToRequest', () => {
  it('maps an interactive type step to act:type with selector + submit (no ref)', () => {
    const req = stepToRequest(
      { action: 'type', selector: 'input[name=q]', value: '{{q}}', submit: true },
      { q: 'hello' },
    );
    expect(req).toEqual({
      action: 'act',
      request: { kind: 'type', selector: 'input[name=q]', text: 'hello', submit: true },
    });
  });

  it('maps a click step to act:click with selector', () => {
    const req = stepToRequest({ action: 'click', selector: '.go' }, {});
    expect(req).toEqual({ action: 'act', request: { kind: 'click', selector: '.go' } });
  });

  it('compiles an extract step to act:evaluate', () => {
    const req = stepToRequest(
      { action: 'extract', extract: { from: '.row', multiple: true, fields: { t: '.t' } } },
      {},
    );
    expect(req.action).toBe('act');
    expect(req.request?.kind).toBe('evaluate');
    expect(req.request?.fn).toContain('querySelectorAll');
  });

  it('maps an evaluate step to act:evaluate, interpolating vars into the fn source', () => {
    const req = stepToRequest(
      { action: 'evaluate', fn: "const r = await fetch('/r/{{sub}}/hot.json'); return r;" },
      { sub: 'rust' },
    );
    expect(req.action).toBe('act');
    expect(req.request?.kind).toBe('evaluate');
    expect(req.request?.fn).toBe("const r = await fetch('/r/rust/hot.json'); return r;");
  });

  it('throws when a required field is absent', () => {
    expect(() => stepToRequest({ action: 'navigate' }, {})).toThrow(/navigate step requires/);
    expect(() => stepToRequest({ action: 'click' }, {})).toThrow(/click step requires/);
    expect(() => stepToRequest({ action: 'evaluate' }, {})).toThrow(/evaluate step requires/);
  });

  it('rejects a non-http(s) navigate url (closes the recipe-path scheme bypass)', () => {
    expect(() => stepToRequest({ action: 'navigate', url: 'file:///etc/passwd' }, {})).toThrow(
      /navigate url 必须是 http\(s\)/,
    );
    // also after interpolation of an input value
    expect(() => stepToRequest({ action: 'navigate', url: '{{u}}' }, { u: 'chrome://settings' })).toThrow(
      /必须是 http\(s\)/,
    );
  });

  it('allows an http(s) navigate url', () => {
    expect(stepToRequest({ action: 'navigate', url: 'https://x/?q={{q}}' }, { q: 'a' })).toEqual({
      action: 'navigate',
      url: 'https://x/?q=a',
    });
  });

  it('forwards wait conditions (selector/url/fn) and responseBody timeoutMs', () => {
    const wait = stepToRequest({ action: 'wait', selector: '.results', timeoutMs: 5000 }, {});
    expect(wait.request).toMatchObject({ kind: 'wait', selector: '.results', timeoutMs: 5000 });
    const rb = stepToRequest({ action: 'responseBody', url: 'api/quotes', maxChars: 1000, timeoutMs: 5000 }, {});
    expect(rb).toMatchObject({ action: 'responseBody', url: 'api/quotes', maxChars: 1000, timeoutMs: 5000 });
  });

  it('forwards timeoutMs on evaluate / extract steps (slow in-page work)', () => {
    const ev = stepToRequest({ action: 'evaluate', fn: 'async () => 1', timeoutMs: 8000 }, {});
    expect(ev.request).toMatchObject({ kind: 'evaluate', timeoutMs: 8000 });
    const ex = stepToRequest({ action: 'extract', extract: { from: '.r', multiple: true, fields: { t: 'h3' } }, timeoutMs: 8000 }, {});
    expect(ex.request).toMatchObject({ kind: 'evaluate', timeoutMs: 8000 });
  });

  it('forwards timeoutMs on click / type / select steps (slow selector interactions)', () => {
    const click = stepToRequest({ action: 'click', selector: '.go', timeoutMs: 9000 }, {});
    expect(click.request).toMatchObject({ kind: 'click', timeoutMs: 9000 });
    const type = stepToRequest({ action: 'type', selector: '#i', value: 'x', timeoutMs: 9000 }, {});
    expect(type.request).toMatchObject({ kind: 'type', timeoutMs: 9000 });
    const select = stepToRequest({ action: 'select', selector: '#s', values: ['a'], timeoutMs: 9000 }, {});
    expect(select.request).toMatchObject({ kind: 'select', timeoutMs: 9000 });
  });

  it('requires a value on a type step (no silent text:undefined)', () => {
    expect(() => stepToRequest({ action: 'type', selector: '#i' }, {})).toThrow(/type step requires `value`/);
    // an explicit empty string stays allowed
    expect(stepToRequest({ action: 'type', selector: '#i', value: '' }, {})).toEqual({
      action: 'act',
      request: { kind: 'type', selector: '#i', text: '', submit: undefined },
    });
  });
});

const SEARCH_RECIPE: Recipe = {
  id: 'search',
  inputs: { q: { required: true } },
  steps: [
    { action: 'navigate', url: 'https://x/?q={{q}}' },
    { action: 'type', selector: 'input[name=q]', value: '{{q}}', submit: true },
    { action: 'wait', loadState: 'load' },
    { action: 'extract', as: 'results', extract: { from: '.r', multiple: true, fields: { t: '.t' } } },
  ],
  output: '{{results}}',
};

describe('runRecipe', () => {
  it('runs all steps and returns the output var verbatim', async () => {
    const { call, calls } = mockCall([
      {},
      {},
      {},
      { data: { ok: true, count: 2, records: [{ t: 'a' }, { t: 'b' }] } },
    ]);
    const res = await runRecipe(SEARCH_RECIPE, { q: 'hello' }, { call });

    expect(res.ok).toBe(true);
    expect(calls.map((c) => c.action)).toEqual(['navigate', 'act', 'act', 'act']);
    expect((calls[0] as { url: string }).url).toBe('https://x/?q=hello');
    // output `{{results}}` returns the structured extract data verbatim.
    expect(res.output).toEqual({ ok: true, count: 2, records: [{ t: 'a' }, { t: 'b' }] });
  });

  it('fails fast when a required input is missing', async () => {
    const { call, calls } = mockCall();
    const res = await runRecipe(SEARCH_RECIPE, {}, { call });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/missing required input: q/);
    expect(calls).toHaveLength(0);
  });

  it('rejects (before any step) a numeric input beyond the safe-integer range', async () => {
    // A 19-digit snowflake id passed as a JSON number was already rounded by
    // JSON.parse — stringifying it would navigate to the WRONG resource, so the
    // runner must fail loudly instead of dispatching the corrupted value.
    const { call, calls } = mockCall();
    const res = await runRecipe(SEARCH_RECIPE, { q: 1892345678901234567 }, { call });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/safe-integer range.*pass it as a string/);
    expect(calls).toHaveLength(0);
  });

  it('still coerces safe numbers (e.g. limit: 25) to strings', async () => {
    const { call } = mockCall();
    const res = await runRecipe(SEARCH_RECIPE, { q: 25 }, { call });
    expect(res.ok).toBe(true);
  });

  it('rejects an unsafe number even when the variable is NOT declared in inputs', async () => {
    // RecipeSchema allows `inputs` to be omitted while vars is seeded with every
    // caller entry — the safe-integer guard must not be bypassable that way.
    const { call, calls } = mockCall();
    const undeclared: Recipe = {
      id: 'undeclared',
      steps: [{ action: 'navigate', url: 'https://example.com/{{q}}' }],
    };
    const res = await runRecipe(undeclared, { q: 1892345678901234567 }, { call });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/safe-integer range/);
    expect(calls).toHaveLength(0);
  });

  it('fails loudly (never dispatches) when a saved recipe navigates to file://', async () => {
    // The recipe path calls runtime.call directly, so the scheme guard must live
    // in stepToRequest — a malicious saved recipe must not reach file:// even
    // though it skips the tools.ts MCP boundary.
    const { call, calls } = mockCall();
    const evil: Recipe = { id: 'evil', steps: [{ action: 'navigate', url: 'file:///etc/passwd' }] };
    const res = await runRecipe(evil, undefined, { call });
    expect(res.ok).toBe(false);
    expect(res.failedStep).toBe(0);
    expect(res.failedAction).toBe('navigate');
    expect(res.message).toMatch(/http\(s\)/);
    expect(calls).toHaveLength(0);
  });

  it('aborts on a failed step and reports failedStep', async () => {
    const { call, calls } = mockCall([{}, { ok: false, message: 'selector not found' }]);
    const res = await runRecipe(SEARCH_RECIPE, { q: 'hello' }, { call });
    expect(res.ok).toBe(false);
    expect(res.failedStep).toBe(1);
    expect(res.failedAction).toBe('type');
    expect(res.message).toBe('selector not found');
    // stopped after the failing step — extract never ran.
    expect(calls).toHaveLength(2);
  });

  it('runs a navigate → evaluate (in-page fetch) recipe and returns the evaluate result', async () => {
    // Mirrors the reddit-listing shape: land on the domain, then run a
    // cookie-carrying same-origin fetch via evaluate; output is that var.
    const recipe: Recipe = {
      id: 'reddit-listing',
      inputs: { subreddit: { required: true } },
      steps: [
        { action: 'navigate', url: 'https://www.reddit.com' },
        { action: 'wait', loadState: 'load' },
        { action: 'evaluate', as: 'posts', fn: "return await fetch('/r/{{subreddit}}/hot.json');" },
      ],
      output: '{{posts}}',
    };
    const { call, calls } = mockCall([{}, {}, { data: { result: [{ title: 'a' }, { title: 'b' }] } }]);
    const res = await runRecipe(recipe, { subreddit: 'programming' }, { call });

    expect(res.ok).toBe(true);
    expect(calls.map((c) => c.action)).toEqual(['navigate', 'act', 'act']);
    expect((calls[2] as { request?: { kind: string; fn: string } }).request).toEqual({
      kind: 'evaluate',
      fn: "return await fetch('/r/programming/hot.json');",
    });
    // output `{{posts}}` returns the UNWRAPPED evaluate value (runner strips the
    // `{ result: ... }` wrapper) so the recipe yields the clean array directly.
    expect(res.output).toEqual([{ title: 'a' }, { title: 'b' }]);
  });

  it('continues past an optional failed step', async () => {
    const recipe: Recipe = {
      id: 'opt',
      steps: [
        { action: 'click', selector: '.maybe', optional: true },
        { action: 'navigate', url: 'https://x/' },
      ],
    };
    const { call, calls } = mockCall([{ ok: false, message: 'no such element' }, {}]);
    const res = await runRecipe(recipe, {}, { call });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('fails the recipe when an extract step reports an in-page ok:false (bad selector)', async () => {
    const recipe: Recipe = {
      id: 'x',
      steps: [
        { action: 'navigate', url: 'https://x/' },
        { action: 'extract', as: 'rows', extract: { from: '.r', multiple: true, fields: { t: '.t' } } },
      ],
      output: '{{rows}}',
    };
    // transport ok:true, but the in-page fn returned ok:false (e.g. invalid selector).
    const { call } = mockCall([{}, { data: { result: { ok: false, error: 'invalid CSS selector(s): .r' } } }]);
    const res = await runRecipe(recipe, {}, { call });
    expect(res.ok).toBe(false);
    expect(res.failedStep).toBe(1);
    expect(res.failedAction).toBe('extract');
    expect(res.message).toMatch(/invalid CSS selector/);
  });

  it('fails loudly when output references a missing var (no silent undefined)', async () => {
    const recipe: Recipe = {
      id: 'y',
      steps: [{ action: 'navigate', url: 'https://x/' }],
      output: '{{typo}}',
    };
    const { call } = mockCall([{}]);
    const res = await runRecipe(recipe, {}, { call });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/missing recipe variable: typo/);
  });

  it('rejects an object/array input value (would corrupt interpolation)', async () => {
    const { call, calls } = mockCall();
    const res = await runRecipe(SEARCH_RECIPE, { q: { nested: 1 } as unknown as string }, { call });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/recipe input "q" must be a string, number, or boolean \(got object\)/);
    expect(calls).toHaveLength(0);
  });

  it('coerces a numeric input to its string form (siteguide advertises numeric `limit`)', async () => {
    // The tool schema passes `inputs` as `unknown`, so an agent commonly sends a
    // JSON number for a `limit`-style input; coerce it instead of rejecting.
    const recipe: Recipe = {
      id: 'num',
      inputs: { limit: { required: true } },
      steps: [{ action: 'navigate', url: 'https://x/?size={{limit}}' }],
    };
    const { call, calls } = mockCall([{}]);
    const res = await runRecipe(recipe, { limit: 50 as unknown as string }, { call });
    expect(res.ok).toBe(true);
    expect((calls[0] as { url: string }).url).toBe('https://x/?size=50');
  });

  it('coerces a boolean input to its string form', async () => {
    const recipe: Recipe = {
      id: 'bool',
      inputs: { flag: { required: true } },
      steps: [{ action: 'navigate', url: 'https://x/?f={{flag}}' }],
    };
    const { call, calls } = mockCall([{}]);
    const res = await runRecipe(recipe, { flag: true as unknown as string }, { call });
    expect(res.ok).toBe(true);
    expect((calls[0] as { url: string }).url).toBe('https://x/?f=true');
  });

  it('does NOT store an optional failed step result; a later {{as}} ref fails loudly', async () => {
    const recipe: Recipe = {
      id: 'opt-as',
      steps: [{ action: 'click', selector: '.maybe', optional: true, as: 'maybe' }],
      output: '{{maybe}}',
    };
    // optional step fails (transport ok:false) → skipped, `maybe` never stored →
    // output `{{maybe}}` throws missing-var instead of emitting a failure blob.
    const { call } = mockCall([{ ok: false, message: 'no such element' }]);
    const res = await runRecipe(recipe, {}, { call });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/missing recipe variable: maybe/);
  });

  it('treats a raw evaluate returning {ok:false} as DATA, not a step failure', async () => {
    // Unlike `extract` (compiled sentinel), raw `evaluate` has no ok:false
    // contract — its return value is real data even when shaped like {ok:false}.
    const recipe: Recipe = {
      id: 'eval-ok-false',
      steps: [{ action: 'evaluate', as: 'out', fn: 'return { ok: false, note: "legit" };' }],
      output: '{{out}}',
    };
    const { call } = mockCall([{ data: { result: { ok: false, note: 'legit' } } }]);
    const res = await runRecipe(recipe, {}, { call });
    expect(res.ok).toBe(true);
    expect(res.output).toEqual({ ok: false, note: 'legit' });
  });
});

describe('findUnsafeEvaluateInterpolations', () => {
  it('flags a bare {{var}} embedded inside an evaluate fn', () => {
    const issues = findUnsafeEvaluateInterpolations({
      steps: [{ action: 'evaluate', fn: "await fetch('/r/{{sub}}/hot.json')" }],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/\{\{sub\}\}/);
  });

  it('passes when every evaluate var carries the |js modifier', () => {
    expect(
      findUnsafeEvaluateInterpolations({
        steps: [{ action: 'evaluate', fn: "await fetch('/r/{{sub|js}}/hot.json?n={{n|js}}')" }],
      }),
    ).toHaveLength(0);
  });

  it('flags a |url interpolation inside an evaluate fn (encodeURIComponent leaves single quotes)', () => {
    // `{{q|url}}` is safe for a URL query value but NOT for a JS string literal:
    // `encodeURIComponent("kid's")` keeps the apostrophe, breaking the source.
    const issues = findUnsafeEvaluateInterpolations({
      steps: [{ action: 'evaluate', fn: "await fetch('/api?q={{q|url}}')" }],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/\{\{q\|url\}\}/);
    expect(issues[0]).toMatch(/\|js/);
  });

  it('does NOT flag bare {{var}} in navigate URLs (legitimate path segments)', () => {
    expect(
      findUnsafeEvaluateInterpolations({
        steps: [{ action: 'navigate', url: 'https://x/quotes/{{symbol}}/overview' }],
      }),
    ).toHaveLength(0);
  });

  it('also validates a wait step fn (waitForFunction predicate runs in page JS)', () => {
    // `wait.fn` is interpolated into the page's waitForFunction predicate, same
    // breakout risk as evaluate — a non-|js interpolation must be flagged.
    const issues = findUnsafeEvaluateInterpolations({
      steps: [{ action: 'wait', fn: "() => document.title.includes('{{q}}')" }],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/\(wait\)/);
    expect(issues[0]).toMatch(/\{\{q\}\}/);
    // a |js-escaped wait fn passes
    expect(
      findUnsafeEvaluateInterpolations({
        steps: [{ action: 'wait', fn: "() => document.title.includes('{{q|js}}')" }],
      }),
    ).toHaveLength(0);
  });
});
