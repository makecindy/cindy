/**
 * sessionRepoResetDefaults.test.ts
 * ---------------------------------------------------------------------------
 * `resetSessionToDefaults`(`/new` 语义)对 workingDir 的真实落库行为:
 *   - 渠道声明 refreshWorkingDirOnNew(微信/企微) ⇒ 刷到 prepareNewSession
 *     现解析的目录;
 *   - 未声明(目录恒定渠道) ⇒ 保留行里已有的目录;
 *   - prepared.workingDir 为空 ⇒ 不写空值。
 *
 * 跑真 SQLite(表结构从生产 schema 现推), 与 sessionRepoWorkspaceKind.test.ts
 * 同一套 harness —— slashCommands 的参数透传断言证明"传了开关", 这里证明
 * "开关真的改库"。
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => '/tmp/never-used-here' },
}));
vi.mock('../../../device-link/broadcast-tap', () => ({
  getSafeDataOwnerPushStamp: vi.fn(() => undefined),
  tapWindowBroadcast: vi.fn(),
}));
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  maskPath: (p: string) => p,
}));
vi.mock('../../../maker-host/session-provider-store', () => ({
  setSessionProvider: vi.fn(),
}));
vi.mock('../../defaultSessionSettings', () => ({
  getImDefaultEffortFor: vi.fn(() => 'high'),
  resolveImSessionDefaults: vi.fn(async () => ({
    agentKind: 'claude-code',
    model: 'claude-opus-4-8',
    effort: 'high',
    permissionMode: 'auto',
    fastMode: false,
    providerId: null,
  })),
}));

let db: ReturnType<typeof drizzle>;
vi.mock('../../../localDb/client/current', () => ({
  getDbClient: () => ({ drizzle: db }),
}));

const { sessions } = await import('../../../localDb/schema');
const { createImSessionRepo, resetSessionToDefaults } = await import('../sessionRepo');
import type { ImSessionRow } from '../sessionRepo';
import type { ImOrchestratorConfig, ImSessionNamespace } from '../types';

const OLD_DIR = '/tmp/im-working-dir/wecom-old';
const NEW_DIR = 'D:/projects/wecom-new';

const ns = {
  source: 'wecom',
  workspaceKind: 'dialogue',
  sessionIdFor: (bot: string, user: string) => `wecom_${bot}_${user}`,
  defaultTitle: () => 'WeCom',
  ensureWorkingDir: () => OLD_DIR,
  extraInsertColumns: (bot: string, user: string) => ({ imBotContextId: bot, imUserId: user }),
} as unknown as ImSessionNamespace;

function createTableSql(): string {
  const config = getTableConfig(sessions);
  const cols = config.columns.map((col) => {
    const parts = [`"${col.name}"`, col.getSQLType()];
    if (col.primary) parts.push('PRIMARY KEY');
    if (col.notNull) parts.push('NOT NULL');
    const dflt = col.default;
    if (dflt !== undefined && typeof dflt !== 'object') {
      parts.push(`DEFAULT ${typeof dflt === 'string' ? `'${dflt}'` : Number(dflt)}`);
    }
    return parts.join(' ');
  });
  return `CREATE TABLE "${config.name}" (${cols.join(', ')})`;
}

async function preparedRow(id: string, workingDir: string): Promise<ImSessionRow> {
  return {
    id,
    agentKind: 'claude-code',
    workingDir,
    model: 'claude-opus-4-8',
    effort: 'high',
    permissionMode: 'auto',
    fastMode: false,
    sdkSessionId: 'sdk-old',
    providerId: null,
  };
}

async function workingDirOf(id: string): Promise<string> {
  const rows = await db.select().from(sessions);
  return rows.find((r) => r.id === id)!.workingDir!;
}

beforeEach(() => {
  const raw = new Database(':memory:');
  raw.exec(createTableSql());
  db = drizzle(raw);
});

describe('resetSessionToDefaults 的 workingDir 行为', () => {
  it('refreshWorkingDir=true 时 /new 把行刷到最新解析的渠道目录', async () => {
    const repo = createImSessionRepo({ agentKind: 'claude-code' } as ImOrchestratorConfig, ns);
    const created = await repo.createSession('bot1', 'u1');
    expect(await workingDirOf(created.id)).toBe(OLD_DIR);

    // 用户在设置页改了渠道目录, /new 的 prepared 行带着新目录。
    await resetSessionToDefaults(
      created.id,
      {} as ImOrchestratorConfig,
      await preparedRow(created.id, NEW_DIR),
      {
        channel: 'wecom',
        refreshWorkingDir: true,
      },
    );

    expect(await workingDirOf(created.id)).toBe(NEW_DIR);
  });

  it('refreshWorkingDir=false 时 /new 不动行里已有的目录', async () => {
    const repo = createImSessionRepo({ agentKind: 'claude-code' } as ImOrchestratorConfig, ns);
    const created = await repo.createSession('bot1', 'u1');

    await resetSessionToDefaults(
      created.id,
      {} as ImOrchestratorConfig,
      await preparedRow(created.id, NEW_DIR),
      {
        channel: 'feishu',
        refreshWorkingDir: false,
      },
    );

    expect(await workingDirOf(created.id)).toBe(OLD_DIR);
  });

  it('prepared.workingDir 为空时即便声明了刷新也不写空值', async () => {
    const repo = createImSessionRepo({ agentKind: 'claude-code' } as ImOrchestratorConfig, ns);
    const created = await repo.createSession('bot1', 'u1');

    await resetSessionToDefaults(
      created.id,
      {} as ImOrchestratorConfig,
      await preparedRow(created.id, ''),
      {
        channel: 'wecom',
        refreshWorkingDir: true,
      },
    );

    expect(await workingDirOf(created.id)).toBe(OLD_DIR);
  });
});
