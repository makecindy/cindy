/**
 * ledger.ts — cindy-media 账本(唯一真相)。
 * ---------------------------------------------------------------------------
 * 字节仓(blobStore.ts)只存字节;文件的出生、性质、引用全部是本模块维护的
 * 两张表(localDb/schema.ts: mediaBlobs / mediaRefs)。生命周期 = 引用计数,
 * 回收器在后续切片实现;本切片提供:
 *   - recordBlob:blob 元数据入账(幂等,去重命中只刷 lastAccess);
 *   - addRef:加引用行(含出生信息);
 *   - removeRefs:业务删除自己名下引用(删会话/卸载意识);
 *   - ghostCanRead:意识面板供图的归属校验——该指纹是否「出生自本意识」或
 *     「在本意识的画廊/引渡/寄存引用里」。指纹只当查账钥匙,查无此账即拒;
 *   - ghostDepositUsageBytes / removeGhostDepositRef:寄存配额的计量与释放口。
 *
 * 所有函数接受可注入的 db。生产默认走 DbClient 的 drizzle 代理——本地库真身
 * 在独立 DB 工作线程,主进程侧的终结方法(run/all)经 RPC 返回 Promise,
 * 因此全部函数为 async;测试注入内存库直测(规则 14,await 同样成立)。
 */

import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, lt, ne, or, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { getDbClient } from '../localDb/client/current';
import * as schema from '../localDb/schema';
import { mediaBlobs, mediaRefs } from '../localDb/schema';

export type LedgerDb = BetterSQLite3Database<typeof schema>;

/** 生产默认句柄:DbClient 的 drizzle 代理(未就绪时抛错,由调用方折叠成结构化失败)。 */
function defaultDb(): LedgerDb {
  return getDbClient().drizzle;
}

/**
 * 引用方类型(多态引用,详见 schema.ts mediaRefs 注释)。
 * 'ghost-grant':用户显式引渡给某意识的图(随 ghost_call attachments
 * 人工确认 / 拖进面板)——授权按张、永久,refId = 意识 id;与画廊 ref 一样
 * 计入归属校验(ghostCanRead)与"不被回收"。
 * 'ghost-tool-grant':Host 按工具权限代办的媒体交接(workdir 内直通、Full
 * Access 自动交接、工具出生的聊天附件等),refId = 意识 id。它同样让意识
 * 能按指纹取件,但**绝不**表示用户点过永久授权。刻意使用独立 refKind 而不是
 * 只靠 originKind 区分:旧客户端的授权 shortcut 只认识 ghost-grant,回退后
 * 会 fail closed，不会把新版自动交接误当成人工永久授权。
 * 'ghost-deposit':意识经 cindy 槽 deposit_media 寄存的媒体(用户在插件面板里
 * 粘贴/拖入的图等,makecindy/cindy#784),refId = 意识 id。与 gallery / grant
 * 一样计入归属校验与"不被回收",但**刻意独立成一类**,原因有三:
 *   (a) 配额要单独算 —— 寄存有每意识字节上限(GHOST_CINDY_DEPOSIT_QUOTA_BYTES),
 *       混进画廊就会让"出图多"挤掉"能存参考图";
 *   (b) 画廊要干净 —— listGhostGallery 是意识的**作品**清单(面板重启回放),
 *       用户粘进来的参考图不是作品;
 *   (c) 生命周期要能收 —— 卸载意识时按本 refKind 精确清理寄存物
 *       (uninstallGhostAndCleanup),不牵连画廊与引渡的既有语义。
 * 'integration-cache':集成下载缓存的 token→指纹索引行,
 * refId = `<集成名>:<token>`——(a) 回答"这个 token 下过没有"(指纹制下文件名
 * 不再是 token,没这行就只能重下);(b) 标明该 blob 归缓存策略管(总量上限 +
 * LRU 可清,即使有此引用),不是零引用孤儿。删会话不清它(removeSessionRefs
 * 不含此类),生死由回收器的 cache 策略决定。
 * 'profile-avatar':用户自定义头像(设置 → 用户卡片编辑),refId = 登录用户
 * id。跨会话持久(removeSessionRefs 不碰),同 refId 只保留最新指纹——换头像时
 * 由 profileEdit 用 removeRefsExceptHash 清旧引用,恢复默认头像时 removeRefs 清空。
 */
