export * from '@cindy/maker-shared/mcp-apps';

/** Only plugin-owned local resource references need the execution computer. No URL fetching. */
export function hasExecutionComputerFile(value: unknown): boolean {
  const queue: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  while (queue.length) {
    const item = queue.pop()!;
    if (++visited > 50_000 || item.depth > 24) return true; // Uninspectable plugin payloads stay local.
    if (!item.value || typeof item.value !== 'object') continue;
    const data = item.value as Record<string, unknown>;
    if (data.type === 'resource_link' && typeof data.uri === 'string' && /^(?:cindy-media:|library:)/i.test(data.uri)) return true;
    for (const child of Object.values(data)) queue.push({ value: child, depth: item.depth + 1 });
  }
  return false;
}
