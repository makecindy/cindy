function splitRawText(text: string, maxCodePoints: number): string[] {
  const points = Array.from(text);
  const chunks: string[] = [];
  let offset = 0;
  while (offset < points.length) {
    let end = Math.min(offset + maxCodePoints, points.length);
    if (end < points.length) {
      while (end > offset && (points[end - 1] === "`" || points[end] === "`")) {
        end -= 1;
      }
      if (end === offset) end = Math.min(offset + maxCodePoints, points.length);
      const minimumBreak = offset + Math.floor(maxCodePoints * 0.6);
      for (let candidate = end; candidate > minimumBreak; candidate -= 1) {
        if (
          points[candidate - 1] === "\n" ||
          /\s/u.test(points[candidate - 1])
        ) {
          end = candidate;
          break;
        }
      }
    }
    chunks.push(points.slice(offset, end).join(""));
    offset = end;
  }
  return chunks;
}

function togglesFence(text: string): number {
  return (text.match(/^\s*```/gm) ?? []).length;
}

export function chunkWechatText(text: string, maxCodePoints = 3500): string[] {
  if (!Number.isSafeInteger(maxCodePoints) || maxCodePoints < 1) {
    throw new RangeError("maxCodePoints must be a positive integer");
  }
  const points = Array.from(text);
  if (points.length === 0) return [];
  if (maxCodePoints < 9) return splitRawText(text, maxCodePoints);

  const rawChunks = splitRawText(text, maxCodePoints - 8);
  const chunks: string[] = [];
  let fenceOpen = false;
  for (const raw of rawChunks) {
    const prefix = fenceOpen ? "```\n" : "";
    if (togglesFence(raw) % 2 === 1) fenceOpen = !fenceOpen;
    const suffix = fenceOpen ? "\n```" : "";
    chunks.push(`${prefix}${raw}${suffix}`);
  }
  return chunks;
}
