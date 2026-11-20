import path from 'node:path';

export function inferProjectsRoot(
  directories: readonly string[],
  platform = process.platform,
): string | null {
  const counts = new Map<string, { parent: string; count: number }>();
  for (const directory of directories) {
    const parent = path.dirname(directory);
    if (parent === directory) continue;
    const key = platform === 'win32' ? parent.toLowerCase() : parent;
    const entry = counts.get(key) ?? { parent, count: 0 };
    entry.count++;
    counts.set(key, entry);
  }
  let best: { parent: string; count: number } | null = null;
  for (const entry of counts.values())
    if (entry.count >= 2 && (!best || entry.count > best.count)) best = entry;
  return best?.parent ?? null;
}

