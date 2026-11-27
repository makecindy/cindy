// Match both sides and their common ancestor. Marker labels contain changing
// commit IDs; the bytes inside the three sections are the relevant evidence.
function splitConflict(text) {
  if (text.includes('\0')) throw new Error('Binary conflict requires review');
  const context = [],
    blocks = [];
  const markers = [...text.matchAll(/^(<<<<<<< |\|\|\|\|\|\|\| |=======|>>>>>>> )[^\n]*(?:\n|$)/gm)];
  if (!markers.length || markers.length % 4) throw new Error('Unsupported conflict representation');
  let start = 0;
  for (let i = 0; i < markers.length; i += 4) {
    const [left, base, right, end] = markers.slice(i, i + 4);
    if (
      left[1] !== '<<<<<<< ' ||
      base[1] !== '||||||| ' ||
      right[0] !== '=======\n' ||
      end[1] !== '>>>>>>> '
    ) {
      throw new Error('Ambiguous conflict markers');
    }
    context.push(text.slice(start, left.index));
    blocks.push(
      JSON.stringify([
        text.slice(left.index + left[0].length, base.index),
        text.slice(base.index + base[0].length, right.index),
        text.slice(right.index + right[0].length, end.index),
      ]),
    );
    start = end.index + end[0].length;
  }
  context.push(text.slice(start));
  return { context, blocks };
}

export function replayConflict(recorded, resolved, current) {
  const old = splitConflict(recorded),
    live = splitConflict(current);
  if (old.blocks.length !== live.blocks.length || old.blocks.some((block, i) => block !== live.blocks[i])) {
    throw new Error('Conflict blocks changed');
  }
  if (/^(?:<{7}|\|{7}|={7}|>{7})(?: |$)/m.test(resolved))
    throw new Error('Resolution contains conflict markers');
  const prefix = old.context[0],
    suffix = old.context.at(-1);
  if (
    !resolved.startsWith(prefix) ||
    !resolved.endsWith(suffix) ||
    prefix.length + suffix.length > resolved.length
  ) {
    throw new Error('Recorded resolution changed surrounding text');
  }
  let middle = resolved.slice(prefix.length, resolved.length - suffix.length);
  const parts = [live.context[0]];
  for (let i = 1; i < old.blocks.length; i++) {
    const anchor = old.context[i];
    const offset = middle.indexOf(anchor);
    if (!anchor || offset < 0 || offset !== middle.lastIndexOf(anchor))
      throw new Error('Ambiguous resolution boundary');
    parts.push(middle.slice(0, offset), live.context[i]);
    middle = middle.slice(offset + anchor.length);
  }
  parts.push(middle, live.context.at(-1));
  return parts.join('');
}
