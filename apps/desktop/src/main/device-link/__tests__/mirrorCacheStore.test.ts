/**
 * mirrorCacheStore.test.ts —— 远程会话镜像冷缓存(落盘)的行为守卫。
 *
 * 守住的核心不变量:
 *  - 缓存是可丢弃的加速物:损坏 JSON / 缺文件 / 超上限一律静默降级,绝不抛错、绝不写坏。
 *  - 不缓存 live 态与非白名单字段(连接状态缓存下来会在冷启动画出假在线)。
 *  - 空列表 = 清掉该条(被控端 /clear 后不能留下能被 hydrate 的旧正文)。
 *  - 逐出与体积上限真实生效,缓存不会无界增长。
 *  - deviceId / sessionId 是不可信输入:路径穿越字符不得逃出缓存目录。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createMirrorCache,
  MirrorCachePurgeError,
  coerceCachedSession,
  messageFileName,
  normalizeMessages,
  normalizeDeviceSessions,
  MAX_CACHED_MESSAGES,
  MAX_CACHED_TEXT_CHARS,
  MAX_MESSAGE_FILE_BYTES,
  MAX_MESSAGE_FILES,
  __testing,
} from '../mirrorCacheStore';

let root: string;

function cache() {
  return createMirrorCache(() => root);
}

function messagesDir(): string {
  return path.join(root, __testing.messagesDirName);
}

function row(id: string, createdAt: string, extra: Record<string, unknown> = {}) {
  return { id, clientId: `c-${id}`, role: 'user', content: `body-${id}`, createdAt, ...extra };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-cache-test-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('messageFileName', () => {
  it('路径穿越 / 分隔符 / NUL 全部被消毒,文件名不含目录结构', () => {
    const name = messageFileName('../../etc', 'a/b\\c d\u0000e');
    expect(name).not.toContain('..');
    expect(name).not.toContain('/');
    expect(name).not.toContain('\\');
    expect(name).not.toContain('\u0000');
    expect(name).not.toContain(' ');
    expect(name.endsWith('.json')).toBe(true);
  });

  it('同 (设备, 会话) 稳定、不同输入不撞名(消毒后可读片段相同也靠哈希区分)', () => {
    expect(messageFileName('dev-1', 'sess-1')).toBe(messageFileName('dev-1', 'sess-1'));
    // 消毒后可读片段一致(都成 a_b),唯一性只能靠哈希
    expect(messageFileName('dev', 'a/b')).not.toBe(messageFileName('dev', 'a\\b'));
  });
});

describe('normalizeMessages', () => {
  it('按 createdAt 升序 + 按 id 去重 + 只留最新 MAX 条', () => {
    const many = Array.from({ length: MAX_CACHED_MESSAGES + 10 }, (_, i) =>
      row(`m${i}`, new Date(2026, 0, 1, 0, 0, i).toISOString()),
    );
    const normalized = normalizeMessages([...many].reverse());
    expect(normalized).toHaveLength(MAX_CACHED_MESSAGES);
    expect(normalized[0].id).toBe('m10');
    expect(normalized[normalized.length - 1].id).toBe(`m${MAX_CACHED_MESSAGES + 9}`);
  });

  it('同 id 保留最后一次(对账口径:后写的更新)', () => {
    const normalized = normalizeMessages([
      row('m1', '2026-01-01T00:00:00.000Z', { content: 'old' }),
      row('m1', '2026-01-01T00:00:00.000Z', { content: 'new' }),
    ]);
    expect(normalized).toHaveLength(1);
    expect(normalized[0].content).toBe('new');
  });

  it('丢弃没有 id / clientId 的行与非对象项,不抛错', () => {
    expect(normalizeMessages([null, 'x', 42, { createdAt: 'x' }])).toEqual([]);
  });

  it('保留原始字段(与 fresh 逐字段一致才能让 renderer 短路判等)', () => {
    const [only] = normalizeMessages([
      row('m1', '2026-01-01T00:00:00.000Z', { agentMeta: { turnCostUsd: 1.5 }, rowid: 7 }),
    ]);
    expect(only.agentMeta).toEqual({ turnCostUsd: 1.5 });
    expect(only.rowid).toBe(7);
  });
});

describe('coerceCachedSession', () => {
  it('只留白名单字段,live 态与大字段被丢弃', () => {
    const coerced = coerceCachedSession({
      id: 's1',
      title: 'T',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      deviceLinkConnectionStatus: 'connected',
      deviceLinkDeviceId: 'dev-1',
      attached: true,
      _count: { messages: 99 },
      extraDirs: ['/a', '/b'],
    });
    expect(coerced).not.toBeNull();
    expect(coerced).not.toHaveProperty('deviceLinkConnectionStatus');
    expect(coerced).not.toHaveProperty('deviceLinkDeviceId');
    expect(coerced).not.toHaveProperty('attached');
    expect(coerced).not.toHaveProperty('_count');
    expect(coerced).not.toHaveProperty('extraDirs');
    expect(coerced?.title).toBe('T');
  });

  it('长文本截断到上限', () => {
    const coerced = coerceCachedSession({
      id: 's1',
      status: 'active',
      title: 'x'.repeat(MAX_CACHED_TEXT_CHARS + 50),
      preview: 'y'.repeat(MAX_CACHED_TEXT_CHARS + 50),
    });
    expect((coerced?.title as string).length).toBe(MAX_CACHED_TEXT_CHARS);
    expect((coerced?.preview as string).length).toBe(MAX_CACHED_TEXT_CHARS);
  });

  it('缺 id / 非 active|archived 状态 → 丢弃(不该出现在列表里)', () => {
    expect(coerceCachedSession({ status: 'active' })).toBeNull();
    expect(coerceCachedSession({ id: 's1', status: 'deleted' })).toBeNull();
    expect(coerceCachedSession({ id: 's1' })).toBeNull();
  });
});

describe('normalizeDeviceSessions', () => {
  it('按最近活动排序、按每设备上限裁剪、丢弃空设备', () => {
    const devices = normalizeDeviceSessions(
      [
        {
          deviceId: 'dev-1',
          deviceName: 'Mac',
          sessions: [
            { id: 'old', status: 'active', updatedAt: '2026-01-01T00:00:00.000Z' },
            { id: 'new', status: 'active', updatedAt: '2026-06-01T00:00:00.000Z' },
          ],
        },
        { deviceId: 'dev-2', deviceName: 'PC', sessions: [] },
        { deviceId: '', deviceName: 'nameless', sessions: [{ id: 'x', status: 'active' }] },
      ],
      1,
    );
    expect(devices).toHaveLength(1);
    expect(devices[0].deviceId).toBe('dev-1');
    expect(devices[0].sessions.map((s) => s.id)).toEqual(['new']);
  });
});

describe('readMessages / writeMessages', () => {
  it('写入后可读回,内容与归一化结果一致', async () => {
    const c = cache();
    await c.writeMessages('dev-1', 'sess-1', [
      row('m2', '2026-01-02T00:00:00.000Z'),
      row('m1', '2026-01-01T00:00:00.000Z'),
    ]);
    expect((await c.readMessages('dev-1', 'sess-1')).map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('未命中 / 损坏 JSON → 空数组,不抛错', async () => {
    const c = cache();
    expect(await c.readMessages('dev-1', 'missing')).toEqual([]);
    await fsp.mkdir(messagesDir(), { recursive: true });
    await fsp.writeFile(
      path.join(messagesDir(), messageFileName('dev-1', 'broken')),
      '{not json',
      'utf8',
    );
    expect(await c.readMessages('dev-1', 'broken')).toEqual([]);
  });

  it('空数组 = 清掉该条(被控端 /clear 后不留可 hydrate 的旧正文)', async () => {
    const c = cache();
    await c.writeMessages('dev-1', 'sess-1', [row('m1', '2026-01-01T00:00:00.000Z')]);
    await c.writeMessages('dev-1', 'sess-1', []);
    expect(await c.readMessages('dev-1', 'sess-1')).toEqual([]);
    expect(fs.existsSync(path.join(messagesDir(), messageFileName('dev-1', 'sess-1')))).toBe(false);
  });

  it('单文件超体积上限 → 放弃写入并保留旧文件(宁缺毋滥)', async () => {
    const c = cache();
    await c.writeMessages('dev-1', 'sess-1', [row('keep', '2026-01-01T00:00:00.000Z')]);
    const huge = [
      row('huge', '2026-02-01T00:00:00.000Z', { content: 'x'.repeat(MAX_MESSAGE_FILE_BYTES + 1) }),
    ];
    await c.writeMessages('dev-1', 'sess-1', huge);
    expect((await c.readMessages('dev-1', 'sess-1')).map((m) => m.id)).toEqual(['keep']);
  });

  it('空 deviceId / sessionId 一律 no-op(不在缓存根乱建文件)', async () => {
    const c = cache();
    await c.writeMessages('', 'sess-1', [row('m1', '2026-01-01T00:00:00.000Z')]);
    await c.writeMessages('dev-1', '  ', [row('m1', '2026-01-01T00:00:00.000Z')]);
    expect(fs.existsSync(messagesDir())).toBe(false);
    expect(await c.readMessages('', 'sess-1')).toEqual([]);
  });

  it('超文件数上限 → 按 mtime 逐出最旧,新写入的留下', async () => {
    const c = cache();
    for (let i = 0; i < MAX_MESSAGE_FILES + 5; i += 1) {
      await c.writeMessages('dev-1', `sess-${i}`, [row(`m${i}`, '2026-01-01T00:00:00.000Z')]);
      // mtime 分辨率有限:显式回拨保证 LRU 顺序确定(越早写的越旧)。
      const file = path.join(messagesDir(), messageFileName('dev-1', `sess-${i}`));
      const stamp = new Date(2026, 0, 1, 0, 0, i);
      await fsp.utimes(file, stamp, stamp);
    }
    const files = await fsp.readdir(messagesDir());
    expect(files.length).toBeLessThanOrEqual(MAX_MESSAGE_FILES);
    expect(await c.readMessages('dev-1', 'sess-0')).toEqual([]);
    expect(await c.readMessages('dev-1', `sess-${MAX_MESSAGE_FILES + 4}`)).not.toEqual([]);
  });
});

describe('重复写入去重', () => {
  it('内容没变 → 不再落盘(10 秒一轮的对账不该反复写盘)', async () => {
    const c = cache();
    const rows = [row('m1', '2026-01-01T00:00:00.000Z')];
    await c.writeMessages('dev-1', 'sess-1', rows);
    const file = path.join(messagesDir(), messageFileName('dev-1', 'sess-1'));
    const past = new Date(2020, 0, 1);
    await fsp.utimes(file, past, past);

    await c.writeMessages('dev-1', 'sess-1', rows);

    // mtime 未被刷新 = 确实没重写
    expect((await fsp.stat(file)).mtimeMs).toBe(past.getTime());
  });

  it('内容变了 → 照常落盘', async () => {
    const c = cache();
    await c.writeMessages('dev-1', 'sess-1', [row('m1', '2026-01-01T00:00:00.000Z')]);
    await c.writeMessages('dev-1', 'sess-1', [
      row('m1', '2026-01-01T00:00:00.000Z'),
      row('m2', '2026-01-02T00:00:00.000Z'),
    ]);
    expect((await c.readMessages('dev-1', 'sess-1')).map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('清掉之后再写同样内容能恢复(去重指纹随删除一起失效)', async () => {
    const c = cache();
    const rows = [row('m1', '2026-01-01T00:00:00.000Z')];
    await c.writeMessages('dev-1', 'sess-1', rows);
    await c.clearDevice('dev-1');
    expect(await c.readMessages('dev-1', 'sess-1')).toEqual([]);

    await c.writeMessages('dev-1', 'sess-1', rows);
    expect((await c.readMessages('dev-1', 'sess-1')).map((m) => m.id)).toEqual(['m1']);
  });

  it('空写清掉后再写同样内容能恢复', async () => {
    const c = cache();
    const rows = [row('m1', '2026-01-01T00:00:00.000Z')];
    await c.writeMessages('dev-1', 'sess-1', rows);
    await c.writeMessages('dev-1', 'sess-1', []);
    await c.writeMessages('dev-1', 'sess-1', rows);
    expect((await c.readMessages('dev-1', 'sess-1')).map((m) => m.id)).toEqual(['m1']);
  });

  // review(greptile P1):指纹一旦与「盘上真有这份内容」脱钩,同内容的后续写入会被永久跳过。
  it('写入失败不留指纹 → 恢复后同样内容仍能落盘', async () => {
    const c = cache();
    const rows = [row('m1', '2026-01-01T00:00:00.000Z')];
    // 把 messages 目录位置占成普通文件,让 mkdir/写入必然失败。
    await fsp.writeFile(messagesDir(), 'not a directory', 'utf8');
    await c.writeMessages('dev-1', 'sess-1', rows);
    expect(fs.statSync(messagesDir()).isFile()).toBe(true);

    await fsp.rm(messagesDir(), { force: true });
    await c.writeMessages('dev-1', 'sess-1', rows);

    expect((await c.readMessages('dev-1', 'sess-1')).map((m) => m.id)).toEqual(['m1']);
  });

  it('被 LRU 逐出的文件不留指纹 → 同样内容能重新写回', async () => {
    const c = cache();
    const victim = [row('victim', '2026-01-01T00:00:00.000Z')];
    await c.writeMessages('dev-1', 'sess-victim', victim);
    const victimFile = path.join(messagesDir(), messageFileName('dev-1', 'sess-victim'));
    const old = new Date(2020, 0, 1);
    await fsp.utimes(victimFile, old, old);
    // 灌满到逐出:victim 是 mtime 最旧的那个,必然先走。
    for (let i = 0; i < MAX_MESSAGE_FILES + 2; i += 1) {
      await c.writeMessages('dev-1', `sess-${i}`, [row(`m${i}`, '2026-02-01T00:00:00.000Z')]);
    }
    expect(fs.existsSync(victimFile)).toBe(false);

    await c.writeMessages('dev-1', 'sess-victim', victim);

    expect((await c.readMessages('dev-1', 'sess-victim')).map((m) => m.id)).toEqual(['victim']);
  });
});

describe('deviceId / sessionId 归一化', () => {
  // review(copilot):IPC 层的 requireString 不 trim,写/读/清必须共用同一套归一化,
  // 否则 "dev " 写出的文件 clearDevice("dev") 永远清不掉。
  it('首尾空白视作同一 (设备, 会话)', async () => {
    const c = cache();
    await c.writeMessages('dev-1 ', ' sess-1', [row('m1', '2026-01-01T00:00:00.000Z')]);

    expect((await c.readMessages('dev-1', 'sess-1')).map((m) => m.id)).toEqual(['m1']);
    expect(await fsp.readdir(messagesDir())).toHaveLength(1);
    expect(messageFileName('dev-1 ', 'sess-1')).toBe(messageFileName('dev-1', ' sess-1'));
  });

  it('带空白写入的文件能被 clearDevice 清掉', async () => {
    const c = cache();
    await c.writeMessages(' dev-1 ', 'sess-1', [row('m1', '2026-01-01T00:00:00.000Z')]);
    await c.clearDevice('dev-1');
    expect(await c.readMessages('dev-1', 'sess-1')).toEqual([]);
    expect(await fsp.readdir(messagesDir())).toHaveLength(0);
  });
});

describe('session list', () => {
  it('写入后读回,live 态字段不落盘', async () => {
    const c = cache();
    await c.writeSessionList([
      {
        deviceId: 'dev-1',
        deviceName: 'Mac',
        sessions: [
          {
            id: 's1',
            status: 'active',
            title: 'T',
            createdAt: '2026-01-01T00:00:00.000Z',
            deviceLinkConnectionStatus: 'connected',
          },
        ],
      },
    ]);
    const devices = await c.readSessionList();
    expect(devices).toHaveLength(1);
    expect(devices[0].sessions[0]).not.toHaveProperty('deviceLinkConnectionStatus');
  });

  it('空快照 = 删掉文件;损坏 JSON → 空数组', async () => {
    const c = cache();
    await c.writeSessionList([
      { deviceId: 'dev-1', deviceName: 'Mac', sessions: [{ id: 's1', status: 'active' }] },
    ]);
    await c.writeSessionList([]);
    expect(await c.readSessionList()).toEqual([]);
    await fsp.mkdir(root, { recursive: true });
    await fsp.writeFile(path.join(root, __testing.sessionListFileName), 'nope', 'utf8');
    expect(await c.readSessionList()).toEqual([]);
  });

  it('体积超限 → 逐级缩小每设备会话数后仍能写入', async () => {
    const c = cache();
    // 每条会话都顶着截断上限的标题 + 预览,100 条 × 8 设备必然超 512KB → 触发缩容。
    const bulky = (deviceId: string) => ({
      deviceId,
      deviceName: deviceId,
      sessions: Array.from({ length: 100 }, (_, i) => ({
        id: `${deviceId}-s${i}`,
        status: 'active' as const,
        title: 'x'.repeat(MAX_CACHED_TEXT_CHARS),
        preview: 'y'.repeat(MAX_CACHED_TEXT_CHARS),
        workingDir: 'z'.repeat(MAX_CACHED_TEXT_CHARS),
        updatedAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
      })),
    });
    await c.writeSessionList(
      Array.from({ length: 8 }, (_, i) => bulky(`dev-${i}`)),
    );
    const devices = await c.readSessionList();
    expect(devices.length).toBeGreaterThan(0);
    // 缩容后每设备条数小于原始 100 条
    expect(devices[0].sessions.length).toBeLessThan(100);
  });
});

describe('clearDevice / clearAll', () => {
  it('clearDevice 只清该设备:它的消息文件与列表条目都走,其它设备不受影响', async () => {
    const c = cache();
    await c.writeMessages('dev-1', 'sess-1', [row('m1', '2026-01-01T00:00:00.000Z')]);
    await c.writeMessages('dev-2', 'sess-2', [row('m2', '2026-01-01T00:00:00.000Z')]);
    await c.writeSessionList([
      { deviceId: 'dev-1', deviceName: 'Mac', sessions: [{ id: 's1', status: 'active' }] },
      { deviceId: 'dev-2', deviceName: 'PC', sessions: [{ id: 's2', status: 'active' }] },
    ]);

    await c.clearDevice('dev-1');

    expect(await c.readMessages('dev-1', 'sess-1')).toEqual([]);
    expect((await c.readMessages('dev-2', 'sess-2')).map((m) => m.id)).toEqual(['m2']);
    expect((await c.readSessionList()).map((d) => d.deviceId)).toEqual(['dev-2']);
  });

  it('clearAll 整棵目录删掉,之后读仍安全', async () => {
    const c = cache();
    await c.writeMessages('dev-1', 'sess-1', [row('m1', '2026-01-01T00:00:00.000Z')]);
    await c.clearAll();
    expect(fs.existsSync(root)).toBe(false);
    expect(await c.readMessages('dev-1', 'sess-1')).toEqual([]);
    expect(await c.readSessionList()).toEqual([]);
  });

  // review(codex P1):隐私清理不能把失败吞成成功 —— 调用方要能 log / 持久化重试,
  // 否则账号边界照常推进而上一个账号的明文缓存留在盘上。
  //
  // 制造「内容删不掉」用的是「父目录只读」(删文件需要父目录写权限)。root 跑测试时
  // 权限位不生效,那种环境下跳过。
  const canTestUnwritableDir = (process.getuid?.() ?? 0) !== 0;

  it.skipIf(!canTestUnwritableDir)(
    'clearAll 内容删不掉时抛 MirrorCachePurgeError,并带上仍存在的文件清单',
    async () => {
      const cacheRoot = path.join(root, 'locked-cache');
      const c = createMirrorCache(() => cacheRoot);
      await c.writeMessages('dev-1', 'sess-1', [row('m1', '2026-01-01T00:00:00.000Z')]);
      const dir = path.join(cacheRoot, __testing.messagesDirName);
      const stuck = path.join(dir, (await fsp.readdir(dir))[0]);
      await fsp.chmod(dir, 0o500); // r-x:目录里的文件删不掉了
      try {
        await c.clearAll().then(
          () => expect.unreachable('clearAll should have rejected'),
          (err: unknown) => {
            expect(err).toBeInstanceOf(MirrorCachePurgeError);
            const purgeErr = err as MirrorCachePurgeError;
            expect(purgeErr.root).toBe(cacheRoot);
            expect(purgeErr.remaining).toContain(stuck);
          },
        );
      } finally {
        await fsp.chmod(dir, 0o700);
      }
    },
  );

  it.skipIf(!canTestUnwritableDir)(
    'clearAll 会尽力删掉能删的内容(一个删不掉的文件不该让其它文件也留下)',
    async () => {
      const cacheRoot = path.join(root, 'partial-cache');
      const c = createMirrorCache(() => cacheRoot);
      await c.writeSessionList([
        { deviceId: 'dev-1', deviceName: 'Mac', sessions: [{ id: 's1', status: 'active' }] },
      ]);
      await c.writeMessages('dev-1', 'sess-1', [row('m1', '2026-01-01T00:00:00.000Z')]);
      const dir = path.join(cacheRoot, __testing.messagesDirName);
      await fsp.chmod(dir, 0o500);
      try {
        await expect(c.clearAll()).rejects.toBeInstanceOf(MirrorCachePurgeError);
        // messages/ 里的删不掉,但列表快照必须已经没了
        expect(fs.existsSync(path.join(cacheRoot, __testing.sessionListFileName))).toBe(false);
      } finally {
        await fsp.chmod(dir, 0o700);
      }
    },
  );

  // 整棵 rm 失败后的降级路径:逐文件删,把「还剩什么」查清楚 ——
  // 目录空壳留着无所谓,聊天正文留着才是隐私问题。
  it('purgeContents 逐个删内容,并返回仍存在的文件清单', async () => {
    const dir = path.join(root, 'purge-me');
    await fsp.mkdir(path.join(dir, 'messages'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'session-list.json'), '{}', 'utf8');
    await fsp.writeFile(path.join(dir, 'messages', 'a.json'), '{}', 'utf8');

    const remaining = await __testing.purgeContents(dir);

    expect(remaining).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'session-list.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'messages', 'a.json'))).toBe(false);
  });

  it('purgeContents 对不存在的目录安全返回空清单(ENOENT = 真的没有内容)', async () => {
    expect(await __testing.purgeContents(path.join(root, 'nope'))).toEqual([]);
  });

  // review(codex P1):readdir 因权限失败时"数不出东西"不等于"已经空了" —— 当成空的话
  // clearAll 会误报成功、不入重试队列,而明文缓存可能仍在里面。
  it.skipIf(!canTestUnwritableDir)(
    'purgeContents 把「读不了的目录」计入残留清单(而不是当成已清空)',
    async () => {
      const dir = path.join(root, 'unreadable');
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, 'a.json'), '{}', 'utf8');
      await fsp.chmod(dir, 0o000);
      try {
        expect(await __testing.purgeContents(dir)).toEqual([dir]);
      } finally {
        await fsp.chmod(dir, 0o700);
      }
    },
  );

  it.skipIf(!canTestUnwritableDir)(
    'clearAll 在缓存目录读不了时抛错(不静默成功、能进重试队列)',
    async () => {
      const cacheRoot = path.join(root, 'unreadable-cache');
      await fsp.mkdir(path.join(cacheRoot, 'messages'), { recursive: true });
      await fsp.writeFile(path.join(cacheRoot, 'messages', 'a.json'), '{}', 'utf8');
      const c = createMirrorCache(() => cacheRoot);
      await fsp.chmod(cacheRoot, 0o000);
      try {
        await expect(c.clearAll()).rejects.toBeInstanceOf(MirrorCachePurgeError);
      } finally {
        await fsp.chmod(cacheRoot, 0o700);
      }
    },
  );

  // review(greptile + codex P1):枚举失败被当成「里面没东西」→ 一个文件都不删却报成功,
  // IPC 也就不会登记重试,正文在权限恢复后照样能被读回。
  it.skipIf(!canTestUnwritableDir)(
    'clearDevice 在 messages 目录数不出内容时抛错(不静默成功)',
    async () => {
      const c = cache();
      await c.writeMessages('dev-1', 'sess-1', [row('m1', '2026-01-01T00:00:00.000Z')]);
      const dir = messagesDir();
      await fsp.chmod(dir, 0o000);
      try {
        await c.clearDevice('dev-1').then(
          () => expect.unreachable('clearDevice should have rejected'),
          (err: unknown) => {
            expect(err).toBeInstanceOf(MirrorCachePurgeError);
            expect((err as MirrorCachePurgeError).remaining).toContain(dir);
          },
        );
      } finally {
        await fsp.chmod(dir, 0o700);
      }
    },
  );

  it('clearDevice 对不存在的 messages 目录正常完成(ENOENT = 真的没有)', async () => {
    const c = cache();
    await expect(c.clearDevice('dev-1')).resolves.toBeUndefined();
  });

  // review(codex P1):两台设备同时被收掉时,各自「读快照 → 写除我之外的全部」会互相覆盖。
  it('clearAll 期间在途的 clearDevice 不会把列表快照重建出来', async () => {
    const c = cache();
    await c.writeSessionList([
      { deviceId: 'dev-1', deviceName: 'Mac', sessions: [{ id: 's1', status: 'active' }] },
      { deviceId: 'dev-2', deviceName: 'PC', sessions: [{ id: 's2', status: 'active' }] },
    ]);

    const inFlight = c.clearDevice('dev-1');
    await c.clearAll();
    await inFlight.catch(() => undefined); // 清理失败与否不是这条断言的重点

    expect(await c.readSessionList()).toEqual([]);
    expect(fs.existsSync(path.join(root, __testing.sessionListFileName))).toBe(false);
  });

  it('并发 clearDevice 不会把彼此从列表快照里恢复回来', async () => {
    const c = cache();
    await c.writeSessionList([
      { deviceId: 'dev-1', deviceName: 'Mac', sessions: [{ id: 's1', status: 'active' }] },
      { deviceId: 'dev-2', deviceName: 'PC', sessions: [{ id: 's2', status: 'active' }] },
      { deviceId: 'dev-3', deviceName: 'Keep', sessions: [{ id: 's3', status: 'active' }] },
    ]);

    await Promise.all([c.clearDevice('dev-1'), c.clearDevice('dev-2')]);

    expect((await c.readSessionList()).map((d) => d.deviceId)).toEqual(['dev-3']);
  });

  // review(codex P1):消息文件删掉了、会话元数据却还在盘上 → 下次冷启动照样把这台
  // 被撤销的设备画回侧边栏。
  it.skipIf(!canTestUnwritableDir)(
    'clearDevice 在列表快照写不下去时抛错并带上该文件',
    async () => {
      const cacheRoot = path.join(root, 'ro-list');
      const c = createMirrorCache(() => cacheRoot);
      await c.writeSessionList([
        { deviceId: 'dev-1', deviceName: 'Mac', sessions: [{ id: 's1', status: 'active' }] },
        { deviceId: 'dev-2', deviceName: 'PC', sessions: [{ id: 's2', status: 'active' }] },
      ]);
      const listFile = path.join(cacheRoot, __testing.sessionListFileName);
      await fsp.chmod(cacheRoot, 0o500); // 目录只读:原子 rename 落不进去
      try {
        await c.clearDevice('dev-1').then(
          () => expect.unreachable('clearDevice should have rejected'),
          (err: unknown) => {
            expect(err).toBeInstanceOf(MirrorCachePurgeError);
            expect((err as MirrorCachePurgeError).remaining).toContain(listFile);
          },
        );
      } finally {
        await fsp.chmod(cacheRoot, 0o700);
      }
    },
  );

  // review(codex P1):撤销设备时删不掉的文件会留到本账号生命周期结束,必须能被重试。
  it.skipIf(!canTestUnwritableDir)(
    'clearDevice 有文件删不掉时抛 MirrorCachePurgeError 并带上那些路径',
    async () => {
      const c = cache();
      await c.writeMessages('dev-1', 'sess-1', [row('m1', '2026-01-01T00:00:00.000Z')]);
      const dir = messagesDir();
      const stuck = path.join(dir, messageFileName('dev-1', 'sess-1'));
      await fsp.chmod(dir, 0o500);
      try {
        await c.clearDevice('dev-1').then(
          () => expect.unreachable('clearDevice should have rejected'),
          (err: unknown) => {
            expect(err).toBeInstanceOf(MirrorCachePurgeError);
            expect((err as MirrorCachePurgeError).remaining).toEqual([stuck]);
          },
        );
      } finally {
        await fsp.chmod(dir, 0o700);
      }
    },
  );

  it('clearAll 之后到达的在途写入不会把内容写回(代际闸)', async () => {
    const c = cache();
    const rows = [row('m1', '2026-01-01T00:00:00.000Z')];
    // 模拟并发:写入发起后、落盘前发生了登出清理。
    const inFlight = c.writeMessages('dev-1', 'sess-1', rows);
    await c.clearAll();
    await inFlight;

    expect(await c.readMessages('dev-1', 'sess-1')).toEqual([]);
    expect(fs.existsSync(path.join(messagesDir(), messageFileName('dev-1', 'sess-1')))).toBe(false);
  });

  it('clearAll 之后到达的在途列表快照写入同样被作废', async () => {
    const c = cache();
    const inFlight = c.writeSessionList([
      { deviceId: 'dev-1', deviceName: 'Mac', sessions: [{ id: 's1', status: 'active' }] },
    ]);
    await c.clearAll();
    await inFlight;

    expect(await c.readSessionList()).toEqual([]);
  });

  it('清理之后的新写入照常落盘(代际闸只作废在途的那一批)', async () => {
    const c = cache();
    await c.clearAll();
    await c.writeMessages('dev-1', 'sess-1', [row('m1', '2026-01-01T00:00:00.000Z')]);
    expect((await c.readMessages('dev-1', 'sess-1')).map((m) => m.id)).toEqual(['m1']);
  });

  // review(codex P1):clearDevice 与 clearAll 同构 —— 在途写入的原子 rename 会在删除之后
  // 完成,把刚被撤销的设备正文重建出来。
  it('clearDevice 之后到达的在途写入不会重建该设备的消息', async () => {
    const c = cache();
    const inFlight = c.writeMessages('dev-1', 'sess-1', [row('m1', '2026-01-01T00:00:00.000Z')]);
    await c.clearDevice('dev-1');
    await inFlight;
    expect(await c.readMessages('dev-1', 'sess-1')).toEqual([]);
  });

  it('clearDevice 之后到达的在途列表写入不会重建该设备的条目', async () => {
    const c = cache();
    const inFlight = c.writeSessionList([
      { deviceId: 'dev-1', deviceName: 'Mac', sessions: [{ id: 's1', status: 'active' }] },
    ]);
    await c.clearDevice('dev-1');
    await inFlight;
    expect((await c.readSessionList()).map((d) => d.deviceId)).toEqual([]);
  });

  it('clearDevice 只作废在途写入,之后的新写入照常落盘', async () => {
    const c = cache();
    await c.clearDevice('dev-1');
    await c.writeMessages('dev-1', 'sess-1', [row('m1', '2026-01-01T00:00:00.000Z')]);
    expect((await c.readMessages('dev-1', 'sess-1')).map((m) => m.id)).toEqual(['m1']);
  });
});

describe('并发写入', () => {
  // review(greptile P1):两次并发写入在 await 处交错时,落盘内容与登记的指纹可能来自
  // 不同那一次,于是较新的快照之后会被 unchanged 跳过,冷启动一直显示旧消息。
  it('同一会话的并发写入串行化:盘上留的是最后一笔,且指纹与它一致', async () => {
    const c = cache();
    const first = [row('m1', '2026-01-01T00:00:00.000Z')];
    const second = [row('m1', '2026-01-01T00:00:00.000Z'), row('m2', '2026-01-02T00:00:00.000Z')];

    await Promise.all([
      c.writeMessages('dev-1', 'sess-1', first),
      c.writeMessages('dev-1', 'sess-1', second),
    ]);

    expect((await c.readMessages('dev-1', 'sess-1')).map((m) => m.id)).toEqual(['m1', 'm2']);

    // 指纹没错位的判据:再提交**盘上这份**会被去重跳过,而提交另一份必须真的写下去。
    const file = path.join(messagesDir(), messageFileName('dev-1', 'sess-1'));
    const past = new Date(2020, 0, 1);
    await fsp.utimes(file, past, past);
    await c.writeMessages('dev-1', 'sess-1', second);
    expect((await fsp.stat(file)).mtimeMs).toBe(past.getTime());

    await c.writeMessages('dev-1', 'sess-1', first);
    expect((await c.readMessages('dev-1', 'sess-1')).map((m) => m.id)).toEqual(['m1']);
  });

  it('列表快照的并发写入同样串行化', async () => {
    const c = cache();
    await Promise.all([
      c.writeSessionList([
        { deviceId: 'dev-1', deviceName: 'Mac', sessions: [{ id: 's1', status: 'active' }] },
      ]),
      c.writeSessionList([
        { deviceId: 'dev-1', deviceName: 'Mac', sessions: [{ id: 's1', status: 'active' }] },
        { deviceId: 'dev-2', deviceName: 'PC', sessions: [{ id: 's2', status: 'active' }] },
      ]),
    ]);

    const devices = (await c.readSessionList()).map((d) => d.deviceId).sort();
    expect(devices).toEqual(['dev-1', 'dev-2']);
  });
});
