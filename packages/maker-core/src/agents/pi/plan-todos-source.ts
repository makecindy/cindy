/** Shared verbatim with the generated Pi adapter; no runtime module dependency. */
export const PI_PLAN_TODOS_SOURCE = String.raw`
function extractTodoItems(plan) {
  const lines = plan.split(/\r?\n/);
  let fence;
  const visible = [];
  for (const line of lines) {
    const marker = line.match(/^\s*(\x60{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined;
      continue;
    }
    if (!fence) visible.push(line);
  }
  const header = visible.findIndex(line => /^(?:(?:implementation|execution|action|work)\s+)?plan\s*[:：]?$/i.test(
    line.trim().replace(/^#{1,6}\s+/, '').replace(/\*\*|__/g, ''),
  ) || /^(?:实施|执行|工作|行动)?计划\s*[:：]?$/.test(
    line.trim().replace(/^#{1,6}\s+/, '').replace(/\*\*|__/g, ''),
  ));
  const candidates = [];
  for (const line of visible.slice(header + 1)) {
    const match = line.match(/^([ \t]*)(\d+)[.)、．）]\s*(\S.*)$/);
    if (!match) continue;
    const step = Number(match[2]);
    const text = match[3].trim().replace(/^\[[ xX]\]\s*/, '')
      .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1').replace(/__([^_]+)__/g, '$1')
      .replace(/\x60([^\x60]+)\x60/g, '$1').trim();
    if (!text) continue;
    candidates.push({ indent: match[1].replace(/\t/g, '    ').length, step, text, completed: false });
  }
  const indent = candidates.reduce((minimum, item) => Math.min(minimum, item.indent), Infinity);
  const items = candidates.filter(item => item.indent === indent);
  // Duplicate/unsafe ids cannot be addressed faithfully by native [DONE:n].
  // Let the adapter retain the entire plan as one item instead of renumbering it.
  if (items.some(item => !Number.isSafeInteger(item.step)) || new Set(items.map(item => item.step)).size !== items.length) return [];
  return items.map(({ step, text, completed }) => ({ step, text, completed }));
}
`;
