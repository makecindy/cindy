/**
 * dirDeposit.ts — 目录过户票据库(xd-service 意识化二期,2026-07-13)。
 * ---------------------------------------------------------------------------
 * 「意识触碰用户目录的唯一通道」的主机真身,与图片 attachments 过户同哲学:
 * 上传对象由用户 / 主 agent 显式交付,意识永远拿不到绝对路径与文件字节。
 *
 * 流程:
 *   ghost_call 顶层 dir(绝对路径)
 *     → deposit():验证(绝对 / 存在 / 是目录 / **必须位于会话 workdir 内**)
 *       + 收集文件(排除 node_modules/.git/.env 等开发残留,限额预检)
 *       + 发一次性限时票据(token),relPaths 等元数据注入 args.dir_deposit
 *     → 意识 fetch-request 报 uploadDir.token
 *     → take():验票(本意识 + 未过期 + 未消费),取走即失效,
 *       networkSlot 凭返回的 read() 逐文件读盘代组 multipart 出网。
 *
 * 安全论证:dir 只能来自主 agent 的 ghost_call 调用(用户信任域、权限模式
 * 管辖),且被钳制在会话 workdir 内——workdir 内容本就是主 agent 可读可发网
 * 的范围,本通道不扩大攻击面;意识自造 token 无效(票据按 ghostId 绑定、
 * 主机侧随机发放)。
 *
 * 纯 Node(fs/path/crypto),零 Electron(规则 14):单测直接驱动。
 * 收集逻辑源自 @cindy/mcps xd-service/collect.ts(该包随 MCP 退役删除,
 * 逻辑迁居于此并通用化)。
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  GHOST_DIR_DEPOSIT_TTL_MS,
  GHOST_FETCH_DIR_UPLOAD_MAX_BYTES_PER_FILE,
  GHOST_FETCH_DIR_UPLOAD_MAX_FILES,
  GHOST_FETCH_DIR_UPLOAD_MAX_TOTAL_BYTES,
  GHOST_SAVE_DEPOSIT_MAX_TOTAL_BYTES,
  GHOST_SAVE_DEPOSIT_MAX_USES,
  GHOST_SAVE_DEPOSIT_TTL_MS,
} from '../../shared/ghost.js';

/** 收集到的单个可上传文件。 */
export interface CollectedDirFile {
  /** 绝对路径(主机读盘用,不出主机)。 */
  absPath: string;
  /** 相对目录根的 POSIX 风格路径(multipart filename,服务端按它还原结构)。 */
  relPath: string;
  size: number;
}

/** 过户成功后注入 args.dir_deposit 的元数据(意识可见的全部信息)。 */
export interface DirDepositReceipt {
  token: string;
  file_count: number;
  total_bytes: number;
  /** 相对路径清单(意识据此做 preset 判定等纯逻辑;拿不到内容)。 */
  rel_paths: string[];
}

/** take() 的返回:文件读取经闭包,networkSlot 保持零 fs 依赖。 */
export interface TakenDirDeposit {
  files: Array<{ relPath: string; size: number; read(): Promise<Uint8Array> }>;
  totalBytes: number;
}

/** 排除的目录名(dev-time 垃圾,与原 collect.ts 同口径)。 */
const EXCLUDE_DIR_NAMES = new Set([
  'node_modules', '.git', '.svn', '.hg', '.idea', '.vscode', '.DS_Store',
  '__pycache__', '.next', '.turbo', '.cache',
]);

/** 排除的文件名(凭证与平台垃圾)。 */
const EXCLUDE_FILE_NAMES = new Set([
  '.DS_Store', 'Thumbs.db', '.gitignore', '.gitattributes', '.npmrc',
]);

/** .env 及一切变体(.env.production / .env.local…)绝不出网:前缀匹配,宁滥勿漏。 */
function isEnvFile(name: string): boolean {
  return name === '.env' || name.startsWith('.env.');
}