export type MediaRefKind =
  | 'message'
  | 'session-attachment'
  | 'im-inbox'
  | 'ghost-gallery'
  | 'ghost-grant'
  | 'ghost-tool-grant'
  | 'ghost-deposit'
  | 'import'
  | 'integration-cache'
  | 'profile-avatar';
/** 出生来源类型。 */
export type MediaOriginKind = 'ghost' | 'tool' | 'user' | 'integration';

export interface RecordBlobParams {
  hash: string;
  ext: string;
  mimeType: string;
  bytes: number;
  /** 性质=可再生缓存(容量上限可清);附件/作品传 false。 */
  isCache?: boolean;
}

export interface AddRefParams {
  hash: string;
  refKind: MediaRefKind;
  refId: string;
  originSessionId?: string;
  originKind?: MediaOriginKind;
  originId?: string;
  /** 人类可读备注(画廊 caption 等);可空。 */
  label?: string;
}

/**
 * blob 元数据入账;已有同指纹行(去重命中)刷 lastAccessAt。
 * isCache **只降不升**(非 cache 粘性):同字节先以 cache 入库、后被非 cache
 * 业务(聊天附件/作品)引用时必须降为非 cache——否则 cache 回收器会把承载
 * 用户附件的 blob 当可再生缓存清掉(review P1);反向(false→true)不升,
 * 已有非 cache 引用的内容不因后来的缓存写入而变得可清。
 */
export async function recordBlob(params: RecordBlobParams, db: LedgerDb = defaultDb()): Promise<void> {
  const now = Date.now();
  const isCache = params.isCache ?? false;
  await db.insert(mediaBlobs)
    .values({
      hash: params.hash,
      ext: params.ext,
      mimeType: params.mimeType,
      bytes: params.bytes,
      isCache,
      createdAt: now,
      lastAccessAt: now,
    })
    .onConflictDoUpdate({
      target: mediaBlobs.hash,
      set: isCache ? { lastAccessAt: now } : { lastAccessAt: now, isCache: false },
    })
    .run();
}

/**
 * 非 cache 粘性降级口(recordBlob 注释声明的不变量,"只挂 ref 不重新 ingest"
 * 的路径用):blob 若以 cache 入仓(集成下载 isCache=true)、后被非 cache 业务
 * (聊天消息 / IM 用户附件)引用,必须降为非 cache,否则 cache 回收器会把
 * 聊天历史仍在引用的字节当可再生缓存清掉(review P1)。幂等(WHERE isCache=1
 * 才写),查无此账 no-op;不提供反向升级。
 */
export async function pinBlob(hash: string, db: LedgerDb = defaultDb()): Promise<void> {
  await db
    .update(mediaBlobs)
    .set({ isCache: false })
    .where(and(eq(mediaBlobs.hash, hash), eq(mediaBlobs.isCache, true)))
    .run();
}

/** 加一条引用行,返回引用 id。blob 行必须已入账(FK 保证)。 */
export async function addRef(params: AddRefParams, db: LedgerDb = defaultDb()): Promise<string> {
  // message ref 的生命周期靠 removeSessionRefs 按出生会话连坐清理,漏传
  // originSessionId 的引用将永远无人回收——契约升级为代码级断言(规则 9)。
  if (params.refKind === 'message' && !params.originSessionId) {
    throw new Error('cindy-media: message ref requires originSessionId');
  }
  const id = randomUUID();
  await db.insert(mediaRefs)
    .values({
      id,
      hash: params.hash,
      refKind: params.refKind,
      refId: params.refId,
      originSessionId: params.originSessionId ?? null,
      originKind: params.originKind ?? null,
      originId: params.originId ?? null,
      label: params.label ?? null,
      createdAt: Date.now(),
    })
    .run();
  return id;
}

/** Remove exactly one reference row created by a staged operation. */
export async function removeRefById(id: string, db: LedgerDb = defaultDb()): Promise<number> {
  const result = await db.delete(mediaRefs).where(eq(mediaRefs.id, id)).run();
  return result.changes;
}

/**
 * 集成缓存索引查询:cacheKey(`<集成名>:<token>`)→ 最近一次登记的指纹。
 * 同 key 多行(token 复用换内容)时取最新;无登记返回 null(调用方去真下载)。
 */
export async function getIntegrationCacheHash(
  cacheKey: string,
  db: LedgerDb = defaultDb(),
): Promise<string | null> {
  const rows = await db
    .select({ hash: mediaRefs.hash })
    .from(mediaRefs)
    .where(and(eq(mediaRefs.refKind, 'integration-cache'), eq(mediaRefs.refId, cacheKey)))
    .orderBy(desc(mediaRefs.createdAt))
    .limit(1)
    .all();
  return rows[0]?.hash ?? null;
}

