/** Optional, bounded usage hints for one invitation; never a profile identity or capability grant. */
export interface BotWelcomeContext {
  projects: string[];
  tasks: string[];
  automations: string[];
}

/** Shared by the cached projection and Main's untrusted IPC/persisted-data boundary. */
export function normalizeBotWelcomeContext(raw: unknown): BotWelcomeContext | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const body = raw as Record<string, unknown>;
  const labels = (value: unknown, limit: number): string[] => {
    if (!Array.isArray(value)) return [];
    const result: string[] = [];
    // Bound inspection as well as the resulting prompt, even for malformed callers.
    for (const item of value.slice(0, 20)) {
      if (typeof item !== 'string') continue;
      const label = item.slice(0, 240).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
      if (label && !result.includes(label)) result.push(label);
      if (result.length === limit) break;
    }
    return result;
  };
  const context = {
    projects: labels(body.projects, 3),
    tasks: labels(body.tasks, 4),
    automations: labels(body.automations, 2),
  };
  return Object.values(context).some(items => items.length) ? context : undefined;
}