/**
 * 递归收集目录下可上传文件(限额:数量 / 单文件 / 总量,超限即错)。
 * 返回 either 形态,message 是可直达模型的人话(不含主机侧敏感信息)。
 */
export function collectDirFiles(
  dirAbs: string,
): { ok: true; files: CollectedDirFile[]; totalBytes: number } | { ok: false; message: string } {
  const files: CollectedDirFile[] = [];
  let totalBytes = 0;

  const walk = (current: string): string | null => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return null; // 单个不可读子目录跳过,不致命
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDE_DIR_NAMES.has(entry.name)) continue;
        const err = walk(abs);
        if (err) return err;
      } else if (entry.isFile()) {
        if (EXCLUDE_FILE_NAMES.has(entry.name) || isEnvFile(entry.name)) continue;
        let size: number;
        try {
          size = fs.statSync(abs).size;
        } catch {
          continue;
        }
        if (size > GHOST_FETCH_DIR_UPLOAD_MAX_BYTES_PER_FILE) {
          return `单文件超过限额 ${GHOST_FETCH_DIR_UPLOAD_MAX_BYTES_PER_FILE} 字节:${path.relative(dirAbs, abs)}`;
        }
        const rel = path.relative(dirAbs, abs).split(path.sep).join('/');
        files.push({ absPath: abs, relPath: rel, size });
        totalBytes += size;
        if (files.length > GHOST_FETCH_DIR_UPLOAD_MAX_FILES) {
          return `文件数超过限额 ${GHOST_FETCH_DIR_UPLOAD_MAX_FILES},请清理无关文件或拆分上传`;
        }
        if (totalBytes > GHOST_FETCH_DIR_UPLOAD_MAX_TOTAL_BYTES) {
          return `总体积超过限额 ${GHOST_FETCH_DIR_UPLOAD_MAX_TOTAL_BYTES} 字节`;
        }
      }
      // symlink 等其他类型直接忽略(不跟链接,防指出 workdir 外)
    }
    return null;
  };

  const err = walk(dirAbs);
  if (err) return { ok: false, message: err };
  if (files.length === 0) return { ok: false, message: '目录中没有可上传的文件' };
  return { ok: true, files, totalBytes };
}

/** 路径 b 是否位于目录 a 内(含等于 a;win32 大小写不敏感比较)。
 *  导出给 ghost 附件本地路径分类器复用(ghostLocalPathGrant),钳制口径唯一。 */