/** 某指纹在某引用方名下是否已有引用(commit 幂等去重用,避免重发消息刷重复行)。 */
export async function hasRef(
  params: {
    hash: string;
    refKind: MediaRefKind;
    refId: string;
    /** Optional provenance filter; omit to preserve the historical any-origin query. */
    originKind?: MediaOriginKind;
  },
  db: LedgerDb = defaultDb(),
): Promise<boolean> {
  const predicates = [
    eq(mediaRefs.hash, params.hash),
    eq(mediaRefs.refKind, params.refKind),
    eq(mediaRefs.refId, params.refId),
  ];
  if (params.originKind !== undefined) {
    predicates.push(eq(mediaRefs.originKind, params.originKind));
  }
  const rows = await db
    .select({ one: sql`1` })
    .from(mediaRefs)
    .where(and(...predicates))
    .limit(1)
    .all();
  return rows.length > 0;
}

/**
 * 某意识是否已有 Host 工具代办的附件交接记录。
 *
 * 新版使用独立的 ghost-tool-grant/tool；旧版曾把同一语义写成
 * ghost-grant/tool。两者都只能作为工具 provenance 使用，不能被当成
 * ghost-grant/user 的人工永久授权。集中兼容旧行，避免各调用点漏判或扩权。
 */
export async function hasGhostToolGrant(
  params: { hash: string; ghostId: string },
  db: LedgerDb = defaultDb(),
): Promise<boolean> {
  const rows = await db
    .select({ one: sql`1` })
    .from(mediaRefs)
    .where(
      and(
        eq(mediaRefs.hash, params.hash),
        eq(mediaRefs.refId, params.ghostId),
        eq(mediaRefs.originKind, 'tool'),
        or(
          eq(mediaRefs.refKind, 'ghost-tool-grant'),
          eq(mediaRefs.refKind, 'ghost-grant'),
        ),
      ),
    )
    .limit(1)
    .all();
  return rows.length > 0;
}

/**
 * 删会话的引用清理(会话删除钩子唯一入口):
 *   - session-attachment / import:refId 就是会话 id,直接删;
 *   - message:refId 是消息 id,按出生会话(originSessionId)连坐删——
 *     会话没了,它名下消息的引用自然一起走;
 *   - **绝不**碰 ghost-gallery / ghost-grant / ghost-tool-grant /
 *     ghost-deposit:画廊/引渡/工具交接/寄存是跨会话的持久引用,
 *     "删会话作品不陪葬"正是靠这几类 ref 存活
 *     (寄存物同理:画布上的图不该因为删了某个会话就变得不能改)。
 * 引用删完后引用归零的 blob 交回收器,本函数不动字节仓。
 */
export async function removeSessionRefs(
  sessionId: string,
  db: LedgerDb = defaultDb(),
): Promise<number> {
  const result = await db
    .delete(mediaRefs)
    .where(
      or(
        and(eq(mediaRefs.refKind, 'session-attachment'), eq(mediaRefs.refId, sessionId)),
        and(eq(mediaRefs.refKind, 'import'), eq(mediaRefs.refId, sessionId)),
        and(eq(mediaRefs.refKind, 'message'), eq(mediaRefs.originSessionId, sessionId)),
      ),
    )
    .run();
  return result.changes;
}

/**
 * 替换型引用清理:删除某引用方名下、指纹**不等于** keepHash 的引用行。
 * 「同 refId 只保留最新内容」的业务(个人头像等)换内容时用。调用方的顺序
 * 契约:ingest 新指纹挂引用 → 业务侧提交新地址 → 最后调本函数清旧指纹,
 * 使任何失败点都只留"多余引用行"的无害泄漏(下次替换清掉),业务地址永远
 * 不会指向零引用指纹(完整分析见 profileEdit.updateProfile 头注释)。
 */
export async function removeRefsExceptHash(
  params: { refKind: MediaRefKind; refId: string; keepHash: string },
  db: LedgerDb = defaultDb(),
): Promise<number> {
  const result = await db
    .delete(mediaRefs)
    .where(
      and(
        eq(mediaRefs.refKind, params.refKind),
        eq(mediaRefs.refId, params.refId),
        ne(mediaRefs.hash, params.keepHash),
      ),
    )
    .run();
  return result.changes;
}

