import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { maskColorComments } from './hardcoded-color-match.mjs';

// Read the generation contract, not a second hand-maintained token allowlist.
// readSpacingVariables(root) is fresh per call so audit({root}) always honours
// that checkout's bindings — including corruption introduced between calls;
// the cached default below only serves direct callers of this module.
const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export function readSpacingVariables(root) {
  const readJson = file => JSON.parse(readFileSync(path.join(root, 'packages/design-tokens/src', file), 'utf8'));
  const { foundations } = readJson('desktop-bindings.json');
  if (!foundations?.css || typeof foundations.css !== 'object' || Array.isArray(foundations.css)) {
    throw new Error('Invalid desktop-bindings.json; expected foundations.css as a non-array mapping');
  }
  const bindings = Object.entries(foundations.css)
    // Includes component spacing (space-input-lg), not only Tailwind's scale.
    .filter(([, id]) => id.startsWith('semantic.foundations.space-'));
  if (!bindings.length) {
    throw new Error('Invalid desktop-bindings.json; foundations.css has no semantic.foundations.space-* entries');
  }
  // The prefix alone must not invent sources: every binding target has to
  // be a real dimension token in the DTCG generation source. A bare key, an
  // empty object or a group is not a token — the generator's flatten() only
  // emits leaves that carry $value (production.ts).
  const dtcg = readJson('semantic/foundations.json')?.semantic?.foundations;
  if (!dtcg || typeof dtcg !== 'object' || Array.isArray(dtcg)) {
    throw new Error('Invalid semantic/foundations.json; expected semantic.foundations DTCG tokens');
  }
  const unbound = bindings.filter(([, id]) => {
    const token = dtcg[id.slice('semantic.foundations.'.length)];
    return !token || typeof token !== 'object' || !('$value' in token) || token.$type !== 'dimension';
  });
  if (unbound.length) {
    throw new Error(`Invalid desktop-bindings.json; spacing bindings without a dimension DTCG token: ${unbound.map(([name]) => `--${name}`).join(', ')}`);
  }
  return new Set(bindings.map(([name]) => `--${name}`));
}
let moduleSpacing;
function getSpacingVariables() {
  moduleSpacing ??= readSpacingVariables(MODULE_ROOT);
  return moduleSpacing;
}

