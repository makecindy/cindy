/**
 * MemoryStorage — Maker Memory 的文件系统层 (CRUD + frontmatter + MEMORY.md 派生)。
 *
 * 责任边界:
 *  - 文件 IO + frontmatter 解析 + 路径 sanitize + size 校验
 *  - **MEMORY.md 索引由本层自动重建** (write/delete 时同步触发), LLM 永远不直接改 MEMORY.md
 *    → 跟 Claude Code auto-memory "让 LLM 手写索引" 的反 pattern 区分; 解决 "分片改了
 *    但索引没同步" 的常见 bug。
 *  - 不管 SQLite/FTS5 (那是 fts.ts 的事), 不管 BaseAgent / MCP (那是上层的事)。
 *  - 不管 sanitizeWorkdir → directory name 的映射, 调用方传已经准备好的目录绝对路径。
 *
 * 写入路径:
 *  write() → schema 校验 → 撞名/size 检查 → 写 .md 文件 → rebuildIndex() → 返 WriteResult
 *  失败抛 MemoryError (硬错误: schema/撞名/路径非法), 软警告通过 WriteResult.warning 字段
 *  返给调用方 (size 接近上限, 提示 LLM consolidate)。
 *
 * 时序:
 *  fs 操作不加锁 — 同一 workdir 下多 session 并发写概率极低, 真撞了 OS 文件 lock 兜底,
 *  最坏情况 MEMORY.md 短暂不一致, rebuildIndex 幂等可恢复。要 ACID 加 SQLite 太重。
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import matter from 'gray-matter';

import {
  CURATED_MEMORY_TYPES,
  DEFAULT_MEMORY_CONFIG,
  isMemoryType,
  MemoryError,
  type MemoryConfig,
  type MemoryFrontmatter,
  type MemoryRecord,
  type MemoryType,
  type WriteOptions,
  type WriteResult,
  type WriteWarningDetail,
} from './types.js';

const INDEX_FILENAME = 'MEMORY.md';
const META_FILENAME = 'meta.json';
const SHARD_EXT = '.md';
const SLUG_REGEX = /^[a-z0-9_-]+$/;

/**
 * 把 workdir 绝对路径转成 sanitize 后的目录名 (Claude Code 风格)。
 *  E:\AIWork\xdt-maker  → 'E--AIWork-xdt-maker'
 *  /Users/sam/proj     → 'Users-sam-proj'
 *
 * 用法是 host 算好后传给 MakerMemoryStore: <userData>/maker-memory/<sanitized>/。
 * 不在 storage 里直接拼路径, 保持 storage 的 dir 是 "已就绪的目录" 这一职责单一。
 */
export function sanitizeWorkdir(absPath: string): string {
  // 替换路径分隔符 + 冒号 (Windows 盘符) 为 '-'; 去除前导 '-' 但保留 'E--' 这种
  // 双 dash (盘符自带 ':' → '-' + '\' → '-')。
  return absPath
    .replace(/[\\/]/g, '-')
    .replace(/:/g, '-')
    .replace(/^-+/, ''); // 去除最前面的 leading '-' (Unix 路径 / 开头转完是 '-Users-...')
}

/**
 * Maker Memory 的 store 定位键(scope key)。本地会话直接用 workdir 绝对路径
 * (保持既有存储目录不迁移);SSH remote 会话用 `ssh:<host 段>:<workdir>` 复合键 —
 * 远端路径是远端机器上的字符串,直接当 key 会跟本地同名路径共用一个 store
 * (两台机器各有 /home/me/proj 时记忆互串)。host 段经 encodeURIComponent 编码:
 * 编码后不含 `:`,前缀后的首个 `:` 即边界,(hostId, workdir) → key 是单射 —
 * 裸拼接时 ('/x:/repo','prod') 与 ('/repo','prod:/x') 会撞成同一个 key
 * (review R5 P2);常规 alias 编码前后相同,键仍可读。数据仍存控制端本机,
 * 目录名经 memoryScopeDirName 派生。所有 getStore 调用方 (agent 启动注入 /
 * MCP withStore) 必须统一经本函数取键,不得各自拼接。
 */
export function buildMemoryScopeKey(workingDir: string, remoteHostId?: string | null): string {
  return remoteHostId ? `ssh:${encodeURIComponent(remoteHostId)}:${workingDir}` : workingDir;
}