/** 删除某引用方名下的全部引用(删会话 / 卸载意识时由业务代码调用)。 */
export async function removeRefs(
  params: { refKind: MediaRefKind; refId: string },
  db: LedgerDb = defaultDb(),
): Promise<number> {
  const result = await db
    .delete(mediaRefs)
    .where(and(eq(mediaRefs.refKind, params.refKind), eq(mediaRefs.refId, params.refId)))
    .run();
  return result.changes;
}

/**
 * Remove one session-attachment ref only when no live message in that session
 * still contains the blob hash.  The predicate is part of the DELETE so a
 * concurrent message commit cannot turn a read-then-delete check into data
 * loss; at worst a later commit recreates the coarse session ref.
 */
export async function removeSessionAttachmentRefIfUnreferencedByLiveMessage(
  params: { sessionId: string; hash: string },
  db: LedgerDb = defaultDb(),
): Promise<number> {
  if (!/^[0-9a-f]{64}$/.test(params.hash)) return 0;
  const result = await db
    .delete(mediaRefs)
    .where(
      and(
        eq(mediaRefs.refKind, 'session-attachment'),
        eq(mediaRefs.refId, params.sessionId),
        eq(mediaRefs.hash, params.hash),
        sql`NOT EXISTS (
          SELECT 1
            FROM messages
           WHERE messages.session_id = ${params.sessionId}
             AND messages.rewind_at IS NULL
             AND messages.content LIKE ${`%${params.hash}%`}
        )`,
      ),
    )
    .run();
  return result.changes;
}

/**
 * 意识面板供图归属校验:该指纹「出生自本意识」「挂在本意识画廊」「用户
 * 显式引渡给本意识(ghost-grant)」「Host 代办交接给本意识
 * (ghost-tool-grant)」或「本意识寄存的(ghost-deposit)」才放行。
 * 查无此账 = 拒(不区分"不存在"与"不属于你",不给探测空间)。
 *
 * 寄存计入本校验正是 #784 要买的东西:用户粘进面板的图寄存后与生成图同权,
 * 面板取件、edit_image / edit_video 的源图校验(resolveOwnedMedia 走本函数)
 * 一并成立 —— "画布上的图 = AI 能加工的图"。
 */
export async function ghostCanRead(
  hash: string,
  ghostId: string,
  db: LedgerDb = defaultDb(),
): Promise<boolean> {
  const row = await db
    .select({ one: sql`1` })
    .from(mediaRefs)
    .where(
      and(
        eq(mediaRefs.hash, hash),
        or(
          and(eq(mediaRefs.originKind, 'ghost'), eq(mediaRefs.originId, ghostId)),
          and(eq(mediaRefs.refKind, 'ghost-gallery'), eq(mediaRefs.refId, ghostId)),
          and(eq(mediaRefs.refKind, 'ghost-grant'), eq(mediaRefs.refId, ghostId)),
          and(eq(mediaRefs.refKind, 'ghost-tool-grant'), eq(mediaRefs.refId, ghostId)),
          and(eq(mediaRefs.refKind, 'ghost-deposit'), eq(mediaRefs.refId, ghostId)),
        ),
      ),
    )
    .limit(1)
    .all();
  return row.length > 0;
}

/**
 * 某意识寄存物的账面字节占用(deposit 配额判定唯一依据)。
 *
 * 按**去重后的指纹**求和(DISTINCT hash 再 join blob 字节):同一张图被寄存
 * 两次只有一行 ref(addRef 前有 hasRef 幂等挡),但即便历史数据里出现重复行,
 * 这里也只算一份 —— 配额口径必须与"磁盘上真实多占了多少字节"一致,内容
 * 寻址下同指纹只占一份磁盘。
 */
export async function ghostDepositUsageBytes(
  ghostId: string,
  db: LedgerDb = defaultDb(),
): Promise<number> {
  const rows = await db
    .select({ bytes: sql<number>`COALESCE(SUM(${mediaBlobs.bytes}), 0)` })
    .from(mediaBlobs)
    .where(
      sql`EXISTS (SELECT 1 FROM ${mediaRefs} WHERE ${mediaRefs.hash} = ${mediaBlobs.hash} AND ${mediaRefs.refKind} = 'ghost-deposit' AND ${mediaRefs.refId} = ${ghostId})`,
    )
    .all();
  return rows[0]?.bytes ?? 0;
}

