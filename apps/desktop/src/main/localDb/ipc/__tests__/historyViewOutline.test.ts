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
  it('folds plain-text tool output while keeping artifact candidates and failures', () => {
    const body = 'Checking original UI image catalogs: 55\n'.repeat(50000);
    expect(outline('tool_result', body, null, true)).toBe('');
    expect(outline('tool_result', `<tool_use_error>${body}`, null, true)).toBe('<tool_use_error>');
    expect(outline('tool_result', 'saved cindy-media://blobs/a.png', null, true)).toBe('saved cindy-media://blobs/a.png');
    expect(outline('tool_result', 'xdt-file:///work/report.pdf', null, true)).toBe('xdt-file:///work/report.pdf');
    // Incidental mentions in long output must not keep the whole body.
    expect(outline('tool_result', `const xdt_helper = 1;\n${body}`, null, true)).toBe('');
    expect(outline('tool_result', `${body}see xdt-file:///work/report.pdf`, null, true)).toBe('');
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

describe('history artifact inference cache (#5503)', () => {
  it('infers command artifacts once per immutable row and keys on command text', async () => {
    const { commandArtifactCacheSize, resetCommandArtifactCache } = await import('../historyViewOutline');
    resetCommandArtifactCache();
    const command = `echo '${'x'.repeat(200000)}' > /work/cached-report.txt`;
    const content = outline('tool_use', { toolName: 'Bash', input: { command } });
    const row = { id: 'row-1', clientId: '1', role: 'tool_use' as const, content, createdAt: '2026-09-25T00:00:00Z' };
    const first = withHistoryArtifacts(row);
    expect(first.historyArtifacts).toMatchObject([{ path: '/work/cached-report.txt', source: 'command' }]);
    expect(commandArtifactCacheSize()).toBe(1);
    const started = performance.now();
    for (let index = 0; index < 50; index += 1) withHistoryArtifacts(row);
    expect(performance.now() - started).toBeLessThan(500);
    expect(commandArtifactCacheSize()).toBe(1);
    // Same id with different text is a different entry, never a stale hit.
    const changed = outline('tool_use', { toolName: 'Bash', input: { command: 'echo ok > /work/other.txt' } });
    expect(withHistoryArtifacts({ ...row, content: changed }).historyArtifacts).toMatchObject([{ path: '/work/other.txt' }]);
    expect(commandArtifactCacheSize()).toBe(2);
    // Returned arrays are copies: callers mutating artifacts cannot poison the cache.
    const again = withHistoryArtifacts(row);
    again.historyArtifacts!.length = 0;
    expect(withHistoryArtifacts(row).historyArtifacts).toHaveLength(1);
    resetCommandArtifactCache();
  });
});
