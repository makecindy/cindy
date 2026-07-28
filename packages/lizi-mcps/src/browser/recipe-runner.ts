/**
 * Recipe executor. Runs a {@link Recipe}'s steps in order against an injected
 * `call` (the BrowserControlRuntime's `call`), so it is fully unit-testable with
 * a mock. Each step maps to an existing browser primitive; interactive steps
 * pass a stable CSS `selector` straight to the vendored `act` (no snapshot ref).
 *
 * On the first non-`optional` step that returns `ok:false`, execution stops and
 * the result reports `failedStep` so the agent can fall back to manual
 * snapshot+ref operation.
 */
import type { BrowserControlRequest, BrowserControlResult } from '@cindy/browser-control-runtime';

import { buildExtractFnSource, type ExtractSpec } from './extract.js';
import type { Recipe, RecipeStep } from './recipe-loader.js';
import { isHttpUrl } from './url-guard.js';

export interface RecipeRunDeps {
  call: (req: BrowserControlRequest) => Promise<BrowserControlResult>;
  logger?: { warn?: (message: string, meta?: unknown) => void };
}

export interface RecipeRunResult {
  ok: boolean;
  recipe: string;
  steps: Array<{ action: string; ok: boolean }>;
  output?: unknown;
  failedStep?: number;
  failedAction?: string;
  message?: string;
}

// `{{var}}` with an optional `|modifier` (e.g. `{{query|url}}`). The modifier
// makes interpolation context-safe so authors don't hand-encode:
//   - `url` → encodeURIComponent (for a value placed into a URL query)
//   - `js`  → escape for embedding inside a JS string literal (', ", `, \, newlines)
// No modifier = raw (strings verbatim, non-strings JSON.stringify'd) — legacy behavior.
const VAR_RE = /\{\{\s*([\w-]+)\s*(?:\|\s*([a-z]+)\s*)?\}\}/g;
const SINGLE_VAR_RE = /^\{\{\s*([\w-]+)\s*\}\}$/;

/**
 * Escape a string so it is safe inside a single/double/back-quoted JS string
 * literal. Escapes `$` too: inside a back-quoted (template) literal an unescaped
 * `${...}` is evaluated as interpolation, so a value carrying `${` would break out
 * of the string the author intended; `\$` renders as a literal `$` in all three
 * literal kinds and neutralizes that. (Backslash is escaped first so we never
 * double-process the escapes we introduce.)
 */