function classifySpacing(value, spacingVariables = getSpacingVariables()) {
  const expression = value.slice(value.indexOf('[') + 1, -1);
  const direct = /^var\(\s*(--[\w-]+)\s*\)$/.exec(expression);
  if (direct && spacingVariables.has(direct[1])) {
    return { classification: 'spacing-source-reference',
      reason: 'References the generated spacing source; component-role suitability still needs review.' };
  }
  const references = [...expression.matchAll(/var\(\s*(--[\w-]+)/g)].map(match => match[1]);
  if (references.some(name => !spacingVariables.has(name))) {
    return { classification: 'unknown-spacing-reference',
      reason: 'Contains a variable outside the generated spacing bindings; verify its source, fallbacks and component role. A variable name alone is not approval.' };
  }
  if (references.length) {
    // Pure means registered var() references joined only by calc operators.
    // Anything left after stripping them — literals, fallbacks, env()/min()
    // operands — is a non-token operand; detect that residue explicitly
    // instead of relying on where a digit happens to appear.
    const residue = expression
      .replace(/var\(\s*--[\w-]+\s*\)/g, '')
      .replace(/calc/g, '')
      .replace(/[-+*/()_,.\s]/g, '');
    return { classification: residue.length > 0 ? 'mixed-spacing-expression' : 'spacing-expression',
      reason: residue.length > 0 ? 'Combines spacing references with literals, fallbacks or other non-token operands (env(), min() …); review each operand and the component role.'
        : 'Derived spacing expression; verify the calculation and component role. References do not approve the whole expression.' };
  }
  // Tailwind writes spaces in arbitrary values as underscores: a bare value
  // may be a list (p-[14px_16px]). Every item must be a literal on its own —
  // a number with any CSS dimension unit (1lh, 2dvh, 12PX, 17pt …), never a
  // unit enumeration, mirroring the typography gate's own discipline.
  const literal = /^-?(?:\d*\.)?\d+[a-z%]*$/i;
  return { classification: expression.split('_').every(part => literal.test(part)) ? 'literal-spacing' : 'unclassified-spacing',
    reason: 'No verified spacing source reference; use the matching standard spacing class or document the component-specific geometry.' };
}

/** Report-only layer review. Registrations live in DESIGN §5, not this module.
 * Recognise only explicit production identities; unknown membership never becomes
 * a pill recommendation. This deliberately cannot adjudicate visual evidence. */
export function classifyDesignLayer({ member, layer, radius, evidence = false }) {
  if (layer === 'hit') return { classification: 'pending-target', reason: 'Hit geometry is independent of the visible mark; usage date targets still await the designer ruling.' };
  if (layer === 'indicator') return { classification: 'interaction-indicator', reason: 'Focus/selection is a separate layer; review the registered component treatment.' };
  const expected = { keycap: '4px', 'usage-heatmap-day': '2px', 'usage-token-bar': '2px',
    'workflow-status-cell': '2px', 'system-category-square': '2px',
    'ordinary-action': 'full', container: 'xl', textarea: 'lg' }[member];
  if (!expected) return { classification: 'unknown', reason: 'Visible layer has no verified registration/classification; DESIGN §5 requires a decision, not a pill guess.' };
  if (!evidence) return { classification: 'missing-evidence', reason: `Claimed ${member} needs evidence identifying this particular visible layer and scope.` };
  const equivalents = { full: ['full', '9999px'], xl: ['xl', '12px'], lg: ['lg', '8px'] };
  return (equivalents[expected] ?? [expected]).includes(radius)
    ? { classification: 'registered-value', reason: `${member}: matches DESIGN §5 on this visible layer; not a whole-component approval.` }
    : { classification: 'registered-value-violation', reason: `${member}: this visible layer requires ${expected} at all four corners (DESIGN §5).` };
}

/** DESIGN §5 corner-radius inventory: 0 / 2px (registered data marks) / 4px
 * (keycaps; other 4px usages are registered debt) / 8px / 12px / pill. Values
 * outside that set have no legitimate layer anywhere, so a new one blocks.
 * Theme-derived named steps resolve with the default --radius (8px): md = 6px,
 * 2xl = 16px, 3xl = 24px. var()/calc()/% values stay report-only. */
const GOVERNED_RADIUS_PX = new Set([0, 2, 4, 8, 12, 9999]);
const NAMED_RADIUS_PX = { md: 6, '2xl': 16, '3xl': 24 };
export function offScaleRadius(raw) {
  let px;
  const tailwind = /^rounded(?:-(?:[trblse]|tl|tr|bl|br|ss|se|es|ee))?(?:-(.+))?$/.exec(raw);
  if (tailwind) {
    const value = tailwind[1];
    if (value === undefined) return null;
    const arbitrary = /^\[([^\]]+)\]$/.exec(value);
    if (arbitrary) {
      // Tailwind turns `_` into a space, so rounded-[8px_10px] / [6px_12px/4px] is a shorthand:
      // check every item; var() / calc() / % items stay report-only.
      for (const part of arbitrary[1].split(/[_/\s]+/).filter(Boolean)) {
        const literal = /^(\d*\.?\d+)(px|rem)?$/i.exec(part);
        if (!literal) continue;
        const resolved = Number(literal[1]) * (literal[2]?.toLowerCase() === 'rem' ? 16 : 1);
        if (!GOVERNED_RADIUS_PX.has(resolved)) return resolved;
      }
      return null;
    } else px = NAMED_RADIUS_PX[value];
  } else {
    // Literal CSS / style-object radius: every value in a shorthand (6px 10px, 8px / 12px)
    // must be on the inventory; trailing !important or a quote is not part of the value.
    const css = /^(?:setProperty\(\s*['"][\w-]+['"]\s*,|border[\w-]*?[Rr]adius['"]?\s*\]?\s*(?::|=))\s*([\s\S]*)$/.exec(raw);
    if (!css) return null;
    const values = css[1].replace(/!\s*important/i, '').split(/[\s/]+/).filter(Boolean);
    for (const value of values) {
      const literal = /^(\d*\.?\d+)(px|rem)?$/i.exec(value.replace(/^['"`]+|['"`]+$/g, ''));
      if (!literal) continue; // var() / calc() / % / keywords stay report-only
      const resolved = Number(literal[1]) * (literal[2]?.toLowerCase() === 'rem' ? 16 : 1);
      if (!GOVERNED_RADIUS_PX.has(resolved)) return resolved;
    }
    return null;
  }
  return px === undefined || GOVERNED_RADIUS_PX.has(px) ? null : px;
}

/** `className`-bearing attributes are the literal style context this reporter
 * recognises. A palette-shaped token anywhere else in the source — help text,
 * test data, diagnostics prose — is not a class candidate, so reporting it
 * would only add audit noise. Spans cover the quoted value and the whole
 * balanced braced expression (cn()/ternaries included); string-aware brace
 * counting keeps arbitrary values like rounded-[4px] from ending the span.
 * Unparseable attributes fail closed: nothing inside becomes a candidate. */
function classNameValueSpans(source) {
  const spans = [];
  const attribute = /\b[\w$]*[Cc]lassName\s*=\s*(?:"|'|\{)|\bclass\s*=\s*(?:"|')/g;
  for (const match of source.matchAll(attribute)) {
    const open = match[0][match[0].length - 1];
    const start = match.index + match[0].length;
    if (open === '{') {
      let depth = 1, quote = '';
      for (let i = start; i < source.length; i++) {
        const char = source[i];
        if (quote) {
          if (char === '\\') i++;
          else if (char === quote) quote = '';
          continue;
        }
        if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
        if (char === '{') depth++;
        else if (char === '}' && --depth === 0) { spans.push([start, i]); break; }
      }
    } else {
      const close = source.indexOf(open, start);
      if (close >= 0) spans.push([start, close]);
    }
  }
  return spans;
}

/** Spans of `cn(` / `clsx(` / `cva(` / `twMerge(` / `classNames(` argument lists: class strings
 * assembled outside a className attribute are still a style context. */
function classHelperSpans(source) {
  const spans = [];
  for (const match of source.matchAll(/(?<![\w$.])(?:cn|clsx|cva|twMerge|classNames)\s*\(/g)) {
    const start = match.index + match[0].length;
    let depth = 1, quote = '';
    for (let i = start; i < source.length; i++) {
      const char = source[i];
      if (quote) { if (char === '\\') i++; else if (char === quote) quote = ''; continue; }
      if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
      if (char === '(') depth++;
      else if (char === ')' && --depth === 0) { spans.push([start, i]); break; }
    }
  }
  return spans;
}

const UTILITY_WORDS = new Set(['flex', 'grid', 'block', 'inline', 'hidden', 'relative', 'absolute', 'fixed', 'sticky', 'border',
  'truncate', 'transition', 'shadow', 'underline', 'static', 'contents', 'container', 'rounded', 'italic', 'uppercase']);
/** A string literal on this line made only of class-like tokens (a bare class list). */
function insideClassListLiteral(source, index) {
  const lineStart = source.lastIndexOf('\n', index - 1) + 1;
  const lineEnd = source.indexOf('\n', index); const end = lineEnd < 0 ? source.length : lineEnd;
  const line = source.slice(lineStart, end), at = index - lineStart;
  for (const m of line.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)) {
    if (at < m.index || at > m.index + m[0].length) continue;
    const tokens = m[2].split(/\s+/).filter(Boolean);
    return tokens.length > 0 && tokens.every(t => /^[\w!:[\]/.%()#&>*~@=,+-]+$/.test(t) && (/[-:[]/.test(t) || UTILITY_WORDS.has(t)));
  }
  return false;
}
/** True when `index` sits inside a string literal or template text (prose, help text, embedded CSS),
 * tracked lexically from the start of the file: ' and " end at the line break, template literals span
 * lines, `${ … }` is code again, comments are skipped. */
function insideStringLiteral(source, index) {
  let mode = 'code';
  const exprDepth = [];
  for (let i = 0; i < index; i++) {
    const char = source[i], next = source[i + 1];
    if (mode === 'code') {
      if (char === '/' && next === '/') mode = 'line';
      else if (char === '/' && next === '*') { mode = 'block'; i++; }
      else if (char === "'") mode = 'sq';
      else if (char === '"') mode = 'dq';
      else if (char === '`') mode = 'tpl';
      else if (char === '{' && exprDepth.length) exprDepth[exprDepth.length - 1]++;
      else if (char === '}' && exprDepth.length) { if (exprDepth[exprDepth.length - 1] === 0) { exprDepth.pop(); mode = 'tpl'; } else exprDepth[exprDepth.length - 1]--; }
    } else if (mode === 'sq' || mode === 'dq') {
      if (char === '\\') i++;
      else if (char === '\n' || char === (mode === 'sq' ? "'" : '"')) mode = 'code';
    } else if (mode === 'tpl') {
      if (char === '\\') i++;
      else if (char === '`') mode = 'code';
      else if (char === '$' && next === '{') { exprDepth.push(0); mode = 'code'; i++; }
    } else if (mode === 'line') { if (char === '\n') mode = 'code'; }
    else if (mode === 'block' && char === '*' && next === '/') { mode = 'code'; i++; }
  }
  return mode === 'sq' || mode === 'dq' || mode === 'tpl';
}

/** DESIGN §5 keeps intrinsic content geometry (icon masks, illustration
 * shapes) outside the radius inventory. Authors declare it in a comment on the
 * same line or one of the two lines above: `design: intrinsic-geometry — <why>` (the reason is required). */
// Must be a real comment (// … , /* … */, <!-- … -->) carrying a non-empty reason after a dash or colon.
const INTRINSIC_GEOMETRY = /design:\s*intrinsic-geometry\s*(?:[—–:-]+)\s*[^\s*/>-]/;
function declaresIntrinsicGeometry(rawSource, line) {
  if (!rawSource) return false;
  // Keep only real comment text (strings keep their `//` but are not comments): a marker quoted
  // inside a string literal never declares anything.
  const masked = maskColorComments(rawSource);
  let commentsOnly = '';
  for (let i = 0; i < rawSource.length; i++) commentsOnly += rawSource[i] !== masked[i] ? rawSource[i] : (rawSource[i] === '\n' ? '\n' : ' ');
  const lines = commentsOnly.split('\n');
  return lines.slice(Math.max(0, line - 3), line).some(text => INTRINSIC_GEOMETRY.test(text));
}

export function reportDesignLayers(file, source, changed, locate, spacingVariables, rawSource) {
  const findings = [];
  // Candidate reporting only: a palette utility is not proof of its rendered
  // role. Leave dynamic classes, CSS named values and exemptions to review.
  const paletteUtility = /(?<![\w-])(?:bg|text|border|ring|fill|stroke|outline|decoration|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|[1-9]00|950)(?:\/(?:\d+|\[[^\]\n]+\]))?(?![\w-])/g;
  const classSpans = classNameValueSpans(source);
  const helperSpans = classHelperSpans(source);
  for (const match of source.matchAll(paletteUtility)) {
    if (!classSpans.some(([start, end]) => match.index >= start && match.index < end)) continue;
    const pos = locate(match.index);
    if (!changed.has(pos.line)) continue;
    findings.push({ file, ...pos, rule: 'named-palette-candidate', value: match[0], disposition: 'report',
      classification: 'palette-utility',
      reason: 'Literal Tailwind palette utility; candidate only, verify rendered role and registered exceptions.',
      suggestion: 'Use the matching semantic theme role on a production surface; preserve sanctioned content and legacy overrides. This report does not add blocking scope.',
    });
  }
  const patterns = /\brounded(?:-(?:[trblse]|tl|tr|bl|br|ss|se|es|ee)(?=-))?(?:-(?:\[[^\]\n]+\]|[\w-]+))?|\b(?:border(?:-(?:top|bottom)-(?:left|right)|-(?:start|end)-(?:start|end))?-radius|border(?:(?:Top|Bottom)(?:Left|Right)|(?:Start|End)(?:Start|End))?Radius)['"]?\s*\]?\s*(?::|=(?!=))\s*[^;,}]+|\bsetProperty\(\s*['\"]border(?:-(?:top|bottom)-(?:left|right)|-(?:start|end)-(?:start|end))?-radius['\"]\s*,\s*[^;)]+|\b(?:[pm][xytrblse]?|gap(?:-[xy])?|space-[xy])-\[[^\]\n]+\]/g;
  for (const match of source.matchAll(patterns)) {
    const start = locate(match.index);
    // A multi-line declaration counts as changed when ANY line it spans was added/edited.
    const endLine = locate(Math.max(match.index, match.index + match[0].trimEnd().length - 1)).line;
    const changedLine = [...changed].filter(line => line >= start.line && line <= endLine).sort((a, b) => a - b)[0];
    if (changedLine === undefined) continue;
    const pos = changedLine === start.line ? start : { line: changedLine, column: 1 };
    const tagStart = source.lastIndexOf('<', match.index);
    const tagEnd = source.indexOf('>', match.index);
    const tag = tagStart >= 0 && tagEnd >= 0 ? source.slice(tagStart, tagEnd + 1) : '';
    const isRadius = /^(rounded|border|setProperty)/.test(match[0]);
    let member, layer, evidence = false;
    if (/\/usage\/Usage(?:Heatmap|TokenBars)\.tsx$|\/UsageHeatmap\.tsx$/.test(file)) {
      member = /data-usage-mark="(usage-heatmap-day|usage-token-bar)"/.exec(tag)?.[1];
      if (member) evidence = true;
      else if (/\busage-chart-target\b/.test(tag)) layer = 'hit';
      else if (/\busage-chart-indicator\b/.test(tag)) layer = 'indicator';
    }
    // Registered keyboard frame AND visible fill/border, not a button-tag heuristic.
    if (/^<kbd\s/.test(tag) && /\b(?:border|bg-)/.test(tag)) { member = 'keycap'; evidence = true; }
    const radius = /^rounded-\[([^\]]+)\]$/.exec(match[0])?.[1] ?? match[0].replace(/^rounded-/, '');
    const judgement = isRadius ? classifyDesignLayer({ member, layer, radius, evidence })
      : classifySpacing(match[0], spacingVariables);
    const offScale = isRadius ? offScaleRadius(match[0].trim()) : null;
    if (offScale !== null && declaresIntrinsicGeometry(rawSource, start.line)) {
      findings.push({ file, ...pos, rule: 'off-scale-radius', value: match[0], disposition: 'report',
        classification: 'declared-intrinsic-geometry',
        reason: `Resolves to ${offScale}px; declared intrinsic content geometry (DESIGN §5), so it is outside the radius inventory.`,
        suggestion: 'Reviewer: confirm the shape belongs to the content itself (icon mask, illustration), not to a control, container or row highlight.' });
      continue;
    }
    // Block only where the value really styles something: a class attribute / cn() argument / bare class
    // list, a style-object `borderRadius:` outside any string, or a CSS-file declaration. Prose and
    // diagnostics that merely mention a radius stay a report.
    const raw = match[0].trim();
    const inSpan = spans => spans.some(([a, b]) => match.index >= a && match.index < b);
    const styleContext = /^rounded/.test(raw)
      ? inSpan(classSpans) || inSpan(helperSpans) || insideClassListLiteral(source, match.index)
      : /^(?:border[A-Z]|setProperty)/.test(raw)
        // A quoted static key ('borderRadius': / ['borderRadius'] =) is code: judge the position of its opening quote.
        ? !insideStringLiteral(source, /^border[\w-]*?[Rr]adius['"]\s*\]?\s*[:=]/.test(raw) && /['"]/.test(source[match.index - 1]) ? match.index - 1 : match.index)
        : /\.(?:css|scss|less|html)$/.test(file);
    if (offScale !== null && !styleContext) {
      findings.push({ file, ...pos, rule: 'off-scale-radius', value: match[0], disposition: 'report',
        classification: 'off-scale-radius-unconfirmed-context',
        reason: `Resolves to ${offScale}px, outside the DESIGN §5 radius inventory, but it is not in a confirmed style context (class attribute, cn() call, class list, style object or CSS file).`,
        suggestion: 'If this styles a visible layer, use a governed radius (rounded-full / rounded-xl / rounded-lg); if it is prose or an embedded CSS string, ignore this report.' });
      continue;
    }
    if (offScale !== null) {
      findings.push({ file, ...pos, rule: 'off-scale-radius', value: match[0], disposition: 'block',
        classification: 'off-scale-radius',
        reason: `Resolves to ${offScale}px, outside the DESIGN §5 radius inventory (0 / 2 / 4 / 8 / 12px / pill); no layer may use it.`,
        suggestion: 'Assign the visible layer through DESIGN §5: ordinary control frame → rounded-full, container → rounded-xl (12px), inner control / textarea / row highlight → rounded-lg (8px). Intrinsic content geometry (icon mask, illustration) is outside the inventory: add a `design: intrinsic-geometry — <reason>` comment on this line or just above. A genuinely new shape needs a design ruling first.' });
      continue;
    }
    findings.push({ file, ...pos, rule: isRadius ? 'visible-layer-radius' : 'role-spacing',
      value: match[0], disposition: 'report', ...judgement,
      suggestion: isRadius
        ? 'Review the visible frame, contained mark and hit/indicator layers separately against DESIGN §5 and governance §13; register missing evidence/decisions. Do not change user radius overrides.'
        : 'Use the existing p/px/py, m/mx/my, gap/gap-x/gap-y and space-x/space-y scales from desktop-bindings.json foundations.spacing and the component treatment in DESIGN §4/5. Verify unknown variables, calculations and fallbacks; do not infer button spacing from a DOM tag.' });
  }
  if (/components\/settings\/.*(?:Dialog|Wizard)\.tsx$/.test(file) && changed.size) {
    findings.push({ file, line: Math.min(...changed), column: 1, rule: 'form-adoption', disposition: 'report',
      value: 'form consumer', reason: 'G2 independent contributor trial is pending; broad FormField adoption is not a blocking rule.',
      suggestion: 'Use DESIGN §4 and the existing DS-6 behaviour tests to review field association, focus, saving and secret controls. Do not infer behaviour from classes.' });
  }
  return findings;
}
