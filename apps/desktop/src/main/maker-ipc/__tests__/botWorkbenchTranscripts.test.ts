import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({
    drizzle: { select: () => ({ from: () => ({ where: async () => inCindyRows }) }) },
  }),
}));
vi.mock('../../maker-host/claude-local-sessions.js', () => ({
  parseClaudeCodeMessageLine: vi.fn((line: string) => {
    const row = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
    if ((row.type !== 'user' && row.type !== 'assistant') || typeof row.message?.content !== 'string') return [];
    return [{ role: row.type, content: row.message.content, createdAt: 0 }];
  }),
}));
vi.mock('../../maker-host/codex-local-sessions.js', () => ({
  parseCodexRolloutMessageLine: vi.fn((line: string) => {
    const row = JSON.parse(line) as { type?: string; payload?: { role?: string; text?: string } };
    return row.type === 'msg' && row.payload?.text ? { role: row.payload.role, text: row.payload.text, createdAt: 0 } : null;
  }),
}));

let inCindyRows: Array<{ sdkSessionId: string; agentKind: string }> = [];

import {
  boundTranscript,
  claudeStorageNames,
  findCwdInHead,
  listExternalSessionsForProjects,
  parsePiTranscriptLine,
  readHeadTailLines,
  recentCodexDayDirs,
} from '../botWorkbenchTranscripts.js';

let root: string | null = null;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

describe('boundTranscript', () => {
  it('strips instruction blocks, drops empty messages and keeps the most recent within the budget', () => {
    const items = [
      { role: 'user' as const, text: 'old '.repeat(400), at: 1 },
      { role: 'assistant' as const, text: '<system-reminder>internal</system-reminder>', at: 2 },
      { role: 'user' as const, text: '把图标导出来', at: 3 },
      { role: 'assistant' as const, text: '导好了 mdpi,还差 xxhdpi', at: 4 },
    ];
    const bounded = boundTranscript(items, 200);
    expect(bounded.items.map((item) => item.at)).toEqual([1, 3, 4]);
    expect(bounded.items[0].text.startsWith('…')).toBe(true);
    expect(bounded.items.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(200);
    expect(bounded.truncated).toBe(true);
    expect(boundTranscript(items.slice(2)).truncated).toBe(false);
  });
});

describe('readHeadTailLines', () => {
  it('reads a small file once and only the head and tail of a large one', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'wb-ht-'));
    const small = path.join(root, 's.jsonl');
    await writeFile(small, ['a', 'b', 'c', ''].join('\n'), 'utf8');
    expect(await readHeadTailLines(small, 64)).toMatchObject({ head: ['a', 'b', 'c'], tail: ['a', 'b', 'c'], whole: true });
    const big = path.join(root, 'b.jsonl');
    const lines = Array.from({ length: 200 }, (_, index) => `line-${String(index).padStart(3, '0')}`);
    await writeFile(big, `${lines.join('\n')}\n`, 'utf8');
    const parts = await readHeadTailLines(big, 64);
    expect(parts.whole).toBe(false);
    expect(parts.head[0]).toBe('line-000');
    expect(parts.tail.at(-1)).toBe('line-199');
    // 被截断的半行丢掉:每段都只剩完整行,远少于全文。
    for (const line of [...parts.head, ...parts.tail]) expect(line).toMatch(/^line-\d{3}$/);
    expect(parts.head.length + parts.tail.length).toBeLessThan(20);
  });
});

describe('transcript helpers', () => {
  it('parses Pi message lines and skips anything uncertain', () => {
    expect(parsePiTranscriptLine(JSON.stringify({
      type: 'message',
      timestamp: '2026-10-01T00:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: '修图标' }, { type: 'image', data: 'x' }] },
    }))).toEqual({ role: 'user', text: '修图标', at: Date.parse('2026-10-01T00:00:00.000Z') });
    expect(parsePiTranscriptLine(JSON.stringify({ type: 'session', id: 'p1', cwd: '/w' }))).toBeNull();
    expect(parsePiTranscriptLine(JSON.stringify({ type: 'message', message: { role: 'toolResult', content: 'x' } }))).toBeNull();
    expect(parsePiTranscriptLine('{not json')).toBeNull();
  });

  it('finds cwd in a truncated head', () => {
    expect(findCwdInHead('{"type":"session_meta","payload":{"id":"x","cwd":"/Users/me/Code/app","instructions":"lo')).toBe('/Users/me/Code/app');
    expect(findCwdInHead('{"cwd":"C:\\\\Code\\\\app"}')).toBe('C:\\Code\\app');
    expect(findCwdInHead('{"type":"x"}')).toBeNull();
  });

  it('derives Claude storage names and recent Codex day folders', () => {
    expect(claudeStorageNames('/Users/me/Code/my.app')).toEqual(['-Users-me-Code-my.app', '-Users-me-Code-my-app']);
    expect(claudeStorageNames('C:\\Users\\me\\app')).toEqual(['C--Users-me-app']);
    const days = recentCodexDayDirs('/c/sessions', new Date(2026, 9, 1, 12).getTime(), 2);
    expect(days).toEqual([
      path.join('/c/sessions', '2026', '10', '01'),
      path.join('/c/sessions', '2026', '09', '30'),
      path.join('/c/sessions', '2026', '09', '29'),
    ]);
  });
});

