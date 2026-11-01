/**
 * 测试价值
 * - 生产入口与可观察结果：各换引擎来源适配器的 list() / read()（与导入执行层调用方式一致），
 *   断言列出哪些任务（含子 Agent 只计数、空记录不列）以及读出的消息顺序与内容。
 * - Bug／规则依据：设计说明 §12（真实数据与极限情况）——撤回、分支、分叉、覆盖写、多代文件
 *   这些来源语义读错，导入后的任务就会多出被撤回的轮次或丢掉最新回复。
 * - 现有覆盖缺口：这些来源此前没有任何读取代码；真实数据只有 Cursor 一种在本机可验证。
 * - 最小失败输入：每个来源一份最小样本，只放触发其特有语义的几行记录。
 * - tier：unit（临时目录里的文件与 SQLite，进程内完成）。
 * - 实测耗时：见 PR 描述。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cursorAdapter } from '../sources/cursor';
import { deepseekAdapter } from '../sources/deepseek';
import { factoryAdapter } from '../sources/factory';
import { geminiAdapter } from '../sources/gemini';
import { kimiAdapter } from '../sources/kimi';
import { opencodeAdapter } from '../sources/opencode';
import { qwenAdapter } from '../sources/qwen';
import { workbuddyAdapter } from '../sources/workbuddy';
import type { NormalizedMessage, SourceAdapter } from '../types';

let home: string;
const project = () => path.join(home, 'work', 'my-app');
/** Tools name per-project folders by the path with separators (and a Windows drive colon) turned into dashes. */
const dashedProject = () => project().replace(/^([A-Za-z]):/, '$1').replace(/[\\/]+/g, '-').replace(/^-+/, '');

async function put(rel: string, content: string | unknown[]): Promise<string> {
  const file = path.join(home, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Array.isArray(content) ? content.map((l) => JSON.stringify(l)).join('\n') + '\n' : content);
  return file;
}

async function readAll(adapter: SourceAdapter) {
  const listed = await adapter.list({ homeDir: home, cindyUserDataDir: null });
  const messages: Record<string, NormalizedMessage[]> = {};
  for (const s of listed.sessions) {
    messages[s.sourceSessionId] = [];
    for await (const m of adapter.read(s, { cindySessionId: 'x' })) messages[s.sourceSessionId]!.push(m);
  }
  return { listed, messages };
}

const brief = (ms: NormalizedMessage[]) => ms.map((m) => `${m.role}:${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`);

beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'cindy-import-fixtures-'));
  await mkdir(project(), { recursive: true });
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('foreign source adapters', () => {
  it('Gemini CLI folds overwrites, patches and rewinds and maps the project folder', async () => {
    await put('.gemini/projects.json', JSON.stringify({ projects: { [project()]: 'my-app' } }));
    await put('.gemini/tmp/my-app/chats/session-2026-10-30T10-00-abcd1234.jsonl', [
      { sessionId: 'g1', projectHash: 'h', startTime: '2026-10-30T10:00:00Z', lastUpdated: '2026-10-30T10:05:00Z', kind: 'main' },
      { id: 'u1', timestamp: '2026-10-30T10:00:01Z', type: 'user', content: [{ text: 'fix the bug' }] },
      { id: 'a1', timestamp: '2026-10-30T10:00:02Z', type: 'gemini', content: 'draft' },
      // 同一 id 再写一遍：以最后一次为准，位置不变。
      { id: 'a1', timestamp: '2026-10-30T10:00:02Z', type: 'gemini', content: 'final answer', toolCalls: [{ id: 'c1', name: 'read_file', args: { file_path: 'x' }, result: [{ functionResponse: { id: 'c1', name: 'read_file', response: { output: 'file body' } } }] }] },
      { id: 'u2', timestamp: '2026-10-30T10:01:00Z', type: 'user', content: 'try something else' },
      { id: 'a2', timestamp: '2026-10-30T10:01:01Z', type: 'gemini', content: 'abandoned' },
      { $rewindTo: 'u2' },
      { $set: { summary: 'Fix the login bug' } },
    ]);
    await put('.gemini/tmp/my-app/chats/g1/sub-1.jsonl', [{ sessionId: 's1', kind: 'subagent' }]);
    const { listed, messages } = await readAll(geminiAdapter);
    expect(listed.internalCount).toBe(1);
    expect(listed.sessions.map((s) => [s.sourceSessionId, s.title, s.cwd])).toEqual([['g1', 'Fix the login bug', project()]]);
    expect(brief(messages.g1!)).toEqual([
      'user:fix the bug',
      'assistant:final answer',
      'tool_use:{"toolUseId":"c1","toolName":"read_file","input":{"file_path":"x"}}',
      'tool_result:file body',
    ]);
  });

  it('Qwen Code follows the active branch so rewound turns are dropped', async () => {
    const base = { sessionId: 'q', cwd: project(), version: '1' };
    await put(`.qwen/projects/-work-my-app/chats/${'1'.repeat(8)}-0000-0000-0000-000000000000.jsonl`, [
      { ...base, uuid: 'u1', parentUuid: null, timestamp: '2026-10-30T10:00:00Z', type: 'user', message: { role: 'user', parts: [{ text: 'hello' }] } },
      { ...base, uuid: 'a1', parentUuid: 'u1', timestamp: '2026-10-30T10:00:01Z', type: 'assistant', message: { role: 'model', parts: [{ text: 'thinking…', thought: true }, { functionCall: { id: 'c1', name: 'ls', args: {} } }] } },
      { ...base, uuid: 't1', parentUuid: 'a1', timestamp: '2026-10-30T10:00:02Z', type: 'tool_result', message: { role: 'user', parts: [{ functionResponse: { id: 'c1', name: 'ls', response: { output: 'a b' } } }] } },
      { ...base, uuid: 'u2', parentUuid: 't1', timestamp: '2026-10-30T10:01:00Z', type: 'user', message: { role: 'user', parts: [{ text: 'rewound question' }] } },
      // /rewind：新记录指回 t1，u2 落到死分支。
      { ...base, uuid: 'r1', parentUuid: 't1', timestamp: '2026-10-30T10:02:00Z', type: 'system', subtype: 'rewind', systemPayload: { truncatedCount: 1 } },
      { ...base, uuid: 'u3', parentUuid: 'r1', timestamp: '2026-10-30T10:02:01Z', type: 'user', message: { role: 'user', parts: [{ text: 'new question' }] } },
      { ...base, uuid: 'x1', parentUuid: 'u3', timestamp: '2026-10-30T10:02:02Z', type: 'system', subtype: 'ui_telemetry' },
    ]);
    await put('.qwen/projects/-work-my-app/subagents/q/agent-1.jsonl', [{ uuid: 'z' }]);
    const { listed, messages } = await readAll(qwenAdapter);
    expect(listed.internalCount).toBe(1);
    expect(listed.sessions[0]!.cwd).toBe(project());
    expect(brief(Object.values(messages)[0]!)).toEqual([
      'user:hello',
      'thinking:{"text":"thinking…","durationMs":0,"isRedacted":false}',
      'tool_use:{"toolUseId":"c1","toolName":"ls","input":{}}',
      'tool_result:a b',
      'user:new question',
    ]);
  });

  it('OpenCode reads its SQLite store, counts subtask sessions and drops reverted messages', async () => {
    await mkdir(path.join(home, '.local/share/opencode'), { recursive: true });
    const db = new Database(path.join(home, '.local/share/opencode/opencode.db'));
    db.exec(`
      CREATE TABLE session (id TEXT, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT, revert TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
      CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    `);
    db.pragma('journal_mode = WAL');
    const insS = db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?)');
    insS.run('ses_1', 'p', null, project(), 'Build pricing page', JSON.stringify({ messageID: 'msg_3' }), 1000, 5000, null);
    insS.run('ses_2', 'p', 'ses_1', project(), 'subtask', null, 2000, 3000, null);
    const insM = db.prepare('INSERT INTO message VALUES (?,?,?,?,?)');
    const insP = db.prepare('INSERT INTO part VALUES (?,?,?,?,?)');
    insM.run('msg_1', 'ses_1', 1100, 1100, JSON.stringify({ role: 'user' }));
    insP.run('prt_1', 'msg_1', 'ses_1', 1100, JSON.stringify({ type: 'text', text: 'make a pricing page' }));
    insP.run('prt_2', 'msg_1', 'ses_1', 1100, JSON.stringify({ type: 'text', text: '<file contents>', synthetic: true }));
    insM.run('msg_2', 'ses_1', 1200, 1200, JSON.stringify({ role: 'assistant' }));
    insP.run('prt_3', 'msg_2', 'ses_1', 1200, JSON.stringify({ type: 'tool', callID: 't1', tool: 'write', state: { status: 'completed', input: { path: 'a' }, output: 'ok', time: { start: 1201, end: 1202 } } }));
    insP.run('prt_4', 'msg_2', 'ses_1', 1203, JSON.stringify({ type: 'text', text: 'done' }));
    insM.run('msg_3', 'ses_1', 1300, 1300, JSON.stringify({ role: 'user' }));
    insP.run('prt_5', 'msg_3', 'ses_1', 1300, JSON.stringify({ type: 'text', text: 'reverted ask' }));
    db.close();
    const { listed, messages } = await readAll(opencodeAdapter);
    expect(listed.internalCount).toBe(1);
    expect(listed.sessions.map((s) => [s.sourceSessionId, s.title, s.cwd])).toEqual([['ses_1', 'Build pricing page', project()]]);
    expect(brief(messages.ses_1!)).toEqual([
      'user:make a pricing page',
      'tool_use:{"toolUseId":"t1","toolName":"write","input":{"path":"a"}}',
      'tool_result:ok',
      'assistant:done',
    ]);
  });

  it('Kimi Code applies undo from wire events; Kimi CLI maps the folder from kimi.json', async () => {
    const dir = '.kimi-code/sessions/wd_my-app_abc/k1';
    await put(`${dir}/state.json`, JSON.stringify({ id: 'k1', title: 'Clean billing events', cwd: project(), createdAt: 1000, updatedAt: 2000, agents: { main: { type: 'main' }, 'agent-1': { type: 'sub' } } }));
    await put(`${dir}/agents/main/wire.jsonl`, [
      { type: 'metadata', protocol_version: '1.5' },
      { type: 'context.append_message', agentId: 'main', time: 1100, message: { role: 'user', content: [{ type: 'text', text: 'dedupe events' }] } },
      { type: 'context.append_message', agentId: 'main', time: 1200, message: { role: 'assistant', content: [{ type: 'think', think: 'plan' }, { type: 'text', text: 'first try' }], toolCalls: [] } },
      { type: 'context.undo', count: 1, time: 1250 },
      { type: 'context.append_message', agentId: 'main', time: 1300, message: { role: 'assistant', content: [{ type: 'text', text: 'second try' }], toolCalls: [{ type: 'function', id: 'c1', name: 'sql', arguments: '{"q":"select 1"}' }] } },
      { type: 'context.append_message', agentId: 'main', time: 1400, message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: '1' }] } },
    ]);
    const md5 = (await import('node:crypto')).createHash('md5').update(project()).digest('hex');
    await put('.kimi/kimi.json', JSON.stringify({ work_dirs: [{ path: project(), kaos: 'local' }] }));
    await put(`.kimi/sessions/${md5}/c1/context.jsonl`, [
      { role: '_system_prompt', content: 'sys' },
      { role: 'user', content: 'hi from cli' },
      { role: 'user', content: '<system>CHECKPOINT 1</system>' },
      { role: 'assistant', content: 'hello' },
    ]);
    const { listed, messages } = await readAll(kimiAdapter);
    expect(listed.internalCount).toBe(1);
    expect(listed.sessions.map((s) => [s.sourceSessionId, s.cwd])).toEqual([['k1', project()], ['cli:c1', project()]]);
    expect(brief(messages.k1!)).toEqual([
      'user:dedupe events',
      'assistant:second try',
      'tool_use:{"toolUseId":"c1","toolName":"sql","input":{"q":"select 1"}}',
      'tool_result:1',
    ]);
    expect(brief(messages['cli:c1']!)).toEqual(['user:hi from cli', 'assistant:hello']);
  });

  it('DeepSeek Harness reads the newest generation and skips the inherited fork prefix', async () => {
    const dir = '.dsh/sessions/--work-my-app--/d1';
    await put(`${dir}/session.v3.jsonl`, [{ type: 'session', version: 3, id: 'd1', createdAt: 1, cwd: project() }]);
    await put(`${dir}/session.v4.jsonl`, [
      { type: 'session', version: 4, id: 'd1', createdAt: 1000, cwd: project(), isSeeded: true, delegationDepth: 0 },
      { type: 'user/message', seq: 1, time: 1001, data: { id: 'm0', role: 'user', content: [{ type: 'text', text: 'inherited' }], source: { kind: 'user' } } },
      { type: 'session/end-seed', seq: 2, time: 1002, data: { inherited: true } },
      { type: 'user/message', seq: 3, time: 1100, data: { id: 'm1', role: 'user', content: [{ type: 'text', text: 'sum tokens' }], source: { kind: 'user' } } },
      { type: 'assistant/message', seq: 4, time: 1200, data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: 'r' }, { type: 'tool-call', id: 'k1', name: 'sql', arguments: '{}' }] } } },
      { type: 'tool/call', seq: 5, time: 1201, data: { callId: 'k1', name: 'sql', arguments: '{}' } },
      { type: 'tool/result', seq: 6, time: 1300, data: { message: { role: 'tool', toolCallId: 'k1', content: [{ type: 'text', text: '42' }] } } },
      { type: 'session/title', seq: 7, time: 1301, data: { title: 'Token totals' } },
    ]);
    await put('.dsh/sessions/--work-my-app--/d2/session.v4.jsonl', [{ type: 'session', version: 4, id: 'd2', createdAt: 1, origin: 'subagent', delegationDepth: 1 }]);
    const { listed, messages } = await readAll(deepseekAdapter);
    expect(listed.internalCount).toBe(1);
    expect(listed.sessions.map((s) => [s.sourceSessionId, s.title, s.cwd])).toEqual([['d1', 'Token totals', project()]]);
    expect(brief(messages.d1!)).toEqual([
      'user:sum tokens',
      'thinking:{"text":"r","durationMs":0,"isRedacted":false}',
      'tool_use:{"toolUseId":"k1","toolName":"sql","input":{}}',
      'tool_result:42',
    ]);
  });

  it.each([
    ['Cursor', cursorAdapter, async () => {
      const dir = `.cursor/projects/${dashedProject()}/agent-transcripts`;
      await put(`${dir}/c1/c1.jsonl`, [
        { role: 'user', message: { content: [{ type: 'text', text: '<timestamp>2026-10-30T10:00:00Z</timestamp>\n<user_query>\nfix dark mode\n</user_query>' }] } },
        { role: 'assistant', message: { content: [{ type: 'text', text: 'on it' }, { type: 'tool_use', name: 'Edit', input: { path: 'a' } }] } },
        { type: 'turn_ended', status: 'ok' },
      ]);
      await put(`${dir}/c1/subagents/s1.jsonl`, [{ role: 'user', message: { content: [] } }]);
      await put(`${dir}/c2/c2.jsonl`, [{ type: 'turn_ended', status: 'error' }]);
    }, ['user:fix dark mode', 'assistant:on it', 'tool_use']],
    ['Factory', factoryAdapter, async () => {
      await put(`.factory/sessions/${dashedProject()}/f1.jsonl`, [
        { type: 'session_start', id: 'f1', title: 'Nightly export', cwd: project(), version: 2 },
        { type: 'message', id: 'm1', timestamp: '2026-10-30T10:00:00Z', message: { role: 'user', content: 'add nightly export' } },
        { type: 'message', id: 'm2', timestamp: '2026-10-30T10:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't1', name: 'Write', input: {} }] } },
        { type: 'message', id: 'm3', timestamp: '2026-10-30T10:00:02Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'written' }] } },
        // Tool-injected context is dropped; a user's own tagged text is kept.
        { type: 'message', id: 'm4', timestamp: '2026-10-30T10:00:03Z', message: { role: 'user', content: '<system-reminder>todo list empty</system-reminder>' } },
        { type: 'message', id: 'm5', timestamp: '2026-10-30T10:00:04Z', message: { role: 'user', content: '<request>fix login</request>' } },
      ]);
    }, ['user:add nightly export', 'assistant:ok', 'tool_use', 'tool_result:written', 'user:<request>fix login</request>']],
    ['WorkBuddy', workbuddyAdapter, async () => {
      await put('.workbuddy/projects/-work-my-app/w1.jsonl', [
        { type: 'message', role: 'user', sessionId: 'w1', cwd: project(), timestamp: 1000, content: [{ type: 'input_text', text: '<system-reminder>x</system-reminder>' }], providerData: { skipRun: true } },
        { type: 'message', role: 'user', sessionId: 'w1', cwd: project(), timestamp: 1001, content: [{ type: 'input_text', text: 'compare cloud prices' }] },
        { type: 'function_call', callId: 'k', name: 'search', arguments: '{"q":"vps"}', timestamp: 1002 },
        { type: 'function_call_result', callId: 'k', status: 'completed', output: { type: 'text', text: 'results' }, timestamp: 1003 },
        { type: 'message', role: 'assistant', sessionId: 'w1', timestamp: 1004, content: [{ type: 'output_text', text: 'here is a table' }] },
        { type: 'topic', topic: 'Cloud prices' },
      ]);
    }, ['user:compare cloud prices', 'tool_use', 'tool_result:results', 'assistant:here is a table']],
  ] as const)('%s lists real conversations only and reads them in order', async (_name, adapter, setup, expected) => {
    await setup();
    const { listed, messages } = await readAll(adapter);
    expect(listed.sessions).toHaveLength(1);
    // Cursor recovers the folder from its dashed name, so Windows separators come back as '/'.
    expect(path.resolve(listed.sessions[0]!.cwd!)).toBe(project());
    expect(brief(Object.values(messages)[0]!).map((m) => (m.startsWith('tool_use') ? 'tool_use' : m))).toEqual(expected);
  });
});
