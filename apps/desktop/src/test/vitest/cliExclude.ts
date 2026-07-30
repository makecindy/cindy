export function parseVitestCliExclude(args: readonly string[]): string[] {
  const patterns: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--exclude') {
      const pattern = args[index + 1];
      if (pattern && !pattern.startsWith('--')) {
        patterns.push(pattern);
        index += 1;
      }
      continue;
    }
    if (arg.startsWith('--exclude=')) {
      const pattern = arg.slice('--exclude='.length);
      if (pattern) patterns.push(pattern);
    }
  }

  return patterns;
}
