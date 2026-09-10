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

export function reportDesignLayers(file, source, changed, locate) {
  const findings = [];
  const patterns = /\brounded(?:-(?:\[[^\]\n]+\]|[\w-]+))?|\bborder(?:-radius|Radius)\s*:\s*[^;,}\n]+|\b(?:p[xytrbl]?|gap[xy]?)-\[[^\]\n]+\]/g;
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
      : { classification: 'unclassified-spacing', reason: 'Spacing needs a verified component role; do not apply button padding based on a DOM tag.' };
    findings.push({ file, ...pos, rule: isRadius ? 'visible-layer-radius' : 'role-spacing',
      value: match[0], disposition: 'report', ...judgement,
      suggestion: 'Review the visible frame, contained mark and hit/indicator layers separately against DESIGN §5 and governance §13; register missing evidence/decisions. Do not change user radius overrides.' });
  }
  if (/components\/settings\/.*(?:Dialog|Wizard)\.tsx$/.test(file) && changed.size) {
    findings.push({ file, line: Math.min(...changed), column: 1, rule: 'form-adoption', disposition: 'report',
      value: 'form consumer', reason: 'G2 independent contributor trial is pending; broad FormField adoption is not a blocking rule.',
      suggestion: 'Use DESIGN §4 and the existing DS-6 behaviour tests to review field association, focus, saving and secret controls. Do not infer behaviour from classes.' });
  }
  return findings;
}
