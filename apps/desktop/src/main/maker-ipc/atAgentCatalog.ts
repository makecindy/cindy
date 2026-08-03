import path from 'node:path';

import type { AgentCustomization, AgentKind, AtResourceItem } from '@cindy/maker-core';

function oneLine(value: unknown, maxLength: number): string {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, maxLength)
    : '';
}

function isInsideProjectAgentDirectory(workingDir: string, absolutePath: string): string | null {
  const relative = path.relative(workingDir, absolutePath);
  if (!relative || path.isAbsolute(relative)) return null;
  const relPath = relative.replace(/\\/g, '/');
  if (relPath === '..' || relPath.startsWith('../')) return null;
  if (!relPath.startsWith('.claude/agents/') || !relPath.endsWith('.md')) return null;
  return relPath;
}

/** Project Agent definitions are engine-independent @ candidates, even while Codex or Pi is active. */
export function listAtProjectAgentResources(
  items: readonly AgentCustomization[],
  workingDir: string,
  query?: string,
): AtResourceItem[] {
  if (!path.isAbsolute(workingDir)) return [];
  const normalizedQuery = oneLine(query, 500).toLowerCase();
  const resources: AtResourceItem[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    if (
      item.engine !== 'claude-code'
      || item.kind !== 'agent'
      || item.scope !== 'project'
    ) continue;
    const relPath = isInsideProjectAgentDirectory(workingDir, item.absolutePath);
    const name = oneLine(item.name, 200);
    if (!relPath || !name || seen.has(relPath)) continue;
    const description = oneLine(item.description, 500);
    if (
      normalizedQuery
      && !name.toLowerCase().includes(normalizedQuery)
      && !relPath.toLowerCase().includes(normalizedQuery)
      && !description.toLowerCase().includes(normalizedQuery)
    ) continue;
    seen.add(relPath);
    resources.push({
      type: 'agent',
      name,
      relPath,
      ...(description ? { description } : {}),
    });
  }

  return resources;
}

export function mergeAtProjectAgentResources(
  base: readonly AtResourceItem[],
  projectAgents: readonly AtResourceItem[],
  cap?: number,
): { items: AtResourceItem[]; capped: boolean } {
  const merged: AtResourceItem[] = [];
  const seen = new Set<string>();
  for (const item of [...projectAgents, ...base]) {
    const key = `${item.type}:${item.relPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  const limit = typeof cap === 'number' && Number.isFinite(cap)
    ? Math.max(0, Math.floor(cap))
    : merged.length;
  return {
    items: merged.slice(0, limit),
    capped: merged.length > limit,
  };
}

/** Native project Agents are an executable capability of Claude Code only. */
export function supportsAtProjectAgentResources(agentKind: AgentKind): boolean {
  return agentKind === 'claude-code';
}

function isProjectAgentPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/').replace(/\/$/, '');
  return normalized === '.claude/agents' || normalized.startsWith('.claude/agents/');
}

/** Apply the engine boundary and keep Claude Agent definitions out of ordinary file results. */
export function finalizeAtProjectAgentResources(
  agentKind: AgentKind,
  base: readonly AtResourceItem[],
  projectAgents: readonly AtResourceItem[],
  cap?: number,
): { items: AtResourceItem[]; capped: boolean } {
  if (!supportsAtProjectAgentResources(agentKind)) {
    return {
      items: base.filter((item) => item.type !== 'agent' && !isProjectAgentPath(item.relPath)),
      capped: false,
    };
  }
  return mergeAtProjectAgentResources(base, projectAgents, cap);
}