describe('listExternalSessionsForProjects', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it('finds recent sessions of all three sources inside the project, with bounded digests, counting older ones', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'wb-ext-'));
    const project = path.join(root, 'Code', 'app');
    const now = Date.now();
    const claudeRoot = path.join(root, 'claude');
    const codexRoot = path.join(root, 'codex', 'sessions');
    const piRoot = path.join(root, 'pi');
    const claudeFolder = path.join(claudeRoot, claudeStorageNames(project)[0]!);
    await mkdir(claudeFolder, { recursive: true });
    const claudeLine = (type: string, content: string) => JSON.stringify({ type, cwd: project, message: { content } });
    await writeFile(path.join(claudeFolder, 'c-new.jsonl'), [
      claudeLine('user', '把图标导出来'),
      ...Array.from({ length: 50 }, (_, index) => claudeLine('assistant', `step ${index} ${'x'.repeat(4000)}`)),
      claudeLine('assistant', '还差 xxhdpi'),
    ].join('\n'));
    await writeFile(path.join(claudeFolder, 'c-old.jsonl'), claudeLine('user', '很久以前'));
    await utimes(path.join(claudeFolder, 'c-old.jsonl'), new Date(now - 40 * DAY), new Date(now - 40 * DAY));
    await writeFile(path.join(claudeFolder, 'c-imported.jsonl'), claudeLine('user', '已在 Cindy 里'));

    const today = recentCodexDayDirs(codexRoot, now, 0)[0]!;
    await mkdir(today, { recursive: true });
    const uuid = '01a0f587-e669-7900-a224-363dcb19f570';
    const other = '01a0f587-e669-7900-a224-363dcb19f571';
    const meta = (cwd: string) => JSON.stringify({ type: 'session_meta', payload: { id: 'x', cwd, instructions: 'i'.repeat(200_000) } });
    await writeFile(path.join(today, `rollout-2026-10-01T11-35-19-${uuid}.jsonl`), [
      meta(path.join(project, '.cindy-worktrees', 'fix')),
      JSON.stringify({ type: 'msg', payload: { role: 'user', text: '修 CI' } }),
    ].join('\n'));
    await writeFile(path.join(today, `rollout-2026-10-01T11-35-19-${other}.jsonl`), meta(path.join(root, 'elsewhere')));

    // 多账号登录的 Codex home:codex-accounts/<账号>/<供应商>/sessions/YYYY/MM/DD。
    const accountsRoot = path.join(root, 'codex-accounts', 'a'.repeat(64));
    const accountDay = recentCodexDayDirs(path.join(accountsRoot, 'openai-1', 'sessions'), now, 0)[0]!;
    await mkdir(accountDay, { recursive: true });
    const accountId = '01a0f587-e669-7900-a224-363dcb19f572';
    await writeFile(path.join(accountDay, `rollout-2026-10-01T11-35-19-${accountId}.jsonl`), [
      meta(project),
      JSON.stringify({ type: 'msg', payload: { role: 'user', text: '账号会话' } }),
    ].join('\n'));

    await mkdir(piRoot, { recursive: true });
    await writeFile(path.join(piRoot, '2026-10-01T00-00-00_p1.jsonl'), [
      JSON.stringify({ type: 'session', id: 'p1', cwd: project }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: '写文档' }] } }),
    ].join('\n'));

    inCindyRows = [{ sdkSessionId: 'c-imported', agentKind: 'cc' }];
    const result = await listExternalSessionsForProjects({
      roots: { claude: [claudeRoot], codex: [codexRoot, path.join(root, 'missing')], codexAccounts: [accountsRoot], pi: [piRoot] },
      projectDirs: [project],
      caseInsensitive: false,
      since: now - 30 * DAY,
      now,
    });
    const byKey = new Map(result.sessions.map((item) => [`${item.source}:${item.id}`, item]));
    expect([...byKey.keys()].sort()).toEqual(['claude:c-new', `codex:${uuid}`, `codex:${accountId}`, 'pi:p1']);
    expect(byKey.get(`codex:${accountId}`)!.digest).toMatchObject({ purpose: '账号会话' });
    expect(result.olderCount).toBe(1);
    expect(result.overflowCount).toBe(0);
    expect(byKey.get('claude:c-new')!.digest).toMatchObject({ purpose: '把图标导出来' });
    expect(byKey.get('claude:c-new')!.digest!.recent.at(-1)).toEqual({ role: 'assistant', text: '还差 xxhdpi' });
    expect(byKey.get(`codex:${uuid}`)!.digest).toMatchObject({ purpose: '修 CI' });
    expect(byKey.get('pi:p1')).toMatchObject({ title: '写文档', cwd: project });

    const capped = await listExternalSessionsForProjects({
      roots: { claude: [claudeRoot], codex: [codexRoot], codexAccounts: [accountsRoot], pi: [piRoot] },
      projectDirs: [project],
      caseInsensitive: false,
      since: now - 30 * DAY,
      now,
      max: 1,
    });
    expect(capped.sessions).toHaveLength(1);
    expect(capped.overflowCount).toBe(3);
    inCindyRows = [];
  });
});
