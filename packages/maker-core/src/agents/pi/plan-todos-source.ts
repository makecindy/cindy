/**
 * Shared verbatim with the generated Pi adapter (which has no workspace imports).
 * Adapted from zcinta0514's #8976 parser for #8933.
 */
export const PI_PLAN_TODOS_SOURCE = String.raw`
function planLines(plan) {
  const visible = [];
  let fence;
  let offset = 0;
  for (const line of plan.split('\n')) {
    const start = offset;
    offset += line.length + 1;
    const marker = line.match(/^\s*(\x60{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined;
      continue;
    }
    if (!fence) visible.push({ text: line, start });
  }
  return visible;
}
function isPlanHeader(line) {
  const title = line.trim().replace(/^#{1,6}\s+/, '').replace(/\*\*|__/g, '');
  return /^(?:(?:implementation|execution|action|work)\s+)?plan\s*[:：]?$/i.test(title)
    || /^(?:实施|执行|工作|行动)?计划\s*[:：]?$/.test(title)
    || /^(?:final\s+(?:plan|steps)|最终(?:计划|步骤))\s*[:：]?$/i.test(title);
}
function selectPlanText(content) {
  const visible = content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  // A visible plan is authoritative. Native Pi also accepts plans in thinking
  // blocks; preserve that ability without exposing unrelated reasoning before
  // the last actual plan section or a fenced example.
  const visibleLines = planLines(visible);
  const visibleHeader = visibleLines.findLastIndex(line => isPlanHeader(line.text));
  // Valid whole plans need not have parseable ids. Only a bare introduction
  // (with no actual body) should defer to a plan carried in thinking.
  const substantiveVisible = visibleLines.slice(visibleHeader + 1).some(line => {
    const text = line.text.trim();
    return text && !/^(?:here(?:'s| is) (?:the|my|a) plan|计划如下|以下是计划)[.!:：。]?$/i.test(text);
  });
  if (substantiveVisible) return visible;
  // A dangling visible heading is not a plan. Do not let it become the last
  // header of the combined response and hide the actual thinking steps.
  let nativeVisible = visible;
  let linesWithoutEmptyHeaders = visibleLines;
  while (true) {
    const header = linesWithoutEmptyHeaders.findLastIndex(line => isPlanHeader(line.text));
    if (header < 0 || linesWithoutEmptyHeaders.slice(header + 1).some(line => line.text.trim())) break;
    nativeVisible = nativeVisible.slice(0, linesWithoutEmptyHeaders[header].start);
    linesWithoutEmptyHeaders = planLines(nativeVisible);
  }
  const native = content.filter(block => block.type === 'thinking')
    .map(block => block.thinking ?? '').concat(nativeVisible ? [nativeVisible] : []).join('\n');
  const header = planLines(native).findLast(line => isPlanHeader(line.text));
  if (header) return native.slice(header.start);
  // Some native providers emit a numbered plan in thinking without a
  // heading. Keep the complete top-level list, including blank lines and
  // step details, while still dropping unrelated preamble.
  const lines = planLines(native);
  const numbered = lines.filter(line => /^\s*\d+[.)、．）]\s*\S/.test(line.text));
  if (numbered.length) {
    const indent = line => line.text.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;
    const minimum = numbered.reduce((minimum, line) => Math.min(minimum, indent(line)), Infinity);
    const roots = numbered.filter(line => indent(line) === minimum);
    let start = 0;
    for (let i = 1; i < roots.length; i++) {
      const previous = roots[i - 1];
      const gap = native.slice(previous.start + previous.text.length, roots[i].start);
      const restarts = i - start >= 2 && i + 1 < roots.length
        && Number(roots[i].text.trim().match(/^\d+/)[0]) === 1;
      // Separate Markdown lists can restart numbering, or be divided by an
      // outer paragraph. Blanks/continuations within one list stay intact.
      if ((restarts && /\n[ \t]*\n/.test(gap))
        || /\n[ \t]*\n[^\s\n][^\n]*\n[ \t]*\n/.test(gap)) start = i;
    }
    return native.slice(roots[start].start);
  }
  return visible;
}
function extractTodoItems(plan) {
  const visible = planLines(plan).map(line => line.text);
  let header = -1;
  for (let i = 0; i < visible.length; i++) {
    if (isPlanHeader(visible[i])) header = i;
  }
  const candidates = [];
  for (const line of visible.slice(header + 1)) {
    const match = line.match(/^([ \t]*)(\d+)[.)、．）]\s*(\S.*)$/);
    if (!match) continue;
    const text = match[3].trim().replace(/^\[[ xX]\]\s*/, '')
      .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1').replace(/__([^_]+)__/g, '$1')
      .replace(/\x60([^\x60]+)\x60/g, '$1').trim();
    candidates.push({ indent: match[1].replace(/\t/g, '    ').length,
      step: Number(match[2]), text, completed: false });
  }
  const indent = candidates.reduce((minimum, item) => Math.min(minimum, item.indent), Infinity);
  const items = candidates.filter(item => item.indent === indent);
  // Ambiguous ids cannot be faithfully addressed by native [DONE:n] progress.
  if (items.some(item => !item.text || !Number.isSafeInteger(item.step) || item.step < 1)
    || new Set(items.map(item => item.step)).size !== items.length) return [];
  return items.map(({ step, text, completed }) => ({ step, text, completed }));
}
`;
