import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { registerSkillhubTools } from '../xdt-helper/skillhub.js';
import { createXdtHelperMcpServer } from '../lizi_xdtHelperMcpServer.js';
import { z } from 'zod';
import type { LiziMcpSessionContext } from '../types.js';

function fixture(overrides: Partial<LiziMcpSessionContext> = {}) {
  const registry = new XdtHelperToolRegistry();
  const context = { agentKind: 'codex', workingDir: path.resolve('project'), sessionId: 'task', sessionInstanceId: 'instance', ...overrides };
  const execute = vi.fn(async () => ({ ok: true as const, status: 'uploaded', version: '1.0.0' }));
  registerSkillhubTools(registry, { getSessionContext: () => context, execute });
  return { registry, context, execute };
}
const publication = { path: path.resolve('project', 'release-notes'), name: 'release-notes', mode: 'create', visibility: 'private' };

describe('SkillHub helper tools', () => {
  it.each(['claude-code', 'codex', 'pi'] as const)('keeps startup schemas stable and discovers/calls SkillHub through %s', async (agentKind) => {
    const f = fixture({ agentKind });
    const sessionContext = { ...f.context, agentKind };
    const base = createXdtHelperMcpServer({}, sessionContext);
    const enabled = createXdtHelperMcpServer({ skillhub: f.execute }, sessionContext);
    const tools = (server: unknown) => (server as { _registeredTools: Record<string, { description: string; inputSchema: z.ZodType; handler: (args: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }> }> })._registeredTools;
    const definitions = (server: unknown) => Object.entries(tools(server)).map(([name, tool]) => ({ name, description: tool.description, inputSchema: z.toJSONSchema(tool.inputSchema) }));
    const read = (result: { content: Array<{ type: string; text?: string }> }) => JSON.parse(result.content[0]!.text!);
    try {
      expect(definitions(enabled)).toEqual(definitions(base));
      const listing = read(await tools(enabled).list_tools!.handler({ category: 'skills' }));
      expect(listing.tools.find((tool: { name: string }) => tool.name === 'publish_skill').inputSchema.required).toEqual(['path', 'name', 'mode']);
      expect(listing.tools.find((tool: { name: string }) => tool.name === 'search_skills').inputSchema.required).toEqual(['query']);
      await tools(enabled).call_tool!.handler({ name: 'search_skills', args: { query: 'release notes', scope: 'team' } });
      expect(f.execute).toHaveBeenLastCalledWith({ action: 'search', query: 'release notes', scope: 'team' }, expect.objectContaining({ agentKind, sessionId: 'task', sessionInstanceId: 'instance' }));
      const result = read(await tools(enabled).call_tool!.handler({ name: 'publish_skill', args: publication }));
      expect(result).toMatchObject({ ok: true, status: 'uploaded', version: '1.0.0' });
      expect(f.execute).toHaveBeenCalledWith({ action: 'publish', input: publication }, expect.objectContaining({ agentKind, sessionId: 'task', sessionInstanceId: 'instance' }));
    } finally {
      await base.close();
      await enabled.close();
    }
  });
  it('discovers tools under skills and binds the host context for publication', async () => {
    const { registry, context, execute } = fixture();
    expect(registry.list('skills').map((tool) => tool.name)).toEqual(['search_skills', 'list_my_published_skills', 'publish_skill', 'get_skill_publish_status']);
    const result = await registry.call('publish_skill', publication);
    expect(result.isError).toBeUndefined();
    expect(execute).toHaveBeenCalledWith({ action: 'publish', input: publication }, context);
    execute.mockClear();
    expect((await registry.call('publish_skill', { ...publication, sessionId: 'forged' })).isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
  it.each([
    { ...publication, visibility: undefined },
    { ...publication, name: '../other' },
    { ...publication, mode: 'update' },
    { ...publication, mode: 'update', visibility: undefined, tags: ['tag'] },
    { ...publication, team_slug: 'some-team' },
    { ...publication, visibility: 'shared', team_slug: 'some-team' },
  ])('rejects invalid publication arguments before calling the host: %j', async (input) => {
    const { registry, execute } = fixture();
    expect((await registry.call('publish_skill', input)).isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
  it.each([{ sessionId: undefined }, { remoteHostId: 'ssh-host' }])('rejects unavailable task contexts: %j', async (overrides) => {
    const { registry, execute } = fixture(overrides);
    expect((await registry.call('publish_skill', publication)).isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
  it('discovers sharing targets without owner selectors and forwards them unchanged', async () => {
    const { registry, execute, context } = fixture();
    const tool = registry.get('publish_skill')!;
    expect(tool.inputShape).not.toHaveProperty('team_slug');
    expect(tool.inputShape).toHaveProperty('visible_slugs');
    const input = { ...publication, visibility: 'shared', visible_slugs: ['engineering'] };
    expect((await registry.call('publish_skill', input)).isError).toBeUndefined();
    expect(execute).toHaveBeenCalledWith({ action: 'publish', input }, context);
  });
  it('forwards update, pagination and exact-version status requests without publication defaults', async () => {
    const { registry, context, execute } = fixture();
    const input = { path: publication.path, name: publication.name, mode: 'update', changelog: 'Fixed release notes' };
    await registry.call('publish_skill', input);
    expect(execute).toHaveBeenLastCalledWith({ action: 'publish', input }, context);
    await registry.call('list_my_published_skills', { query: 'release', cursor: '2' });
    expect(execute).toHaveBeenLastCalledWith({ action: 'list', query: 'release', cursor: '2' }, context);
    await registry.call('get_skill_publish_status', { name: 'release-notes', version: '1.0.1' });
    expect(execute).toHaveBeenLastCalledWith({ action: 'status', name: 'release-notes', version: '1.0.1' }, context);
  });
  it('searches the selected catalog and requires a catalog for pagination', async () => {
    const { registry, context, execute } = fixture();
    await registry.call('search_skills', { query: ' release notes ', scope: 'team', cursor: '2' });
    expect(execute).toHaveBeenLastCalledWith({ action: 'search', query: 'release notes', scope: 'team', cursor: '2' }, context);
    execute.mockClear();
    expect((await registry.call('search_skills', { query: 'release', cursor: '2' })).isError).toBe(true);
    expect((await registry.call('search_skills', { query: '  ' })).isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
});
