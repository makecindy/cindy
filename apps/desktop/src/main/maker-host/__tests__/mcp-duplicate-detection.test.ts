import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectMcpDuplicates, resolveMcpDuplicateChoices, type McpDuplicateDetectionDeps } from '../mcp-duplicate-detection.js';
import type { McpDuplicateChoice } from '../../../shared/customMcp.js';

// #8902: production diagnostics + runtime projection. Existing custom MCP CRUD tests
// never read native configuration. Minimal input: one host hub and one native hub/claude.
// Unit tier: injected JSON reader, no disk/network/real credentials.
function fixture() {
  const home = path.resolve('fixture-home');
  const native = { magpie: { type: 'http', url: 'http://localhost:3425/mcp/magpie/hub/claude', headers: { Authorization: 'fixture-native-secret' } } };
  const config = { mcpServers: native, projects: {} as Record<string, unknown> };
  const custom = [{ id: 'custom_magpie', name: 'Magpie', transport: 'http' as const,
    url: 'http://localhost:3425/mcp/magpie/hub', headers: {} }];
  const files = new Map<string, unknown>([[path.join(home, '.claude.json'), config]]);
  const choices: Record<string, McpDuplicateChoice> = {};
  const deps: McpDuplicateDetectionDeps = { home, readJson: async file => files.get(file) ?? {},
    listCustom: async () => custom, readToken: () => 'fixture-host-secret', readChoices: () => choices };
  return { home, native, config, custom, files, choices, deps };
}

describe('MCP duplicate suggestions and explicit choices', () => {
  it('suggests router aliases without exposing credentials or changing runtime defaults', async () => {
    const f = fixture();
    const report = await detectMcpDuplicates(f.deps, { env: {} });
    expect(report.connections).toMatchObject([{ cindyId: 'custom_magpie', claudeName: 'magpie', reason: 'similar', origin: 'http://localhost:3425' }]);
    expect(JSON.stringify(report)).not.toContain('secret');
    expect(resolveMcpDuplicateChoices(report)).toEqual({ skipHostServers: [], denyNativeServers: [] });
  });

  it.each([
    ['cindy', [], ['magpie']], ['claude', ['custom_magpie'], []], ['both', [], []],
  ] as const)('applies only the explicit %s choice and invalidates it after credential changes', async (choice, skip, deny) => {
    const f = fixture();
    const report = await detectMcpDuplicates(f.deps, { env: {} });
    f.choices[report.connections[0]!.id] = choice;
    expect(resolveMcpDuplicateChoices(await detectMcpDuplicates(f.deps, { env: {} })))
      .toEqual({ skipHostServers: skip, denyNativeServers: deny });
    f.native.magpie.headers.Authorization = 'different-secret';
    expect(resolveMcpDuplicateChoices(await detectMcpDuplicates(f.deps, { env: {} })))
      .toEqual({ skipHostServers: [], denyNativeServers: [] });
  });

  it.each([
    ['http://LOCALHOST:3425/mcp/magpie/hub/', 'endpoint'],
    ['http://localhost:3425/mcp/magpie/hub?account=other', 'similar'],
    ['http://localhost:3426/mcp/magpie/hub', undefined],
    ['http://localhost:3425/mcp/unrelated', undefined],
    ['http://localhost:3425/mcp/magpie/hub-other', undefined],
  ])('compares endpoint boundaries: %s', async (url, reason) => {
    const f = fixture(); f.native.magpie.url = url!;
    const report = await detectMcpDuplicates(f.deps, { env: {} });
    expect(report.connections[0]?.reason).toBe(reason);
    expect(report.complete).toBe(true);
  });

  it('uses the actual configuration directory and does not apply a global choice to a project override', async () => {
    const f = fixture();
    const root = path.resolve('other-config');
    expect((await detectMcpDuplicates(f.deps, { env: { CLAUDE_CONFIG_DIR: root } })).connections).toEqual([]);
    f.files.set(path.join(root, '.claude.json'), f.config);
    const report = await detectMcpDuplicates(f.deps, { env: { CLAUDE_CONFIG_DIR: root } });
    f.choices[report.connections[0]!.id] = 'claude';
    const workingDir = path.resolve('project');
    f.files.set(path.join(workingDir, '.mcp.json'), { mcpServers: { magpie: { url: 'https://other.test/mcp' } } });
    expect((await detectMcpDuplicates(f.deps, { env: { CLAUDE_CONFIG_DIR: root }, workingDir })).connections).toEqual([]);
  });

  it('preserves connections and reports incomplete diagnostics when configuration cannot be read', async () => {
    const f = fixture(); f.deps.readJson = async () => { throw new Error('private config content'); };
    expect(await detectMcpDuplicates(f.deps, { env: {} })).toEqual({ complete: false, connections: [] });
  });

  it('invalidates a choice when a credential referenced through the environment changes', async () => {
    const f = fixture(); f.native.magpie.headers.Authorization = 'Bearer ${MCP_TOKEN}';
    const report = await detectMcpDuplicates(f.deps, { env: { MCP_TOKEN: 'first-secret' } });
    f.choices[report.connections[0]!.id] = 'claude';
    const changed = await detectMcpDuplicates(f.deps, { env: { MCP_TOKEN: 'second-secret' } });
    expect(resolveMcpDuplicateChoices(changed)).toEqual({ skipHostServers: [], denyNativeServers: [] });
    expect(JSON.stringify(changed)).not.toContain('secret');
  });

  it('does not suggest disabled native connections or names already overridden by Cindy', async () => {
    const f = fixture();
    f.files.set(path.join(f.home, '.claude.json'), { ...f.config, disabledMcpServers: ['magpie'] });
    expect((await detectMcpDuplicates(f.deps, { env: {} })).connections).toEqual([]);
    f.files.set(path.join(f.home, '.claude.json'), f.config);
    f.custom[0]!.id = 'magpie';
    expect((await detectMcpDuplicates(f.deps, { env: {} })).connections).toEqual([]);
  });

  it('reports malformed native configurations as incomplete instead of no duplicates', async () => {
    const f = fixture(); f.files.set(path.join(f.home, '.claude.json'), { mcpServers: [] });
    expect(await detectMcpDuplicates(f.deps, { env: {} })).toEqual({ connections: [], complete: false });
  });

  it('keeps both sides if overlapping pairs have contradictory or incomplete choices', async () => {
    const f = fixture();
    f.custom.push({ ...f.custom[0]!, id: 'custom_second' });
    const report = await detectMcpDuplicates(f.deps, { env: {} });
    report.connections[0]!.choice = 'claude'; report.connections[1]!.choice = 'cindy';
    expect(resolveMcpDuplicateChoices(report)).toEqual({ skipHostServers: [], denyNativeServers: [] });
  });
});
