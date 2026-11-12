/**
 * 伙伴记忆全链（形成 → 存 → 取 → 用 → 删）的进程内集成测试。
 *
 * 这里刻意**不**用 mock 存储:
 *  - 真 `MakerMemoryManager` + 真 better-sqlite3 + 真 tmp 目录落盘;
 *  - 真 `createCindyMemoryMcpServer`,经 MCP SDK 的 InMemoryTransport 由一个
 *    「假模型回合」发 `call_tool({name:'memory_write'})` —— 与 Claude / Codex /
 *    PI 三个 harness 在真机上走的是同一条 registry 分发路径;
 *  - session ctx 用生产形状(`memoryScopeKey` 由 host 侧
 *    `buildBotMemoryScopeKey(botId)` 派生,`workingDir` 是项目目录),
 *    正是修复后的 piEnvironment / codexEnvironment / claude-code buildMcpServers
 *    注入的那份 ctx。
 *
 * 覆盖的五环:
 *  1. 形成 — 模型调 memory_write,不需要任何 bot 专属工具;
 *  2. 存   — 分片落在 `bot:<botId>` 的 store 目录,项目 store 一条都没有,
 *            账号级的 Cindy 记忆(`user-memory/`)也不会被伙伴碰到;
 *  3. 取   — 下一次会话启动读的 `store.getIndex()`(= host 的 readMemoryIndex,
 *            hydrateBotProfileRuntime 把它拼进 makerMemoryIndexSnapshot)含这条;
 *  4. 用   — 伙伴自己读到的 `store.list()` 与引擎同一份,且 `learned-`
 *            前缀契约成立;
 *  5. 删   — 删除 / 清空后引擎侧真没了,且下一次会话装配的索引里也不再出现。
 *
 * 无法在这里离线验证的:真 LLM 是否愿意写记忆、Electron IPC 布线、渲染层。
 *
 * 文件末尾另有一组「普通任务的两份记忆」:同一套真 manager + 真 MCP 分发,验证
 * memory 工具在账号级(user)与项目(project)两份之间的路由。放在这里是因为它要的
 * 正是这套不 mock 存储的 harness,另起文件只会把同样的初始化再付一遍。
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import DatabaseCtor from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Real better-sqlite3 + FTS rebuild on a temp disk. Windows CI shards this
// package next to other sqlite tests, and Defender can make that synchronous
// work exceed Vitest's default 5s — the learned-prefix case then times out
// and afterEach unlinks fts.db while the handle is still closing (EBUSY).
// Same bounded Windows allowance as maker-core memory sqlite tests;
// assertions stay unchanged.
vi.setConfig({
  testTimeout: process.platform === 'win32' ? 30_000 : 5_000,
  hookTimeout: process.platform === 'win32' ? 30_000 : 10_000,
});

import {
  MakerMemoryManager,
  buildBotMemoryScopeKey,
  buildMemoryScopeKey,
  memoryScopeDirName,
  parseBotMemoryScopeKey,
  USER_MEMORY_SCOPE_KEY,
  type Logger,
  type MemoryRecord,
} from '@cindy/maker-core';

import { createCindyMemoryMcpServer } from '../cindy_memoryMcpServer.js';
import { createLiziMcpProviders } from '../providers.js';
import type { LiziMcpSessionContext } from '../types.js';

const noopLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => noopLogger,
};

const BOT_ID = 'bot-release-helper';
const OTHER_BOT_ID = 'bot-note-taker';
const PROJECT_DIR = path.join(path.sep, 'repo', 'cindy');

/**
 * `learned-` 是记忆存储与 Bot Skill 工具共享的稳定约定。深度编辑入口直接
 * 打开伙伴的家,不再由 renderer 维护第二套分类逻辑。
 */
const LEARNED_SLUG_PREFIX = 'learned-';

let root: string;
let manager: MakerMemoryManager;
let databases: DatabaseCtor.Database[];

/** owner 作用域(登录态)由宿主注入;本测试默认「已就绪」,未登录态单列一个用例。 */
let ownerAvailable = true;
let memoryEnabled = true;

/**
 * 伙伴作用域一律按宿主的接线声明为独立作用域(host-factory 对每个有伙伴的宿主都这么做):
 * 伙伴只有自己那一份记忆,不读写账号级的 Cindy 记忆。`botHome` 只决定落盘位置 ——
 * 默认留在 `maker-memory/` 下的旧位置,true 时放进伙伴的家。
 */