/** buildMemoryScopeKey 的远端键前缀。本地键恒为绝对路径, 不会以它开头。 */
const SSH_SCOPE_KEY_PREFIX = 'ssh:';

/**
 * scope key → 落盘目录名。本地键沿用 sanitizeWorkdir(既有目录不迁移);远端
 * 键不能走有损的 sanitizeWorkdir — `ssh:prod:/repo` 与本地路径 `/ssh/prod:/repo`
 * 会 sanitize 成同一个目录名, 隔离承诺被撞破 (review R4 P2)。远端目录名 =
 * `ssh-<host 可读片段>-<sha256(完整 key) 前 16 hex>`:key 是 (hostId, 路径)
 * 对的单射 (见 buildMemoryScopeKey), hash 因此保证目录唯一性, 且对特殊字符/
 * 超长路径免疫 (定长, Windows MAX_PATH 安全);host 片段 (编码形态, 不含 `:`)
 * 只为肉眼可辨识。
 */
export function memoryScopeDirName(scopeKey: string): string {
  if (!scopeKey.startsWith(SSH_SCOPE_KEY_PREFIX)) return sanitizeWorkdir(scopeKey);
  const hostSegment = scopeKey.slice(SSH_SCOPE_KEY_PREFIX.length).split(':', 1)[0] ?? '';
  const digest = createHash('sha256').update(scopeKey, 'utf8').digest('hex').slice(0, 16);
  return `ssh-${sanitizeWorkdir(hostSegment).slice(0, 24)}-${digest}`;
}

/** filename = `<type>_<slug>.md`; slug 误带 `<type>_` 前缀会被拒绝 (见 validateNoTypePrefix) */
export function buildFilename(type: MemoryType, slug: string): string {
  validateNoTypePrefix(type, slug);
  return `${type}_${slug}${SHARD_EXT}`;
}

/**
 * 拒绝 slug 上误带的 `<type>_` 前缀 — memory_write 的调用方 (LLM) 常把 type
 * 写进 name, 造成 `feedback_feedback_foo.md` 双前缀分片 (#1652 附带 bug, #205 审计亦命中)。
 * **只报错不剥离**: 剥离会让存量双前缀分片在 update/append/consolidate 时定位错位 —
 * parseFilename 把 `feedback_feedback_foo.md` 的 slug 解析为 `feedback_foo`, 剥离后
 * 定位到 `feedback_foo.md`, 造成 not-found 或静默修改错误分片。报错让调用方传纯 slug,
 * 存量双前缀分片由一次性改名/去重迁移清理 (另行处理)。
 */
function validateNoTypePrefix(type: MemoryType, slug: string): void {
  if (slug === type) {
    throw new MemoryError(
      'invalid-slug',
      `slug 不能等于 type 名 "${type}", 请传纯 slug (如 "${type}-brief")`,
    );
  }
  if (slug.startsWith(`${type}_`)) {
    throw new MemoryError(
      'invalid-slug',
      `slug "${slug}" 已带 type 前缀 "${type}_", 请传纯 slug (如 "${stripAllTypePrefixes(type, slug) || type + '-brief'}")`,
    );
  }
}

/** 剥掉 slug 上所有重复的 `<type>_` 前缀 — 错误信息示例必须本身可通过校验 */
function stripAllTypePrefixes(type: MemoryType, slug: string): string {
  let out = slug;
  while (out.startsWith(`${type}_`)) {
    out = out.slice(type.length + 1);
  }
  return out;
}
/** 解析 filename 反推 type + slug, 不匹配返 null */
export function parseFilename(filename: string): { type: MemoryType; slug: string } | null {
  if (!filename.endsWith(SHARD_EXT)) return null;
  if (filename === INDEX_FILENAME) return null;
  const stem = filename.slice(0, -SHARD_EXT.length);
  const idx = stem.indexOf('_');
  if (idx <= 0) return null;
  const typeStr = stem.slice(0, idx);
  const slug = stem.slice(idx + 1);
  if (!isMemoryType(typeStr)) return null;
  if (!SLUG_REGEX.test(slug)) return null;
  return { type: typeStr, slug };
}

export function validateSlug(slug: string, maxLen: number): void {
  if (!SLUG_REGEX.test(slug)) {
    throw new MemoryError('invalid-slug', `slug 只允许 [a-z0-9_-], 收到 "${slug}"`);
  }
  if (slug.length > maxLen) {
    throw new MemoryError('invalid-slug', `slug 长度 > ${maxLen}: "${slug}"`);
  }
}

