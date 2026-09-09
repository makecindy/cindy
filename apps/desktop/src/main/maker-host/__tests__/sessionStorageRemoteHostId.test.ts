/**
 * #3525 回归:DesktopSessionStorage 的 CAS 契约——
 *
 * INVARIANT: `compareAndClearSdkSessionId(id, expected)` 只能把「当前 sdkSessionId
 * 仍等于 expected 的那一行」清空。若并发方已把新 ID 写回,旧恢复请求的 CAS 必须
 * 自然未命中(changes=0 → false),绝不能清掉并发写入的新 ID。
 *
 * 与旧 mock 的差别(Greptile P2):旧 mock 的 where() 不评估条件表达式、靠手动
 * 切换 runResult 决定结果 —— 即使实现漏掉 `sdkSessionId = expected` 谓词,测试
 * 仍会通过。现在 mock 内部维护一个真实行存储:update 真正改行,where 条件对象
 * 被逐节点解析成 (column, value) 谓词并按行求值,未命中自然返回 changes=0。
 * 「实现漏掉谓词 → 测试变红」由此成立:漏掉谓词时两个 CAS 都会命中,第二个
 * 断言(false)失败。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';

// 真实 schema:drizzle 列对象的 name 即 DB 列名(sdkSessionId → sdk_session_id)。
// mock 的行存储以 DB 列名为键,update patch 必须先经过同一映射。
import { sessions } from '../../localDb/schema.js';

/** TS 属性名 patch → DB 列名 patch(与 where 条件用的列名同口径)。 */
function toDbColumns(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    const column = (sessions as unknown as Record<string, { name?: string }>)[key];
    out[column?.name ?? key] = value;
  }
  return out;
}

/** 模拟数据库:sessions 表按 id 存行,update 真实改状态。 */
const h = vi.hoisted(() => {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    rows,
    captured: null as Record<string, unknown> | null,
  };
});

/** drizzle 条件对象 → 谓词(逐节点下钻 queryChunks,拼出 (column, value) 对)。 */
function compileCondition(condition: SQL): Array<{ column: string; value: unknown }> {
  const predicates: Array<{ column: string; value: unknown }> = [];
  const visit = (node: unknown): void => {
    if (node == null) return;
    const chunk = node as { queryChunks?: unknown[]; name?: unknown; value?: unknown; constructor?: { name?: string } };
    const className = chunk.constructor?.name ?? '';
    if (className === 'SQLiteText' || className === 'SQLiteInteger' || className === 'SQLiteBoolean') {
      // 列节点本身没有独立谓词含义,等 EQ 节点把 column+value 拼在一起。
      return;
    }
    if (Array.isArray(chunk.queryChunks)) {
      const columnNode = chunk.queryChunks.find(
        (c) => (c as { constructor?: { name?: string } })?.constructor?.name?.startsWith('SQLite'),
      );
      const paramNode = chunk.queryChunks.find(
        (c) => (c as { constructor?: { name?: string } })?.constructor?.name === 'Param',
      );
      if (columnNode && paramNode) {
        predicates.push({
          column: String((columnNode as { name: string }).name),
          value: (paramNode as { value: unknown }).value,
        });
        return;
      }
      for (const child of chunk.queryChunks) visit(child);
    }
  };
  visit(condition);
  return predicates;
}

function conditionMatches(row: Record<string, unknown>, condition: SQL): boolean {
  return compileCondition(condition).every((p) => row[p.column] === p.value);
}

vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({
    drizzle: {
      insert: () => ({
        values: (row: Record<string, unknown>) => {
          h.captured = row;
          if (typeof row.id === 'string') h.rows.set(row.id, { ...row });
          return Promise.resolve();
        },
      }),
      update: () => ({
        set: (patch: Record<string, unknown>) => ({
          where: (condition: SQL) => ({
            run: async () => {
              // patch 键是 TS 属性名,行键是 DB 列名,先对齐再合并。
              const dbPatch = toDbColumns(patch);
              let changes = 0;
              for (const [id, row] of h.rows) {
                if (conditionMatches(row, condition)) {
                  h.rows.set(id, { ...row, ...dbPatch });
                  changes += 1;
                }
              }
              return { changes };
            },
          }),
        }),
      }),
    },
  }),
}));