function createManager(botHome = false): MakerMemoryManager {
  return new MakerMemoryManager({
    basePath: root,
    resolveBasePath: () => (ownerAvailable ? root : null),
    ownerScopeKey: () => (ownerAvailable ? 'local:owner-a:1' : 'local:none:1'),
    reloadEnabled: () => memoryEnabled,
    initialEnabled: memoryEnabled,
    isIndependentScope: (scopeKey: string) => parseBotMemoryScopeKey(scopeKey) !== null,
    ...(botHome ? {
      resolveStorageDir: (scopeKey: string) => {
        const botId = parseBotMemoryScopeKey(scopeKey);
        return botId ? path.join(root, 'bots', botId, 'memories') : null;
      },
    } : {}),
    sqliteFactory: (filePath) => {
      const database = new DatabaseCtor(filePath);
      databases.push(database);
      return database;
    },
    agents: {},
    logger: noopLogger,
  });
}

beforeEach(async () => {
  ownerAvailable = true;
  memoryEnabled = true;
  databases = [];
  root = await mkdtemp(path.join(tmpdir(), 'bot-memory-chain-'));
  manager = createManager();
});

afterEach(async () => {
  // Windows cannot remove fts.db while the manager still owns an open connection.
  manager.dispose();
  for (const database of databases) expect(database.open).toBe(false);
  try {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') throw error;
    // Defender / indexer can keep fts.db briefly after close. Leave the temp
    // directory for the OS, matching maker-core memory scope-resolver cleanup.
  }
});

/**
 * 起一个真 cindy_memory MCP server,并把 session ctx 固定成「某个 Bot 的一次
 * 会话」。ctx 形状与修复后的三个 harness 注入一致:workingDir 仍是项目目录,
 * memoryScopeKey 才是伙伴记忆的定位键。
 */