export function isPathInsideDir(parentAbs: string, childAbs: string): boolean {
  const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const rel = path.relative(fold(path.resolve(parentAbs)), fold(path.resolve(childAbs)));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

interface VaultEntry {
  ghostId: string;
  files: CollectedDirFile[];
  totalBytes: number;
  expiresAt: number;
}

/**
 * 过户票据库:deposit 发票,take 验票取货(单次消费 + TTL + ghostId 绑定)。
 * 进程内内存态——票据本就是"一次调用链内"的短命凭据,不落盘。
 */
export class DirDepositVault {
  private readonly entries = new Map<string, VaultEntry>();
  /** 时钟注入(单测用;生产走 Date.now)。 */
  constructor(private readonly now: () => number = Date.now) {}

  /**
   * 过户一个目录。workdirAbs 是当前会话工作目录(钳制边界);userGranted=true
   * 表示用户已在确认卡上对**这个路径**点了允许(GhostGrantConfirmBridge),
   * 跳过 workdir 钳制(存在性/类型校验照常)——除接线层的确认流外,任何
   * 调用方不得传 true。缺 workdir 语境且未获用户确认时直接拒绝。
   */
  deposit(params: {
    ghostId: string;
    dirAbs: string;
    workdirAbs: string | null;
    userGranted?: boolean;
  }): { ok: true; receipt: DirDepositReceipt } | { ok: false; message: string } {
    const { ghostId, dirAbs, workdirAbs, userGranted } = params;
    if (!path.isAbsolute(dirAbs)) {
      return { ok: false, message: `dir 必须是绝对路径,得到:${dirAbs}` };
    }
    if (!workdirAbs && !userGranted) {
      return { ok: false, message: '目录必须位于当前会话的工作目录内(不许过户 workdir 之外的路径)' };
    }
    // realpath 归一化后再做钳制:词法比较防不了 symlink / junction——
    // `<workdir>/evil-link → ~/.ssh` 这类"根路径本身是链接"的目录,词法上
    // 在 workdir 内、实际内容在外。两边都解真身(顺带消掉 macOS /tmp →
    // /private/tmp、Windows 8.3 短名的歧义),解不开一律拒。
    let realDir: string;
    try {
      realDir = fs.realpathSync.native(dirAbs);
    } catch {
      return { ok: false, message: `目录不存在:${dirAbs}` };
    }
    // workdir 真身单独解:解不开(远程路径 / 已删)按「不在 workdir 内」处理,
    // 未获用户确认时拒,而不是误报"目录不存在"。
    let realWorkdir: string | null = null;
    if (workdirAbs) {
      try {
        realWorkdir = fs.realpathSync.native(workdirAbs);
      } catch {
        realWorkdir = null;
      }
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(realDir);
    } catch {
      return { ok: false, message: `目录不存在:${dirAbs}` };
    }
    if (!userGranted && (!realWorkdir || !isPathInsideDir(realWorkdir, realDir))) {
      return { ok: false, message: '目录必须位于当前会话的工作目录内(不许过户 workdir 之外的路径)' };
    }
    // 单文件过户(2026-07-13,Drive/Gmail 附件类"传一个文件"场景):dir 指向
    // 文件时按单文件票据处理,钳制与排除口径同目录(凭证类文件名照拒)。
    let collected: { ok: true; files: CollectedDirFile[]; totalBytes: number } | { ok: false; message: string };
    if (stat.isFile()) {
      const name = path.basename(realDir);
      if (EXCLUDE_FILE_NAMES.has(name) || isEnvFile(name)) {
        return { ok: false, message: `该文件类型不允许过户:${name}` };
      }
      if (stat.size > GHOST_FETCH_DIR_UPLOAD_MAX_BYTES_PER_FILE) {
        return { ok: false, message: `单文件超过限额 ${GHOST_FETCH_DIR_UPLOAD_MAX_BYTES_PER_FILE} 字节:${name}` };
      }
      collected = { ok: true, files: [{ absPath: realDir, relPath: name, size: stat.size }], totalBytes: stat.size };
    } else if (stat.isDirectory()) {
      collected = collectDirFiles(realDir);
    } else {
      return { ok: false, message: `路径不是目录或文件:${dirAbs}` };
    }
    if (!collected.ok) return collected;

    this.sweep();
    const token = randomUUID();
    this.entries.set(token, {
      ghostId,
      files: collected.files,
      totalBytes: collected.totalBytes,
      expiresAt: this.now() + GHOST_DIR_DEPOSIT_TTL_MS,
    });
    return {
      ok: true,
      receipt: {
        token,
        file_count: collected.files.length,
        total_bytes: collected.totalBytes,
        rel_paths: collected.files.map((f) => f.relPath),
      },
    };
  }

  /**
   * 验票取货:本意识 + 未过期 + 未消费,取走即失效(重放无效)。
   * 无效原因不分类(不存在 / 越权 / 过期统一 null),不给探测空间。
   */
  take(ghostId: string, token: string): TakenDirDeposit | null {
    this.sweep();
    const entry = this.entries.get(token);
    if (!entry || entry.ghostId !== ghostId) return null;
    this.entries.delete(token);
    if (this.now() > entry.expiresAt) return null;
    return {
      totalBytes: entry.totalBytes,
      files: entry.files.map((f) => ({
        relPath: f.relPath,
        size: f.size,
        read: () => fs.promises.readFile(f.absPath).then((b) => new Uint8Array(b)),
      })),
    };
  }

  /** 惰性清理过期票据(每次存取顺带,量级极小无需定时器)。 */
  private sweep(): void {
    const now = this.now();
    for (const [token, entry] of this.entries) {
      if (now > entry.expiresAt) this.entries.delete(token);
    }
  }
}

let vaultSingleton: DirDepositVault | null = null;

/** 进程内单例(ghost_call 过户与 networkSlot 取货共用同一本账)。 */
export function getDirDepositVault(): DirDepositVault {
  if (!vaultSingleton) vaultSingleton = new DirDepositVault();
  return vaultSingleton;
}

/* ────────────────────────────────────────────────────────────────────────
 * save 票据(下行落盘)——dirDeposit(上行读)的镜像。
 * 主 agent 经 ghost_call 顶层 save_dir 过户一个 workdir 内目录 → 发限时
 * 票据(可多次写:一次调用链里下多个附件),意识 fetch({as:'file'}) 时
 * 主机把响应字节写进该目录。意识全程拿不到绝对路径,只见落盘文件名;
 * 文件名主机消毒(只留 basename、剥控制字符与前导点)且永不覆盖已有文件。
 * ──────────────────────────────────────────────────────────────────────── */

/** 过户成功后注入 args.save_deposit 的元数据(意识可见的全部信息)。 */
export interface SaveDepositReceipt {
  token: string;
  /** 目标目录名(仅展示用途,如"已存到 downloads/ 下";不含上级路径)。 */
  dir_name: string;
}

interface SaveVaultEntry {
  ghostId: string;
  dirAbs: string;
  usesLeft: number;
  bytesLeft: number;
  expiresAt: number;
}

/** Windows 保留设备名(不区分大小写;带任意扩展名同样命中,如 NUL.pdf)。 */
const WINDOWS_RESERVED_BASENAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * 意识建议名 / 派生名 → 安全文件名(只留 basename、剥非法字符与前导点/尾部
 * 点空格、避开 Windows 保留设备名)。名字可被远端 Content-Disposition 控制:
 * 写 NUL 会静默写进空设备(回执成功、盘上无文件),尾部点/空格会被 Windows
 * 静默截断导致回执名与落盘名不一致(规则 15)。
 */
export function sanitizeSaveFileName(raw: string | undefined): string {
  const base = (raw ?? '').split(/[\\/]/).pop() ?? '';
  let cleaned = base
    // eslint-disable-next-line no-control-regex -- 控制字符是显式清洗目标
    .replace(/[\u0000-\u001f<>:"|?*]/g, '')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim();
  if (!cleaned || cleaned === '..') return 'download';
  // 先截断再查保留名:截尾可能让尾段重新以 NUL./COM1. 开头,顺序反了会漏。
  if (cleaned.length > 128) cleaned = cleaned.slice(-128);
  if (WINDOWS_RESERVED_BASENAME_RE.test(cleaned)) cleaned = `_${cleaned}`;
  return cleaned;
}

/** 防覆盖去重:已存在时在扩展名前插 " (n)"。 */
function dedupeFileName(dirAbs: string, fileName: string): string {
  let candidate = fileName;
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  for (let n = 1; fs.existsSync(path.join(dirAbs, candidate)); n++) {
    candidate = `${stem} (${n})${ext}`;
  }
  return candidate;
}

/**
 * 下行落盘票据库:deposit 发票(验证目录在 workdir 内),use 验票拿写入
 * 闭包(TTL + ghostId 绑定 + 次数/字节双预算;写满自动作废)。
 */
export class SaveDepositVault {
  private readonly entries = new Map<string, SaveVaultEntry>();
  constructor(private readonly now: () => number = Date.now) {}

  /** 过户一个可写目录(钳制与 userGranted 旁路口径与 DirDepositVault.deposit 完全一致)。 */
  deposit(params: {
    ghostId: string;
    dirAbs: string;
    workdirAbs: string | null;
    userGranted?: boolean;
  }): { ok: true; receipt: SaveDepositReceipt } | { ok: false; message: string } {
    const { ghostId, dirAbs, workdirAbs, userGranted } = params;
    if (!path.isAbsolute(dirAbs)) {
      return { ok: false, message: `save_dir 必须是绝对路径,得到:${dirAbs}` };
    }
    if (!workdirAbs && !userGranted) {
      return { ok: false, message: '落盘目录必须位于当前会话的工作目录内' };
    }
    let realDir: string;
    try {
      realDir = fs.realpathSync.native(dirAbs);
    } catch {
      return { ok: false, message: `目录不存在:${dirAbs}(落盘目录需要预先存在)` };
    }
    let realWorkdir: string | null = null;
    if (workdirAbs) {
      try {
        realWorkdir = fs.realpathSync.native(workdirAbs);
      } catch {
        realWorkdir = null;
      }
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(realDir);
    } catch {
      return { ok: false, message: `目录不存在:${dirAbs}` };
    }
    if (!stat.isDirectory()) {
      return { ok: false, message: `save_dir 不是目录:${dirAbs}` };
    }
    if (!userGranted && (!realWorkdir || !isPathInsideDir(realWorkdir, realDir))) {
      return { ok: false, message: '落盘目录必须位于当前会话的工作目录内(不许写 workdir 之外)' };
    }
    this.sweep();
    const token = randomUUID();
    this.entries.set(token, {
      ghostId,
      dirAbs: realDir,
      usesLeft: GHOST_SAVE_DEPOSIT_MAX_USES,
      bytesLeft: GHOST_SAVE_DEPOSIT_MAX_TOTAL_BYTES,
      expiresAt: this.now() + GHOST_SAVE_DEPOSIT_TTL_MS,
    });
    return { ok: true, receipt: { token, dir_name: path.basename(realDir) } };
  }

  /**
   * 验票写盘:本意识 + 未过期 + 预算内。与 dirDeposit.take 不同,票据可
   * 多次使用(一次调用链下多个附件),写满次数/字节自动作废。无效原因
   * 不分类统一 null(不给探测空间)。
   */
  async write(
    ghostId: string,
    token: string,
    fileName: string,
    bytes: Uint8Array,
  ): Promise<{ fileName: string } | null> {
    this.sweep();
    const entry = this.entries.get(token);
    if (!entry || entry.ghostId !== ghostId) return null;
    if (this.now() > entry.expiresAt) {
      this.entries.delete(token);
      return null;
    }
    if (entry.usesLeft <= 0 || bytes.byteLength > entry.bytesLeft) return null;
    const finalName = dedupeFileName(entry.dirAbs, sanitizeSaveFileName(fileName));
    try {
      // 异步写:上限 256MB,同步写会把 main event loop 卡住数百 ms 到秒级
      //(遇杀软实时扫描更糟),期间全部 IPC / 窗口交互冻结(规则 15)。
      await fs.promises.writeFile(path.join(entry.dirAbs, finalName), bytes);
    } catch {
      return null;
    }
    entry.usesLeft -= 1;
    entry.bytesLeft -= bytes.byteLength;
    if (entry.usesLeft <= 0 || entry.bytesLeft <= 0) this.entries.delete(token);
    return { fileName: finalName };
  }

  private sweep(): void {
    const now = this.now();
    for (const [token, entry] of this.entries) {
      if (now > entry.expiresAt) this.entries.delete(token);
    }
  }
}

let saveVaultSingleton: SaveDepositVault | null = null;

/** 进程内单例(ghost_call 过户与 networkSlot 写盘共用同一本账)。 */
export function getSaveDepositVault(): SaveDepositVault {
  if (!saveVaultSingleton) saveVaultSingleton = new SaveDepositVault();
  return saveVaultSingleton;
}
