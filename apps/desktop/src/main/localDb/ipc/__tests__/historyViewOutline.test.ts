import { DatabaseSync } from 'node:sqlite';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { historyOutlineContent, withHistoryArtifacts } from '../historyViewOutline';

function outline(role: string, content: unknown, agentMeta: unknown = null, raw = false) {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE messages (role TEXT, content TEXT, agent_meta TEXT)');
    db.prepare('INSERT INTO messages VALUES (?, ?, ?)').run(role, raw ? String(content) : JSON.stringify(content), JSON.stringify(agentMeta));
    const query = new SQLiteSyncDialect().sqlToQuery(historyOutlineContent());
    const row = db.prepare(`SELECT ${query.sql} AS content FROM messages`).get(...query.params as string[])!;
    try { return JSON.parse(row.content as string); } catch { return row.content; }
  } finally { db.close(); }
}

describe('SQLite history outline', () => {
  it('does not return folded thinking, tool outputs or file bodies to the main thread', () => {
    const body = 'private heavy body '.repeat(100000);
    expect(JSON.stringify(outline('thinking', { text: body, durationMs: 1000 })).length).toBeLessThan(100);
    expect(outline('thinking', { text: '', durationMs: 0 })).toEqual({ isRedacted: false, durationMs: 0 });
    expect(outline('tool_result', body)).toBe('');
    const content = outline('tool_use', { toolName: 'Write', input: { file_path: '/work/report.md', content: body } });
    expect(JSON.stringify(content)).not.toContain(body);
    const result = withHistoryArtifacts({ id: '1', clientId: '1', role: 'tool_use', content, createdAt: '2026-09-25T00:00:00Z' });
    expect(result.historyArtifacts).toMatchObject([{ path: '/work/report.md', source: 'tool' }]);
  });
  it('keeps visible prose, artifacts and malformed legacy bodies intact', () => {
    expect(outline('assistant', 'Final answer')).toBe('Final answer');
    expect(outline('assistant', 'Internal prose', { parentUuid: 'agent' })).toBe('');
    const media = JSON.stringify({ xdt_image_url: 'cindy-media://blobs/test.png' });
    expect(outline('tool_result', media)).toBe(media);
    expect(outline('tool_result', 'xdt-file://report.pdf')).toBe('xdt-file://report.pdf');
    expect(outline('tool_use', '{broken', null, true)).toBe('{broken');
    expect(() => outline('tool_use', { toolName: 'file_change', input: { changes: ['malformed'] } })).not.toThrow();
  });
  it('retains command file candidates without sending command bodies in the summary', () => {
    const content = outline('tool_use', { toolName: 'Bash', input: { command: 'echo done > /work/report.txt' } });
    const result = withHistoryArtifacts({ id: '1', clientId: '1', role: 'tool_use', content, createdAt: '2026-09-25T00:00:00Z' });
    expect(result.historyArtifacts).toMatchObject([{ path: '/work/report.txt', source: 'command' }]);
    expect(JSON.stringify(result.historyArtifacts)).not.toContain('echo');
  });
  it.each(['Bash', 'exec'])('bounds long %s command outlines after extracting trailing output paths', (toolName) => {
    const command = `echo '${'x'.repeat(300000)}' > /work/trailing-report.txt`;
    const content = outline('tool_use', { toolName, input: { command, displayCommand: command } });
    const result = withHistoryArtifacts({ id: '1', clientId: '1', role: 'tool_use', content, createdAt: '2026-09-25T00:00:00Z' });
    expect(JSON.stringify(result).length).toBeLessThan(1500);
    expect(result.historyArtifacts).toMatchObject([{ path: '/work/trailing-report.txt', source: 'command' }]);
    expect(content.input.command).toBe(command);
    const empty = outline('tool_use', { toolName, input: null });
    expect(() => withHistoryArtifacts({ id: '2', clientId: '2', role: 'tool_use', content: empty, createdAt: '' })).not.toThrow();
  });
  it('retains structured failures and rejects malformed file changes', () => {
    for (const result of [{ ok: false }, { success: false }, { status: 'FAILED' }]) {
      expect(outline('tool_result', JSON.stringify(result))).toBe('<tool_use_error>');
    }
    expect(outline('tool_result', JSON.stringify({ ok: true }))).toBe('');
    const content = outline('tool_use', { toolName: 'file_change', input: { changes: [{ path: '/work/no.md', kind: { type: 'add' } }] } });
    expect(withHistoryArtifacts({ id: '1', clientId: '1', role: 'tool_use', content, createdAt: '2026-09-25T00:00:00Z' }).historyArtifacts).toBeUndefined();
  });
  it('keeps document delivery metadata and file suppression without edit bodies', () => {
    const delivery = { toolName: 'cindy_mcp_call_tool', input: { server: 'documents', tool: 'render_pdf', args: { outPath: '/work/report.pdf', htmlPath: '/work/source.html' } } };
    expect(outline('tool_use', delivery)).toEqual(delivery);
    const content = outline('tool_use', { toolName: 'Edit', input: { file_path: '/work/code.ts', old_string: 'heavy', new_string: 'heavy' } });
    const projected = withHistoryArtifacts({ id: '1', clientId: '1', role: 'tool_use', content, createdAt: '2026-09-25T00:00:00Z' });
    expect(projected.historyArtifacts).toMatchObject([{ path: '/work/code.ts', exclude: 'command' }]);
    expect(JSON.stringify(content)).not.toContain('heavy');
  });
});
