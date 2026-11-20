import { DatabaseSync } from 'node:sqlite';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { describe, expect, it, vi } from 'vitest';
import type { HistoryMessageSource } from '@cindy/maker-shared/message-window';
import { historyOutlineContent, historyOutlineContentStamp, withHistoryArtifacts } from '../historyViewOutline';

vi.mock('node:worker_threads', async (importOriginal) =>
  (await import('./fixtures/historyCommandWorker')).mockHistoryCommandWorker(await importOriginal<typeof import('node:worker_threads')>()));
vi.mock('@cindy/maker-shared/tool-use-descriptor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cindy/maker-shared/tool-use-descriptor')>();
  return {
    ...actual,
    describeToolUse(toolName: string, input: unknown) {
      const { command, displayCommand } = (input as { command?: string; displayCommand?: string } | null) ?? {};
      if (toolName === 'exec' && Math.max(command?.length ?? 0, displayCommand?.length ?? 0) > 256) {
        throw new Error('Long history command normalized on the caller thread');
      }
      return actual.describeToolUse(toolName, input);
    },
  };
});

async function project<T extends HistoryMessageSource>(row: T) {
  const [projected] = await withHistoryArtifacts([row]);
  return projected;
}

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

function stamp(content: string | null) {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE messages (content TEXT)');
    db.prepare('INSERT INTO messages VALUES (?)').run(content);
    const query = new SQLiteSyncDialect().sqlToQuery(historyOutlineContentStamp());
    return db.prepare(`SELECT ${query.sql} AS stamp FROM messages`).get(...query.params as string[])!.stamp as string | null;
  } finally { db.close(); }
}

function legacyStamp(content: string | null): string | null {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE messages (content TEXT)');
    db.prepare('INSERT INTO messages VALUES (?)').run(content);
    return db.prepare("SELECT length(content) || ':' || substr(content, -24) AS stamp FROM messages").get()!.stamp as string | null;
  } finally { db.close(); }
}

