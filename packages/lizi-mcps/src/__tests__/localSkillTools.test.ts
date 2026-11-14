import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createXdtHelperMcpServer } from '../lizi_xdtHelperMcpServer.js';
import { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { registerLocalSkillLibraryTools, type LocalSkillLibraryCallback } from '../xdt-helper/local_skills.js';
import type { LiziMcpSessionContext } from '../types.js';

// Test value: real helper registration/discovery/dispatch must keep startup schemas fixed
// while search/read/configure reach the current task's host. Existing SkillHub tests cover
// remote catalogs, not local libraries or paged original reads. Minimal cases: absent host,
// selected id+sha256, register replacement, remote/expired caller. Unit, no filesystem/network.
const context: LiziMcpSessionContext = {
  agentKind: 'codex', workingDir: path.resolve('project'), sessionId: 'task', sessionInstanceId: 'instance',
};
const result = { ok: true as const, matches: [{ id: 'selected-id', name: 'selected-local-skill' }] };
function fixture(overrides: Partial<LiziMcpSessionContext> = {}) {
  const registry = new XdtHelperToolRegistry();
  const current = { ...context, ...overrides };
  const execute = vi.fn<LocalSkillLibraryCallback>().mockResolvedValue(result);
  registerLocalSkillLibraryTools(registry, { getSessionContext: () => current, execute });
  return { registry, current, execute };
}
type ToolResponse = { content: Array<{ type: string; text?: string }>; isError?: boolean };
const read = (value: ToolResponse) => JSON.parse(value.content[0]!.text!);
const serverTools = (server: unknown) => (server as {
  _registeredTools: Record<string, {
    description: string; inputSchema: z.ZodType;
    handler(args: unknown, extra?: { signal?: AbortSignal }): Promise<ToolResponse>;
  }>;
})._registeredTools;

describe('local Skill library helper', () => {
  // Review 4507777247: all local routes must retain MCP's per-request Stop signal.
  it('passes the MCP request signal through every local library action', async () => {
    const f = fixture();
    const server = createXdtHelperMcpServer({ localSkillLibrary: f.execute }, f.current);
    const controller = new AbortController();
    const routes = [
      ['search_local_skills', { library_id: 'work', query: 'method' }],
      ['read_local_skill', { library_id: 'work', id: 'selected-id' }],
      ['configure_local_skill_library', { library_id: 'work', action: 'register', sources: [path.resolve('skills')] }],
      ['configure_local_skill_library', { library_id: 'work', action: 'refresh' }],
      ['configure_local_skill_library', { library_id: 'work', action: 'remove' }],
    ] as const;
    try {
      for (const [name, args] of routes) {
        expect(read(await serverTools(server).call_tool!.handler({ name, args }, { signal: controller.signal }))).toEqual(result);
        expect(f.execute.mock.calls.at(-1)?.[2]).toBe(controller.signal);
      }
    } finally { await server.close(); }
  });

  it.each(['claude-code', 'codex', 'pi'] as const)('discovers local tools through stable %s startup schemas', async (agentKind) => {
    const f = fixture({ agentKind });
    const sessionContext = { ...f.current, agentKind };
    const base = createXdtHelperMcpServer({}, sessionContext);
    const enabled = createXdtHelperMcpServer({ localSkillLibrary: f.execute }, sessionContext);
    const definitions = (server: unknown) => Object.entries(serverTools(server)).map(([name, tool]) => ({
      name, description: tool.description, inputSchema: z.toJSONSchema(tool.inputSchema),
    }));
    try {
      expect(definitions(enabled)).toEqual(definitions(base));
      const unavailable = read(await serverTools(base).list_tools!.handler({ category: 'skills' }));
      expect(JSON.stringify(unavailable)).not.toContain('search_local_skills');
      const listing = read(await serverTools(enabled).list_tools!.handler({ category: 'skills' }));
      expect(listing.tools.map((tool: { name: string }) => tool.name)).toEqual([
        'search_local_skills', 'read_local_skill', 'configure_local_skill_library',
      ]);
      expect(f.execute).not.toHaveBeenCalled();
      expect(JSON.stringify(listing)).not.toContain('selected-local-skill');
      const searched = read(await serverTools(enabled).call_tool!.handler({
        name: 'search_local_skills', args: { library_id: 'personal-work', query: 'release notes', limit: 3 },
      }));
      expect(searched).toEqual(result);
      expect(f.execute).toHaveBeenLastCalledWith({ action: 'search', library_id: 'personal-work', query: 'release notes', limit: 3 }, f.current, undefined);
      const control = read(await serverTools(enabled).call_tool!.handler({
        name: 'get_capabilities', args: { scope: 'control', key: 'tools.skills', operation: 'read_local_skill' },
      }));
      expect(control).toMatchObject({ ok: true, control: {
        availability: 'available', missingOperations: [],
        operations: [{ name: 'read_local_skill', schemaComplete: true, inputSchema: { required: ['library_id', 'id'] } }],
      } });
      expect(JSON.stringify(control)).not.toContain('selected-local-skill');
    } finally {
      await base.close();
      await enabled.close();
    }
  });

  it('forwards exact selection and continuation to the host without loading other Skill descriptions', async () => {
    const f = fixture();
    f.execute.mockResolvedValue({ ok: true, content: 'selected source page', sha256: 'a'.repeat(64), nextOffset: 120, eof: false });
    const args = { library_id: 'personal-work', id: 'selected-id', offset: 60, sha256: 'a'.repeat(64), chars: 60 };
    expect(read(await f.registry.call('read_local_skill', args))).toMatchObject({ content: 'selected source page', nextOffset: 120, eof: false });
    expect(f.execute).toHaveBeenCalledWith({ action: 'read', ...args }, f.current, undefined);
  });

  it('registers complete sources with an optional gateway/model and keeps refresh/remove distinct', async () => {
    const f = fixture();
    const sources = [path.resolve('source-one'), path.resolve('source-two')];
    await f.registry.call('configure_local_skill_library', { action: 'register', library_id: 'work', sources });
    expect(f.execute).toHaveBeenLastCalledWith({ action: 'register', library_id: 'work', sources }, f.current, undefined);
    const configured = {
      action: 'register', library_id: 'work', sources: [sources[1]], gateway_path: path.resolve('discovery'),
      embedding_model: 'text-embedding-3-small', rebuild: true,
    };
    await f.registry.call('configure_local_skill_library', configured);
    expect(f.execute).toHaveBeenLastCalledWith(configured, f.current, undefined);
    await f.registry.call('configure_local_skill_library', { action: 'refresh', library_id: 'work', rebuild: true });
    expect(f.execute).toHaveBeenLastCalledWith({ action: 'refresh', library_id: 'work', rebuild: true }, f.current, undefined);
    f.execute.mockResolvedValue({ ok: true, removed: true, gateway_path: path.resolve('discovery') });
    const removed = read(await f.registry.call('configure_local_skill_library', { action: 'remove', library_id: 'work' }));
    expect(removed).toMatchObject({ removed: true, gateway_path: path.resolve('discovery') });
    expect(f.execute).toHaveBeenLastCalledWith({ action: 'remove', library_id: 'work' }, f.current, undefined);
  });

  it.each([
    { action: 'register', library_id: 'work' },
    { action: 'register', library_id: '../work', sources: ['source'] },
    { action: 'register', library_id: 'a'.repeat(41), sources: ['source'] },
    { action: 'refresh', library_id: 'work', embedding_model: 'new-model' },
    { action: 'remove', library_id: 'work', rebuild: true },
    { action: 'register', library_id: 'work', sources: ['source'], sessionId: 'forged' },
  ])('rejects requests outside the configuration action contract: %j', async (input) => {
    const f = fixture();
    expect((await f.registry.call('configure_local_skill_library', input)).isError).toBe(true);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('uses the current session context on every call and propagates host read errors', async () => {
    const f = fixture();
    f.execute.mockResolvedValue({ ok: false, errorCode: 'SKILL_CHANGED', message: 'Read again from offset 0' });
    expect(read(await f.registry.call('read_local_skill', { library_id: 'work', id: 'selected-id' }))).toMatchObject({
      ok: false, errorCode: 'SKILL_CHANGED', data: { hint: 'Read again from offset 0' },
    });
    f.execute.mockClear();
    f.current.remoteHostId = 'ssh-host';
    expect(read(await f.registry.call('search_local_skills', { library_id: 'work', query: 'release' }))).toMatchObject({ errorCode: 'UNSUPPORTED_CAPABILITY' });
    delete f.current.remoteHostId;
    delete f.current.sessionId;
    expect(read(await f.registry.call('search_local_skills', { library_id: 'work', query: 'release' }))).toMatchObject({ errorCode: 'NO_SESSION_CONTEXT' });
    expect(f.execute).not.toHaveBeenCalled();
  });
});
