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
    || /^(?:实施|执行|工作|行动)?计划\s*[:：]?$/.test(title);
}
function selectPlanText(content) {
  const visible = content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  // A visible plan is authoritative. Native Pi also accepts plans in thinking
  // blocks; preserve that ability without exposing unrelated reasoning before
  // the last actual plan section or a fenced example.
  if (planLines(visible).some(line => isPlanHeader(line.text)) || extractTodoItems(visible).length) return visible;
  const native = content.map(block => block.type === 'text' ? block.text
    : block.type === 'thinking' ? block.thinking ?? '' : '').join('\n');
  const header = planLines(native).findLast(line => isPlanHeader(line.text));
  return header ? native.slice(header.start) : visible;
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
