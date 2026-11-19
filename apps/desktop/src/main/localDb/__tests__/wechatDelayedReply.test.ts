import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WechatIlinkError, type WechatTransport } from '@cindy/wechat-ilink';
import type { DbClient } from '../client/DbClient';
import { setMainLocale } from '../../i18n.desktop';
import { encryptWechatContextToken } from '../../im/wechat/contextCrypto';
import { WechatIM } from '../../im/wechat/WechatIM';
import { deps, host, fakeDb, blockingLiveTransport } from '../../im/wechat/__tests__/wechatFixtures';

vi.mock('../../im/wechat/mediaStaging', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../im/wechat/mediaStaging')>(),
  removeReleasedWechatFiles: vi.fn(async () => undefined),
}));
beforeEach(() => setMainLocale('zh-CN'));
afterEach(() => setMainLocale('en'));

// #10135: db tier (existing localDb/** include), real SQLite/migration/store/worker
// and public outbox lifecycle. Unit host-boundary tests retain only fake DBs. The
// prior fake DB cases never exercised aged rows after context recovery. Transport
// and secrets are synthetic; the historical attempt count is seeded, not traffic.
it.each(['text', 'platform-time', 'platform-time-fallback', 'notice-unknown', 'media', 'media-missing', 'media-empty', 'media-too-large', 'media-mixed-missing', 'media-later-missing', 'media-removed-after-notice', 'body-failed', 'body-failed-same-context', 'chunks', 'same-context-refresh', 'localized-time', 'classical-time'] as const)('labels recovered old output and preserves fresh long-task results: %s', async mode => {
  vi.useFakeTimers();
  const localizedTime = mode === 'localized-time' || mode === 'classical-time';
  // Vitest worker threads cannot reliably change the process's timezone via TZ.
  // Simulate host timezone discovery while retaining real Intl date formatting.
  const timeZone = localizedTime ? 'America/Los_Angeles' : 'Asia/Shanghai';
  const DateTimeFormat = Intl.DateTimeFormat;
  const dateTimeFormatSpy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (locales, options) {
    return new DateTimeFormat(locales, { ...options, timeZone: options?.timeZone ?? timeZone });
  });
  if (mode === 'classical-time') setMainLocale('zh-Hans-x-lzh');
  const Database = (await import('better-sqlite3')).default;
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const { tx } = await import('../worker/opHandlers/tx');
  const { WechatTaskStore } = await import('../../im/wechat/taskStore');
  const sql = new Database(':memory:');
  sql.pragma('foreign_keys = ON');
  sql.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE media_blobs(hash TEXT PRIMARY KEY, ext TEXT, mime_type TEXT, bytes INTEGER, is_cache INTEGER, created_at INTEGER, last_access_at INTEGER);
    CREATE TABLE media_refs(id TEXT PRIMARY KEY, hash TEXT, ref_kind TEXT, ref_id TEXT, origin_session_id TEXT, origin_kind TEXT, origin_id TEXT, label TEXT, created_at INTEGER);
    INSERT INTO sessions(id) VALUES('old-session'),('fresh-session');`);
  sql.exec(readFileSync(path.resolve(process.cwd(), 'drizzle/0082_daffy_calypso.sql'), 'utf8').replaceAll('--> statement-breakpoint', ''));
  const files = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const isMedia = mode.startsWith('media');
  const invalidMedia = mode === 'media-missing' || mode === 'media-empty' || mode === 'media-too-large' || mode === 'media-mixed-missing' || mode === 'media-later-missing';
  const tempDir = isMedia ? await files.mkdtemp(path.join(tmpdir(), 'wechat-delayed-')) : null;
  const mediaPath = tempDir ? path.join(tempDir, 'example.txt') : null;
  if (mediaPath) await files.writeFile(mediaPath, 'synthetic file');
  const key = Buffer.alloc(32, 3);
  const oldAt = Date.parse(localizedTime ? '2026-11-07T01:14:00Z' : '2026-11-07T15:14:00Z');
  let now = oldAt + 4 * 24 * 60 * 60 * 1000;
  const db = fakeDb({
    query: vi.fn(async (q, params = []) => sql.prepare(q).all(...params)) as DbClient['query'],
    queryOne: vi.fn(async (q, params = []) => sql.prepare(q).get(...params)) as DbClient['queryOne'],
    exec: vi.fn(async (q, params = []) => sql.prepare(q).run(...params)) as DbClient['exec'],
    tx: vi.fn(async (name, args) => tx(sql, { name, args })) as DbClient['tx'],
  });
  const store = new WechatTaskStore(db, key);
  await store.activateBindingEpoch({ bindingEpoch: 'epoch', expectedActiveEpoch: null, now: oldAt });
  const seed = (id: string, created: number, attempts: number) => {
    const encrypted = encryptWechatContextToken(id + '-context', key, 'epoch', id);
    sql.prepare(`INSERT INTO wechat_inbox(id,binding_epoch,platform_message_id,platform_seq,peer_id,received_at,platform_created_at,expires_at,status,session_id,conversation_epoch,payload_json,context_nonce,context_ciphertext,context_tag)
      VALUES(?, 'epoch', ?,1,'owner',?,?,?,'delivery_pending',?,0,?,?,?,?)`).run(id,id,oldAt,oldAt,oldAt+1800000,id+'-session',JSON.stringify({ text: id+'-question' }),encrypted.nonce,encrypted.ciphertext,encrypted.tag);
    sql.prepare(`INSERT INTO wechat_outbox(id,binding_epoch,task_id,client_id,kind,chunk_index,text,media_json,status,attempts,next_retry_at,created_at)
      VALUES(?, 'epoch', ?, ?, 'final',0,?,'[]','pending',?,?,?)`).run(id+'-out',id,id+'-client',id+'-reply',attempts,now,created);
  };
  seed('old', oldAt, 9753);
  // The inbound task is four days old, but its result has only just completed.
  seed('fresh', now, 0);
  if (mode === 'platform-time') sql.prepare("UPDATE wechat_inbox SET received_at=?, platform_created_at=? WHERE id='old'").run(now, oldAt - 24 * 60 * 60 * 1000);
  if (mode === 'platform-time-fallback') sql.prepare("UPDATE wechat_inbox SET platform_created_at=0 WHERE id='old'").run();
  if (mode === 'chunks') {
    // commitFinal persists all chunks with one task, kind and creation time.
    for (let index = 1; index < 3; index += 1) {
      sql.prepare(`INSERT INTO wechat_outbox(id,binding_epoch,task_id,client_id,kind,chunk_index,text,media_json,status,attempts,next_retry_at,created_at)
        SELECT ?,binding_epoch,task_id,?,kind,?,?,'[]','pending',attempts,next_retry_at,created_at
        FROM wechat_outbox WHERE id='old-out'`).run(`old-out-${index}`, `old-client-${index}`, index, `old-reply-${index}`);
    }
  }
  if (mediaPath) sql.prepare("UPDATE wechat_outbox SET text=?, media_json=? WHERE task_id='old'").run(mode === 'media-mixed-missing' ? 'old-reply' : '', JSON.stringify([{ absPath: mediaPath, clientId: 'old-media-client' }]));
  const credentials = { bindingEpoch: 'epoch', botToken: 'synthetic-token', ilinkBotId: 'wechat-bot', userId: 'owner', baseUrl: 'https://example.invalid', boundAt: oldAt };
  const transport = blockingLiveTransport();
  const sends: Array<Parameters<WechatTransport['sendMessage']>[0]> = [];
  let noticeAckLost = mode === 'notice-unknown';
  const sameContextRefresh = mode === 'same-context-refresh';
  const bodyFailureCase = mode.startsWith('body-failed') || sameContextRefresh;
  let oldBodyBlocked = true;
  const receivedIds = new Set<string>();
  const visible: Array<Parameters<WechatTransport['sendMessage']>[0]> = [];
  const order: string[] = [];
  transport.uploadMedia = vi.fn<WechatTransport['uploadMedia']>(async () => {
    order.push('upload');
    return { ref: { kind: 'file' }, fileName: 'example.txt' };
  });
  transport.sendMedia = vi.fn(async input => { order.push('media'); return { clientId: input.clientId }; });
  transport.sendMessage = vi.fn(async input => {
    sends.push({ ...input });
    order.push('text');
    if (input.contextToken === 'new-question-context' && input.clientId !== 'old-client' && noticeAckLost) {
      noticeAckLost = false;
      receivedIds.add(input.clientId);
      visible.push({ ...input });
      throw new WechatIlinkError('NETWORK_ERROR', 'synthetic unknown notice result', true);
    }
    if (input.contextToken === 'old-context' && (!bodyFailureCase || (input.clientId === 'old-client' && oldBodyBlocked))) {
      throw new WechatIlinkError('PROTOCOL_ERROR', 'synthetic refusal', true);
    }
    if (!receivedIds.has(input.clientId)) {
      receivedIds.add(input.clientId);
      visible.push({ ...input });
    }
    if (mode === 'media-removed-after-notice' && input.contextToken === 'new-question-context') {
      // The bytes validated before the notice must be the bytes subsequently sent.
      await files.rm(mediaPath!);
    }
    return { clientId: input.clientId };
  });
  const createIM = () => new WechatIM(deps({ host: host({ secretRead: name => name === 'wechat_data_key_v1' ? key.toString('base64') : name === 'wechat_credentials_epoch' ? JSON.stringify(credentials) : null }),
    getDbClient: () => db, createTransport: () => transport, now: () => now }));
  let im = createIM();
  try {
    await im.init();
    await vi.waitFor(() => expect(sql.prepare("SELECT status FROM wechat_outbox WHERE task_id='fresh'").pluck().get()).toBe('delivered'), { timeout: 4000 });
    expect(sql.prepare("SELECT status,attempts FROM wechat_outbox WHERE task_id='old'").get()).toMatchObject({ status: 'pending', attempts: 9756 });
    expect(sends.filter(s => s.contextToken === 'fresh-context')).toEqual([expect.objectContaining({ text: 'fresh-reply', clientId: 'fresh-client' })]);
    const originalNotice = sends.find(s => s.contextToken === 'old-context');
    await im.dispose();
    im = createIM();
    await im.init();
    sends.length = 0;
    order.length = 0;
    if (sameContextRefresh) {
      // Retain the old task's accepted notice, excluding the separate fresh control.
      visible.splice(0, visible.length, ...visible.filter(item => item.contextToken === 'old-context'));
    } else visible.length = 0; // A new question starts a new visible timeline.
    now += bodyFailureCase && !sameContextRefresh ? 4 * 24 * 60 * 60 * 1000 : 2000;
    oldBodyBlocked = false;
    if (mode === 'media-missing' || mode === 'media-mixed-missing') await files.rm(mediaPath!);
    if (mode === 'media-later-missing') {
      sql.prepare("UPDATE wechat_outbox SET media_json=? WHERE id='old-out'").run(JSON.stringify([
        { absPath: mediaPath, clientId: 'old-media-client' },
        { absPath: path.join(tempDir!, 'missing.txt'), clientId: 'missing-media-client' },
      ]));
    }
    if (mode === 'media-empty') await files.writeFile(mediaPath!, '');
    if (mode === 'media-too-large') await files.truncate(mediaPath!, 5 * 1024 * 1024 + 1);
    if (mode !== 'body-failed-same-context') {
      await store.refreshPendingOutboxContext({ bindingEpoch: 'epoch', peerId: 'owner', contextToken: sameContextRefresh ? 'old-context' : 'new-question-context', now });
    }
    await vi.waitFor(() => expect(['delivered', 'failed_terminal']).toContain(sql.prepare("SELECT status FROM wechat_outbox WHERE task_id='old'").pluck().get()), { timeout: 4000 });
    expect(sql.prepare("SELECT status FROM wechat_outbox WHERE task_id='old'").pluck().get()).toBe(invalidMedia ? 'failed_terminal' : 'delivered');
    if (invalidMedia) {
      if (mode === 'media-mixed-missing') {
        expect(sends.map(item => item.text)).toEqual([expect.stringContaining('old-question'), 'old-reply']);
        expect(sends[1]?.clientId).toBe('old-client');
      } else if (mode === 'media-later-missing') {
        expect(sends.map(item => item.text)).toEqual([expect.stringContaining('old-question')]);
        expect(order).toEqual(['text', 'upload', 'media']);
        expect(transport.sendMedia).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'old-media-client' }), expect.any(AbortSignal));
      } else {
        expect(sends).toEqual([]); // No attribution for content that cannot be delivered.
        expect(visible).toEqual([]);
      }
      if (mode !== 'media-later-missing') {
        expect(transport.uploadMedia).not.toHaveBeenCalled();
        expect(transport.sendMedia).not.toHaveBeenCalled();
      }
      expect(sql.prepare("SELECT attempts,text FROM wechat_outbox WHERE id='old-out'").get()).toEqual({ attempts: 9757, text: mode === 'media-mixed-missing' ? 'old-reply' : '' });
      return;
    }
    if (mode === 'chunks') {
      await vi.waitFor(() => expect(sql.prepare("SELECT count(*) FROM wechat_outbox WHERE task_id='old' AND status='delivered'").pluck().get()).toBe(3));
      expect(visible.map(item => item.text)).toEqual([expect.stringContaining('old-question'), 'old-reply', 'old-reply-1', 'old-reply-2']);
      expect(sends).toHaveLength(4); // One notice request, then the three original chunks.
      expect(sends.slice(1).map(item => item.clientId)).toEqual(['old-client', 'old-client-1', 'old-client-2']);
    }
    // Original payload/client IDs remain unchanged. Notice retries are stable
    // within one context and delivery window, including unknown send results.
    expect(sends).toHaveLength(mode === 'notice-unknown' ? 3 : isMedia ? 1 : mode === 'chunks' ? 4 : 2);
    if (sameContextRefresh) expect(visible).toHaveLength(2); // Same token must not renew the accepted notice.
    expect(sends[0]?.text).toContain(localizedTime ? '2026/11/06' : '2026/11/07');
    expect(sends[0]?.text).toContain(localizedTime ? '17:14:00' : '23:14:00');
    expect(sends[0]?.text).toContain(localizedTime ? 'GMT-8' : 'GMT+8');
    if (mode === 'platform-time') {
      expect(sends[0]?.text).toContain('2026/11/06'); // Platform send time, before delayed poll ingestion.
      expect(sends[0]?.text).not.toContain('2026/11/11');
    }
    expect(sends[0]?.text).toContain('old-question');
    expect(sends[0]?.text).toContain(mode === 'classical-time' ? '迟至' : '延迟');
    expect(sends[0]?.clientId).not.toBe('old-client');
    expect(sends[0]?.text).toBe(originalNotice?.text);
    if (bodyFailureCase) {
      expect(visible).toHaveLength(2);
      expect(visible[0]?.text).toContain('old-question');
      expect(visible[0]?.text).toContain('2026/11/07');
      expect(visible[0]?.text).toContain('23:14:00');
      expect(visible[1]?.text).toBe('old-reply');
    }
    if (isMedia) {
      expect(order).toEqual(['text', 'upload', 'media']);
      expect(transport.sendMedia).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'old-media-client', contextToken: 'new-question-context' }), expect.any(AbortSignal));
    } else {
      expect(sends.find(item => item.clientId === 'old-client')).toMatchObject({ text: 'old-reply', contextToken: mode === 'body-failed-same-context' || sameContextRefresh ? 'old-context' : 'new-question-context', clientId: 'old-client' });
      if (mode === 'notice-unknown') expect(sends[0]).toEqual(sends[1]);
    }
    expect(sql.prepare("SELECT attempts,text FROM wechat_outbox WHERE id='old-out'").get()).toEqual({ attempts: mode === 'notice-unknown' ? 9758 : 9757, text: isMedia ? '' : 'old-reply' });
  } finally {
    await im.dispose();
    store.destroy();
    sql.close();
    if (tempDir) await files.rm(tempDir, { recursive: true, force: true });
    dateTimeFormatSpy.mockRestore();
    vi.useRealTimers();
  }
});
