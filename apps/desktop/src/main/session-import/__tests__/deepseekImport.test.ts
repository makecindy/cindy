/**
 * 测试价值：#8958 的 v4 inbox 记录必须能扫描、读取，并进入真实 writer / handoff。
 * 既有 foreignSourceAdapters 仅覆盖 user/message；这里用独立的内存 DbClient 端口隔离
 * 写入消费者，避免影响该文件中其它来源的真实 SQLite fixture。最小输入为报告的
 * zstd v4 session + agent/inbox/spliced；unit tier，无外网或真实用户目录。
 * 各用例分别保护导入消费、重复身份、来源过滤和分叉/子 Agent；实测耗时见 PR。
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deepseekAdapter, parseDeepSeekEvent } from '../sources/deepseek';
import { createMessageSink } from '../writer';
import { buildImportHandoffMarker } from '../handoff';
import type { NormalizedMessage } from '../types';

const h = vi.hoisted(() => ({ rows: [] as Array<{ key: string; role: string; content: string; createdAt: number }> }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({
  tx: async (_name: string, args: { rows: typeof h.rows }) => { h.rows.push(...args.rows); },
  query: async (sql: string, params: unknown[]) => {
    const rows = h.rows.map((r, i) => ({ ...r, rowid: i + 1, toolUseId: null, agentMeta: null }));
    return sql.includes('created_at < ?')
      ? rows.filter((r) => r.role === 'user' && r.createdAt < Number(params[1]))
      : rows.reverse();
  },
}) }));
vi.mock('../../cindy-media/chatAttachments.js', () => ({ commitMessageMediaRefs: async () => {} }));
vi.mock('../../cindy-media/ingest.js', () => ({ ingestMedia: vi.fn() }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ debug: vi.fn() }) }));

let home: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'cindy-deepseek-import-'));
  vi.stubEnv('DSH_HOME', path.join(home, '.dsh'));
  h.rows.length = 0;
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); });

function user(id: string, text: string) {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } };
}
async function fixture(events: unknown[], extra: Record<string, unknown> = {}, id = 'session-v4') {
  const dir = path.join(home, '.dsh', 'sessions', encodeURIComponent(path.join(home, 'project')), id);
  await mkdir(dir, { recursive: true });
  const lines = [{ type: 'session', version: 4, id, createdAt: 1000, cwd: path.join(home, 'project'), ...extra }, ...events];
  await writeFile(path.join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(lines.map((e) => JSON.stringify(e)).join('\n') + '\n')));
}
async function readFirst() {
  const listed = await deepseekAdapter.list({ homeDir: home, cindyUserDataDir: null });
  expect(listed.unreadableCount).toBe(0);
  expect(listed.sessions).toHaveLength(1);
  const messages: NormalizedMessage[] = [];
  for await (const m of deepseekAdapter.read(listed.sessions[0]!, { cindySessionId: 'import-test' })) messages.push(m);
  return { listed, messages };
}

describe('DeepSeek v4 import', () => {
  it('scans reported compressed inbox history and passes user text to the writer and engine handoff', async () => {
    await fixture([
      { type: 'system/message', data: { message: user('system', 'policy changed') } },
      { type: 'agent/inbox/spliced', data: { inserted: [{ ...user('notice', 'injected context'), source: { kind: 'system-prompt' } }] } },
      { type: 'agent/inbox/spliced', seq: 2, time: 1100, data: { inserted: [user('u1', 'fix the login bug')] } },
      { type: 'assistant/message', seq: 3, time: 1200, data: { message: { content: [{ type: 'text', text: 'checking login' }] } } },
    ]);
    const { listed, messages } = await readFirst();
    expect(listed.sessions[0]).toMatchObject({ source: 'deepseek', title: 'fix the login bug', cwd: path.join(home, 'project') });
    expect(messages.map((m) => [m.role, m.content])).toEqual([['user', 'fix the login bug'], ['assistant', 'checking login']]);
    const sink = createMessageSink({ sessionId: 'import-test', agentKind: null });
    for (const m of messages) await sink.push(m);
    await sink.flush();
    expect(h.rows.map((r) => [r.role, JSON.parse(r.content)])).toEqual([['user', 'fix the login bug'], ['assistant', 'checking login']]);
    const marker = await buildImportHandoffMarker({ sessionId: 'import-test', fromLabel: 'DeepSeek Harness', toHarness: 'codex' });
    const content = JSON.parse(marker.content);
    expect(content).toMatchObject({ consumed: false, reason: 'session-import' });
    expect(content.handoff).toContain('fix the login bug');
    expect(content.handoff).toContain('checking login');
    expect(content.handoff.split('fix the login bug')).toHaveLength(2);
    expect(content.handoff).not.toContain('injected context');
  });

  it('imports each identified prompt once across inbox and user/message, retaining distinct identical prompts', async () => {
    const first = user('u1', 'repeat');
    await fixture([
      { type: 'agent/inbox/spliced', seq: 1, data: { inserted: [first, user('u2', 'repeat')] } },
      { type: 'user/message', seq: 2, data: first },
      { type: 'user/message', seq: 3, data: { content: 'legacy without identity' } },
    ]);
    const { messages } = await readFirst();
    expect(messages.map((m) => m.content)).toEqual(['repeat', 'repeat', 'legacy without identity']);
    expect(new Set(messages.map((m) => m.key)).size).toBe(3);
  });

  it('uses claimed prompt content and order, excluding canceled queue entries from titles and history', async () => {
    await fixture([
      { type: 'agent/inbox/spliced', seq: 1, data: { target: 'next-turn', start: 0, inserted: [user('cancel', 'canceled prompt'), user('u1', 'draft prompt')] } },
      { type: 'agent/inbox/spliced', seq: 2, data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' } },
      { type: 'assistant/message', seq: 3, data: { content: 'previous answer' } },
      { type: 'user/message', seq: 4, data: user('u1', 'final prompt') },
    ]);
    const { listed, messages } = await readFirst();
    expect(listed.sessions[0]!.title).toBe('final prompt');
    expect(messages.map((m) => [m.role, m.content])).toEqual([['assistant', 'previous answer'], ['user', 'final prompt']]);
  });

  it('rejects malformed inbox payloads and non-user producers while retaining literal user text and legacy images', () => {
    for (const inserted of [null, {}, [null, 'text', { role: 'assistant', content: 'wrong role' }, { ...user('x', 'notice'), source: { kind: 'cron' } }]]) {
      expect(parseDeepSeekEvent({ type: 'agent/inbox/spliced', data: { inserted } }, 0, new Set())).toEqual([]);
    }
    const messages = parseDeepSeekEvent({ type: 'agent/inbox/spliced', data: { inserted: [
      user('literal', '<system-reminder>my question</system-reminder>'),
      { role: 'user', content: [{ type: 'image', attachment: { mimeType: 'image/png', path: '/unused/synthetic.png' } }] },
    ] } }, 1, new Set());
    expect(messages).toHaveLength(2);
    expect(messages[0]!.content).toBe('<system-reminder>my question</system-reminder>');
    expect(messages[1]!.images).toEqual([{ mimeType: 'image/png', filePath: '/unused/synthetic.png' }]);
  });

  it('resolves v1 image references under the scanned DSH home without using display names as paths', async () => {
    const digest = 'a'.repeat(64);
    await fixture([{ type: 'agent/inbox/spliced', data: { inserted: [{
      ...user('image', 'inspect image'), content: [
        { type: 'image', attachment: { attachmentId: `sha256:${digest}`, mediaType: 'image/png', name: '../../escape.png' } },
        { type: 'text', text: 'inspect image' },
        { type: 'image', attachment: { attachmentId: 'sha256:../../escape', mediaType: 'image/png' } },
      ],
    }] } }]);
    const { messages } = await readFirst();
    expect(messages[0]!.images).toEqual([{ mimeType: 'image/png', filePath: path.join(home, '.dsh', 'attachments', 'v1', 'objects', 'aa', digest) }]);
    // Only path projection is exercised: no media bytes are created or archived.
  });

  it('skips inherited inbox history and excludes subagents while preserving an explicit title', async () => {
    await fixture([
      { type: 'agent/inbox/spliced', seq: 1, data: { inserted: [user('parent', 'inherited')] } },
      { type: 'session/end-seed', seq: 2 },
      { type: 'agent/inbox/spliced', seq: 3, data: { inserted: [user('child', 'new question')] } },
      { type: 'session/title', data: { title: 'Explicit title' } },
    ], { isSeeded: true });
    await fixture([], { origin: 'subagent' }, 'session-child');
    const { listed, messages } = await readFirst();
    expect(listed.internalCount).toBe(1);
    expect(listed.sessions[0]!.title).toBe('Explicit title');
    expect(messages.map((m) => m.content)).toEqual(['new question']);
  });
});