async function connectBotSession(
  ctx: Partial<LiziMcpSessionContext> & { agentKind: LiziMcpSessionContext['agentKind'] },
  throughProvider = false,
) {
  const sessionContext: LiziMcpSessionContext = {
    workingDir: PROJECT_DIR,
    vendorOptions: {},
    ...ctx,
  } as LiziMcpSessionContext;
  const deps = {
    getManager: () => manager,
    workdir: sessionContext.workingDir,
    getSessionContext: () => sessionContext,
    logger: noopLogger,
  };
  let server: ReturnType<typeof createCindyMemoryMcpServer>;
  if (throughProvider) {
    const provider = createLiziMcpProviders({ memory: deps })
      .find((item) => item.name === 'cindy_memory')!;
    expect(provider.isEnabled?.(sessionContext)).toBe(true);
    expect(provider.isEnabled?.({ ...sessionContext, memoryScopeKey: undefined })).toBe(false);
    // Claude binds a concrete Session at registration; shared Codex/Pi
    // bridges start without one and resolve it at tool-call time.
    const registrationContext: LiziMcpSessionContext = ctx.agentKind === 'claude-code'
      ? sessionContext
      : { agentKind: ctx.agentKind, workingDir: '', getSessionContext: () => sessionContext };
    expect(provider.isEnabled?.(registrationContext)).toBe(true);
    const config = provider.toClaudeSdkConfig(registrationContext) as { instance: typeof server };
    server = config.instance;
  } else {
    server = createCindyMemoryMcpServer(deps);
  }
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'bot-memory-chain', version: '0.0.0' });
  await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
  return {
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

type Envelope = { ok: true; data: unknown } | { ok: false; code: string; message: string };

function parseEnvelope(result: unknown): Envelope {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  const first = content.find((block) => block.type === 'text');
  if (!first) throw new Error('tool result carried no text block');
  return JSON.parse(first.text) as Envelope;
}

/** 「假模型回合」:模型经二级分派写一条记忆。 */
async function modelWritesMemory(
  client: Client,
  args: { type: string; name: string; title: string; description: string; body: string },
): Promise<Envelope> {
  return parseEnvelope(
    await client.callTool({
      name: 'call_tool',
      arguments: { name: 'memory_write', args },
    }),
  );
}

/** 主进程「取」这一环的真实实现(maker-host buildBotRuntimeDeps.readMemoryIndex)。 */
async function readMemoryIndex(scopeKey: string): Promise<string> {
  return (await manager.getStore(scopeKey)).getIndex();
}

/** 设置页「TA 记得的 / TA 学会的」的真实实现(register.ts BOT_MEMORY_LIST)。 */
async function botMemoryList(botId: string): Promise<MemoryRecord[]> {
  const store = await manager.getStore(buildBotMemoryScopeKey(botId), { skipDisabledCheck: true });
  return store.list();
}

function partition(records: readonly MemoryRecord[]): {
  memories: MemoryRecord[];
  learned: MemoryRecord[];
} {
  const memories: MemoryRecord[] = [];
  const learned: MemoryRecord[] = [];
  for (const record of records) {
    if (record.frontmatter.type === 'digest') continue;
    if (record.slug.startsWith(LEARNED_SLUG_PREFIX)) learned.push(record);
    else memories.push(record);
  }
  return { memories, learned };
}

describe('Cindy Bot 记忆全链(形成 → 存 → 取 → 用 → 删)', () => {
  it.each(['claude-code', 'codex', 'pi'] as const)('keeps %s Bot registration and MCP reads/writes available with global memory off', async (agentKind) => {
    manager.dispose();
    memoryEnabled = false;
    manager = createManager(true);
    const botScope = buildBotMemoryScopeKey(BOT_ID);
    const bot = await connectBotSession({ agentKind, memoryScopeKey: botScope }, true);
    const project = await connectBotSession({ agentKind: 'codex' });
    const record = {
      type: 'user', name: 'independent', title: 'Independent',
      description: 'Bot-owned preference', body: 'Keep answers concise.',
    };
    try {
      expect(await modelWritesMemory(bot.client, record)).toMatchObject({ ok: true });
      const read = await bot.client.callTool({
        name: 'call_tool',
        arguments: { name: 'memory_read', args: { filename: 'user_independent.md' } },
      });
      expect(parseEnvelope(read)).toMatchObject({ ok: true, data: { body: record.body } });
      expect(await readMemoryIndex(botScope)).toContain('user_independent.md');
      expect(existsSync(path.join(root, 'bots', BOT_ID, 'memories', 'user_independent.md'))).toBe(true);
      expect(await modelWritesMemory(project.client, record)).toMatchObject({
        ok: false, code: 'MAKER_MEMORY_NOT_READY',
      });
      expect(existsSync(path.join(root, 'maker-memory'))).toBe(false);

      // Independent from the global toggle does not mean independent from
      // the account boundary: the same bound Bot must still fail closed.
      ownerAvailable = false;
      expect(await modelWritesMemory(bot.client, { ...record, name: 'signed-out' })).toMatchObject({
        ok: false, code: 'MAKER_MEMORY_NOT_READY',
      });
    } finally {
      await bot.cleanup();
      await project.cleanup();
    }
  });

  it('形成/存:模型的一次 memory_write 落进伙伴自己的记忆空间,不进项目记忆', async () => {
    const session = await connectBotSession({
      agentKind: 'claude-code',
      sessionId: 'session-1',
      memoryScopeKey: buildBotMemoryScopeKey(BOT_ID),
    });
    try {
      const written = await modelWritesMemory(session.client, {
        type: 'user',
        name: 'chris-cadence',
        title: 'Chris 的节奏偏好',
        description: '周报只要三条,不要展开',
        body: 'Chris 说过:周报只要三条要点,不要展开叙述。',
      });
      expect(written.ok).toBe(true);
    } finally {
      await session.cleanup();
    }

    // 存:落盘位置就是 bot scope 目录,项目 scope 目录压根没被创建。
    const botDir = path.join(root, 'maker-memory', memoryScopeDirName(buildBotMemoryScopeKey(BOT_ID)));
    const projectDir = path.join(root, 'maker-memory', memoryScopeDirName(buildMemoryScopeKey(PROJECT_DIR)));
    expect(existsSync(botDir)).toBe(true);
    expect(existsSync(projectDir)).toBe(false);
    expect(await readdir(botDir)).toEqual(expect.arrayContaining(['user_chris-cadence.md']));
    // 伙伴写的 `user` 类记忆留在伙伴自己那份里,不进账号级的 Cindy 记忆。
    expect(existsSync(path.join(root, 'user-memory'))).toBe(false);

    // 项目 store 里一条都没有 —— 这是「两张皮」回归的直接哨兵。
    const projectStore = await manager.getStore(buildMemoryScopeKey(PROJECT_DIR));
    expect(await projectStore.list()).toEqual([]);
  });

  it('存:两个伙伴在同一个项目目录下互不串味', async () => {
    for (const [botId, slug] of [
      [BOT_ID, 'release-notes-shape'],
      [OTHER_BOT_ID, 'meeting-notes-shape'],
    ] as const) {
      const session = await connectBotSession({
        agentKind: 'pi',
        sessionId: `session-${botId}`,
        memoryScopeKey: buildBotMemoryScopeKey(botId),
      });
      try {
        expect(
          (
            await modelWritesMemory(session.client, {
              type: 'project',
              name: slug,
              title: slug,
              description: `${botId} 的做法`,
              body: `${botId} 记下的内容。`,
            })
          ).ok,
        ).toBe(true);
      } finally {
        await session.cleanup();
      }
    }

    expect((await botMemoryList(BOT_ID)).map((r) => r.slug)).toEqual(['release-notes-shape']);
    expect((await botMemoryList(OTHER_BOT_ID)).map((r) => r.slug)).toEqual(['meeting-notes-shape']);
  });

  it('取:下一次会话装配的索引里读得到上一次会话写的记忆', async () => {
    const first = await connectBotSession({
      agentKind: 'codex',
      sessionId: 'session-a',
      memoryScopeKey: buildBotMemoryScopeKey(BOT_ID),
    });
    try {
      await modelWritesMemory(first.client, {
        type: 'feedback',
        name: 'no-emoji',
        title: '别用 emoji',
        description: 'Chris 明确说过不要 emoji',
        body: '**Why:** Chris 说过。\n**How to apply:** 所有回复都不加 emoji。',
      });
    } finally {
      await first.cleanup();
    }

    // 这就是 hydrateBotProfileRuntime 拿去拼 makerMemoryIndexSnapshot 的那份索引。
    const index = await readMemoryIndex(buildBotMemoryScopeKey(BOT_ID));
    expect(index).toContain('别用 emoji');
    expect(index).toContain('Chris 明确说过不要 emoji');

    // 同一份 store 在新会话里也检索得到(memory_search 走的是同一个 scope key)。
    const second = await connectBotSession({
      agentKind: 'codex',
      sessionId: 'session-b',
      memoryScopeKey: buildBotMemoryScopeKey(BOT_ID),
    });
    try {
      const searched = parseEnvelope(
        await second.client.callTool({
          name: 'call_tool',
          arguments: { name: 'memory_search', args: { query: 'emoji' } },
        }),
      );
      expect(searched.ok).toBe(true);
      expect(JSON.stringify((searched as { data: unknown }).data)).toContain('no-emoji');
    } finally {
      await second.cleanup();
    }
  });

  it('用:设置页两个列表读的就是引擎那份,learned- 前缀切分成立', async () => {
    const session = await connectBotSession({
      agentKind: 'claude-code',
      sessionId: 'session-c',
      memoryScopeKey: buildBotMemoryScopeKey(BOT_ID),
    });
    try {
      await modelWritesMemory(session.client, {
        type: 'user',
        name: 'chris-cadence',
        title: 'Chris 的节奏偏好',
        description: '周报只要三条',
        body: '周报只要三条要点。',
      });
      await modelWritesMemory(session.client, {
        type: 'project',
        name: 'learned-weekly-report-shape',
        title: '周报的写法',
        description: '先结论后依据,三条封顶',
        body: '固定用「结论 / 依据 / 下一步」三段。',
      });
    } finally {
      await session.cleanup();
    }

    const records = await botMemoryList(BOT_ID);
    const { memories, learned } = partition(records);
    expect(memories.map((r) => r.frontmatter.title)).toEqual(['Chris 的节奏偏好']);
    expect(learned.map((r) => r.frontmatter.title)).toEqual(['周报的写法']);
    // 同源判据:UI 列出来的 filename 就是引擎索引里那条。
    const index = await readMemoryIndex(buildBotMemoryScopeKey(BOT_ID));
    for (const record of records) expect(index).toContain(record.frontmatter.title);
  });

  it('删:单条删除后引擎真没了,下一次会话装配的索引也不再包含', async () => {
    const session = await connectBotSession({
      agentKind: 'claude-code',
      sessionId: 'session-d',
      memoryScopeKey: buildBotMemoryScopeKey(BOT_ID),
    });
    try {
      await modelWritesMemory(session.client, {
        type: 'user',
        name: 'keep-me',
        title: '留着的',
        description: '留着',
        body: '留着。',
      });
      await modelWritesMemory(session.client, {
        type: 'user',
        name: 'delete-me',
        title: '要删的',
        description: '删掉',
        body: '删掉。',
      });
    } finally {
      await session.cleanup();
    }

    const before = await botMemoryList(BOT_ID);
    const target = before.find((record) => record.slug === 'delete-me');
    expect(target).toBeDefined();

    // register.ts BOT_MEMORY_DELETE 的实现。
    const store = await manager.getStore(buildBotMemoryScopeKey(BOT_ID), { skipDisabledCheck: true });
    await store.delete(target!.filename);

    expect((await botMemoryList(BOT_ID)).map((r) => r.slug)).toEqual(['keep-me']);
    const index = await readMemoryIndex(buildBotMemoryScopeKey(BOT_ID));
    expect(index).not.toContain('要删的');
    expect(index).toContain('留着的');

    // 新会话里模型也读不到了(memory_read 直报 NOT_FOUND)。
    const next = await connectBotSession({
      agentKind: 'claude-code',
      sessionId: 'session-e',
      memoryScopeKey: buildBotMemoryScopeKey(BOT_ID),
    });
    try {
      const read = parseEnvelope(
        await next.client.callTool({
          name: 'call_tool',
          arguments: { name: 'memory_read', args: { filename: target!.filename } },
        }),
      );
      expect(read.ok).toBe(false);
      expect((read as { code: string }).code).toBe('NOT_FOUND');
    } finally {
      await next.cleanup();
    }
  });

  it('删:清空后伙伴记忆归零,且不碰另一个伙伴', async () => {
    for (const botId of [BOT_ID, OTHER_BOT_ID]) {
      const session = await connectBotSession({
        agentKind: 'pi',
        sessionId: `session-${botId}`,
        memoryScopeKey: buildBotMemoryScopeKey(botId),
      });
      try {
        await modelWritesMemory(session.client, {
          type: 'user',
          name: 'shared-slug',
          title: `${botId} 的一条`,
          description: '一条',
          body: '内容。',
        });
      } finally {
        await session.cleanup();
      }
    }

    // register.ts BOT_MEMORY_CLEAR 的实现。
    await manager.resetWorkdir(buildBotMemoryScopeKey(BOT_ID));

    expect(await botMemoryList(BOT_ID)).toEqual([]);
    expect(await readMemoryIndex(buildBotMemoryScopeKey(BOT_ID))).not.toContain(`${BOT_ID} 的一条`);
    expect((await botMemoryList(OTHER_BOT_ID)).map((r) => r.slug)).toEqual(['shared-slug']);
  });

  it('回归:ctx 丢了 memoryScopeKey 就会写进 Cindy 自己的记忆(这正是修好的那条缝)', async () => {
    // 故意模拟修复前的 piEnvironment / cc-remote-mcp:ctx 只有 workingDir,
    // 工具把它当成 PROJECT_DIR 的普通任务。
    const session = await connectBotSession({ agentKind: 'pi', sessionId: 'session-legacy' });
    try {
      await modelWritesMemory(session.client, {
        type: 'user',
        name: 'stray',
        title: '走丢的一条',
        description: '走丢',
        body: '走丢。',
      });
    } finally {
      await session.cleanup();
    }
    expect(await botMemoryList(BOT_ID)).toEqual([]);
    // 普通任务的 `user` 类记忆进账号级那一份(每个项目都生效),不进项目那一份。
    const userStore = await manager.getStore(USER_MEMORY_SCOPE_KEY);
    expect((await userStore.list()).map((r) => r.slug)).toEqual(['stray']);
    const projectStore = await manager.getStore(buildMemoryScopeKey(PROJECT_DIR));
    expect(await projectStore.list()).toEqual([]);
  });

  it('未登录:owner 未就绪时不静默落临时目录,而是明确报 MAKER_MEMORY_NOT_READY', async () => {
    ownerAvailable = false;
    const session = await connectBotSession({
      agentKind: 'claude-code',
      sessionId: 'session-signed-out',
      memoryScopeKey: buildBotMemoryScopeKey(BOT_ID),
    });
    try {
      const written = await modelWritesMemory(session.client, {
        type: 'user',
        name: 'signed-out',
        title: '未登录',
        description: '未登录',
        body: '未登录。',
      });
      expect(written.ok).toBe(false);
      expect((written as { code: string }).code).toBe('MAKER_MEMORY_NOT_READY');
    } finally {
      await session.cleanup();
    }
    expect(existsSync(path.join(root, 'maker-memory'))).toBe(false);

    // owner 就绪后同一个伙伴照常可写可读 —— 记忆本身不依赖任何远程服务。
    ownerAvailable = true;
    const back = await connectBotSession({
      agentKind: 'claude-code',
      sessionId: 'session-signed-in',
      memoryScopeKey: buildBotMemoryScopeKey(BOT_ID),
    });
    try {
      expect(
        (
          await modelWritesMemory(back.client, {
            type: 'user',
            name: 'signed-in',
            title: '登录后',
            description: '登录后',
            body: '登录后。',
          })
        ).ok,
      ).toBe(true);
    } finally {
      await back.cleanup();
    }
    expect((await botMemoryList(BOT_ID)).map((r) => r.slug)).toEqual(['signed-in']);
  });
});

/**
 * 普通任务的两份记忆(docs/product-rules/cindy-memory.md §1)。
 *
 * 入口:模型经 `call_tool` 调 memory_write / read / list / search / delete / consolidate,
 * 会话是一次普通项目任务(ctx 没有 memoryScopeKey,workingDir 是项目目录)。
 * 保护的规则:写到哪一份由 `scope` 决定,不传时 `user` 类进账号级、其余进项目;
 * 读、删不传 `scope` 时两份都找、跟着文件走;两份里有同名文件时必须指明,不替模型猜;
 * 合并可以把另一份里的来源收进来并从那一份删掉。这些规则写在工具里,不靠提示词。
 */
describe('Cindy 记忆工具:账号级与项目两份之间的路由', () => {
  let session: Awaited<ReturnType<typeof connectBotSession>>;

  beforeEach(async () => {
    session = await connectBotSession({ agentKind: 'codex', sessionId: 'project-task' });
  });
  afterEach(async () => {
    await session.cleanup();
  });

  async function call(name: string, args: Record<string, unknown>): Promise<Envelope> {
    return parseEnvelope(
      await session.client.callTool({ name: 'call_tool', arguments: { name, args } }),
    );
  }
  const data = (envelope: Envelope) => (envelope as { data: Record<string, unknown> }).data;
  const entry = (type: string, name: string, extra: Record<string, unknown> = {}) => ({
    type, name, title: `title ${name}`, description: `about ${name}`, body: `body of ${name}`, ...extra,
  });
  /** 两份记忆各自落盘了哪些文件(直接问 manager,不经被测工具)。 */
  async function stored(): Promise<{ user: string[]; project: string[] }> {
    const filenames = async (scopeKey: string) =>
      (await (await manager.getStore(scopeKey)).list()).map((r) => r.filename);
    return {
      user: await filenames(USER_MEMORY_SCOPE_KEY),
      project: await filenames(buildMemoryScopeKey(PROJECT_DIR)),
    };
  }

  it('写:user 类默认进账号级,其余默认进项目,显式 scope 优先;list / search 标出每条在哪一份', async () => {
    expect(data(await call('memory_write', entry('user', 'nickname')))).toMatchObject({ scope: 'user' });
    expect(data(await call('memory_write', entry('feedback', 'repo-style')))).toMatchObject({ scope: 'project' });
    expect(data(await call('memory_write', entry('feedback', 'everywhere-style', { scope: 'user' }))))
      .toMatchObject({ scope: 'user' });

    expect(await stored()).toEqual({
      user: ['feedback_everywhere-style.md', 'user_nickname.md'],
      project: ['feedback_repo-style.md'],
    });

    const listed = data(await call('memory_list', {})) as unknown as Array<{ scope: string; filename: string }>;
    expect(listed.map((r) => `${r.scope}:${r.filename}`).sort()).toEqual([
      'project:feedback_repo-style.md',
      'user:feedback_everywhere-style.md',
      'user:user_nickname.md',
    ]);
    const { hits } = data(await call('memory_search', { query: 'style' })) as unknown as {
      hits: Array<{ scope: string; filename: string }>;
    };
    expect(hits.map((h) => `${h.scope}:${h.filename}`).sort()).toEqual([
      'project:feedback_repo-style.md',
      'user:feedback_everywhere-style.md',
    ]);
  });

  it('读 / 删不传 scope:两份都找,跟着文件所在的那一份走', async () => {
    await call('memory_write', entry('user', 'nickname'));
    await call('memory_write', entry('feedback', 'repo-style'));

    expect(data(await call('memory_read', { filename: 'user_nickname.md' })))
      .toMatchObject({ scope: 'user', body: expect.stringContaining('body of nickname') });
    expect(data(await call('memory_read', { filename: 'feedback_repo-style.md' })))
      .toMatchObject({ scope: 'project', body: expect.stringContaining('body of repo-style') });

    expect(data(await call('memory_delete', { filename: 'user_nickname.md' })))
      .toEqual({ deleted: 'user_nickname.md', scope: 'user' });
    expect(await stored()).toEqual({ user: [], project: ['feedback_repo-style.md'] });
  });

  it('两份里有同名文件:不传 scope 报 INVALID_PARAMS 且什么都不动,指明 scope 后照常', async () => {
    await call('memory_write', entry('feedback', 'style', { body: 'project copy' }));
    await call('memory_write', entry('feedback', 'style', { body: 'user copy', scope: 'user' }));

    for (const tool of ['memory_read', 'memory_delete']) {
      expect(await call(tool, { filename: 'feedback_style.md' }), tool)
        .toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
    }
    expect(await stored()).toEqual({ user: ['feedback_style.md'], project: ['feedback_style.md'] });

    expect(data(await call('memory_read', { filename: 'feedback_style.md', scope: 'user' })))
      .toMatchObject({ scope: 'user', body: expect.stringContaining('user copy') });
  });

  it('合并:来源在另一份记忆里时,合并成功后从那一份删掉', async () => {
    // 项目里记了一条其实是通用偏好的 feedback;把它和账号级已有的一条并成 user 类。
    await call('memory_write', entry('feedback', 'concise-here'));
    await call('memory_write', entry('feedback', 'concise-everywhere', { scope: 'user' }));

    const merged = await call('memory_consolidate', {
      sources: ['feedback_concise-here.md', 'feedback_concise-everywhere.md'],
      target: entry('user', 'concise'),
    });
    expect(data(merged)).toMatchObject({ scope: 'user', filename: 'user_concise.md' });
    expect([...(data(merged).deletedSources as string[])].sort()).toEqual([
      'feedback_concise-everywhere.md', 'feedback_concise-here.md',
    ]);
    expect(await stored()).toEqual({ user: ['user_concise.md'], project: [] });
  });

  // 评审 (Greptile P1): 目标在两份里都有又没指明 scope 时, 不替调用方挑一份去覆盖。
  it('合并的目标在两份里都有同名文件:不传 scope 报 INVALID_PARAMS 且什么都不动,指明 scope 后照常', async () => {
    await call('memory_write', entry('feedback', 'style', { body: 'project copy' }));
    await call('memory_write', entry('feedback', 'style', { body: 'user copy', scope: 'user' }));
    await call('memory_write', entry('feedback', 'extra', { body: 'extra' }));

    const args = { sources: ['feedback_extra.md'], target: entry('feedback', 'style', { body: 'merged' }) };
    expect(await call('memory_consolidate', args)).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
    expect(await stored()).toEqual({ user: ['feedback_style.md'], project: ['feedback_extra.md', 'feedback_style.md'] });
    expect(data(await call('memory_read', { filename: 'feedback_style.md', scope: 'user' })))
      .toMatchObject({ body: expect.stringContaining('user copy') });

    expect(data(await call('memory_consolidate', { ...args, scope: 'project' })))
      .toMatchObject({ scope: 'project', filename: 'feedback_style.md' });
    expect(await stored()).toEqual({ user: ['feedback_style.md'], project: ['feedback_style.md'] });
  });
});
