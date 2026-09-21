/**
 * claudeTranscriptRelocation.test.ts — 会话移动转录迁移编排。
 * ------------------------------------------------------------------------------------
 * 验证 relocateClaudeTranscriptsForSessionMove 的编排顺序与三源 id 并集:
 *   1. sessions.sdk_session_id(DB 最近持久化);
 *   2. messages.agent_meta 的 DISTINCT sdkSessionId(rewind fork 历史链);
 *   3. 活跃会话内存 id(fork 后未随消息落库的最新 id——2026-07 事故来源);
 * 以及关键顺序约束(PR #472 Codex / Greptile review):DB 旧 id 必须在被
 * UPDATE 覆盖前读走(否则漏迁其转录)、内存 id 先持久化回 DB(handle 关闭后
 * lazy-create resume 只认 DB 值)、活跃 handle 必须在复制前关闭(杜绝旧 cwd
 * 进程继续追加旧目录 jsonl 的分叉);'<pending>' 占位 id 不持久化不入集合但
 * 仍关 handle;空集 no-op、maker-core 抛错被吞并(移动主流程不受影响)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '../../localDb/client/DbClient.js';

const h = vi.hoisted(() => ({
  relocate: vi.fn(),
  queryOne: vi.fn(),
  query: vi.fn(),
  exec: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@cindy/maker-core', () => ({
  relocateClaudeSessionTranscripts: h.relocate,
}));
vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({ queryOne: h.queryOne, query: h.query, exec: h.exec }),
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: h.warn, error: vi.fn() }),
}));

import {
  relocateClaudeTranscriptsForSessionMove,
  setLiveCcSessionBridge,
} from '../claude-transcript-relocation.js';

const LIVE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DB_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const META_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

beforeEach(() => {
  vi.clearAllMocks();
  setLiveCcSessionBridge(null);
  h.relocate.mockResolvedValue({
    copied: ['x'],
    replaced: [],
    skipped: [],
    missing: [],
    targetKeyInexact: false,
  });
  h.exec.mockResolvedValue({ changes: 1 });
});

describe('relocateClaudeTranscriptsForSessionMove', () => {
  it('uses the captured database throughout a scoped move', async () => {
    const client = { queryOne: vi.fn(async () => ({ sdkSessionId: DB_ID })), query: vi.fn(async () => [{ sid: META_ID }]), exec: vi.fn(async () => ({ changes: 1 })) };
    setLiveCcSessionBridge({ resolveSdkSessionId: () => LIVE_ID, closeSession: vi.fn(async () => undefined) });
    await relocateClaudeTranscriptsForSessionMove('s1', '/old/dir', '/new/dir', { client: client as unknown as DbClient, assertCurrent: () => undefined });
    expect(client.exec).toHaveBeenCalledOnce();
    expect(client.query).toHaveBeenCalledOnce();
    expect(h.queryOne).not.toHaveBeenCalled();
    expect(h.exec).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
    expect(h.relocate).toHaveBeenCalledOnce();
  });

  it('stops before persistence and runtime close if the account changes during the read', async () => {
    let current = true;
    const closeSession = vi.fn(async () => undefined);
    const client = { queryOne: vi.fn(async () => { current = false; return { sdkSessionId: DB_ID }; }), query: vi.fn(), exec: vi.fn() };
    setLiveCcSessionBridge({ resolveSdkSessionId: () => LIVE_ID, closeSession });
    await relocateClaudeTranscriptsForSessionMove('s1', '/old/dir', '/new/dir', {
      client: client as unknown as DbClient,
      assertCurrent: () => { if (!current) throw new Error('account changed'); },
    });
    expect(client.exec).not.toHaveBeenCalled();
    expect(h.exec).not.toHaveBeenCalled();
    expect(closeSession).not.toHaveBeenCalled();
    expect(h.relocate).not.toHaveBeenCalled();
  });
  it('unions DB sdk_session_id, message agent_meta ids and the live in-memory id', async () => {
    h.queryOne.mockResolvedValue({ sdkSessionId: DB_ID });
    h.query.mockResolvedValue([{ sid: META_ID }, { sid: DB_ID }, { sid: null }]);
    setLiveCcSessionBridge({
      resolveSdkSessionId: (sessionId) => (sessionId === 's1' ? LIVE_ID : null),
      closeSession: vi.fn(async () => undefined),
    });

    await relocateClaudeTranscriptsForSessionMove('s1', '/old/dir', '/new/dir');

    expect(h.relocate).toHaveBeenCalledTimes(1);
    const args = h.relocate.mock.calls[0][0];
    expect([...args.sdkSessionIds].sort()).toEqual([LIVE_ID, DB_ID, META_ID].sort());
    expect(args.oldWorkingDir).toBe('/old/dir');
    expect(args.newWorkingDir).toBe('/new/dir');
  });

  it('reads the old DB id BEFORE overwriting it, then closes the handle BEFORE copying', async () => {
    const order: string[] = [];
    h.queryOne.mockImplementation(async () => {
      order.push('read-db-id');
      return { sdkSessionId: DB_ID };
    });
    h.query.mockResolvedValue([]);
    h.exec.mockImplementation(async () => {
      order.push('persist-live-id');
      return { changes: 1 };
    });
    const closeSession = vi.fn(async () => {
      order.push('close');
    });
    h.relocate.mockImplementation(async () => {
      order.push('relocate');
      return { copied: [], replaced: [], skipped: [], missing: [], targetKeyInexact: false };
    });
    setLiveCcSessionBridge({ resolveSdkSessionId: () => LIVE_ID, closeSession });

    const out = await relocateClaudeTranscriptsForSessionMove('s1', '/old/dir', '/new/dir');

    // 顺序硬约束:读走 DB 旧 id(被覆盖前)→ 持久化内存 id → 关闭 handle
    // (flush + 停止旧 cwd 写入)→ 复制。
    expect(order).toEqual(['read-db-id', 'persist-live-id', 'close', 'relocate']);
    expect(closeSession).toHaveBeenCalledWith('s1');
    expect(h.exec).toHaveBeenCalledWith(expect.stringContaining('UPDATE sessions SET sdk_session_id'), [
      LIVE_ID,
      's1',
    ]);
    // 被覆盖前读走的 DB 旧 id 必须仍在迁移集合里(Greptile P1)。
    const args = h.relocate.mock.calls[0][0];
    expect([...args.sdkSessionIds].sort()).toEqual([LIVE_ID, DB_ID].sort());
    // 持久化的 id 要上报给 handler 并入返回行 / 广播 patch(Codex review)。
    expect(out).toEqual({ persistedSdkSessionId: LIVE_ID });
  });

  it('resolves projectsRoot from XDT_USER_DATA_DIR/claude-home in dev multi-instance runs', async () => {
    const prevUserData = process.env.XDT_USER_DATA_DIR;
    const prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.XDT_USER_DATA_DIR = '/tmp/xdt-instance-b';
    delete process.env.CLAUDE_CONFIG_DIR;
    try {
      h.queryOne.mockResolvedValue({ sdkSessionId: DB_ID });
      h.query.mockResolvedValue([]);

      await relocateClaudeTranscriptsForSessionMove('s1', '/old/dir', '/new/dir');

      // CLI 子进程被 auth-adapters 重定向到 <userData>/claude-home,迁移必须用同一根,
      // 否则回退 ~/.claude 找不到源、也写不进 CLI 实际读取的目录。
      const args = h.relocate.mock.calls[0][0];
      expect(args.projectsRoot?.split(/[\\/]/).slice(-3).join('/')).toBe(
        'xdt-instance-b/claude-home/projects',
      );
    } finally {
      if (prevUserData === undefined) delete process.env.XDT_USER_DATA_DIR;
      else process.env.XDT_USER_DATA_DIR = prevUserData;
      if (prevConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
    }
  });

  it('does not persist the live id when it already equals the DB id', async () => {
    h.queryOne.mockResolvedValue({ sdkSessionId: LIVE_ID });
    h.query.mockResolvedValue([]);
    setLiveCcSessionBridge({
      resolveSdkSessionId: () => LIVE_ID,
      closeSession: vi.fn(async () => undefined),
    });

    await relocateClaudeTranscriptsForSessionMove('s1', '/old/dir', '/new/dir');

    expect(h.exec).not.toHaveBeenCalled();
  });

  it('ignores a <pending> placeholder live id but still closes the handle', async () => {
    h.queryOne.mockResolvedValue({ sdkSessionId: DB_ID });
    h.query.mockResolvedValue([]);
    const closeSession = vi.fn(async () => undefined);
    setLiveCcSessionBridge({ resolveSdkSessionId: () => '<pending>', closeSession });

    await relocateClaudeTranscriptsForSessionMove('s1', '/old/dir', '/new/dir');

    // 占位符绝不能写进 DB,也不参与迁移;handle 连的是旧 cwd,仍要关。
    expect(h.exec).not.toHaveBeenCalled();
    expect(closeSession).toHaveBeenCalledWith('s1');
    const args = h.relocate.mock.calls[0][0];
    expect(args.sdkSessionIds).toEqual([DB_ID]);
  });

  it('still closes the idle handle even when it has no live sdk id yet', async () => {
    h.queryOne.mockResolvedValue({ sdkSessionId: DB_ID });
    h.query.mockResolvedValue([]);
    const closeSession = vi.fn(async () => undefined);
    setLiveCcSessionBridge({ resolveSdkSessionId: () => null, closeSession });

    await relocateClaudeTranscriptsForSessionMove('s1', '/old/dir', '/new/dir');

    expect(closeSession).toHaveBeenCalledWith('s1');
    // 无内存 id 时不写 DB。
    expect(h.exec).not.toHaveBeenCalled();
  });

  it('skips relocation entirely when no sdk session id is known', async () => {
    h.queryOne.mockResolvedValue({ sdkSessionId: null });
    h.query.mockResolvedValue([]);

    await relocateClaudeTranscriptsForSessionMove('s1', '/old/dir', '/new/dir');

    expect(h.relocate).not.toHaveBeenCalled();
  });

  it('proceeds with DB/live ids when the agent_meta query fails (malformed rows)', async () => {
    h.queryOne.mockResolvedValue({ sdkSessionId: DB_ID });
    // 历史消息带坏 JSON 的 agent_meta 时 json_extract 会抛 malformed JSON;
    // meta 只是补充来源,不能拖垮核心迁移(Codex review)。
    h.query.mockRejectedValue(new Error('malformed JSON'));

    await relocateClaudeTranscriptsForSessionMove('s1', '/old/dir', '/new/dir');

    expect(h.relocate).toHaveBeenCalledTimes(1);
    expect(h.relocate.mock.calls[0][0].sdkSessionIds).toEqual([DB_ID]);
    expect(h.warn).toHaveBeenCalled();
  });

  it('drops non-string sdkSessionId values from agent_meta rows', async () => {
    h.queryOne.mockResolvedValue({ sdkSessionId: DB_ID });
    // 合法 JSON 但 sdkSessionId 是数字 / 对象(导入或部分损坏数据):truthiness
    // 过滤会放行,下游 id.trim() 抛错拖垮迁移(Codex review)。
    h.query.mockResolvedValue([{ sid: 42 as unknown as string }, { sid: META_ID }]);

    await relocateClaudeTranscriptsForSessionMove('s1', '/old/dir', '/new/dir');

    expect(h.relocate).toHaveBeenCalledTimes(1);
    expect([...h.relocate.mock.calls[0][0].sdkSessionIds].sort()).toEqual(
      [DB_ID, META_ID].sort(),
    );
  });

  it('guards the agent_meta query with json_valid', async () => {
    h.queryOne.mockResolvedValue({ sdkSessionId: DB_ID });
    h.query.mockResolvedValue([]);

    await relocateClaudeTranscriptsForSessionMove('s1', '/old/dir', '/new/dir');

    expect(h.query).toHaveBeenCalledWith(expect.stringContaining('json_valid(agent_meta)'), ['s1']);
  });

  it('swallows maker-core failures with a warning (move flow must proceed)', async () => {
    h.queryOne.mockResolvedValue({ sdkSessionId: 'sdk-db' });
    h.query.mockResolvedValue([]);
    h.relocate.mockRejectedValue(new Error('disk full'));

    // 复制失败前 liveId 未持久化(无 bridge)→ 如实返回 null;不抛错。
    await expect(
      relocateClaudeTranscriptsForSessionMove('s1', '/old/dir', '/new/dir'),
    ).resolves.toEqual({ persistedSdkSessionId: null });
    expect(h.warn).toHaveBeenCalled();
  });

  it('works without a live bridge registered (DB + meta sources only)', async () => {
    h.queryOne.mockResolvedValue({ sdkSessionId: 'sdk-db' });
    h.query.mockResolvedValue([{ sid: 'sdk-meta-1' }]);

    await relocateClaudeTranscriptsForSessionMove('s1', '/old/dir', '/new/dir');

    const args = h.relocate.mock.calls[0][0];
    expect([...args.sdkSessionIds].sort()).toEqual(['sdk-db', 'sdk-meta-1']);
  });
});