/**
 * 删除某意识对某指纹的寄存引用(release_media 的账本口)。返回是否真的删掉了
 * 行(false = 本就没有,幂等)。**只删本 refKind + 本 refId**:画廊、引渡、
 * 聊天消息的引用一概不碰,字节交回收器按引用归零统一处理。
 */
export async function removeGhostDepositRef(
  params: { hash: string; ghostId: string },
  db: LedgerDb = defaultDb(),
): Promise<boolean> {
  const result = await db
    .delete(mediaRefs)
    .where(
      and(
        eq(mediaRefs.hash, params.hash),
        eq(mediaRefs.refKind, 'ghost-deposit'),
        eq(mediaRefs.refId, params.ghostId),
      ),
    )
    .run();
  return result.changes > 0;
}

/** 查某指纹的落盘元数据(改图代办等"手里只有指纹"的调用方用);无账即 null。 */
export async function getBlobInfo(
  hash: string,
  db: LedgerDb = defaultDb(),
): Promise<{ ext: string; mimeType: string; bytes: number } | null> {
  const rows = await db
    .select({ ext: mediaBlobs.ext, mimeType: mediaBlobs.mimeType, bytes: mediaBlobs.bytes })
    .from(mediaBlobs)
    .where(eq(mediaBlobs.hash, hash))
    .limit(1)
    .all();
  return rows[0] ?? null;
}

// ── 回收器查询与条件删账──────────────────────────────────────────────

/** 该指纹名下无任何引用行(零引用判定的 SQL 片段,删账与候选查询共用)。 */
function noRefsExist() {
  return sql`NOT EXISTS (SELECT 1 FROM ${mediaRefs} WHERE ${mediaRefs.hash} = ${mediaBlobs.hash})`;
}

export interface ZeroRefBlobRow {
  hash: string;
  ext: string;
  bytes: number;
  isCache: boolean;
  createdAt: number;
  lastAccessAt: number;
}

/**
 * 零引用回收候选:无任何引用行,且入库与最后访问都早于缓冲期(cutoffMs 时间戳)。
 * 缓冲期挡两类"零引用但有主"(§4):写入与记账的间隙、生成→落库的在途窗口。
 * 草稿托盘/排队消息等暂存区的活引用由 recycler 拿本清单再行剔除。
 */
export async function listZeroRefBlobs(
  cutoffMs: number,
  db: LedgerDb = defaultDb(),
): Promise<ZeroRefBlobRow[]> {
  return await db
    .select({
      hash: mediaBlobs.hash,
      ext: mediaBlobs.ext,
      bytes: mediaBlobs.bytes,
      isCache: mediaBlobs.isCache,
      createdAt: mediaBlobs.createdAt,
      lastAccessAt: mediaBlobs.lastAccessAt,
    })
    .from(mediaBlobs)
    .where(and(lt(mediaBlobs.createdAt, cutoffMs), lt(mediaBlobs.lastAccessAt, cutoffMs), noRefsExist()))
    .all();
}

export interface MediaStorageStats {
  totalCount: number;
  totalBytes: number;
  cacheCount: number;
  cacheBytes: number;
}

/** 账面占用统计(存储管理卡片展示用;字节数以账本为准,与磁盘的出入归对账工具)。 */
export async function getStorageStats(db: LedgerDb = defaultDb()): Promise<MediaStorageStats> {
  const rows = await db
    .select({
      isCache: mediaBlobs.isCache,
      count: sql<number>`COUNT(*)`,
      bytes: sql<number>`COALESCE(SUM(${mediaBlobs.bytes}), 0)`,
    })
    .from(mediaBlobs)
    .groupBy(mediaBlobs.isCache)
    .all();
  const stats: MediaStorageStats = { totalCount: 0, totalBytes: 0, cacheCount: 0, cacheBytes: 0 };
  for (const row of rows) {
    stats.totalCount += row.count;
    stats.totalBytes += row.bytes;
    if (row.isCache) {
      stats.cacheCount += row.count;
      stats.cacheBytes += row.bytes;
    }
  }
  return stats;
}

export interface CacheBlobRow {
  hash: string;
  ext: string;
  bytes: number;
  lastAccessAt: number;
}

/** cache 性质 blob 按 LRU 升序(最久未用在前),供逐出候选规划。 */
export async function listCacheBlobsByLru(db: LedgerDb = defaultDb()): Promise<CacheBlobRow[]> {
  return await db
    .select({
      hash: mediaBlobs.hash,
      ext: mediaBlobs.ext,
      bytes: mediaBlobs.bytes,
      lastAccessAt: mediaBlobs.lastAccessAt,
    })
    .from(mediaBlobs)
    .where(eq(mediaBlobs.isCache, true))
    .orderBy(asc(mediaBlobs.lastAccessAt))
    .all();
}