// schema.js 同样需要指向 hoisted 行存储的列名映射;这里不 mock schema,
// 直接用真实 schema(drizzle 列对象的 name 即 db 列名)。
import { DesktopSessionStorage } from '../session-storage';

describe('DesktopSessionStorage.create remoteHostId 规范化', () => {
  beforeEach(() => {
    h.captured = null;
    h.rows.clear();
  });

  const base = {
    id: 's1',
    title: 'New Maker',
    workDir: '/repo',
    model: 'gpt-5.5',
    agentKind: 'codex' as const,
  };

  it('空白 host 落 null(本地语义)', async () => {
    const storage = new DesktopSessionStorage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await storage.create({ ...base, remoteHostId: '   ' } as any);
    expect(h.captured?.remoteHostId).toBeNull();
  });

  it('空串 host 落 null', async () => {
    const storage = new DesktopSessionStorage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await storage.create({ ...base, remoteHostId: '' } as any);
    expect(h.captured?.remoteHostId).toBeNull();
  });

  it('有效 host trim 后保留', async () => {
    const storage = new DesktopSessionStorage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await storage.create({ ...base, remoteHostId: ' host-a ' } as any);
    expect(h.captured?.remoteHostId).toBe('host-a');
  });

  it('未传 host 落 null', async () => {
    const storage = new DesktopSessionStorage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await storage.create({ ...base } as any);
    expect(h.captured?.remoteHostId).toBeNull();
  });
});

describe('DesktopSessionStorage.create workspaceKind', () => {
  beforeEach(() => {
    h.captured = null;
    h.rows.clear();
  });

  const base = {
    id: 'dialogue-session',
    title: 'New Maker',
    workDir: '/userData/dialogues/2026-06-29/dialogue-session',
    model: 'gpt-5.4',
    agentKind: 'codex' as const,
  };

  it('保留显式 dialogue 分类,即使会话有真实 workingDir', async () => {
    const storage = new DesktopSessionStorage();
    await storage.create({ ...base, workspaceKind: 'dialogue' });
    expect(h.captured?.workspaceKind).toBe('dialogue');
    expect(h.captured?.workingDir).toBe('/userData/dialogues/2026-06-29/dialogue-session');
  });

  it('未传 workspaceKind 仍按历史默认 project 落库', async () => {
    const storage = new DesktopSessionStorage();
    await storage.create(base);
    expect(h.captured?.workspaceKind).toBe('project');
  });

  it('非法 workspaceKind 不会原样落库', async () => {
    const storage = new DesktopSessionStorage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await storage.create({ ...base, workspaceKind: 'scratch' } as any);
    expect(h.captured?.workspaceKind).toBe('project');
  });
});

describe('DesktopSessionStorage.create Review purpose', () => {
  beforeEach(() => {
    h.captured = null;
    h.rows.clear();
  });

  it('persists Review source in the same insert that creates the session', async () => {
    const storage = new DesktopSessionStorage();
    await storage.create({
      id: 'review-session',
      title: 'Review',
      workDir: '/repo',
      model: 'gpt-5.5',
      agentKind: 'codex',
      reviewMode: true,
    });
    expect(h.captured?.source).toBe('review');
  });
});

describe('DesktopSessionStorage.create workingDir 规范化', () => {
  beforeEach(() => {
    h.captured = null;
    h.rows.clear();
  });

  it('Windows 反斜杠路径入库前归一为 storage spelling', async () => {
    const storage = new DesktopSessionStorage();
    const created = await storage.create({
      id: 'windows-path-session',
      title: 'New Maker',
      workDir: 'D:\\repo\\project\\',
      model: 'gpt-5.4',
      agentKind: 'codex',
    });
    expect(h.captured?.workingDir).toBe('D:/repo/project');
    expect(created.workDir).toBe('D:/repo/project');
  });
});

