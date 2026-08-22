/**
 * 每伙伴交付物投影的行为契约。
 *
 * 覆盖:委派产物 + 会话产出文件 + 消息附件三条来源的聚合、多伙伴隔离、去重、
 * 上限截断,以及「不存在的文件不出现」这条存在性门槛。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle> | null,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, handler);
    }),
  },
}));
vi.mock('../../client/current', () => ({
  getDbClient: () => ({ drizzle: h.db }),
  tryGetDbClient: () => ({ drizzle: h.db }),
}));
vi.mock('../../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: vi.fn(),
}));

import { listBotArtifacts, registerBotArtifactIpc } from '../botArtifacts';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-bot-artifacts-'));
let sqlite: Database.Database | null = null;

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** 在临时目录里造一个真文件并返回绝对路径(存在性门槛要求文件真的在)。 */
function writeFile(relPath: string): string {
  const abs = path.join(tmpRoot, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'x');
  return abs;
}

function createDb(): void {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL DEFAULT 'New Maker',
      working_dir TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY NOT NULL,
      client_id TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_use_id TEXT,
      agent_meta TEXT,
      agent_kind TEXT,
      created_at INTEGER NOT NULL,
      rewind_at INTEGER
    );
    CREATE TABLE bot_profiles (
      id TEXT PRIMARY KEY NOT NULL,
      display_name TEXT NOT NULL,
      description TEXT DEFAULT '' NOT NULL,
      avatar TEXT DEFAULT '🤖' NOT NULL,
      avatar_color TEXT DEFAULT 'violet' NOT NULL,
      status TEXT DEFAULT 'active' NOT NULL,
      current_version INTEGER DEFAULT 1 NOT NULL,
      canonical_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE bot_session_links (
      id TEXT PRIMARY KEY NOT NULL,
      bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      profile_version INTEGER DEFAULT 1 NOT NULL,
      role TEXT NOT NULL,
      channel_id TEXT,
      route_key TEXT,
      created_at INTEGER NOT NULL,
      archived_at INTEGER
    );
    CREATE TABLE bot_delegations (
      id TEXT PRIMARY KEY NOT NULL,
      requesting_bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
      target_bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
      parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      child_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      objective TEXT NOT NULL,
      context_refs_json TEXT DEFAULT '[]' NOT NULL,
      artifact_refs_json TEXT DEFAULT '[]' NOT NULL,
      permission_snapshot_json TEXT DEFAULT '{}' NOT NULL,
      lineage_json TEXT DEFAULT '[]' NOT NULL,
      target_profile_version INTEGER NOT NULL,
      depth INTEGER DEFAULT 1 NOT NULL,
      budget_tokens INTEGER,
      tokens_used INTEGER DEFAULT 0 NOT NULL,
      status TEXT DEFAULT 'queued' NOT NULL,
      result_summary TEXT,
      output_artifacts_json TEXT DEFAULT '[]' NOT NULL,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      accepted_at INTEGER,
      completed_at INTEGER,
      updated_at INTEGER NOT NULL
    );
  `);
  h.db = drizzle(sqlite);
}

function addBot(id: string, sessionId: string, workingDir: string): void {
  sqlite!
    .prepare(
      'INSERT INTO sessions (id, working_dir, created_at, updated_at) VALUES (?, ?, 1, 1)',
    )
    .run(sessionId, workingDir);
  sqlite!
    .prepare(
      'INSERT INTO bot_profiles (id, display_name, canonical_session_id, created_at, updated_at) VALUES (?, ?, ?, 1, 1)',
    )
    .run(id, id, sessionId);
  sqlite!
    .prepare(
      "INSERT INTO bot_session_links (id, bot_id, session_id, role, created_at) VALUES (?, ?, ?, 'canonical', 1)",
    )
    .run(`link-${id}`, id, sessionId);
}

function addMessage(
  sessionId: string,
  clientId: string,
  role: string,
  content: unknown,
  createdAt: number,
): void {
  sqlite!
    .prepare(
      'INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(`m-${clientId}`, clientId, sessionId, role, JSON.stringify(content), createdAt);
}

beforeEach(() => {
  h.handlers.clear();
  createDb();
});

describe('bot artifact projection', () => {
  it('aggregates delegation outputs, generated files and message attachments', async () => {
    addBot('bot-a', 'session-a', tmpRoot);
    const generated = writeFile('report.docx');
    const attached = writeFile('inbox/notes.md');
    addMessage(
      'session-a',
      'c1',
      'tool_use',
      { toolName: 'Write', input: { file_path: generated } },
      1_000,
    );
    addMessage(
      'session-a',
      'c2',
      'user',
      { text: 'here', files: [{ name: 'notes.md', path: attached, size: 12 }] },
      2_000,
    );
    sqlite!
      .prepare(
        `INSERT INTO bot_delegations
         (id, requesting_bot_id, target_bot_id, objective, target_profile_version,
          status, output_artifacts_json, created_at, completed_at, updated_at)
         VALUES (?, ?, ?, 'do it', 1, 'completed', ?, 1, 3000, 3000)`,
      )
      .run(
        'del-1',
        'bot-a',
        'bot-a',
        JSON.stringify([{ ref: 'cindy-media://blobs/abc.png', kind: 'image' }]),
      );

    const result = await listBotArtifacts({ botId: 'bot-a' });
    expect(result.botId).toBe('bot-a');
    expect(result.truncated).toBe(false);
    // 时间倒序:委派产物(3000) > 附件(2000) > 产出文件(1000)。
    expect(result.items.map((item) => item.source)).toEqual([
      'delegation',
      'attachment',
      'generated',
    ]);
    expect(result.items.map((item) => item.category)).toEqual(['image', 'doc', 'doc']);
    // 协议引用不暴露磁盘路径。
    expect(result.items[0]!.path).toBeNull();
    expect(result.items[0]!.ref).toBe('cindy-media://blobs/abc.png');
    // 本机文件补齐了体积。
    expect(result.items[2]!.sizeBytes).toBe(1);
  });

  /*
    协议引用的存在性。早前这一类一律放行,于是**字节已经被回收的作品仍然留在
    网格里**,点开必然失败(只能靠打开失败的 toast 兜底)。现在它们也过同一道闸:
    在主进程内解成绝对路径 → stat,路径不写回条目。
  */
  describe('协议引用的存在性', () => {
    const resolveRefPath = (ref: string) =>
      ref.startsWith('cindy-media://') ? path.join(tmpRoot, ref.slice('cindy-media://'.length)) : null;

    function addDelegationArtifact(ref: string, kind: string) {
      sqlite!
        .prepare(
          `INSERT INTO bot_delegations
           (id, requesting_bot_id, target_bot_id, objective, target_profile_version,
            status, output_artifacts_json, created_at, completed_at, updated_at)
           VALUES (?, 'bot-a', 'bot-a', 'do it', 1, 'completed', ?, 1, 3000, 3000)`,
        )
        .run(`del-${ref}`, JSON.stringify([{ ref, kind }]));
    }

    it('字节已被回收的引用不再出现在仓库里', async () => {
      addBot('bot-a', 'session-a', tmpRoot);
      addDelegationArtifact('cindy-media://gone.png', 'image');

      // 不给解析器 = 与加闸之前逐字同行为:放行。
      expect((await listBotArtifacts({ botId: 'bot-a' })).items).toHaveLength(1);
      // 给了解析器,而磁盘上没有这个字节 → 摘掉。
      const filtered = await listBotArtifacts({ botId: 'bot-a' }, { resolveRefPath });
      expect(filtered.items).toEqual([]);
    });

    it('字节还在的引用照常出现,且不把解出来的路径写回条目', async () => {
      addBot('bot-a', 'session-a', tmpRoot);
      fs.writeFileSync(path.join(tmpRoot, 'kept.png'), 'xy');
      addDelegationArtifact('cindy-media://kept.png', 'image');

      const result = await listBotArtifacts({ botId: 'bot-a' }, { resolveRefPath });
      expect(result.items).toHaveLength(1);
      // renderer 那边仍然只看得到协议地址 —— 解出来的绝对路径只用于这一次判定。
      expect(result.items[0]!.path).toBeNull();
      expect(result.items[0]!.ref).toBe('cindy-media://kept.png');
      // 顺带补齐了体积。
      expect(result.items[0]!.sizeBytes).toBe(2);
    });

    it('解析器认不出的协议一律放行,不因为判不了就删掉用户的作品', async () => {
      addBot('bot-a', 'session-a', tmpRoot);
      addDelegationArtifact('xdt-image://legacy-domain-asset', 'image');

      const result = await listBotArtifacts({ botId: 'bot-a' }, { resolveRefPath });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.ref).toBe('xdt-image://legacy-domain-asset');
    });
  });

  /*
    这一条盯的是一个具体故障:**伙伴做出来的图在对话里好好地显示着,作品集里
    一张都没有。** 图和视频不是文件写入 —— 它们从工具结果的 xdt_image_urls /
    xdt_video_urls 里回来,而投影原来只认「文件工具的新建」和「消息附件」两条。
  */
  it('picks up images and videos that came back in tool results', async () => {
    addBot('bot-a', 'session-a', tmpRoot);
    addMessage(
      'session-a',
      'm1',
      'tool_result',
      {
        xdt_image_urls: ['cindy-media://blobs/cover.png'],
        xdt_video_urls: ['cindy-media://blobs/clip'],
      },
      5_000,
    );

    const result = await listBotArtifacts({ botId: 'bot-a' });
    expect(result.items.map((item) => item.source)).toEqual(['media', 'media']);
    /*
      两条地址都是 `cindy-media://<指纹>`,长得一模一样、都没有扩展名 ——
      分得开它们的**只有**「它出现在结果的哪个字段里」。靠地址猜的话两条都会
      落进 other。
    */
    expect(result.items.map((item) => item.category).sort()).toEqual(['image', 'video']);
    // 协议引用不暴露磁盘路径,也不参与存在性 stat(媒体仓绝对路径不出主进程)。
    for (const item of result.items) {
      expect(item.path).toBeNull();
      expect(item.ref?.startsWith('cindy-media://')).toBe(true);
    }
  });

  it('leaves out media the tool asked not to render', async () => {
    addBot('bot-a', 'session-a', tmpRoot);
    addMessage(
      'session-a',
      'm1',
      'tool_result',
      { _xdt_render_image: false, xdt_image_urls: ['cindy-media://blobs/hidden.png'] },
      5_000,
    );
    // 不上屏的东西不该出现在「TA 做出来的东西」里。
    expect((await listBotArtifacts({ botId: 'bot-a' })).items).toEqual([]);
  });

  it('keeps each teammate to its own artifacts', async () => {
    addBot('bot-a', 'session-a', tmpRoot);
    addBot('bot-b', 'session-b', tmpRoot);
    const fileA = writeFile('a/only-a.md');
    const fileB = writeFile('b/only-b.md');
    addMessage('session-a', 'a1', 'tool_use', { toolName: 'Write', input: { file_path: fileA } }, 10);
    addMessage('session-b', 'b1', 'tool_use', { toolName: 'Write', input: { file_path: fileB } }, 10);

    const a = await listBotArtifacts({ botId: 'bot-a' });
    const b = await listBotArtifacts({ sessionId: 'session-b' });
    expect(a.items.map((item) => item.name)).toEqual(['only-a.md']);
    expect(b.botId).toBe('bot-b');
    expect(b.items.map((item) => item.name)).toEqual(['only-b.md']);
  });

  it('attributes delegation outputs to the teammate that produced them', async () => {
    addBot('bot-a', 'session-a', tmpRoot);
    addBot('bot-b', 'session-b', tmpRoot);
    sqlite!
      .prepare(
        `INSERT INTO bot_delegations
         (id, requesting_bot_id, target_bot_id, objective, target_profile_version,
          status, output_artifacts_json, created_at, completed_at, updated_at)
         VALUES (?, 'bot-a', 'bot-b', 'do it', 1, 'completed', ?, 1, 5, 5)`,
      )
      .run('del-2', JSON.stringify([{ ref: 'xdt-file://deck.pptx', kind: 'file' }]));

    expect((await listBotArtifacts({ botId: 'bot-a' })).items).toHaveLength(0);
    const producer = await listBotArtifacts({ botId: 'bot-b' });
    expect(producer.items).toHaveLength(1);
    expect(producer.items[0]!.category).toBe('deck');
    expect(producer.items[0]!.delegationId).toBe('del-2');
  });

  it('drops files that no longer exist on disk', async () => {
    addBot('bot-a', 'session-a', tmpRoot);
    const kept = writeFile('kept.csv');
    addMessage('session-a', 'k', 'tool_use', { toolName: 'Write', input: { file_path: kept } }, 10);
    addMessage(
      'session-a',
      'gone',
      'tool_use',
      { toolName: 'Write', input: { file_path: path.join(tmpRoot, 'never-written.xlsx') } },
      20,
    );

    const result = await listBotArtifacts({ botId: 'bot-a' });
    expect(result.items.map((item) => item.name)).toEqual(['kept.csv']);
    expect(result.items[0]!.category).toBe('sheet');
  });

  it('collapses the same file seen through two sources', async () => {
    addBot('bot-a', 'session-a', tmpRoot);
    const shared = writeFile('shared.md');
    addMessage(
      'session-a',
      'w',
      'tool_use',
      { toolName: 'Write', input: { file_path: shared } },
      100,
    );
    addMessage(
      'session-a',
      'u',
      'user',
      { text: '', files: [{ name: 'shared.md', path: shared }] },
      200,
    );

    const result = await listBotArtifacts({ botId: 'bot-a' });
    expect(result.items).toHaveLength(1);
    // 产出来源优先,交付时间取最早的那次。
    expect(result.items[0]!.source).toBe('generated');
    expect(result.items[0]!.createdAt).toBe(100);
  });

  it('caps the list and reports truncation', async () => {
    addBot('bot-a', 'session-a', tmpRoot);
    for (let index = 0; index < 5; index += 1) {
      const file = writeFile(`bulk/file-${index}.md`);
      addMessage(
        'session-a',
        `bulk-${index}`,
        'tool_use',
        { toolName: 'Write', input: { file_path: file } },
        1_000 + index,
      );
    }
    const result = await listBotArtifacts({ botId: 'bot-a', limit: 3 });
    expect(result.items).toHaveLength(3);
    expect(result.truncated).toBe(true);
    // 截断从旧的一端丢:留下的是最新三件。
    expect(result.items.map((item) => item.name)).toEqual([
      'file-4.md',
      'file-3.md',
      'file-2.md',
    ]);
  });

  it('ignores edits, reads and rewound rows', async () => {
    addBot('bot-a', 'session-a', tmpRoot);
    const edited = writeFile('edited.md');
    addMessage(
      'session-a',
      'edit',
      'tool_use',
      { toolName: 'Edit', input: { file_path: edited } },
      10,
    );
    addMessage(
      'session-a',
      'read',
      'tool_use',
      { toolName: 'Read', input: { file_path: edited } },
      11,
    );
    const rewound = writeFile('rewound.md');
    addMessage(
      'session-a',
      'rw',
      'tool_use',
      { toolName: 'Write', input: { file_path: rewound } },
      12,
    );
    sqlite!.prepare('UPDATE messages SET rewind_at = 99 WHERE client_id = ?').run('rw');

    expect((await listBotArtifacts({ botId: 'bot-a' })).items).toHaveLength(0);
  });

  // ── 与对话内交付物卡同源 ──────────────────────────────────────────────
  //
  // 真机症状是「对话里有卡、仓库里没有」。这一组锁住:命令产物与 checkpoint 新建
  // 这两条来源在仓库侧同样成立,且各自的防误报门槛没有被绕过。
  describe('中间件不进作品集', () => {
    /**
     * 实机截图里冒出过一份 q3-summary.html:它是伙伴自己写来定版式的设计稿,被
     * render_pdf 读走做成 PDF 之后,不该和成品并排躺在作品集里。
     *
     * 这条曾经只在「文件工具」那条来源上挡住,而设计稿被 Write 出来时 checkpoint
     * 也记了一笔,于是照样从另一条来源绕进去 —— 所以判定收在三条来源汇合之后。
     */
    it('产出成品时读走的设计稿不出现在作品集里', async () => {
      addBot('bot-a', 'session-a', tmpRoot);
      writeFile('tmp/design.html');
      writeFile('documents/report.pdf');
      addMessage(
        'session-a',
        'w1',
        'tool_use',
        { toolName: 'Write', input: { file_path: path.join(tmpRoot, 'tmp', 'design.html') } },
        Date.now() - 60_000,
      );
      addMessage(
        'session-a',
        'r1',
        'tool_use',
        {
          toolName: 'mcp__cindy_docs__render_pdf',
          input: { htmlPath: 'tmp/design.html', outPath: 'documents/report.pdf' },
        },
        Date.now() - 30_000,
      );

      const names = (await listBotArtifacts({ botId: 'bot-a' })).items.map((i) => i.name);
      expect(names).toEqual(['report.pdf']);
    });

    it('没被读走的文件照常是作品', async () => {
      addBot('bot-a', 'session-a', tmpRoot);
      writeFile('documents/notes.html');
      addMessage(
        'session-a',
        'w2',
        'tool_use',
        { toolName: 'Write', input: { file_path: path.join(tmpRoot, 'documents', 'notes.html') } },
        Date.now() - 60_000,
      );

      const names = (await listBotArtifacts({ botId: 'bot-a' })).items.map((i) => i.name);
      expect(names).toEqual(['notes.html']);
    });
  });

  describe('parity with the in-chat deliverable card', () => {
    // 命令里一律用**相对**路径:候选文本会过临时目录黑名单,而测试夹具本身就住在
    // 系统临时目录里(Linux 上是 /tmp)。相对路径由 workingDir 解析,与真机同路。
    it('picks up command-written artifacts the file tools never recorded', async () => {
      addBot('bot-a', 'session-a', tmpRoot);
      writeFile('artifacts/report.pdf');
      addMessage(
        'session-a',
        'sh',
        'tool_use',
        {
          toolName: 'Bash',
          input: {
            command: 'soffice --headless --convert-to pdf --outdir artifacts docs/report.docx',
          },
        },
        // 文件已经写在磁盘上(mtime = now),命令时间取更早的一刻。
        Date.now() - 60_000,
      );

      const result = await listBotArtifacts({ botId: 'bot-a' });
      expect(result.items.map((item) => item.name)).toEqual(['report.pdf']);
      expect(result.items[0]!.category).toBe('doc');
      expect(result.items[0]!.path).toBe(path.join(tmpRoot, 'artifacts', 'report.pdf'));
    });

    it('drops a command candidate whose file predates the command', async () => {
      addBot('bot-a', 'session-a', tmpRoot);
      const stale = writeFile('artifacts/stale.pdf');
      const long_ago = Date.now() - 400 * 24 * 3600 * 1000;
      fs.utimesSync(stale, new Date(long_ago), new Date(long_ago));
      addMessage(
        'session-a',
        'sh2',
        'tool_use',
        { toolName: 'Bash', input: { command: 'pandoc in.md -o artifacts/stale.pdf' } },
        Date.now(),
      );

      expect((await listBotArtifacts({ botId: 'bot-a' })).items).toHaveLength(0);
    });

    it('never lets a command mention of an edited file become an artifact', async () => {
      addBot('bot-a', 'session-a', tmpRoot);
      const source = writeFile('src/main.ts');
      addMessage(
        'session-a',
        'edit',
        'tool_use',
        { toolName: 'Edit', input: { file_path: source } },
        Date.now() - 60_000,
      );
      addMessage(
        'session-a',
        'sh3',
        'tool_use',
        { toolName: 'Bash', input: { command: 'node build.js > src/main.ts' } },
        Date.now() - 30_000,
      );

      expect((await listBotArtifacts({ botId: 'bot-a' })).items).toHaveLength(0);
    });

    it('adds checkpoint creates and still refuses checkpoint edits', async () => {
      addBot('bot-a', 'session-a', tmpRoot);
      const created = writeFile('checkpoint/made.pdf');
      const touched = writeFile('checkpoint/edited.md');
      const changeSet = {
        id: 'cs-1',
        sessionId: 'session-a',
        anchorClientId: 'u1',
        provider: 'claude-code' as const,
        providerTurnId: null,
        cwd: tmpRoot,
        state: 'complete' as const,
        workspaceState: 'applied' as const,
        isReversible: true,
        incompleteReasons: [],
        createdAt: 400,
        completedAt: 500,
        files: [
          { id: 'f1', path: created, oldPath: null, status: 'added' as const, additions: 1, deletions: 0 },
          { id: 'f2', path: touched, oldPath: null, status: 'modified' as const, additions: 1, deletions: 1 },
        ],
        fileCount: 2,
        additions: 2,
        deletions: 1,
      };

      const result = await listBotArtifacts(
        { botId: 'bot-a' },
        { listTurnChangeSets: async () => [changeSet] },
      );
      expect(result.items.map((item) => item.name)).toEqual(['made.pdf']);
      expect(result.items[0]!.source).toBe('generated');
      expect(result.items[0]!.createdAt).toBe(500);
    });

    it('survives a checkpoint sidecar that cannot be read', async () => {
      addBot('bot-a', 'session-a', tmpRoot);
      const written = writeFile('checkpoint/from-tool.md');
      addMessage(
        'session-a',
        'w',
        'tool_use',
        { toolName: 'Write', input: { file_path: written } },
        10,
      );

      const result = await listBotArtifacts(
        { botId: 'bot-a' },
        {
          listTurnChangeSets: async () => {
            throw new Error('sidecar gone');
          },
        },
      );
      expect(result.items.map((item) => item.name)).toEqual(['from-tool.md']);
    });
  });

  it('rejects a request that names neither a teammate nor a task', async () => {
    registerBotArtifactIpc();
    const handler = h.handlers.get('local-db:bots:artifacts');
    expect(handler).toBeTypeOf('function');
    await expect(handler!({}, {})).rejects.toThrow();
  });
});