describe('SQLite history outline', () => {
  // 2026-10-25: repeated SDK bookkeeping exhausted the 8 MiB scan before
  // a long child-agent range could reach its header. This is an outline only;
  // grouping metadata and unknown fields must survive, full hydration is unchanged.
  it('excludes repeated SDK bookkeeping from outlined rows while retaining grouping metadata', async () => {
    const agentMeta = { parentUuid: 'agent', model: 'model', delivery: 'steer',
      turnCompleted: true, turnUsageDetails: { totalTokens: 12 }, unknown: 'keep',
      uuid: 'sdk-row', sdkSessionId: 'sdk-session', requestId: 'request',
      replyToClientId: 'reply', usage: { details: 'x'.repeat(20000) } };
    const source = { id: '1', clientId: '1', role: 'thinking', content: '', createdAt: '', agentMeta };
    const projected = await project(source);
    expect(projected.agentMeta).toEqual({ parentUuid: 'agent', model: 'model', delivery: 'steer',
      turnCompleted: true, turnUsageDetails: { totalTokens: 12 }, unknown: 'keep' });
    expect(source.agentMeta).toBe(agentMeta);
    expect(source.agentMeta.usage.details).toHaveLength(20000);
  });
  it('stamps a body with a short fact that changes when it is rewritten in place', () => {
    const summary = JSON.stringify('build summary');
    const full = JSON.stringify(`build summary\n${'full log line\n'.repeat(50000)}`);
    expect(stamp(summary)).not.toBe(stamp(full));
    expect(stamp(full)?.length).toBeLessThan(256);
    expect(stamp(JSON.stringify('结果：完成'))).toBe(stamp(JSON.stringify('结果：完成')));
  });
  // The byte-length prototype missed the first pair: its character count changes
  // while its UTF-8 byte count and suffix stay equal. Exercise the production SQL,
  // including SQLite's embedded-NUL behavior, rather than duplicating it in JS.
  it('does not weaken the character-based invalidation contract across UTF-8 and text boundaries', () => {
    const tail = 'q'.repeat(120);
    const pairs = [
      [`ab${tail}`, `é${tail}`],
      [`${tail}中文`, `${tail}中义`],
      [`${'😀'.repeat(23)}a`, `${'😀'.repeat(24)}`],
      [`${'😀'.repeat(24)}`, `${'😀'.repeat(23)}😁`],
      [`${'e\u0301'.repeat(30)}${tail}`, `${'e\u0301'.repeat(29)}e${tail}`],
      [JSON.stringify({ result: '完成😀', detail: `${tail}a` }), JSON.stringify({ result: '完成😀', detail: `${tail}b` })],
      [`plain text ${tail}a`, `plain text ${tail}b`],
    ];
    for (const [before, after] of pairs) {
      expect(legacyStamp(before)).not.toBe(legacyStamp(after));
      expect(stamp(before)).not.toBe(stamp(after));
    }
    // SQLite's text functions stop at NUL, so these retain the exact legacy path.
    for (const content of [null, '', `prefix\u0000${'😀'.repeat(30)}`]) {
      expect(stamp(content)).toBe(legacyStamp(content));
    }
  });
  it('does not return folded thinking, tool outputs or file bodies to the main thread', async () => {
    const body = 'private heavy body '.repeat(100000);
    expect(JSON.stringify(outline('thinking', { text: body, durationMs: 1000 })).length).toBeLessThan(100);
    expect(outline('thinking', { text: '', durationMs: 0 })).toEqual({ isRedacted: false, durationMs: 0 });
    expect(outline('tool_result', body)).toBe('');
    const content = outline('tool_use', { toolName: 'Write', input: { file_path: '/work/report.md', content: body } });
    expect(JSON.stringify(content)).not.toContain(body);
    const result = await project({ id: '1', clientId: '1', role: 'tool_use', content, createdAt: '2026-09-25T00:00:00Z' });
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
  it('retains command file candidates without sending command bodies in the summary', async () => {
    const content = outline('tool_use', { toolName: 'Bash', input: { command: 'echo done > /work/report.txt' } });
    const result = await project({ id: '1', clientId: '1', role: 'tool_use', content, createdAt: '2026-09-25T00:00:00Z' });
    expect(result.historyArtifacts).toMatchObject([{ path: '/work/report.txt', source: 'command' }]);
    expect(JSON.stringify(result.historyArtifacts)).not.toContain('echo');
  });
  it.each(['Bash', 'exec', 'exec displayCommand'])('bounds long %s outlines after off-thread normalization and path inference', async (variant) => {
    const display = `echo "${'x'.repeat(300000)}" > /work/trailing-report.txt`;
    const toolName = variant === 'Bash' ? 'Bash' : 'exec';
    const command = variant === 'exec' ? `/bin/bash -lc '${display}'`
      : variant === 'Bash' ? display : `echo '${'文'.repeat(300000)}' > /work/hidden-report.txt`;
    const content = outline('tool_use', { toolName, input: { command, ...(variant === 'exec displayCommand' && { displayCommand: display }) } });
    const result = await project({ id: '1', clientId: '1', role: 'tool_use', content, createdAt: '2026-09-25T00:00:00Z' });
    expect(JSON.stringify(result).length).toBeLessThan(1500);
    expect(result.historyArtifacts).toMatchObject([{ path: '/work/trailing-report.txt', source: 'command' }]);
    expect(content.input.command).toBe(command);
    if (variant === 'exec displayCommand') expect(content.input.displayCommand).toBe(display);
    const empty = outline('tool_use', { toolName, input: null });
    expect((await project({ id: '2', clientId: '2', role: 'tool_use', content: empty, createdAt: '' })).historyArtifacts).toBeUndefined();
  });
  it('retains structured failures and rejects malformed file changes', async () => {
    for (const result of [{ ok: false }, { success: false }, { status: 'FAILED' }]) {
      expect(outline('tool_result', JSON.stringify(result))).toBe('<tool_use_error>');
    }
    expect(outline('tool_result', JSON.stringify({ ok: true }))).toBe('');
    const content = outline('tool_use', { toolName: 'file_change', input: { changes: [{ path: '/work/no.md', kind: { type: 'add' } }] } });
    expect((await project({ id: '1', clientId: '1', role: 'tool_use', content, createdAt: '2026-09-25T00:00:00Z' })).historyArtifacts).toBeUndefined();
  });
  // The teammate chat lists the tasks a reply started from these receipts (2026-11-10); folded to ''
  // here they never reached the projection that keeps them visible.
  it('keeps a send_to_session receipt readable', () => {
    const receipt = JSON.stringify({ ok: true, target_session_id: 's-1', wake_kind: 'created', target_title: 'Fix it' });
    expect(outline('tool_result', receipt, null, true)).toEqual(JSON.parse(receipt));
    expect(outline('tool_result', `"target_session_id" "wake_kind" ${'x'.repeat(17_000)}`, null, true)).toBe('');
  });

  it('keeps document delivery metadata and file suppression without edit bodies', async () => {
    const delivery = { toolName: 'cindy_mcp_call_tool', input: { server: 'documents', tool: 'render_pdf', args: { outPath: '/work/report.pdf', htmlPath: '/work/source.html' } } };
    expect(outline('tool_use', delivery)).toEqual(delivery);
    const content = outline('tool_use', { toolName: 'Edit', input: { file_path: '/work/code.ts', old_string: 'heavy', new_string: 'heavy' } });
    const projected = await project({ id: '1', clientId: '1', role: 'tool_use', content, createdAt: '2026-09-25T00:00:00Z' });
    expect(projected.historyArtifacts).toMatchObject([{ path: '/work/code.ts', exclude: 'command' }]);
    expect(JSON.stringify(content)).not.toContain('heavy');
  });
});

describe('history artifact inference cache (#5503)', () => {
  it('keeps ordered batched artifacts distinct for equal-length rewrites and isolates cached paths', async () => {
    const row = (id: string, path: string) => ({ id, clientId: id, role: 'tool_use' as const,
      content: { toolName: 'Bash', input: { command: `echo '${'x'.repeat(300000)}' > ${path}` } }, createdAt: '' });
    const original = row('row-1', '/work/old.txt');
    const rewritten = row('row-1', '/work/new.txt');
    const [first, second, third] = await withHistoryArtifacts([original, row('row-2', '/work/next.txt'), rewritten]);
    expect([first, second, third].map((result) => result.historyArtifacts?.map(({ path }) => path))).toEqual([
      ['/work/old.txt'], ['/work/next.txt'], ['/work/new.txt'],
    ]);
    first.historyArtifacts!.length = 0;
    expect((await project(original)).historyArtifacts).toMatchObject([{ path: '/work/old.txt', source: 'command' }]);
  });
});
