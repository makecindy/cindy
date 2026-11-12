import { readFileSync } from 'node:fs';
import { ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import { classifySessionMessageStatus } from '../messageStatus';
import type { SessionMessageStatusSnapshot } from '../messageStatus';

// Execute the production readSessionMessageStatus closure and the
// maker:input:message-status IPC handler while injecting only their host
// services (same extraction approach as inputEnqueueHarness.ts).
const source = readFileSync(new URL('../register.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const fnStart = source.indexOf('const readSessionMessageStatus = async (');
const fnEnd = source.indexOf('  // ─── 把 internal 业务函数发布到 module-level holder', fnStart);
const ipcMark = source.indexOf('MAKER_INVOKE.INPUT_MESSAGE_STATUS');
const handlerStart = source.indexOf('async (_e, sessionId: unknown, messageId: unknown)', ipcMark);
const handlerEnd = source.indexOf('\n  });', handlerStart);
if (fnStart < 0 || fnEnd < fnStart || ipcMark < 0 || handlerStart < ipcMark || handlerEnd < handlerStart) {
  throw new Error('readSessionMessageStatus / INPUT_MESSAGE_STATUS handler not found in register.ts');
}
const fnSource = source.slice(fnStart, fnEnd).trim();
const handlerSource = source.slice(handlerStart, handlerEnd + '\n  }'.length).trim();
const compiled = transpileModule(
  `${fnSource}\nconst __ipcHandler = ${handlerSource};\nreturn { readSessionMessageStatus, ipcHandler: __ipcHandler };`,
  { compilerOptions: { target: ScriptTarget.ES2022 } },
).outputText;

type StatusResult =
  | ({ ok: true } & SessionMessageStatusSnapshot)
  | { ok: false; errorCode: string; message: string };

interface FixtureOptions {
  /** maker.getSessionMeta 的返回；undefined = 会话存在。 */
  meta?: Record<string, unknown> | null;
  queueEntries?: unknown[];
  activeInputClientIds?: string[];
  queueRestored?: boolean;
  /**
   * 按调用顺序消费的 drizzle 查询结果：每次 .limit() 弹出一组行。
   * readSessionMessageStatus 的查询顺序固定为 persisted → sessionRow → reply → (error content)。
   */
  dbResults?: unknown[][];
  deviceLink?: boolean;
  /** 预先记入「派发前被移除」证据的 clientId（sessionId → clientIds）。 */
  discarded?: Record<string, string[]>;
}

function createFixture(options: FixtureOptions = {}) {
  const pending = [...(options.dbResults ?? [])];
  const builder: Record<string, unknown> = {};
  for (const method of ['from', 'where', 'orderBy']) {
    builder[method] = () => builder;
  }
  builder.limit = async () => pending.shift() ?? [];
  const drizzle = { select: () => builder };
  const bindings = {
    maker: {
      getSessionMeta: vi.fn(async () =>
        options.meta === undefined ? { id: 'session-1' } : options.meta,
      ),
    },
    inputCoordinator: {
      ensureQueueRestored: vi.fn(async () => {}),
      isQueueRestored: vi.fn(() => options.queueRestored ?? true),
      getQueueInspection: vi.fn(() => options.queueEntries ?? []),
      getActiveInputClientIds: vi.fn(() => options.activeInputClientIds ?? []),
    },
    getDbClient: () => ({ drizzle }),
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    and: (...args: unknown[]) => args,
    eq: (...args: unknown[]) => args,
    or: (...args: unknown[]) => args,
    gt: (...args: unknown[]) => args,
    inArray: (...args: unknown[]) => args,
    isNull: (...args: unknown[]) => args,
    asc: (...args: unknown[]) => args,
    messages: {},
    sessions: {},
    isDbClientNotReadyError: () => false,
    classifySessionMessageStatus,
    discardedMessageStatusEvidence: new Map(
      Object.entries(options.discarded ?? {}).map(([sid, ids]) => [sid, new Set(ids)]),
    ),
    isDeviceLinkInvoke: () => options.deviceLink ?? false,
    requireSessionId: (id: unknown) => {
      if (typeof id !== 'string' || !id.trim()) {
        throw Object.assign(new Error('invalid session id'), { code: 'INVALID_PARAMS' });
      }
      return id;
    },
    throwIpcError: (code: string, message: string) => {
      throw Object.assign(new Error(message), { code });
    },
  };
  return new Function(...Object.keys(bindings), compiled)(
    ...Object.values(bindings),
  ) as {
    readSessionMessageStatus: (
      sessionId: string,
      messageId: string,
    ) => Promise<StatusResult>;
    ipcHandler: (
      event: unknown,
      sessionId: unknown,
      messageId: unknown,
    ) => Promise<unknown>;
  };
}

const userRow = { id: 'msg-1', role: 'user', createdAt: 100, rewindAt: null, rowid: 1 };

describe('readSessionMessageStatus', () => {
  it('returns dispatched for a persisted message with no reply yet', async () => {
    const { readSessionMessageStatus } = createFixture({
      dbResults: [[userRow], [{ clearedAt: null }], []],
    });

    await expect(readSessionMessageStatus('session-1', 'client-1')).resolves.toMatchObject({
      ok: true,
      status: 'dispatched',
    });
  });

  it('returns consumed once an assistant reply exists after the message', async () => {
    const { readSessionMessageStatus } = createFixture({
      dbResults: [
        [userRow],
        [{ clearedAt: null }],
        [{ id: 'msg-2', role: 'assistant', createdAt: 200, rowid: 2 }],
      ],
    });

    await expect(readSessionMessageStatus('session-1', 'client-1')).resolves.toMatchObject({
      ok: true,
      status: 'consumed',
      consumed_at: new Date(200).toISOString(),
    });
  });

  it('returns failed when the persisted row was rewound', async () => {
    const { readSessionMessageStatus } = createFixture({
      dbResults: [
        [{ ...userRow, rewindAt: 150 }],
        [{ clearedAt: null }],
        [],
      ],
    });

    await expect(readSessionMessageStatus('session-1', 'client-1')).resolves.toMatchObject({
      ok: true,
      status: 'failed',
    });
  });

  it('returns NOT_FOUND when the session does not exist', async () => {
    const { readSessionMessageStatus } = createFixture({ meta: null });

    await expect(readSessionMessageStatus('missing', 'client-1')).resolves.toMatchObject({
      ok: false,
      errorCode: 'NOT_FOUND',
    });
  });

  it('returns failed when the queued message was discarded before dispatch', async () => {
    // 回归（PR #10007 review）：待派发的排队消息被撤回/清理后无落库行，
    // 有效回执必须得到 failed 而不是与无效 ID 相同的 NOT_FOUND。
    const { readSessionMessageStatus } = createFixture({
      discarded: { 'session-1': ['client-1'] },
      dbResults: [[]],
    });

    const result = await readSessionMessageStatus('session-1', 'client-1');
    expect(result).toMatchObject({ ok: true, status: 'failed' });
    expect(result.ok ? result.detail : null).toMatch(/撤回|清理/);
  });

  it('keeps NOT_FOUND for an id with no queue entry, persisted row, or discard evidence', async () => {
    const { readSessionMessageStatus } = createFixture({ dbResults: [[]] });

    await expect(readSessionMessageStatus('session-1', 'client-1')).resolves.toMatchObject({
      ok: false,
      errorCode: 'NOT_FOUND',
    });
  });
});

describe('maker:input:message-status IPC handler', () => {
  it('rejects invocations that are not an authenticated device link', async () => {
    const { ipcHandler } = createFixture({ deviceLink: false });

    await expect(ipcHandler({}, 'session-1', 'client-1')).rejects.toThrow(/device-link only/);
  });

  it('returns the status snapshot to an authenticated device link', async () => {
    const { ipcHandler } = createFixture({
      deviceLink: true,
      dbResults: [[userRow], [{ clearedAt: null }], []],
    });

    await expect(ipcHandler({}, 'session-1', 'client-1')).resolves.toMatchObject({
      ok: true,
      status: 'dispatched',
    });
  });
});
