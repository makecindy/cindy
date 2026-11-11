import { expect, it, vi } from 'vitest';

import { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { registerTeammateProjectTools, type TeammateProjectsCallback } from '../xdt-helper/teammate_projects.js';

function parse(result: { content: Array<{ type: string; text?: string }> }) {
  const block = result.content[0];
  if (block?.type !== 'text' || typeof block.text !== 'string') throw new Error('text expected');
  return JSON.parse(block.text) as Record<string, unknown>;
}

// Restored links are independently discoverable, with the teammate derived from the caller session.
// Moved from the V1 workbench tool tests when those tools were removed.
// Minimal input: list + one project toggle with a caller session; an unbound call. Unit tool registry contract.
it('exposes project discovery and changes using caller identity', async () => {
  const projects = vi.fn<TeammateProjectsCallback>(async () => ({ ok: true as const, projects: [{ project_id: 'a'.repeat(64), working_dir: '/project', linked: true }] }));
  const registry = new XdtHelperToolRegistry();
  registerTeammateProjectTools(registry, { projects, getSessionContext: () => ({ sessionId: 'main', agentKind: 'codex', workingDir: '/home' }) });
  expect(parse(await registry.call('list_teammate_projects', {}))).toMatchObject({ ok: true, projects: [{ linked: true }] });
  await registry.call('set_teammate_project', { project_id: 'a'.repeat(64), linked: false });
  expect(projects).toHaveBeenLastCalledWith({ callerSessionId: 'main', projectId: 'a'.repeat(64), linked: false });
  const unbound = new XdtHelperToolRegistry();
  registerTeammateProjectTools(unbound, { projects, getSessionContext: () => ({ agentKind: 'codex', workingDir: '/home' }) });
  expect(parse(await unbound.call('list_teammate_projects', {}))).toMatchObject({ ok: false, errorCode: 'NOT_A_BOT_SESSION' });
});
