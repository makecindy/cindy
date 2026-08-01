/**
 * interrupted-turn-resume(简化版)单测。
 * 覆盖:started/ended 时间戳写入与保序、quit freeze、「疑似中断」pending 判定
 * (ended / cleared 边界、deleted / 不可见来源排除)、ended 落库后的注入回调通知
 * (广播假阳性修复:生效值读回 / 异常不断链 / ack resolve 前发出),以及 retry
 * 续跑判定 hasAssistantProgressAfterMessage 的正负路径。
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DbClient } from '../client/DbClient.js';
import { clearCurrentDbClient, setCurrentDbClient } from '../client/current.js';
import * as schema from '../schema.js';

describe('sessionActiveTurn', () => {
  let currentClient: DbClient | null = null;
  let rawDb: Database.Database | null = null;

  afterEach(async () => {
    const { _resetSessionActiveTurnStateForTests } = await import('../sessionActiveTurn.js');
    _resetSessionActiveTurnStateForTests();
    vi.restoreAllMocks();
    if (currentClient) {
      clearCurrentDbClient(currentClient);
      currentClient = null;
    }
    rawDb?.close();
    rawDb = null;
  });

  function createTestDbClient(): DbClient {
    const dbHandle = new Database(':memory:');
    rawDb = dbHandle;
    dbHandle.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT 'New Maker',
        status TEXT NOT NULL DEFAULT 'active',
        source TEXT NOT NULL DEFAULT 'desktop',
        cleared_at INTEGER,
        active_turn_started_at INTEGER,
        active_turn_pid INTEGER,
        last_turn_ended_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_use_id TEXT,
        agent_meta TEXT,
        created_at INTEGER NOT NULL,
        rewind_at INTEGER
      );
    `);
    const db = drizzle(dbHandle, { schema });
    const client: DbClient = {
      query: async <T = unknown>(sql: string, params: unknown[] = []) =>
        dbHandle.prepare(sql).all(...params) as T[],
      queryOne: async <T = unknown>(sql: string, params: unknown[] = []) =>
        dbHandle.prepare(sql).get(...params) as T | undefined,
      exec: async (sql, params = []) => dbHandle.prepare(sql).run(...params),
      tx: async () => {
        throw new Error('tx is not used by this test');
      },
      drizzle: db,
      vecAvailable: false,
      dispose: async () => {},
    };
    currentClient = client;
    setCurrentDbClient(client, 'test-user');
    return client;
  }

  async function seedSession(
    client: DbClient,
    id: string,
    patch: {
      status?: string;
      startedAt?: number | null;
      endedAt?: number | null;
      clearedAt?: number | null;
      source?: string;
    } = {},
  ): Promise<void> {
    const now = Date.now();
    await client.exec(
      'INSERT INTO sessions (id, title, status, source, active_turn_started_at, last_turn_ended_at, cleared_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        id,
        id,
        patch.status ?? 'active',
        patch.source ?? 'desktop',
        patch.startedAt ?? null,
        patch.endedAt ?? null,
        patch.clearedAt ?? null,
        now,
        now,
      ],
    );
  }

  async function readMarks(client: DbClient, id: string) {
    return client.queryOne<{ active_turn_started_at: number | null; last_turn_ended_at: number | null }>(
      'SELECT active_turn_started_at, last_turn_ended_at FROM sessions WHERE id = ?',
      [id],
    );
  }

  it('markSessionTurnStarted / markSessionTurnEnded write the two timestamps', async () => {
    const { markSessionTurnStarted, markSessionTurnEnded } = await import('../sessionActiveTurn.js');
    const client = createTestDbClient();
    await seedSession(client, 's-1');

    markSessionTurnStarted('s-1');
    await vi.waitFor(async () => {
      expect((await readMarks(client, 's-1'))?.active_turn_started_at).toBeTypeOf('number');
    });

    markSessionTurnEnded('s-1');
    await vi.waitFor(async () => {
      const row = await readMarks(client, 's-1');
      expect(row?.last_turn_ended_at).toBeTypeOf('number');
      expect(row!.last_turn_ended_at!).toBeGreaterThanOrEqual(row!.active_turn_started_at!);
    });
  });

  it('per-session write chain keeps started/ended landing order for very short turns', async () => {
    const { markSessionTurnStarted, markSessionTurnEnded } = await import('../sessionActiveTurn.js');
    const client = createTestDbClient();
    await seedSession(client, 's-short');

    // 极短 turn:两个 fire-and-forget 写连续入队。链保证 started 先落、ended
    // 后落 —— 否则可能留下 startedAt > endedAt 的假中断。
    markSessionTurnStarted('s-short');
    markSessionTurnEnded('s-short');
    await vi.waitFor(async () => {
      const row = await readMarks(client, 's-short');
      expect(row?.active_turn_started_at).toBeTypeOf('number');
      expect(row?.last_turn_ended_at).toBeTypeOf('number');
    });
    const row = await readMarks(client, 's-short');
    // ended >= started → 疑似中断判定不命中。
    expect(row!.last_turn_ended_at!).toBeGreaterThanOrEqual(row!.active_turn_started_at!);
  });

  it('markSessionTurnEnded honors endedAtOverride so deferred writes keep the frozen timestamp', async () => {
    const { markSessionTurnStarted, markSessionTurnEnded } = await import('../sessionActiveTurn.js');
    const client = createTestDbClient();
    await seedSession(client, 's-deferred');

    // 模拟 register.ts 的延后打标:turn A 逻辑收尾时定格 endedAt,写入被推迟
    // (等 error 行 durable),期间用户已启动新 turn B。ended 必须落定格值,
    // 不能落"写入时刻",否则 B 会被伪装成已结束、B 再被中断时无提示。
    const frozenEndedAt = Date.now() - 60_000;
    markSessionTurnStarted('s-deferred'); // turn B started = now,晚于定格值
    markSessionTurnEnded('s-deferred', frozenEndedAt);
    await vi.waitFor(async () => {
      expect((await readMarks(client, 's-deferred'))?.last_turn_ended_at).toBe(frozenEndedAt);
    });
    const row = await readMarks(client, 's-deferred');
    // started(now) > ended(定格) → turn B 的中断判定仍然命中。
    expect(row!.active_turn_started_at!).toBeGreaterThan(row!.last_turn_ended_at!);
  });

  it('markSessionTurnEnded never rewinds a newer ended timestamp (MAX guard)', async () => {
    const { markSessionTurnEnded } = await import('../sessionActiveTurn.js');
    const client = createTestDbClient();
    const newerEndedAt = Date.now() - 1000;
    await seedSession(client, 's-max-guard', { startedAt: newerEndedAt - 500, endedAt: newerEndedAt });

    // 延后的写(定格值更旧)晚入队:不能把后续 turn 已写下的更新 ended 回退,
    // 否则已正常完成的后续 turn 重启后会误判为中断。
    markSessionTurnEnded('s-max-guard', newerEndedAt - 60_000);
    await new Promise((r) => setTimeout(r, 20));
    expect((await readMarks(client, 's-max-guard'))?.last_turn_ended_at).toBe(newerEndedAt);
  });

  it('ackSessionTurnEndedDurable resolves only after the write landed (no waitFor needed)', async () => {
    const { markSessionTurnStarted, ackSessionTurnEndedDurable } = await import('../sessionActiveTurn.js');
    const client = createTestDbClient();
    await seedSession(client, 's-durable-ack');
    markSessionTurnStarted('s-durable-ack');

    // 用户显式「忽略」:IPC handler await 本函数后才广播/返回 —— resolve 时刻
    // DB 必须已可读到 ended(排在链上 started 写之后),点忽略后立刻退出也不丢。
    const endedAt = await ackSessionTurnEndedDurable('s-durable-ack');
    const row = await readMarks(client, 's-durable-ack');
    expect(row?.last_turn_ended_at).toBe(endedAt);
    expect(row!.last_turn_ended_at!).toBeGreaterThanOrEqual(row!.active_turn_started_at!);
  });

  it('ackSessionTurnEndedDurable preserves a pre-dispatch override below a newer turn start', async () => {
    const { markSessionTurnStarted, ackSessionTurnEndedDurable } = await import('../sessionActiveTurn.js');
    const client = createTestDbClient();
    const ackAt = Date.now() - 1_000;
    await seedSession(client, 's-pre-dispatch-ack', { startedAt: ackAt - 1_000 });

    // 模拟 vendor send 已同步发出新 turn started，随后 dispatched hook 才落旧中断 ack。
    // ack 必须保留 send 前冻结值，不能改用 hook 执行时刻盖过新 started。
    markSessionTurnStarted('s-pre-dispatch-ack');
    const endedAt = await ackSessionTurnEndedDurable('s-pre-dispatch-ack', ackAt);
    const row = await readMarks(client, 's-pre-dispatch-ack');

    expect(endedAt).toBe(ackAt);
    expect(row?.last_turn_ended_at).toBe(ackAt);
    expect(row!.active_turn_started_at!).toBeGreaterThan(row!.last_turn_ended_at!);
  });

  it('markSessionTurnEndedAfterBarrier survives a freeze raised while the barrier is pending', async () => {
    const { markSessionTurnStarted, markSessionTurnEndedAfterBarrier, freezeSessionActiveTurnMarkers } =
      await import('../sessionActiveTurn.js');
    const client = createTestDbClient();
    await seedSession(client, 's-barrier-freeze');
    markSessionTurnStarted('s-barrier-freeze');

    // done 已到(调用时刻未冻结)但 persist drain 未完成时 ⌘Q:该 ended 写必须
    // 照常落盘,否则已完成的 turn 会在重启后误报"应用退出中断"(假阳性)。
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((r) => { releaseBarrier = r; });
    markSessionTurnEndedAfterBarrier('s-barrier-freeze', barrier);
    freezeSessionActiveTurnMarkers();
    releaseBarrier();
    await vi.waitFor(async () => {
      const row = await readMarks(client, 's-barrier-freeze');
      expect(row?.last_turn_ended_at).toBeTypeOf('number');
      expect(row!.last_turn_ended_at!).toBeGreaterThanOrEqual(row!.active_turn_started_at!);
    });
  });

  it('markSessionTurnEndedAfterBarrier is a no-op when already frozen at call time', async () => {
    const { markSessionTurnStarted, markSessionTurnEndedAfterBarrier, freezeSessionActiveTurnMarkers } =
      await import('../sessionActiveTurn.js');
    const client = createTestDbClient();
    await seedSession(client, 's-barrier-frozen');
    markSessionTurnStarted('s-barrier-frozen');
    await vi.waitFor(async () => {
      expect((await readMarks(client, 's-barrier-frozen'))?.active_turn_started_at).toBeTypeOf('number');
    });

    // shutdown close 触发的收尾:调用时刻已冻结 → 挡住,在飞 turn 保持中断态。
    freezeSessionActiveTurnMarkers();
    markSessionTurnEndedAfterBarrier('s-barrier-frozen', Promise.resolve());
    await new Promise((r) => setTimeout(r, 20));
    expect((await readMarks(client, 's-barrier-frozen'))?.last_turn_ended_at).toBeNull();
  });

  it('quit freeze blocks new ended writes so a graceful quit mid-turn still counts as interrupted', async () => {
    const { markSessionTurnStarted, markSessionTurnEnded, freezeSessionActiveTurnMarkers } =
      await import('../sessionActiveTurn.js');
    const client = createTestDbClient();
    await seedSession(client, 's-quit');

    markSessionTurnStarted('s-quit');
    await vi.waitFor(async () => {
      expect((await readMarks(client, 's-quit'))?.active_turn_started_at).toBeTypeOf('number');
    });

    // 模拟 ⌘Q:退出编排冻结后,shutdown-maker 关 session 触发的 ended 写必须
    // no-op,否则"退出时还在飞的 turn"被伪装成正常收尾,重启后没有中断提示。
    freezeSessionActiveTurnMarkers();
    markSessionTurnEnded('s-quit');
    await new Promise((r) => setTimeout(r, 20));

    const row = await readMarks(client, 's-quit');
    expect(row?.last_turn_ended_at).toBeNull();
    expect(row!.active_turn_started_at!).toBeGreaterThan(0);
  });

  it('ended write notifies the injected listener with the effective DB value', async () => {
    const { markSessionTurnStarted, markSessionTurnEnded, setOnSessionTurnEndedPersisted } =
      await import('../sessionActiveTurn.js');
    const client = createTestDbClient();
    await seedSession(client, 's-notify');
    const notified: Array<[string, number]> = [];
    setOnSessionTurnEndedPersisted((sid, endedAt) => notified.push([sid, endedAt]));

    // 正常收尾:落库后必须通知(→ ipc 层广播 sessions:patched),否则 renderer
    // 在飞行中/空窗期取的 startedAt > endedAt 快照永不纠正,任务正常结束后切回
    // 会话仍弹「应用退出中断」假阳性(2026-07-07 实测 bug)。
    markSessionTurnStarted('s-notify');
    markSessionTurnEnded('s-notify');
    await vi.waitFor(() => expect(notified.length).toBe(1));
    const row = await readMarks(client, 's-notify');
    expect(notified[0]).toEqual(['s-notify', row!.last_turn_ended_at!]);
  });

  it('notify carries the read-back MAX-guarded value, never a stale rewind', async () => {
    const { markSessionTurnEnded, setOnSessionTurnEndedPersisted } =
      await import('../sessionActiveTurn.js');
    const client = createTestDbClient();
    const newerEndedAt = Date.now() - 1000;
    await seedSession(client, 's-notify-max', { startedAt: newerEndedAt - 500, endedAt: newerEndedAt });
    const notified: number[] = [];
    setOnSessionTurnEndedPersisted((_sid, endedAt) => notified.push(endedAt));

    // 延后定格写(值更旧)被 MAX 守卫挡下:广播必须发读回的生效值,盲播入参会把
    // renderer 快照的 ended 回退、复活假中断。
    markSessionTurnEnded('s-notify-max', newerEndedAt - 60_000);
    await vi.waitFor(() => expect(notified.length).toBe(1));
    expect(notified[0]).toBe(newerEndedAt);
  });

  it('a throwing listener does not break the write chain or the DB write', async () => {
    const { markSessionTurnEnded, setOnSessionTurnEndedPersisted } =
      await import('../sessionActiveTurn.js');
    const client = createTestDbClient();
    await seedSession(client, 's-notify-throw');
    let calls = 0;
    setOnSessionTurnEndedPersisted(() => {
      calls += 1;
      throw new Error('listener boom');
    });

    markSessionTurnEnded('s-notify-throw');
    await vi.waitFor(async () => {
      expect((await readMarks(client, 's-notify-throw'))?.last_turn_ended_at).toBeTypeOf('number');
    });
    // 后续写照常走链、照常通知(异常只吞不断链)。
    markSessionTurnEnded('s-notify-throw');
    await vi.waitFor(() => expect(calls).toBe(2));
  });

  it('ackSessionTurnEndedDurable fires the listener before resolving (ipc broadcast ordering)', async () => {
    const { markSessionTurnStarted, ackSessionTurnEndedDurable, setOnSessionTurnEndedPersisted } =
      await import('../sessionActiveTurn.js');
    const client = createTestDbClient();
    await seedSession(client, 's-notify-ack');
    const notified: number[] = [];
    setOnSessionTurnEndedPersisted((_sid, endedAt) => notified.push(endedAt));

    // ack IPC handler 不再显式广播,完全依赖本回调:必须在 ack resolve 前发出,
    // 否则「忽略」后其它窗口的 banner / 红点收敛丢失。
    markSessionTurnStarted('s-notify-ack');
    const endedAt = await ackSessionTurnEndedDurable('s-notify-ack');
    expect(notified).toEqual([endedAt]);
  });

  it('listInterruptedPendingSessionIds matches startedAt > endedAt on visible active sessions only', async () => {
    const { listInterruptedPendingSessionIds } = await import('../sessionActiveTurn.js');
    const client = createTestDbClient();
    const now = Date.now();

    // 命中:started 无 ended(崩溃/强杀后重启)。
    await seedSession(client, 's-pending', { startedAt: now - 1000 });
    // 命中:started 晚于上次 ended(上一轮正常收尾后又启动了新 turn 才崩溃)。
    await seedSession(client, 's-pending-2', { startedAt: now - 1000, endedAt: now - 5000 });
    // 不命中:正常收尾(ended >= started)。
    await seedSession(client, 's-done', { startedAt: now - 5000, endedAt: now - 1000 });
    // 不命中:从未跑过 turn。
    await seedSession(client, 's-fresh');
    // 不命中:/clear 越过了 started(任务现场已被用户主动丢弃)。
    await seedSession(client, 's-cleared', { startedAt: now - 5000, clearedAt: now - 1000 });
    // 不命中:deleted 会话。
    await seedSession(client, 's-deleted', { status: 'deleted', startedAt: now - 1000 });
    // 命中:IM(feishu)来源已进入桌面 sidebar 白名单,应正常渲染红点。
    await seedSession(client, 's-feishu', { startedAt: now - 1000, source: 'feishu' });
    // 不命中:不在当前白名单里的旧来源,红点无处展示也无法清除。
    await seedSession(client, 's-hidden-source', {
      startedAt: now - 1000,
      source: 'legacy-hidden',
    });

    expect((await listInterruptedPendingSessionIds()).sort()).toEqual([
      's-feishu',
      's-pending',
      's-pending-2',
    ]);
  });

  it('hasAssistantProgressAfterMessage detects agent output after the user row', async () => {
    const { hasAssistantProgressAfterMessage } = await import('../sessionActiveTurn.js');
    const client = createTestDbClient();
    await seedSession(client, 's-progress');
    const base = Date.now();
    const insert = (id: string, clientId: string, role: string, createdAt: number, rewindAt: number | null = null) =>
      client.exec(
        'INSERT INTO messages (id, client_id, session_id, role, content, created_at, rewind_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, clientId, 's-progress', role, '{}', createdAt, rewindAt],
      );

    await insert('m-user', 'c-user', 'user', base);
    // 尚无 agent 产出 → false。
    expect(await hasAssistantProgressAfterMessage('s-progress', 'c-user')).toBe(false);
    // user 行不存在 → false(重发原文是安全兜底)。
    expect(await hasAssistantProgressAfterMessage('s-progress', 'c-missing')).toBe(false);

    // 早于 user 行的历史 assistant 不算本轮进展。
    await insert('m-old-assistant', 'c-old-assistant', 'assistant', base - 5000);
    expect(await hasAssistantProgressAfterMessage('s-progress', 'c-user')).toBe(false);

    // rewind 软删的产出不算。
    await insert('m-rewound', 'c-rewound', 'tool_use', base + 100, base + 200);
    expect(await hasAssistantProgressAfterMessage('s-progress', 'c-user')).toBe(false);

    await insert('m-tool', 'c-tool', 'tool_use', base + 300);
    expect(await hasAssistantProgressAfterMessage('s-progress', 'c-user')).toBe(true);
  });

  it('hasAssistantProgressAfterMessage counts persisted interaction rows as progress', async () => {
    const { hasAssistantProgressAfterMessage } = await import('../sessionActiveTurn.js');
    const client = createTestDbClient();
    await seedSession(client, 's-interaction');
    const base = Date.now();
    const insert = (id: string, role: string, createdAt: number) =>
      client.exec(
        'INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [id, id, 's-interaction', role, '{}', createdAt],
      );

    // turn 持久化了 ask_user 交互后才失败:重发原文会重新生成已回答的问题,
    // 必须判为"有产出"走续跑。plan_review 同理。
    await insert('c-user3', 'user', base);
    expect(await hasAssistantProgressAfterMessage('s-interaction', 'c-user3')).toBe(false);
    await insert('m-ask', 'ask_user', base + 100);
    expect(await hasAssistantProgressAfterMessage('s-interaction', 'c-user3')).toBe(true);
  });

  it('hasAssistantProgressAfterMessage uses rowid ordering for same-millisecond neighbors', async () => {
    const { hasAssistantProgressAfterMessage } = await import('../sessionActiveTurn.js');
    const client = createTestDbClient();
    await seedSession(client, 's-same-ms');
    const ts = Date.now();
    const insert = (id: string, role: string) =>
      client.exec(
        'INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [id, id, 's-same-ms', role, '{}', ts],
      );

    // 上一 turn 的产出行与本 turn 的 user 行同毫秒:assistant 先插入(rowid 小),
    // 不能被算作"user 行之后的产出"。
    await insert('prev-assistant', 'assistant');
    await insert('c-user2', 'user');
    expect(await hasAssistantProgressAfterMessage('s-same-ms', 'c-user2')).toBe(false);

    // 本 turn 的产出同毫秒但 rowid 更大 → 算产出。
    await insert('this-turn-tool', 'tool_use');
    expect(await hasAssistantProgressAfterMessage('s-same-ms', 'c-user2')).toBe(true);
  });

  it('listErrorTailPendingSessionIds matches undismissed error tails only', async () => {
    const { listErrorTailPendingSessionIds } = await import('../sessionActiveTurn.js');
    const client = createTestDbClient();
    const base = Date.now();
    const insert = (
      sessionId: string,
      id: string,
      role: string,
      content: string,
      createdAt: number,
      rewindAt: number | null = null,
    ) =>
      client.exec(
        'INSERT INTO messages (id, client_id, session_id, role, content, created_at, rewind_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, id, sessionId, role, content, createdAt, rewindAt],
      );

    // 命中:尾行是未 dismissed 的 error。
    await seedSession(client, 's-err');
    await insert('s-err', 'e1-user', 'user', '{}', base);
    await insert('s-err', 'e1-err', 'error', '{"message":"boom"}', base + 100);

    // 命中:content 是非法 JSON —— json_extract 会抛 malformed JSON,必须被
    // json_valid 守卫挡住并按「未 dismissed」放行(fail-safe)。
    await seedSession(client, 's-err-bad-json');
    await insert('s-err-bad-json', 'e2-err', 'error', 'not json at all', base + 100);

    // 命中:数组形态 content(合法 JSON 但取不到顶层键)同样按未 dismissed 处理。
    await seedSession(client, 's-err-array');
    await insert('s-err-array', 'e6-err', 'error', '["boom"]', base + 100);

    // 不命中:用户点过「忽略」(mergeDismissedIntoErrorContent 写入顶层 dismissed)。
    await seedSession(client, 's-dismissed');
    await insert('s-dismissed', 'e3-err', 'error', '{"message":"boom","dismissed":true}', base + 100);

    // 不命中:error 行之后又跑了新 turn,它已不是尾行(turn 重启即自然收敛)。
    await seedSession(client, 's-resumed');
    await insert('s-resumed', 'e4-err', 'error', '{"message":"boom"}', base + 100);
    await insert('s-resumed', 'e4-user', 'user', '{}', base + 200);

    // 不命中:error 行被 rewind 软删,不算尾行。
    await seedSession(client, 's-rewound');
    await insert('s-rewound', 'e5-err', 'error', '{"message":"boom"}', base + 100, base + 150);

    // 命中:error 行与后续 rewind 行同毫秒 —— rewind 的不参与尾行比较,
    // error 仍是尾行(双键比较两侧都过滤 rewind_at IS NULL)。
    await seedSession(client, 's-same-ms-rewound');
    await insert('s-same-ms-rewound', 'e7-err', 'error', '{"message":"boom"}', base + 100);
    await insert('s-same-ms-rewound', 'e7-rewound', 'assistant', '{}', base + 100, base + 150);

    // 不命中:同毫秒但 rowid 更大的活跃行在 error 之后 → error 不是尾行。
    await seedSession(client, 's-same-ms-after');
    await insert('s-same-ms-after', 'e8-err', 'error', '{"message":"boom"}', base + 100);
    await insert('s-same-ms-after', 'e8-user', 'user', '{}', base + 100);

    // 不命中:非 active 会话。
    await seedSession(client, 's-deleted-err', { status: 'deleted' });
    await insert('s-deleted-err', 'e9-err', 'error', '{"message":"boom"}', base + 100);

    // 不命中:不在桌面可见来源白名单里,红点无处展示。
    await seedSession(client, 's-hidden-err', { source: 'legacy-hidden' });
    await insert('s-hidden-err', 'e10-err', 'error', '{"message":"boom"}', base + 100);

    // 不命中:/clear 越过了该 error 行 —— 消息读取路径靠 cleared_at 把它挡在视图外,
    // 横幅根本不显示,红点若还挂着就永远无法处置(PR #879 review P1)。
    await seedSession(client, 's-cleared-err', { clearedAt: base + 500 });
    await insert('s-cleared-err', 'e11-err', 'error', '{"message":"boom"}', base + 100);

    // 命中:error 行在 /clear 之后产生(clear 后又跑了一轮并失败)。
    await seedSession(client, 's-cleared-then-err', { clearedAt: base + 100 });
    await insert('s-cleared-then-err', 'e12-err', 'error', '{"message":"boom"}', base + 500);

    expect((await listErrorTailPendingSessionIds()).sort()).toEqual([
      's-cleared-then-err',
      's-err',
      's-err-array',
      's-err-bad-json',
      's-same-ms-rewound',
    ]);
  });

  // 回归(PR #879 review P1):批量处置先取快照再逐个 ack,快照之后该会话可能已启动
  // 新 turn。盲写 ended 会把刚启动的活跃 turn 记成已收尾,它真被中断时下次启动就
  // 检测不到 —— 所以带上捕获的 startedAt 做 CAS。
  it('ackSessionTurnEndedIfUnchanged skips the write when a new turn already started', async () => {
    const { ackSessionTurnEndedIfUnchanged } = await import('../sessionActiveTurn.js');
    const client = createTestDbClient();
    const captured = Date.now() - 5000;
    await seedSession(client, 's-cas', { startedAt: captured });

    // startedAt 未变 → 写入并回报成功。
    expect(await ackSessionTurnEndedIfUnchanged('s-cas', captured)).toBe(true);
    const after = await readMarks(client, 's-cas');
    expect(after?.last_turn_ended_at).toBeTypeOf('number');
    expect(after!.last_turn_ended_at!).toBeGreaterThanOrEqual(captured);

    // 模拟「快照之后又启动了新 turn」:startedAt 前进,CAS 不再命中。
    await seedSession(client, 's-cas-restarted', { startedAt: captured });
    const restarted = Date.now();
    await client.exec('UPDATE sessions SET active_turn_started_at = ? WHERE id = ?', [
      restarted,
      's-cas-restarted',
    ]);
    expect(await ackSessionTurnEndedIfUnchanged('s-cas-restarted', captured)).toBe(false);
    const untouched = await readMarks(client, 's-cas-restarted');
    // 活跃 turn 没被伪装成已收尾:ended 仍为空,中断判定对它照常成立。
    expect(untouched?.last_turn_ended_at).toBeNull();
    expect(untouched?.active_turn_started_at).toBe(restarted);
  });

  // 回归(PR #879 review P1,两个 reviewer 独立指出):「中断」必须是**开始于本进程
  // 启动之前**的未收尾 turn。只看 startedAt > endedAt 会把正在跑的 turn 也算进去 ——
  // 红点侧给运行中的会话亮红点,批量处置侧更糟:对活跃 turn 写 lastTurnEndedAt,
  // 把它伪装成已收尾,该 turn 真被中断时下次启动就检测不到了。
  it('interrupted leg only matches turns started before this process booted', async () => {
    const { listInterruptedPendingSessionIds, listErrorTailPendingSessionIds, _setBootAtMsForTests } =
      await import('../sessionActiveTurn.js');
    const client = createTestDbClient();
    const bootAt = Date.now();
    _setBootAtMsForTests(bootAt);

    // 命中:turn 开始于本进程启动之前且未收尾 —— 只能是上一个进程留下的。
    await seedSession(client, 's-prev-process', { startedAt: bootAt - 5000 });
    // 不命中:turn 开始于本进程启动之后 = 正在跑,不是中断。
    await seedSession(client, 's-live-turn', { startedAt: bootAt + 1000 });

    expect(await listInterruptedPendingSessionIds()).toEqual(['s-prev-process']);

    // 错误尾行腿与 turn 是否在跑无关(turn 一跑起来就插入 user 行,error 不再是尾行),
    // 所以它可以周期性重跑:这里飞行中的会话尾行是 user 行 → 不命中。
    await client.exec(
      'INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['live-1', 'live-1', 's-live-turn', 'user', '{}', bootAt + 1000],
    );
    await seedSession(client, 's-error-tail', { startedAt: bootAt - 5000, endedAt: bootAt - 1000 });
    await client.exec(
      'INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['tail-1', 'tail-1', 's-error-tail', 'error', '{"message":"boom"}', bootAt],
    );
    expect(await listErrorTailPendingSessionIds()).toEqual(['s-error-tail']);
  });
});