export interface MemoryStorageMeta {
  /** workdir 绝对路径 (调用方记录, storage 不解析) */
  absPath: string;
  /** 首次创建时间 (ISO) */
  createdAt: string;
  /** 最近一次写/读时间 (ISO) — manager 决定是否更新 */
  lastUsedAt: string;
}

export class MemoryStorage {
  private indexCache: string | null = null;
  /**
   * 派生索引 (MEMORY.md) 失效标记 (review #2388 Codex 23rd P1/P2): shard
   * write/delete 已落盘但其后的 rebuildIndex 被 owner 边界中止时置位 —
   * 文件与索引不一致; 下次安全打开 (init) 时 repairIndexIfDirty 惰性修复,
   * 防止同 owner 后续 session 把 stale 索引读进 system prompt。
   */
  private derivedIndexDirty = false;

  constructor(
    /** 已就绪的目录绝对路径, e.g. <userData>/maker-memory/<sanitized-workdir>/ */
    public readonly dir: string,
    public readonly config: MemoryConfig = DEFAULT_MEMORY_CONFIG,
    /**
     * 文件系统写入前守卫 (review #2388 Codex 8th P1): write 内部在真正写盘前
     * 有 await (tryReadRaw 读现有文件判 mode), 边界可在此窗口发生 — 必须在该
     * await 之后、fs.writeFile 之前复核 owner scope, 否则直接调用方 (如 Pi
     * compaction 经 manager.write, withStore 后置检查之外) 会把写入落到旧
     * owner 根后报成功。由 store 透传 manager 注入的 scopeCheck。
     */
    private readonly beforeFileWrite?: () => void,
  ) {}

