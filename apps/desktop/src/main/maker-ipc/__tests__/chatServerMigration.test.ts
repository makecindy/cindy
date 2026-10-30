import { describe, expect, it, vi } from 'vitest';
import { migrateLocalGroups, type LocalChatUpgrade } from '../chatServerMigration.js';
import type { BotGroupMessageView, BotGroupSummary } from '../../../shared/botGroupChat.js';

const groupId = '10000000-0000-4000-8000-000000000001';
const roomId = '10000000-0000-4000-8000-000000000002';
function fixture() {
  let latest: string | null = null;
  let online = true;
  const committed = new Map<string, unknown>();
  const rows = Array.from({ length: 135 }, (_, i) => ({ id: `message-${i}`, sequence: i + 1,
    authorKind: i % 2 ? 'bot' : 'user', authorBotId: i % 2 ? 'old-bot' : null,
    authorName: i % 2 ? 'Old companion' : 'Owner', kind: 'message', content: `message ${i}`,
    createdAt: 1700000000000 + i, attachments: [], files: [], mentions: { all: false, botIds: [] }, noticeCode: null, planId: null,
  } as BotGroupMessageView));
  const deps: LocalChatUpgrade = {
    selfId: 'owner', current: () => online,
    groups: async () => [{ id: groupId, name: 'Old group', members: [{ botId: 'old-bot', name: 'Old companion' }], replyMode: 'all', speakingMode: 'auto' } as BotGroupSummary],
    messages: vi.fn(async (_id, after) => rows.filter(row => row.sequence > after).slice(0, 100)),
    bot: vi.fn(async () => 'server-bot'), attachments: vi.fn(async () => []),
    api: vi.fn(async (route, _method, payload: any) => {
      if (route === '/conversations') return { id: roomId };
      if (route.includes('/import?')) return { sourceId: latest };
      if (route.endsWith('/import')) for (const row of payload.messages) { committed.set(row.sourceId, row); latest = row.sourceId; }
      return {};
    }) as LocalChatUpgrade['api'],
  };
  return { deps, rows, committed, offline: () => { online = false; } };
}
describe('local groups upgrade', () => {
  it.each(['stored', 'projected'])('imports %s runtime notices as safe metadata rather than marker text', async shape => {
    const f = fixture(); f.rows.splice(1);
    Object.assign(f.rows[0], { kind: 'notice', authorKind: 'system', authorName: 'Bot', noticeCode: 'member-failed',
      content: shape === 'stored' ? 'cindy-runtime-error:AUTH_REQUIRED' : '',
      ...(shape === 'projected' ? { runtimeFailureCode: 'AUTH_REQUIRED' } : {}) });
    await migrateLocalGroups(f.deps);
    const row = [...f.committed.values()][0] as { content: Array<{ type: string; data?: Record<string, unknown> }> };
    expect(row.content.find(block => block.type === 'card')?.data).toMatchObject({ kind: 'notice', authorKind: 'system', runtimeFailureCode: 'AUTH_REQUIRED' });
    expect(row.content.some(block => block.type === 'text')).toBe(false);
    expect(JSON.stringify(row)).not.toContain('cindy-runtime-error:');
  });
  it('keeps marker-shaped user text as ordinary history', async () => {
    const f = fixture(); f.rows.splice(1); f.rows[0].content = 'cindy-runtime-error:AUTH_REQUIRED';
    await migrateLocalGroups(f.deps);
    expect(JSON.stringify([...f.committed.values()])).toContain('cindy-runtime-error:AUTH_REQUIRED');
  });
  it('imports every page in order with original authors/time, then resumes without reposting', async () => {
    const f = fixture();
    expect((await migrateLocalGroups(f.deps)).get(groupId)).toBe(roomId);
    expect(f.committed.size).toBe(135);
    const messages = [...f.committed.values()] as any[];
    expect(messages[0]).toMatchObject({ authorId: 'owner', createdAt: new Date(f.rows[0].createdAt).toISOString() });
    expect(messages[1].authorId).toBe('server-bot');
    expect(messages[134].content[0].text).toBe('message 134');
    vi.mocked(f.deps.api).mockClear();
    await migrateLocalGroups(f.deps);
    expect(vi.mocked(f.deps.api).mock.calls.filter(([route]) => route.endsWith('/import'))).toHaveLength(0);
    expect(vi.mocked(f.deps.messages).mock.calls.at(-1)?.[1]).toBe(135);
  });
  it('recovers after the server committed a batch but its response was lost', async () => {
    const f = fixture(), original = f.deps.api;
    let lost = false;
    f.deps.api = async <T>(...args: Parameters<LocalChatUpgrade['api']>) => {
      const result = await original<T>(...args);
      if (args[0].endsWith('/import') && !lost) { lost = true; throw new Error('ECONNRESET'); }
      return result;
    };
    await expect(migrateLocalGroups(f.deps)).rejects.toThrow('ECONNRESET');
    expect(f.committed.size).toBe(50);
    await migrateLocalGroups(f.deps);
    expect(f.committed.size).toBe(135);
    expect(vi.mocked(f.deps.messages).mock.calls.some(([, after]) => after === 50)).toBe(true);
  });
  it('does not reopen or manage a completed group after its owner has left or transferred it', async () => {
    const f = fixture();
    let receipt: { roomId: string; sequence: number } | null = null;
    f.deps.receipts = { read: () => receipt, save: (_id, value) => { receipt = value; } };
    await migrateLocalGroups(f.deps);
    expect(receipt).toEqual({ roomId, sequence: 135, version: 2 });
    f.deps.api = vi.fn(async () => { throw new Error('CONVERSATION_NOT_FOUND'); });
    expect((await migrateLocalGroups(f.deps)).get(groupId)).toBe(roomId);
    expect(f.deps.api).not.toHaveBeenCalled();
  });
  it('stops before sending a batch if the account switches while reading local messages', async () => {
    const f = fixture();
    f.deps.messages = async () => { f.offline(); return f.rows; };
    await expect(migrateLocalGroups(f.deps)).rejects.toThrow('OWNER_CHANGED');
    expect(f.committed.size).toBe(0);
  });
  it('keeps arrangement steps and hand-off names readable without uploading host paths', async () => {
    const f = fixture(); f.rows.splice(1);
    Object.assign(f.rows[0], { kind: 'plan', planId: 'old-plan', files: ['report.md'] });
    f.deps.plan = async () => ({ id: 'old-plan', status: 'done', organizerBotId: 'old-bot', organizerName: 'Old companion',
      currentStep: 0, workDir: '/private/owner/project', branch: null, createdAt: 1, updatedAt: 2,
      steps: [{ position: 0, botId: 'old-bot', botName: 'Old companion', task: 'Write the report', status: 'done' }] });
    await migrateLocalGroups(f.deps);
    const encoded = JSON.stringify([...f.committed.values()]);
    expect(encoded).toContain('Write the report');
    expect(encoded).toContain('report.md');
    expect(encoded).not.toContain('/private/owner/project');
    expect(encoded).toContain('"activity":true');
  });
  it('keeps long Unicode replies complete within the server message budget', async () => {
    const f = fixture();
    f.rows.splice(1);
    f.rows[0].content = '旧群里的完整回复🙂'.repeat(12000);
    await migrateLocalGroups(f.deps);
    const parts = [...f.committed.values()] as any[];
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map(row => row.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('')).join('')).toBe(f.rows[0].content);
    expect(parts.every(row => Buffer.byteLength(JSON.stringify(row.content)) <= 65536)).toBe(true);
    expect(parts.at(-1).sourceId).toMatch(/:done$/);
    vi.mocked(f.deps.api).mockClear();
    await migrateLocalGroups(f.deps);
    expect(vi.mocked(f.deps.api).mock.calls.filter(([route]) => route.endsWith('/import'))).toHaveLength(0);
  });
  it('keeps a failed group resumable while importing the next group', async () => {
    const f = fixture();
    const groups = await f.deps.groups();
    f.deps.groups = async () => [groups[0], { ...groups[0], id: '10000000-0000-4000-8000-000000000003' }];
    f.deps.attachments = vi.fn().mockRejectedValueOnce(new Error('MEDIA_UPLOAD_FAILED')).mockResolvedValue([]);
    f.deps.onError = vi.fn(); f.deps.onRoom = vi.fn();
    const result = await migrateLocalGroups(f.deps);
    expect(f.deps.onError).toHaveBeenCalledWith(groupId, expect.any(Error));
    expect(result.size).toBe(2);
    expect(f.committed.size).toBe(135);
    expect(f.deps.onRoom).toHaveBeenCalledWith(groupId, roomId);
  });
  it('keeps the source unmodified and does not finish when an attachment cannot be uploaded', async () => {
    const f = fixture(), source = JSON.stringify(f.rows);
    f.deps.attachments = async () => { throw new Error('MEDIA_STORAGE_UNAVAILABLE'); };
    await expect(migrateLocalGroups(f.deps)).rejects.toThrow('MEDIA_STORAGE_UNAVAILABLE');
    expect(f.committed.size).toBe(0);
    expect(JSON.stringify(f.rows)).toBe(source);
  });
});