/**
 * 零引用条件删账(recycler 唯一的零引用账删口):零引用 + 缓冲期两个条件
 * 在同一条 DELETE 里复查——扫描到执行之间若有人挂了引用或刷新了访问时间,
 * 这里自然删不动(返回 false),不需要调用方加锁。删账成功后引用行本就为空,
 * FK 级联无事发生;字节文件由调用方接着删。
 */
export async function deleteZeroRefBlobRecord(
  hash: string,
  cutoffMs: number,
  db: LedgerDb = defaultDb(),
): Promise<boolean> {
  const result = await db
    .delete(mediaBlobs)
    .where(
      and(
        eq(mediaBlobs.hash, hash),
        lt(mediaBlobs.createdAt, cutoffMs),
        lt(mediaBlobs.lastAccessAt, cutoffMs),
        noRefsExist(),
      ),
    )
    .run();
  return result.changes > 0;
}

/**
 * cache 逐出条件删账:仍是 cache 性质,且除 integration-cache 外没有任何引用
 * 才删。integration-cache 只是 token→指纹索引(§4:靠 FK 级联随行清掉,下次
 * 同 token 按 miss 重下自愈);其它任何引用(消息/画廊/引渡)意味着 pinBlob
 * 本应已降级——条件里再拦一道,pin 链路漏了也不至于清掉聊天still在引用的字节。
 */
export async function deleteCacheBlobRecord(
  hash: string,
  db: LedgerDb = defaultDb(),
): Promise<boolean> {
  const result = await db
    .delete(mediaBlobs)
    .where(
      and(
        eq(mediaBlobs.hash, hash),
        eq(mediaBlobs.isCache, true),
        sql`NOT EXISTS (SELECT 1 FROM ${mediaRefs} WHERE ${mediaRefs.hash} = ${mediaBlobs.hash} AND ${mediaRefs.refKind} <> 'integration-cache')`,
      ),
    )
    .run();
  return result.changes > 0;
}

/** 账本全量指纹清单(对账工具:与字节仓枚举互diff)。 */
export async function listAllBlobRecords(
  db: LedgerDb = defaultDb(),
): Promise<Array<{ hash: string; ext: string; bytes: number }>> {
  return await db
    .select({ hash: mediaBlobs.hash, ext: mediaBlobs.ext, bytes: mediaBlobs.bytes })
    .from(mediaBlobs)
    .all();
}

/** 画廊清单条目(重启回放用;面板经意识专属协议 /gallery 分支拉取)。 */
export interface GhostGalleryItem {
  hash: string;
  ext: string;
  label: string | null;
  createdAt: number;
}

/**
 * 某意识画廊里的全部引用(新的在前,回放上限截断防失控)。
 * 只查 ghost-gallery ref——这正是"挂墙 = 不被回收"的同一本账,回放与
 * 生死判定天然一致。寄存物(ghost-deposit)**不在此列**:用户粘进面板的
 * 参考图不是这个意识的作品,面板自己知道画布上有什么,不靠画廊回放。
 */
export async function listGhostGallery(
  ghostId: string,
  db: LedgerDb = defaultDb(),
  limit = 200,
): Promise<GhostGalleryItem[]> {
  const rows = await db
    .select({
      hash: mediaRefs.hash,
      ext: mediaBlobs.ext,
      label: mediaRefs.label,
      createdAt: mediaRefs.createdAt,
    })
    .from(mediaRefs)
    .innerJoin(mediaBlobs, eq(mediaRefs.hash, mediaBlobs.hash))
    .where(and(eq(mediaRefs.refKind, 'ghost-gallery'), eq(mediaRefs.refId, ghostId)))
    .orderBy(desc(mediaRefs.createdAt))
    .limit(limit)
    .all();
  return rows;
}

/** 惰性刷新 blob 最近读取时间(cache LRU 依据;失败静默,不影响读路径)。 */
export async function touchBlob(hash: string, db?: LedgerDb): Promise<void> {
  try {
    await (db ?? defaultDb())
      .update(mediaBlobs)
      .set({ lastAccessAt: Date.now() })
      .where(eq(mediaBlobs.hash, hash))
      .run();
  } catch {
    // 账本瞬时不可用不应拖垮媒体读取(含 DbClient 未就绪)。
  }
}