  /** mkdir -p + 写 meta.json (如缺失). 幂等。 */
  async init(absWorkdir: string): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const metaPath = path.join(this.dir, META_FILENAME);
    try {
      await fs.access(metaPath);
    } catch {
      // 首次打开副作用也 fail-closed (review #2388 Codex 16th P1): 异步初始化
      // 期间边界发生, 不得在旧 owner 下创建 meta.json。
      this.beforeFileWrite?.();
      const meta: MemoryStorageMeta = {
        absPath: absWorkdir,
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
      };
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
    }
  }

  /**
   * 列出所有 memory 分片 (含 frontmatter + body)。MEMORY.md / meta.json 自动跳过。
   * 损坏文件 (frontmatter 缺失 / type 非法) 跳过 + 不抛错 — 不让单个坏文件拖垮全量列表。
   */
  async list(): Promise<MemoryRecord[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch (e) {
      if (isENOENT(e)) return [];
      throw new MemoryError('io-error', `readdir failed: ${(e as Error).message}`);
    }
    const records: MemoryRecord[] = [];
    for (const entry of entries) {
      if (entry === INDEX_FILENAME || entry === META_FILENAME) continue;
      if (!entry.endsWith(SHARD_EXT)) continue;
      const parsed = parseFilename(entry);
      if (!parsed) continue;
      try {
        const rec = await this.readRecord(entry);
        if (rec) records.push(rec);
      } catch {
        // 单个坏文件跳过, 由 review 工具后续清理
      }
    }
    // 按 type 分组, 同 type 内按 slug 升序 → MEMORY.md 索引可读性
    records.sort((a, b) => {
      if (a.frontmatter.type !== b.frontmatter.type) {
        return a.frontmatter.type.localeCompare(b.frontmatter.type);
      }
      return a.slug.localeCompare(b.slug);
    });
    return records;
  }

  /** 读单条; 不存在抛 not-found; 损坏抛 invalid-frontmatter */
  async read(filename: string): Promise<MemoryRecord> {
    this.assertSafeFilename(filename);
    const rec = await this.readRecord(filename);
    if (!rec) throw new MemoryError('not-found', `memory not found: ${filename}`);
    return rec;
  }

  /**
   * 写入. mode 语义:
   *  - 'create' (默认): 撞名抛 already-exists
   *  - 'update'       : 覆盖, 不存在抛 not-found
   *  - 'append'       : 追加 body 到现有末尾, 不存在抛 not-found
   *
   * 写完自动重建 MEMORY.md。返 WriteResult.warning:
   *  - 'shard-size-exceeded' : 写完后 body 超 maxShardBytes (软上限)
   *  - 'index-size-exceeded' : 重建后 MEMORY.md 超 maxIndexBytes (软上限)
   * 软警告 = 写入仍成功; warningDetail 附当前字节/软上限/硬上限,
   * 调用方据此判断超了多少再决定不动 / 微剪 / consolidate。
   */
  async write(opts: WriteOptions): Promise<WriteResult> {
    this.validateOpts(opts);
    const filename = buildFilename(opts.type, opts.name);
    const fullPath = path.join(this.dir, filename);

    let nextBody = opts.body;
    let nextFrontmatter: MemoryFrontmatter;
    const mode = opts.mode ?? 'create';

    const existing = await this.tryReadRaw(fullPath);
    if (mode === 'create') {
      if (existing) {
        throw new MemoryError(
          'already-exists',
          `${filename} 已存在; 用 mode:'update' 覆盖或 mode:'append' 追加`,
        );
      }
      nextFrontmatter = {
        title: opts.title,
        description: opts.description,
        type: opts.type,
        updatedAt: new Date().toISOString(),
      };
    } else {
      if (!existing) {
        throw new MemoryError('not-found', `${filename} 不存在; 用 mode:'create' 新建`);
      }
      const parsed = parseRawShard(existing, filename);
      if (mode === 'append') {
        nextBody = `${parsed.body.trimEnd()}\n\n${opts.body}`;
      }
      nextFrontmatter = {
        title: opts.title || parsed.frontmatter.title,
        description: opts.description || parsed.frontmatter.description,
        type: opts.type,
        updatedAt: new Date().toISOString(),
      };
    }

    // size 硬上限校验 (写之前)
    if (Buffer.byteLength(nextBody, 'utf8') > this.config.hardShardBytes) {
      throw new MemoryError(
        'shard-too-large',
        `body ${Buffer.byteLength(nextBody, 'utf8')} bytes > 硬上限 ${this.config.hardShardBytes}`,
      );
    }

    const fileText = matter.stringify(nextBody, nextFrontmatter);
    // tryReadRaw 的 await 窗口后、真正写盘前复核 owner scope (review #2388
    // Codex 8th P1): 边界不得把 shard 写入旧 owner 根。
    this.beforeFileWrite?.();
    await fs.writeFile(fullPath, fileText, 'utf8');
    // shard write 后、索引重建前复核 (review #2388 Codex 12th P1): writeFile
    // await 期间边界可能发生, 不得继续在旧 owner 下 rebuildIndex / 返回成功。
    // not-ready 时文件已落盘但 MEMORY.md 未更新 → 标记派生索引 dirty (Codex 23rd)。
    this.guardAfterMutation();
    await this.rebuildIndex();
    // rebuildIndex 自身多次 await 后、返回前复核 (review #2388 Codex 13th P1)。
    this.beforeFileWrite?.();

    const result: WriteResult = { ok: true, filename };
    const detail = this.computeWarning(nextBody);
    if (detail) {
      result.warning = detail.kind;
      result.warningDetail = detail;
    }
    return result;
  }

  async delete(filename: string): Promise<void> {
    this.assertSafeFilename(filename);
    const fullPath = path.join(this.dir, filename);
    // 删除前复核 (review #2388 Codex 14th P1): 单次预检只保护 delete 开始瞬间,
    // 边界在 fs.unlink / rebuildIndex 之间发生仍会删旧 owner 文件并重建索引。
    this.beforeFileWrite?.();
    try {
      await fs.unlink(fullPath);
    } catch (e) {
      if (isENOENT(e)) throw new MemoryError('not-found', `${filename} 不存在`);
      throw new MemoryError('io-error', `unlink failed: ${(e as Error).message}`);
    }
    // unlink 后复核 — await 窗口后边界可能发生, 不得继续在旧 owner 下重建索引。
    // not-ready 时文件已删但 MEMORY.md 仍列出 → 标记派生索引 dirty (Codex 23rd)。
    this.guardAfterMutation();
    await this.rebuildIndex();
    // rebuildIndex 内部多次 await 后、返回前复核。
    this.beforeFileWrite?.();
  }

  /**
   * 变更后复核辅助 (review #2388 Codex 23rd P1/P2): shard 已落盘但其后
   * rebuildIndex 被 owner 边界中止 → 文件与 MEMORY.md 不一致, 标记派生索引
   * dirty; 下次安全打开 (init) 时 repairIndexIfDirty 惰性重建, 防止同 owner
   * 后续 session 把 stale 索引读进 system prompt。
   */
  private guardAfterMutation(): void {
    try {
      this.beforeFileWrite?.();
    } catch (e) {
      if (e instanceof MemoryError && e.code === 'not-ready') {
        this.derivedIndexDirty = true;
        this.indexCache = null;
      }
      throw e;
    }
  }

  private markIndexDirty(): void {
    this.derivedIndexDirty = true;
    this.indexCache = null;
  }

  /** 派生索引 (MEMORY.md) 是否因中止的写/删而失效 */
  isIndexDirty(): boolean {
    return this.derivedIndexDirty;
  }

  /** 惰性修复: 上次变更被边界中止 → 重建 MEMORY.md 恢复一致 (幂等) */
  async repairIndexIfDirty(): Promise<void> {
    if (!this.derivedIndexDirty) return;
    await this.rebuildIndex();
    this.derivedIndexDirty = false;
  }

  /** 当前 MEMORY.md 内容 (索引文本, 给 system prompt 拼). 不存在返空串 */
  async getIndex(): Promise<string> {
    if (this.indexCache !== null) return this.indexCache;
    try {
      this.indexCache = await fs.readFile(path.join(this.dir, INDEX_FILENAME), 'utf8');
      return this.indexCache;
    } catch (e) {
      if (isENOENT(e)) {
        this.indexCache = '';
        return '';
      }
      throw new MemoryError('io-error', `read index failed: ${(e as Error).message}`);
    }
  }

  /**
   * 重建 MEMORY.md (从所有分片 frontmatter 派生). 调用方一般不直接用 — write/delete 自动触发。
   * 索引格式:
   *   # Memory Index
   *
   *   ## user
   *   - [user_xxx.md] 用户偏好 — 一行 hook description
   *   ...
   *
   *   ## feedback
   *   ...
   */
  async rebuildIndex(): Promise<void> {
    try {
      await this.rebuildIndexInner();
    } catch (e) {
      // 重建被 owner 边界中止 → 索引未更新, 标记 dirty (review #2388 Codex 23rd)
      if (e instanceof MemoryError && e.code === 'not-ready') {
        this.markIndexDirty();
      }
      throw e;
    }
  }

  private async rebuildIndexInner(): Promise<void> {
    const records = await this.list();
    const grouped = new Map<MemoryType, MemoryRecord[]>();
    for (const rec of records) {
      const arr = grouped.get(rec.frontmatter.type) ?? [];
      arr.push(rec);
      grouped.set(rec.frontmatter.type, arr);
    }
    const lines: string[] = ['# Memory Index', ''];
    if (records.length === 0) {
      lines.push('_(empty — no memories saved yet for this workdir)_', '');
    } else {
      // 固定顺序 user → feedback → project → reference。**只列 curated 类型** ——
      // `digest`(系统内部,如 pi 压缩摘要)故意排除:进 FTS 可 memory_search,但不进
      // MEMORY.md、不进 system prompt(见 types.ts MEMORY_TYPES 注释)。新增 curated
      // 类型时改 CURATED_MEMORY_TYPES;不要把 digest 加进来。
      for (const type of CURATED_MEMORY_TYPES) {
        const items = grouped.get(type);
        if (!items || items.length === 0) continue;
        lines.push(`## ${type}`);
        for (const r of items) {
          lines.push(`- [${r.filename}] ${r.frontmatter.title} — ${r.frontmatter.description}`);
        }
        lines.push('');
      }
    }
    const content = lines.join('\n');
    // 索引写盘前复核 (review #2388 Codex 13th P1): rebuildIndex 自身有多次
    // awaited shard reads, 边界不得在旧 owner 下重写 MEMORY.md。
    this.beforeFileWrite?.();
    await fs.writeFile(path.join(this.dir, INDEX_FILENAME), content, 'utf8');
    this.indexCache = content;
  }

  /** 当前索引字节数 (UI / warning 用) */
  async getIndexSize(): Promise<number> {
    const content = await this.getIndex();
    return Buffer.byteLength(content, 'utf8');
  }

  // ── 内部 helper ────────────────────────────────────────────────────────────

  private validateOpts(opts: WriteOptions): void {
    if (!isMemoryType(opts.type)) {
      throw new MemoryError('invalid-type', `type 必须是 user/feedback/project/reference, 收到 "${opts.type}"`);
    }
    validateSlug(opts.name, this.config.maxSlugLen);
    if (!opts.title || opts.title.length === 0) {
      throw new MemoryError('invalid-frontmatter', 'title 必填');
    }
    if (opts.title.length > this.config.maxTitleLen) {
      throw new MemoryError('title-too-long', `title 长度 > ${this.config.maxTitleLen}`);
    }
    if (!opts.description || opts.description.length === 0) {
      throw new MemoryError('invalid-frontmatter', 'description 必填');
    }
    if (opts.description.length > this.config.maxDescriptionLen) {
      throw new MemoryError(
        'description-too-long',
        `description 长度 > ${this.config.maxDescriptionLen}`,
      );
    }
    if (/\r|\n/.test(opts.description)) {
      throw new MemoryError('description-has-newline', 'description 必须是一行 (无换行)');
    }
    if (!opts.body || opts.body.length === 0) {
      throw new MemoryError('invalid-frontmatter', 'body 必填');
    }
  }

  private assertSafeFilename(filename: string): void {
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      throw new MemoryError('path-traversal', `非法文件名: "${filename}"`);
    }
    const parsed = parseFilename(filename);
    if (!parsed) {
      throw new MemoryError('invalid-filename', `不符合 <type>_<slug>.md 格式: "${filename}"`);
    }
  }

  private async readRecord(filename: string): Promise<MemoryRecord | null> {
    const parsed = parseFilename(filename);
    if (!parsed) return null;
    const fullPath = path.join(this.dir, filename);
    const raw = await this.tryReadRaw(fullPath);
    if (!raw) return null;
    const shard = parseRawShard(raw, filename);
    if (!shard) return null;
    return {
      filename,
      slug: parsed.slug,
      frontmatter: shard.frontmatter,
      body: shard.body,
      sizeBytes: Buffer.byteLength(raw, 'utf8'),
    };
  }

  private async tryReadRaw(fullPath: string): Promise<string | null> {
    try {
      return await fs.readFile(fullPath, 'utf8');
    } catch (e) {
      if (isENOENT(e)) return null;
      throw new MemoryError('io-error', `read failed: ${(e as Error).message}`);
    }
  }

  /**
   * 重算某分片的软警告 (含索引侧)。分片侧读盘; 索引侧走 indexCache —
   * 本实例的 write/delete 都会刷新缓存, 因此反映的是**本实例视角**的最新状态;
   * 若 MEMORY.md 被其他实例/进程改写, 索引侧评估可能滞后。
   * consolidate 删源后索引已变小, 写入时点的警告可能失真 — 收尾用本方法重算。
   */
  async assessWarning(filename: string): Promise<WriteWarningDetail | undefined> {
    const rec = await this.read(filename);
    await this.getIndex(); // 确保 indexCache 就绪 (新实例上也能评估索引侧)
    return this.computeWarning(rec.body);
  }

  private computeWarning(body: string): WriteWarningDetail | undefined {
    const bodyBytes = Buffer.byteLength(body, 'utf8');
    if (bodyBytes > this.config.maxShardBytes) {
      return {
        kind: 'shard-size-exceeded',
        sizeBytes: bodyBytes,
        softLimitBytes: this.config.maxShardBytes,
        hardLimitBytes: this.config.hardShardBytes,
      };
    }
    // 索引刚被 rebuildIndex 写过, 直接读 cache
    const indexBytes =
      this.indexCache !== null ? Buffer.byteLength(this.indexCache, 'utf8') : 0;
    if (indexBytes > this.config.maxIndexBytes) {
      return {
        kind: 'index-size-exceeded',
        sizeBytes: indexBytes,
        softLimitBytes: this.config.maxIndexBytes,
      };
    }
    return undefined;
  }
}

// ── 模块级工具 ─────────────────────────────────────────────────────────────

interface ParsedShard {
  frontmatter: MemoryFrontmatter;
  body: string;
}

function parseRawShard(raw: string, filenameForErr: string): ParsedShard {
  const parsed = matter(raw);
  const data = parsed.data as Partial<MemoryFrontmatter>;
  if (!data.title || !data.description || !isMemoryType(data.type)) {
    throw new MemoryError(
      'invalid-frontmatter',
      `${filenameForErr} frontmatter 缺字段或 type 非法`,
    );
  }
  return {
    frontmatter: {
      title: data.title,
      description: data.description,
      type: data.type,
      updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : new Date().toISOString(),
    },
    body: parsed.content.trim(),
  };
}

function isENOENT(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'ENOENT';
}