function jsStringEscape(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

/** Render one variable per its optional modifier. */
function renderVar(value: unknown, modifier: string | undefined, key: string): string {
  if (modifier === 'url') return encodeURIComponent(typeof value === 'string' ? value : String(value));
  if (modifier === 'js') return jsStringEscape(typeof value === 'string' ? value : String(value));
  if (modifier) throw new Error(`unknown interpolation modifier "${modifier}" for variable ${key}`);
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * PURE: substitute `{{var}}` / `{{var|modifier}}` refs. Missing variables throw
 * (no silent blanks). NOTE on trust: the recipe author AND the `inputs` come from
 * the same agent, so raw substitution is not a cross-trust escalation — but values
 * landing inside a JS string (an `evaluate` `fn`) or a URL should use the `js` /
 * `url` modifier so a value containing a quote/space/`&` can't corrupt the source.
 */
export function interpolate(template: string, vars: Record<string, unknown>): string {
  return template.replace(VAR_RE, (_m, key: string, modifier: string | undefined) => {
    if (!(key in vars)) throw new Error(`missing recipe variable: ${key}`);
    return renderVar(vars[key], modifier, key);
  });
}

function interpOpt(s: string | undefined, vars: Record<string, unknown>): string | undefined {
  return s === undefined ? undefined : interpolate(s, vars);
}

/**
 * PURE: reject `{{var}}` refs inside a step's JS-source `fn` that are NOT
 * `|js`-escaped. Both `evaluate` (page-context JS) AND `wait` (the
 * `waitForFunction` predicate) carry an `fn` that lands in page JS, so a value
 * with a quote / backslash / `${` would break out of the literal. Every
 * interpolation in `fn` must carry `|js` — the only modifier that escapes for a
 * JS string literal. Bare `{{var}}` leaves everything raw; `{{var|url}}` is NOT
 * safe here either because `encodeURIComponent` does not escape single quotes
 * (`kid's` stays `kid's` and breaks a single-quoted source). Returns
 * human-readable issues (empty = clean); used by `saveRecipe` so the rule is
 * code-enforced, not left to recipe-author prompt discipline (rule 9).
 *
 * NOTE: `navigate`/`responseBody` URLs are intentionally NOT checked — bundled
 * recipes legitimately embed bare `{{var}}` in URL *path segments*
 * (e.g. ".../quotes/{{symbol}}/overview"); only query *values* need `|url`, which
 * stays advisory there.
 */
export function findUnsafeEvaluateInterpolations(recipe: { steps: RecipeStep[] }): string[] {
  const issues: string[] = [];
  recipe.steps.forEach((step, i) => {
    // Both evaluate.fn and wait.fn are interpolated into page-context JS.
    if (!step.fn || (step.action !== 'evaluate' && step.action !== 'wait')) return;
    // Fresh regex (don't share VAR_RE's lastIndex with interpolate()).
    const re = new RegExp(VAR_RE.source, 'g');
    const unsafe = new Set<string>();
    for (const m of step.fn.matchAll(re)) {
      if (m[2] !== 'js') unsafe.add(m[0]); // bare or |url / other — not JS-string-safe
    }
    if (unsafe.size > 0) {
      issues.push(
        `step ${i} (${step.action}): ${[...unsafe].join(', ')} inside \`fn\` must use the |js modifier — ` +
          'only |js escapes for a JS string literal (|url leaves single quotes unescaped; bare leaves everything raw)',
      );
    }
  });
  return issues;
}

/** PURE: map a recipe step to a runtime request, interpolating string fields. */
export function stepToRequest(step: RecipeStep, vars: Record<string, unknown>): BrowserControlRequest {
  switch (step.action) {
    case 'navigate': {
      if (!step.url) throw new Error('navigate step requires `url`');
      const url = interpolate(step.url, vars);
      // Mirror the tools.ts boundary scheme guard: a saved recipe must not be
      // able to navigate to file:// / chrome:// / data: (the recipe path calls
      // runtime.call directly, bypassing that boundary). Only the scheme is
      // constrained — localhost/private HTTP stays allowed by design.
      if (!isHttpUrl(url)) {
        throw new Error(`navigate url 必须是 http(s);不支持 file:// / chrome:// / data: 等协议(收到 "${url}")`);
      }
      return { action: 'navigate', url };
    }
    case 'click':
      if (!step.selector) throw new Error('click step requires `selector`');
      // Forward timeoutMs (the /act normalizer honors it for slow selector
      // interactions) — parity with wait/extract/evaluate below.
      return {
        action: 'act',
        request: { kind: 'click', selector: interpolate(step.selector, vars), timeoutMs: step.timeoutMs },
      };
    case 'type': {
      if (!step.selector) throw new Error('type step requires `selector`');
      // `value` is schema-optional, but a `type` step with no text would send
      // `text: undefined` to the runtime — a silent no-op / hard-to-debug
      // failure. Require it explicitly (parity with click's selector check).
      // An empty string is a deliberate value and stays allowed.
      const text = interpOpt(step.value, vars);
      if (text === undefined) throw new Error('type step requires `value`');
      return {
        action: 'act',
        request: {
          kind: 'type',
          selector: interpolate(step.selector, vars),
          text,
          submit: step.submit,
          timeoutMs: step.timeoutMs,
        },
      };
    }
    case 'select':
      if (!step.selector) throw new Error('select step requires `selector`');
      return {
        action: 'act',
        request: {
          kind: 'select',
          selector: interpolate(step.selector, vars),
          values: step.values?.map((v) => interpolate(v, vars)),
          timeoutMs: step.timeoutMs,
        },
      };
    case 'wait':
      // The /act wait normalizer accepts selector / url / fn as wait conditions
      // (alongside loadState / textGone) — forward them, or a recipe like
      // `{ action:'wait', selector:'.results' }` reaches the runtime with no
      // condition and fails "wait requires at least one of …".
      return {
        action: 'act',
        request: {
          kind: 'wait',
          selector: interpOpt(step.selector, vars),
          url: interpOpt(step.url, vars),
          fn: interpOpt(step.fn, vars),
          loadState: step.loadState,
          textGone: interpOpt(step.textGone, vars),
          timeoutMs: step.timeoutMs,
        },
      };
    case 'extract':
      if (!step.extract) throw new Error('extract step requires `extract`');
      return {
        action: 'act',
        request: { kind: 'evaluate', fn: buildExtractFnSource(step.extract as ExtractSpec), timeoutMs: step.timeoutMs },
      };
    case 'evaluate':
      // Raw page-context JS (function-expression source). Unlike `extract` (which
      // compiles a DOM-scraping fn), `evaluate` runs author-provided source — the
      // same capability the agent already has via the `browser` tool's `act:evaluate`.
      // Used for same-origin cookie-carrying `fetch` on login/anti-bot sites.
      if (!step.fn) throw new Error('evaluate step requires `fn`');
      return { action: 'act', request: { kind: 'evaluate', fn: interpolate(step.fn, vars), timeoutMs: step.timeoutMs } };
    case 'requests':
      return { action: 'requests', filter: interpOpt(step.filter, vars) };
    case 'responseBody':
      if (!step.url) throw new Error('responseBody step requires `url`');
      return { action: 'responseBody', url: interpolate(step.url, vars), maxChars: step.maxChars, timeoutMs: step.timeoutMs };
    default: {
      const exhaustive: never = step.action;
      throw new Error(`unknown recipe step action: ${String(exhaustive)}`);
    }
  }
}

/** Resolve the output template: a bare `{{var}}` returns that var verbatim
 *  (structured), otherwise interpolate to a string. A bare ref to a missing var
 *  throws (parity with `interpolate` — no silent `undefined` output). */
function resolveOutput(template: string, vars: Record<string, unknown>): unknown {
  const single = template.match(SINGLE_VAR_RE);
  if (single) {
    const key = single[1];
    if (!(key in vars)) throw new Error(`missing recipe variable: ${key}`);
    return vars[key];
  }
  return interpolate(template, vars);
}

/** An `extract` step compiles (via buildExtractFnSource) to an `act:evaluate`
 *  whose fn returns a known `{ ok:false, error }` sentinel on a soft failure
 *  (e.g. a bad selector) while the transport call still succeeds. Detect that so
 *  the recipe fails loudly with a `failedStep` instead of returning the
 *  `{ok:false,...}` blob as "output".
 *
 *  Raw `evaluate` steps are deliberately NOT inspected: they run author-provided
 *  JS with no such sentinel contract (parity with the bare `act:evaluate` tool
 *  path), so a returned object shaped like `{ok:false}` is real data, not a
 *  failure signal — inspecting it would misclassify legitimate output. */
function innerEvaluateError(step: RecipeStep, res: BrowserControlResult): string | undefined {
  if (step.action !== 'extract') return undefined;
  const inner = (res.data as { result?: { ok?: boolean; error?: string } } | undefined)?.result;
  return inner?.ok === false ? (inner.error ?? 'in-page extract reported ok:false') : undefined;
}

/** Value to store under a step's `as`. For `evaluate`/`extract` the runtime wraps
 *  the in-page return value as `res.data = { result: <value> }`; unwrap it so the
 *  recipe `output` is the clean array/object directly (not `{ result: ... }`).
 *  Other steps expose `res.data` verbatim. */
function stepResultValue(step: RecipeStep, res: BrowserControlResult): unknown {
  if (step.action === 'extract' || step.action === 'evaluate') {
    const d = res.data as { result?: unknown } | undefined;
    if (d && typeof d === 'object' && 'result' in d) return d.result;
  }
  return res.data;
}

/** Execute a recipe. `inputs` seed the variable scope; step `as` adds to it. */
export async function runRecipe(
  recipe: Recipe,
  inputs: Record<string, unknown> | undefined,
  deps: RecipeRunDeps,
): Promise<RecipeRunResult> {
  const vars: Record<string, unknown> = { ...(inputs ?? {}) };
  for (const [name, spec] of Object.entries(recipe.inputs ?? {})) {
    if (spec.required && (vars[name] === undefined || vars[name] === null)) {
      return { ok: false, recipe: recipe.id, steps: [], message: `missing required input: ${name}` };
    }
  }
  // Normalize EVERY caller-supplied value — not just declared inputs. vars is
  // seeded with all caller entries and RecipeSchema allows `inputs` to be
  // omitted, so an L2 recipe can interpolate an undeclared variable; the
  // guards below must not be bypassable by leaving a name undeclared.
  // Interpolated values land in URLs / selectors / JS strings. Scalar
  // number/boolean/bigint values coerce cleanly (`String(50)` → "50") and are
  // exactly what built-in recipes advertise via siteguide (e.g. numeric `limit`),
  // so normalize them to their string form here. Objects/arrays would corrupt
  // into "[object Object]" / surprising JSON, so reject those loudly instead
  // (rule 9: code-enforced).
  for (const [name, value] of Object.entries(vars)) {
    if (value !== undefined && value !== null && typeof value !== 'string') {
      if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        // A number beyond the safe-integer range was ALREADY rounded by
        // JSON.parse before we ever saw it (e.g. a 19-digit X snowflake id),
        // so String(value) would bake the corrupted value into a URL/JS step.
        // Fail loudly BEFORE any step runs instead of navigating with it.
        if (typeof value === 'number' && Math.abs(value) > Number.MAX_SAFE_INTEGER) {
          return {
            ok: false,
            recipe: recipe.id,
            steps: [],
            message:
              `recipe input "${name}" exceeds the JSON safe-integer range and has lost precision — ` +
              'pass it as a string (e.g. a 19-digit tweet id must be quoted)',
          };
        }
        vars[name] = String(value);
      } else {
        return {
          ok: false,
          recipe: recipe.id,
          steps: [],
          message: `recipe input "${name}" must be a string, number, or boolean (got ${typeof value})`,
        };
      }
    }
  }

  const steps: Array<{ action: string; ok: boolean }> = [];
  for (let i = 0; i < recipe.steps.length; i++) {
    const step = recipe.steps[i];
    let req: BrowserControlRequest;
    try {
      req = stepToRequest(step, vars);
    } catch (err) {
      return {
        ok: false,
        recipe: recipe.id,
        steps,
        failedStep: i,
        failedAction: step.action,
        message: err instanceof Error ? err.message : String(err),
      };
    }
    const res = await deps.call(req);
    const innerError = innerEvaluateError(step, res);
    const stepOk = res.ok && innerError === undefined;
    steps.push({ action: step.action, ok: stepOk });
    // Only store the result on success: a failed (but `optional`) step must not
    // leak a `{ok:false,...}`/failure blob into `vars`, or a later `{{as}}` ref
    // would silently emit garbage. After this, referencing a skipped step's `as`
    // throws "missing recipe variable" (loud) — the intended behavior.
    if (stepOk && step.as) vars[step.as] = stepResultValue(step, res);
    if (!stepOk) {
      const failMessage = res.message ?? innerError ?? `step ${i} (${step.action}) failed`;
      if (step.optional) {
        deps.logger?.warn?.(`recipe ${recipe.id} step ${i} (${step.action}) failed but is optional`, {
          message: failMessage,
        });
        continue;
      }
      return {
        ok: false,
        recipe: recipe.id,
        steps,
        failedStep: i,
        failedAction: step.action,
        message: failMessage,
      };
    }
  }

  let output: unknown;
  try {
    output = recipe.output !== undefined ? resolveOutput(recipe.output, vars) : undefined;
  } catch (err) {
    return {
      ok: false,
      recipe: recipe.id,
      steps,
      message: err instanceof Error ? err.message : String(err),
    };
  }
  return { ok: true, recipe: recipe.id, steps, output };
}
