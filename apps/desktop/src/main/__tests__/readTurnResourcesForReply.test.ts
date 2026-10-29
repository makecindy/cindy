import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../localDb/client/current.js', () => ({ getDbClient: vi.fn() }));
vi.mock('../cindy-brain/index.js', () => ({ findGhostForInstanceId: vi.fn() }));
import { findGhostForInstanceId } from '../cindy-brain/index.js';
import { createTurnResourceReceipt, readExecutedPluginIdentity, readExecutedSkillIdentity, readTurnResourcesForReply } from '../readTurnResourcesForReply';
import { readTurnResources } from '@cindy/maker-shared/turn-resources';
import { capToolResultTextForPersist } from '../../shared/toolResultPersistCap';
import type { DbClient } from '../localDb/client/DbClient';

/**
 * Test value: readTurnResourcesForReply exposes a complete, safe per-reply receipt,
 * independently of the 50-row history window (core-product-principles §4.1/4.3).
 * Existing bot-result tests do not inspect tool invocation ownership or execution.
 * Smallest failures: a call before 50 Read rows; a rejected plugin; a tool owned
 * by another accepted input. Unit tier, in-memory SQLite only; no user database.
 */
let sqlite: Database.Database;
let db: Pick<DbClient, 'queryOne' | 'query'>;
let time: number;
function row(id: string, role: string, content: unknown, meta: object = {}, toolUseId: string | null = null, agentKind = 'claude-code', session = 'chat') {
  // Production stores strings verbatim, while structured tool payloads use JSON.
  sqlite.prepare('INSERT INTO messages(session_id,client_id,role,content,agent_meta,tool_use_id,agent_kind,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(session, id, role, typeof content === 'string' ? content : JSON.stringify(content), JSON.stringify(meta), toolUseId, agentKind, ++time);
}
function call(id: string, toolName: string, input: object, result: unknown = { ok: true, result: {} }, owner = 'input', agentKind = 'claude-code') {
  // Model a single invocation's host fact, before its result is stored or capped.
  const executionId = readExecutedPluginIdentity(toolName, input, result);
  const skillExecutionId = readExecutedSkillIdentity(toolName, input, result);
  row(id, 'tool_use', { toolName, input }, { replyToClientId: owner,
    ...(executionId ? { turnResourcePluginExecutionId: executionId } : {}),
    ...(skillExecutionId ? { turnResourceSkillExecutionId: skillExecutionId } : {}) }, id, agentKind);
  if (result !== null) row(`${id}-result`, 'tool_result', result, { replyToClientId: owner }, id, agentKind);
}
function final(id = 'final', owner = 'input') { row(id, 'assistant', 'Result', { replyToClientId: owner }); }
const bind = (inputs = ['input']) => readTurnResourcesForReply('chat', 'final', inputs, db);
beforeEach(() => {
  vi.mocked(findGhostForInstanceId).mockReset();
  time = 1000;
  sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE sessions(id TEXT, cleared_at INTEGER);
    CREATE TABLE messages(session_id TEXT,client_id TEXT,role TEXT,content TEXT,agent_meta TEXT,
      tool_use_id TEXT,agent_kind TEXT,created_at INTEGER,rewind_at INTEGER);
    INSERT INTO sessions VALUES ('chat',NULL),('other',NULL);`);
  db = { queryOne: async <T,>(sql: string, args: unknown[] = []) => sqlite.prepare(sql).get(...args) as T | undefined,
    query: async <T,>(sql: string, args: unknown[] = []) => sqlite.prepare(sql).all(...args) as T[] };
  row('input', 'user', 'Do this work');
});
afterEach(() => sqlite.close());

it('retains early real invocations in a long reply and persists only safe names and opaque identities', async () => {
  call('plugin', 'mcp__cindy__ghost_call', { ghost_id: 'github', namespace: 'team', tool: 'call_tool', args: { name: 'get_issue', path: '/private/file', token: 'secret' } });
  call('same-plugin', 'cindy_mcp_call_tool', { server: 'cindy', tool: 'ghost_call', args: { ghost_id: 'github', namespace: 'team', tool: 'call_tool', args: { name: 'get_pull_request' } } }, { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] }, 'input', 'pi');
  call('other-namespace', 'mcp:cindy:ghost_call', { ghost_id: 'github', namespace: null, tool: 'search' });
  call('skill', 'Skill', { skill: 'author:review' }, 'Launching skill: author:review');
  call('workflow', 'Workflow', { script: 'private script and credentials' }, 'Workflow launched in background. Task ID: wf-task');
  const workflow = createTurnResourceReceipt('workflow', 'Release check', 'Release check')!;
  sqlite.prepare('UPDATE messages SET agent_meta=? WHERE client_id=?')
    .run(JSON.stringify({ replyToClientId: 'input', workflowResource: workflow }), 'workflow');
  for (let i = 0; i < 80; i++) call(`read-${i}`, 'Read', { file_path: `/private/${i}/SKILL.md` }, 'Instructions');
  final();
  const resources = await bind();
  expect(resources.map(item => [item.kind, item.name])).toEqual([['plugin', 'github'], ['plugin', 'github'], ['skill', 'author:review'], ['workflow', 'Release check']]);
  expect(new Set(resources.map(item => item.id)).size).toBe(4);
  expect(JSON.stringify(resources)).not.toMatch(/private|secret|credentials|team/);
  expect(await bind()).toEqual(resources);
});

it('retains invocation receipts for production-stored plain and JSON-looking reply text', async () => {
  call('skill', 'Skill', { skill: 'review' }, 'Launching skill: review');
  final();
  for (const content of ['Plain reply', '{"ok":true}', '[]', '123', 'true', '"quoted text"']) {
    sqlite.prepare('UPDATE messages SET content=? WHERE client_id=?').run(content, 'final');
    expect((await bind()).map(item => item.name)).toEqual(['review']);
  }
});

it.each([
  ['mcp__cindy__ghost_call', { ghost_id: 'github', namespace: 'team', tool: 'search' }],
  ['mcp:cindy:ghost_call', { ghost_id: 'github', namespace: 'team', tool: 'search' }],
  ['cindy_mcp_call_tool', { server: 'cindy', tool: 'ghost_call', args: { ghost_id: 'github', namespace: 'team', tool: 'search' } }],
] as const)('retains a host-confirmed %s invocation after its result is capped at 8KB', async (toolName, input) => {
  const fullText = JSON.stringify({ ok: true, result: { text: '<tool_use_error>' + 'x'.repeat(10000) } });
  const executionId = readExecutedPluginIdentity(toolName, input, fullText);
  expect(executionId).toBeTruthy();
  row('large-call', 'tool_use', { toolName, input }, { replyToClientId: 'input', turnResourcePluginExecutionId: executionId }, 'large-call');
  row('large-result', 'tool_result', capToolResultTextForPersist(fullText), {}, 'large-call');
  final();
  expect((await bind()).map(item => item.name)).toEqual(['github']);
  sqlite.prepare('UPDATE messages SET agent_meta=? WHERE client_id=?')
    .run(JSON.stringify({ replyToClientId: 'input', turnResourcePluginExecutionId: 'tr_wrong' }), 'large-call');
  expect(await bind()).toEqual([]);
});

it('cannot derive an execution identity from discovery, grants, malformed inputs or a failed result', () => {
  const input = { ghost_id: 'github', namespace: 'team', tool: 'search' };
  for (const [toolName, args, result] of [
    ['mcp:cindy:ghost_call', { ...input, tool: 'list_tools' }, { ok: true }],
    ['mcp:cindy:ghost_call', { ...input, tool: 'call_tool', args: { name: 'list_tools' } }, { ok: true }],
    ['mcp:cindy:ghost_call', { ...input, grant_only: true }, { ok: true }],
    ['mcp:cindy:ghost_call', { ...input, ghost_id: '/private/path' }, { ok: true }],
    ['mcp:cindy:ghost_call', { ...input, namespace: 'a'.repeat(129) }, { ok: true }],
    ['mcp:cindy:ghost_call', input, { ok: false }],
    ['mcp:cindy:ghost_call', input, '{"ok":true,'],
    ['mcp:untrusted:ghost_call', input, { ok: true }],
  ] as const) expect(readExecutedPluginIdentity(toolName, args, result)).toBeUndefined();
});

// #7113: the shared namespace contract allows 128 characters. The old local
// 100-character regex silently omitted real plugin calls. Unit, SQLite receipt output.
it.each([101, 128])('retains exact host executions for a %i-character namespace and its instance alias', async length => {
  const namespace = 'a'.repeat(length);
  const direct = { ghost_id: 'github', namespace, tool: 'search' };
  const alias = { ghost_id: `_ns/${namespace}/github`, tool: 'search' };
  const identity = readExecutedPluginIdentity('mcp:cindy:ghost_call', direct, { ok: true });
  expect(identity).toBeTruthy();
  expect(readExecutedPluginIdentity('mcp:cindy:ghost_call', alias, { ok: true })).toBe(identity);
  call('direct-plugin', 'mcp:cindy:ghost_call', direct);
  call('alias-plugin', 'mcp:cindy:ghost_call', alias);
  final();
  expect((await bind()).map(item => [item.kind, item.name, item.id])).toEqual([['plugin', 'github', identity]]);
});

// #7113: a combined result belongs to several IDs, not necessarily the primary
// row that stores its text. Only an invocation's exact host fact proves execution.
it('does not infer plugin execution from an unstamped aggregate result', async () => {
  const accepted = { ghost_id: 'github', tool: 'search' };
  row('rejected-primary', 'tool_use', { toolName: 'mcp:cindy:ghost_call', input: { ghost_id: 'rejected-plugin', tool: 'search' } },
    { replyToClientId: 'input' }, 'rejected-primary');
  row('accepted-secondary', 'tool_use', { toolName: 'mcp:cindy:ghost_call', input: accepted },
    { replyToClientId: 'input', turnResourcePluginExecutionId: readExecutedPluginIdentity('mcp:cindy:ghost_call', accepted, { ok: true }) },
    'accepted-secondary');
  row('aggregate-result', 'tool_result', { ok: true, result: {} }, { replyToClientId: 'input' }, 'rejected-primary');
  final();
  expect((await bind()).map(item => item.name)).toEqual(['github']);
});

// #7113: generated summaries can overwrite a failed Skill's display result.
// Existing result checks only cover an unchanged error string; unit, SQLite output.
it('does not infer Skill success after its failed full result is replaced by a successful-looking summary', async () => {
  call('failed-skill', 'Skill', { skill: 'review' }, '<tool_use_error>Unknown skill</tool_use_error>');
  sqlite.prepare('UPDATE messages SET content=? WHERE client_id=?')
    .run('Skill review was loaded and the requested work was completed.', 'failed-skill-result');
  final();
  expect(await bind()).toEqual([]);
});

// #7113: grouped results may be stored only under another tool's primary ID.
// The exact Skill Host fact must survive without its own display row; unit.
it('retains a successful non-primary Skill with its Host fact and no individual result row', async () => {
  row('primary-read', 'tool_use', { toolName: 'Read', input: { file_path: '/fixture/input' } },
    { replyToClientId: 'input' }, 'primary-read');
  const input = { skill: 'review' };
  row('secondary-skill', 'tool_use', { toolName: 'Skill', input }, {
    replyToClientId: 'input',
    turnResourceSkillExecutionId: readExecutedSkillIdentity('Skill', input, 'Launching skill: review'),
  }, 'secondary-skill');
  row('aggregate-result', 'tool_result', 'Both tools completed.', { replyToClientId: 'input' }, 'primary-read');
  final();
  expect((await bind()).map(item => item.name)).toEqual(['review']);
});

it('omits discovery, rejected or unconfirmed calls, prompt-only workflows and non-Claude Skill lookalikes', async () => {
  call('discovery', 'mcp:cindy:ghost_call', { ghost_id: 'github', tool: 'list_tools' });
  call('nested-discovery', 'mcp:cindy:ghost_call', { ghost_id: 'github', tool: 'call_tool', args: { name: 'list_tools' } });
  call('grant', 'mcp:cindy:ghost_call', { ghost_id: 'github', tool: 'search', grant_only: true });
  call('rejected', 'mcp:cindy:ghost_call', { ghost_id: 'github', tool: 'search' }, { ok: false, errorCode: 'TOOL_NOT_FOUND' });
  call('pending', 'mcp:cindy:ghost_call', { ghost_id: 'github', tool: 'search' }, null);
  call('info', 'mcp:cindy:ghost_info', { ghost_id: 'github' });
  call('read', 'Read', { file_path: '/skills/review/SKILL.md' }, 'Skill instructions');
  call('failed-skill', 'Skill', { skill: 'review' }, '<tool_use_error>Unknown skill</tool_use_error>');
  call('codex-skill', 'Skill', { skill: 'review' }, 'loaded', 'input', 'codex');
  call('workflow-prompt', 'Workflow', { prompt: 'Do everything for me' }, 'Workflow launched in background. Task ID: workflow-task');
  final();
  expect(await bind()).toEqual([]);
});

it('counts an executed plugin even when its business result fails, without treating the failure as success', async () => {
  call('business-error', 'mcp:cindy:ghost_call', { ghost_id: 'github', tool: 'search' }, { ok: true, result: { ok: false, error: 'upstream unavailable' } });
  final();
  expect((await bind()).map(item => item.name)).toEqual(['github']);
});

it('uses all exact accepted inputs across steering, excluding queued, later and other-session work', async () => {
  call('early', 'Skill', { skill: 'early' }, 'loaded');
  row('steer', 'user', 'Also include this');
  call('steered', 'Skill', { skill: 'steered' }, 'loaded', 'steer');
  row('queued', 'user', 'Unrelated queued work');
  call('queued-call', 'Skill', { skill: 'queued' }, 'loaded', 'queued');
  final('final', 'steer');
  call('late', 'Skill', { skill: 'late' }, 'loaded', 'steer');
  row('other-tool', 'tool_use', { toolName: 'Skill', input: { skill: 'other' } }, { replyToClientId: 'input' }, 'other-tool', 'claude-code', 'other');
  expect((await bind(['input', 'steer'])).map(item => item.name)).toEqual(['early', 'steered']);
  expect(await bind(['queued'])).toEqual([]);
});

// #7113: child tools inherit the accepted input, so replyToClientId alone cannot
// identify the parent turn. Existing ownership cases only vary input/session IDs.
it('excludes child Skill and plugin calls sharing the parent input before deduplicating parent receipts', async () => {
  call('child-only-skill', 'Skill', { skill: 'child-only' }, 'loaded');
  call('child-only-plugin', 'mcp:cindy:ghost_call', { ghost_id: 'child-plugin', tool: 'search' });
  call('child-shared-skill', 'Skill', { skill: 'shared' }, 'loaded');
  call('child-shared-plugin', 'mcp:cindy:ghost_call', { ghost_id: 'github', tool: 'search' });
  sqlite.prepare("UPDATE messages SET agent_meta=json_set(agent_meta, '$.parentUuid', ?) WHERE client_id LIKE 'child-%'")
    .run('delegated-tool');
  call('parent-skill', 'Skill', { skill: 'shared' }, 'loaded');
  call('parent-plugin', 'mcp:cindy:ghost_call', { ghost_id: 'github', tool: 'search' });
  final();
  expect((await bind()).map(item => [item.kind, item.name])).toEqual([['skill', 'shared'], ['plugin', 'github']]);
});

it.each(['input', 'tool', 'result', 'reply', 'clear'] as const)('honours the visible %s boundary when history was rewound or cleared', async boundary => {
  call('used', 'Skill', { skill: 'review' }, 'loaded');
  final();
  if (boundary === 'clear') sqlite.prepare('UPDATE sessions SET cleared_at=? WHERE id=?').run(time, 'chat');
  else sqlite.prepare('UPDATE messages SET rewind_at=1 WHERE client_id=?')
    .run({ input: 'input', tool: 'used', result: 'used-result', reply: 'final' }[boundary]);
  expect(await bind()).toEqual([]);
});

it('ignores corrupt records and rejects unknown, control-bearing or oversized receipt labels', async () => {
  call('corrupt', 'Skill', { skill: 'review' }, 'loaded');
  sqlite.prepare('UPDATE messages SET agent_meta=? WHERE client_id=?').run('{broken', 'corrupt');
  final();
  expect(await bind()).toEqual([]);
  expect(readTurnResources([{ kind: 'unknown', id: 'id', name: 'Unknown' },
    { kind: 'skill', id: 'id', name: 'hidden\nlabel' }, { kind: 'skill', id: 'id', name: 'x'.repeat(121) },
    { kind: 'plugin', id: 'safe', name: 'GitHub', token: 'must not survive' }]))
    .toEqual([{ kind: 'plugin', id: 'safe', name: 'GitHub' }]);
});

it('snapshots exact host manifest names and preserves legitimate custom display punctuation', async () => {
  vi.mocked(findGhostForInstanceId).mockImplementation((id, namespace) => id === 'editor' && namespace === 'team'
    ? { manifest: { id: 'editor', name: '文案/校对 < A' }, namespace: 'team', namespaceState: 'confirmed' } as ReturnType<typeof findGhostForInstanceId>
    : null);
  call('named-plugin', 'mcp:cindy:ghost_call', { ghost_id: 'editor', namespace: 'team', tool: 'edit' });
  final();
  expect((await bind()).map(item => item.name)).toEqual(['文案/校对 < A']);
  expect(findGhostForInstanceId).toHaveBeenCalledWith('editor', 'team');
});
