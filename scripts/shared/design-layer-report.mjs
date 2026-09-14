import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

export function reportDesignLayers(file, source, changed, locate, spacingVariables) {
  const findings = [];
  // Candidate reporting only: a palette utility is not proof of its rendered
  // role. Leave dynamic classes, CSS named values and exemptions to review.
  const paletteUtility = /(?<![\w-])(?:bg|text|border|ring|fill|stroke|outline|decoration|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|[1-9]00|950)(?:\/(?:\d+|\[[^\]\n]+\]))?(?![\w-])/g;
  for (const match of source.matchAll(paletteUtility)) {
    const pos = locate(match.index);
    if (!changed.has(pos.line)) continue;
    findings.push({ file, ...pos, rule: 'named-palette-candidate', value: match[0], disposition: 'report',
      classification: 'palette-utility',
      reason: 'Literal Tailwind palette utility; candidate only, verify rendered role and registered exceptions.',
      suggestion: 'Use the matching semantic theme role on a production surface; preserve sanctioned content and legacy overrides. This report does not add blocking scope.',
    });
  }
  const patterns = /\brounded(?:-(?:\[[^\]\n]+\]|[\w-]+))?|\bborder(?:-radius|Radius)\s*:\s*[^;,}\n]+|\b(?:[pm][xytrblse]?|gap(?:-[xy])?|space-[xy])-\[[^\]\n]+\]/g;
  for (const match of source.matchAll(patterns)) {
    const pos = locate(match.index);
    if (!changed.has(pos.line)) continue;
    const tagStart = source.lastIndexOf('<', match.index);
    const tagEnd = source.indexOf('>', match.index);
    const tag = tagStart >= 0 && tagEnd >= 0 ? source.slice(tagStart, tagEnd + 1) : '';
    const isRadius = /^(rounded|border)/.test(match[0]);
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
