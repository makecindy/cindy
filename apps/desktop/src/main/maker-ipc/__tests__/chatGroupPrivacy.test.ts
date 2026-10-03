import { describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ rows: [] as unknown[][] }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ drizzle: { select: () => {
  const q: Record<string, unknown> = {};
  for (const method of ['from', 'innerJoin', 'where', 'orderBy']) q[method] = () => q;
  q.limit = async () => state.rows.shift() ?? [];
  return q;
} } }) }));
import { hydrateBotProfileRuntime } from '../botProfileRuntime';
import { chatGroupLaneRouteKey, parseBotGroupPlanRouteKey } from '../../../shared/botGroupChat';
import type { MakerSessionCreateOpts } from '../sessionRequest';

it('keeps different group grants in distinct model histories', () => {
  const keys = ['owner', 'chat', 'tools'].flatMap(mode => [1, 2].map(revision => chatGroupLaneRouteKey('group', { mode: mode as 'owner' | 'chat' | 'tools', revision })));
  expect(new Set(keys).size).toBe(6);
  for (const key of keys) expect(parseBotGroupPlanRouteKey(`${key}:plan:arrangement`)).toEqual({ groupId: 'group', planId: 'arrangement' });
  expect(parseBotGroupPlanRouteKey('group:group:plan:legacy')).toEqual({ groupId: 'group', planId: 'legacy' });
});
describe('chat-only group runtime', () => {
  it.each(['group:test:access:chat:2', 'group:test:access:chat:2:plan:one'])('keeps %s free of owner memory, SOUL, home and learned skills', async routeKey => {
    state.rows = [
      [{ botId: 'bot', role: 'group', routeKey, profileVersion: 1 }],
      [{ displayName: 'Companion', description: 'Public assistant' }],
      [{ identitySource: 'PRIVATE_SOUL', capabilitiesJson: JSON.stringify({ memory: true, userContextSource: 'PRIVATE_USER', skills: ['private-skill'], mcpMode: 'inherit', toolsetMode: 'inherit' }) }],
      [],
    ];
    const deps = {
      readMemoryIndex: vi.fn(async () => 'PRIVATE_MEMORY'),
      listOwnSkills: vi.fn(), readProfileFolder: vi.fn(), listTeammates: vi.fn(), listToolsets: vi.fn(),
      listSkills: vi.fn(async () => [{ name: 'private-skill', path: '/private/SKILL.md', enabled: true }]),
      listMcpServers: vi.fn(async () => [{ name: 'private-mcp', source: 'custom' as const, available: true }]),
    };
    const opts = { id: 'test', agentKind: 'pi', workingDir: '/isolated/group', model: 'test', extraDirs: ['/private'], writableDirs: ['/private'], makerMemoryIndexSnapshot: 'STALE_MEMORY' } as MakerSessionCreateOpts;
    const snapshot = await hydrateBotProfileRuntime(opts, deps, { persistSnapshot: false });
    expect(snapshot?.resolutionStatus).toBe('applied');
    for (const read of [deps.readMemoryIndex, deps.listOwnSkills, deps.readProfileFolder, deps.listTeammates, deps.listToolsets]) expect(read).not.toHaveBeenCalled();
    expect(opts.makerMemoryEnabled).toBe(false);
    expect(opts.extraDirs).toEqual([]);
    expect(opts.writableDirs).toEqual([]);
    expect(opts.botRuntimeProfile?.skillPolicy.configured).toEqual([]);
    expect(opts.botRuntimeProfile?.mcpPolicy.configured).toEqual([]);
    expect(opts.botRuntimeProfile?.toolsetPolicy.configured).toEqual([]);
    const prompt = [opts.botProfilePrompt, opts.botUserProfilePrompt, opts.botProfileContextPrompt, opts.makerMemoryIndexSnapshot].join('\n');
    expect(prompt).toContain('Public assistant');
    expect(prompt).not.toMatch(/PRIVATE_|STALE_MEMORY/);
  });
});