describe('DesktopSessionStorage.compareAndClearSdkSessionId', () => {
  /**
   * 建行:行存储按 **DB 列名**(snake_case)存值 —— 与 drizzle 条件对象里的
   * SQLiteText.name 一致(谓词评估按列名匹配,不是 TS 属性名)。
   */
  function seedSession(id: string, sdkSessionId: string | null): void {
    h.rows.set(id, {
      id,
      title: 't',
      work_dir: '/repo',
      working_dir: '/repo',
      model: 'm',
      agent_kind: 'codex',
      effort: 'high',
      permission_mode: 'ask',
      status: 'active',
      total_token_usage: 0,
      total_cost_usd: 0,
      total_cost_is_approximate: 0,
      context_tokens: 0,
      context_window: 0,
      // DB 列名:sdk_session_id(schema: sdkSessionId: text('sdk_session_id'))。
      sdk_session_id: sdkSessionId,
    });
  }

  beforeEach(() => {
    h.captured = null;
    h.rows.clear();
  });

  it('CAS hit: 行内 sdk_session_id 与 expected 相等 → 清空 + changes=1 → true', async () => {
    seedSession('session-1', 'sdk-old');
    const storage = new DesktopSessionStorage();
    await expect(storage.compareAndClearSdkSessionId('session-1', 'sdk-old')).resolves.toBe(true);
    expect(h.rows.get('session-1')?.sdk_session_id).toBeNull();
  });

  it('CAS miss: 行内 sdk_session_id 已是并发新 ID → 未命中 changes=0 → false,新 ID 保留', async () => {
    // 并发方已把 sdk-a 替换为 sdk-b;旧恢复请求仍期望 sdk-a。
    seedSession('session-1', 'sdk-b');
    const storage = new DesktopSessionStorage();
    await expect(storage.compareAndClearSdkSessionId('session-1', 'sdk-a')).resolves.toBe(false);
    expect(h.rows.get('session-1')?.sdk_session_id).toBe('sdk-b');
  });

  it('未知 id → 未命中 → false', async () => {
    const storage = new DesktopSessionStorage();
    await expect(storage.compareAndClearSdkSessionId('missing', 'sdk-a')).resolves.toBe(false);
  });

  it('并发序列(CAS 契约核心):hit 后并发写回新 ID,旧 expected 的第二次 CAS 自然 miss', async () => {
    seedSession('s1', 'sdk-a');
    const storage = new DesktopSessionStorage();

    // 1) 恢复请求 A:CAS(s1, sdk-a) 命中,行内 sdk_session_id 被清空。
    await expect(storage.compareAndClearSdkSessionId('s1', 'sdk-a')).resolves.toBe(true);
    expect(h.rows.get('s1')?.sdk_session_id).toBeNull();

    // 2) 并发方立刻写回新 ID(真实状态迁移,不是手动改 runResult)。
    //    注意 CAS patch 写的也是 DB 列名(null 清空),直接改行同口径。
    h.rows.set('s1', { ...h.rows.get('s1'), sdk_session_id: 'sdk-b' });

    // 3) 旧恢复请求 B 重放 CAS(s1, sdk-a):条件 sdk_session_id='sdk-a' 对当前
    //    行(= sdk-b)自然未命中 → false。若实现漏掉 sdkSessionId 谓词,
    //    这次 update 会清掉 sdk-b,本断言与下一行断言同时变红。
    await expect(storage.compareAndClearSdkSessionId('s1', 'sdk-a')).resolves.toBe(false);
    expect(h.rows.get('s1')?.sdk_session_id).toBe('sdk-b');
  });

  it('谓词评估器 sanity:两个 eq 子条件都必须满足(and 语义)', async () => {
    seedSession('s1', 'sdk-a');
    const storage = new DesktopSessionStorage();
    // id 对但 expected 不对 → miss。
    await expect(storage.compareAndClearSdkSessionId('s1', 'sdk-nope')).resolves.toBe(false);
    expect(h.rows.get('s1')?.sdk_session_id).toBe('sdk-a');
  });
});
