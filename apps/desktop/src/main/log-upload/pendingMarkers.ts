/**
 * 待补传标记 —— 崩溃现场能不能被补上，全看这一层是否正确。
 *
 * 设计要点（需求 §4.5）：
 *
 *  - **一次未传崩溃 = 一个文件**（`pending-<crashAtMs>-<token>.json`）。天然支持「多次未传
 *    崩溃都能覆盖」，也让并发清除天然只作用于单个崩溃。
 *  - **代次令牌**（文件名里的 `token`）。开发版与正式版共享数据目录，两个实例可能并发读写
 *    同一批标记；仅靠时间戳在同毫秒的并发写下会误判成同一条。
 *  - **原子认领**：`rename(marker → marker.claim.<pid>.<runToken>)`。同目录 rename 在
 *    macOS / Windows 均为原子替换，抢输的实例拿到 ENOENT 直接跳过。
 *  - **只清自己认领的那一代**：删的是自己那个 claim 文件名，绝不会把另一个实例刚写的新
 *    崩溃标记误删。
 *  - **仅成功且非空才清**：上传失败或采到 0 条 ⇒ 把 claim 文件 rename 回原名，下次启动重试。
 *  - **授权关闭 ⇒ 清空全部**：用户关掉授权后不得在下次启动偷偷补传。
 *  - **超出保留期 ⇒ 直接删不上传**：日志已被清理，补传无意义。
 *
 * 纯逻辑：文件系统与随机数注入。
 */

import { LOG_RETENTION_DAYS } from '../../shared/logRetention';

/** 标记文件的 schema。字段少而稳定——崩溃瞬间写盘，越简单越不容易写坏。 */
export interface PendingMarker {
  v: 1;
  /** 代次令牌。同时出现在文件名里（认领靠它），是这条标记的唯一身份。 */
  token: string;
  /** `crash` = 经过 lifecycle 的致命退出；`native-crash` = 启动尸检判定的无退出记录。 */
  kind: 'crash' | 'native-crash';
  /** 崩溃时刻（epoch ms）。补传时作为裁剪锚点。 */
  crashAtMs: number;
  appVersion: string;
  pid: number;
  createdAt: string;
}

/** 已认领的标记：带上 claim 文件路径，供成功清除 / 失败还原。 */
export interface ClaimedMarker {
  marker: PendingMarker;
  /** 认领后的文件路径（`<原名>.claim.<pid>.<runToken>`）。 */
  claimPath: string;
  /** 认领前的原始文件路径，失败时 rename 回去。 */
  originalPath: string;
}

/**
 * 注入的文件系统能力。全部同步：崩溃即时路径只能同步写（进程随时可能没了），
 * 启动补传路径量极小（几个 <400B 的文件），同步也不构成负担。
 */
export interface MarkerFs {
  mkdirSync(dir: string): void;
  readdirSync(dir: string): string[];
  readFileSync(file: string): string;
  writeFileSync(file: string, data: string): void;
  renameSync(from: string, to: string): void;
  unlinkSync(file: string): void;
  statMtimeMs(file: string): number;
}

export interface MarkerStoreDeps {
  /** 标记目录（`<userData>/diagnostics/log-upload`）。 */
  dir: string;
  fs: MarkerFs;
  now(): number;
  pid: number;
  appVersion: string;
  /** 生成代次令牌（生产用 crypto.randomBytes）。 */
  randomToken(): string;
  joinPath(...parts: string[]): string;
  warn(message: string, err?: unknown): void;
}

const PENDING_PREFIX = 'pending-';
const PENDING_SUFFIX = '.json';
const CLAIM_MARK = '.claim.';

/**
 * 被中途杀掉的实例会留下 claim 文件。超过这个时长的 claim 视为可重新认领——否则一个在
 * 补传过程中被强杀的实例会让那个崩溃标记永久卡死，再也补不上。
 */
const STALE_CLAIM_MS = 60 * 60 * 1000;

function isPendingName(name: string): boolean {
  return name.startsWith(PENDING_PREFIX) && name.endsWith(PENDING_SUFFIX);
}

function isClaimName(name: string): boolean {
  return name.startsWith(PENDING_PREFIX) && name.includes(CLAIM_MARK);
}

/**
 * 本模块管理的**任意**标记文件（未认领的 + 已认领的 claim）。
 *
 * `clearAll` 必须用这个而不是 `isPendingName`：claim 文件名形如
 * `pending-<ts>-<token>.json.claim.<pid>.<runToken>`，**不以 `.json` 结尾**。只按
 * `isPendingName` 清的话，用户关闭授权时正在被本进程补传的那条标记会被漏掉，
 * 补传照常完成 —— 正是需求 §4.3 末条要禁止的行为。
 */
function isAnyMarkerName(name: string): boolean {
  return isPendingName(name) || isClaimName(name);
}

/** claim 文件名 → 它认领的原始标记文件名。 */
function originalNameOfClaim(claimName: string): string {
  const at = claimName.indexOf(CLAIM_MARK);
  return at < 0 ? claimName : claimName.slice(0, at);
}

export class PendingMarkerStore {
  private readonly deps: MarkerStoreDeps;
  /** 本进程的运行令牌，进 claim 文件名，区分同 pid 的多次运行（pid 复用）。 */
  private readonly runToken: string;

  constructor(deps: MarkerStoreDeps) {
    this.deps = deps;
    this.runToken = deps.randomToken();
  }

  /**
   * 写一条待补传标记。崩溃即时路径调用，必须同步且极短。
   *
   * 返回写下的标记；写失败返回 null（只 warn，绝不抛——调用点在崩溃处理链上，
   * 再抛会形成二次异常）。
   */
  write(kind: PendingMarker['kind'], crashAtMs: number): PendingMarker | null {
    const marker: PendingMarker = {
      v: 1,
      token: this.deps.randomToken(),
      kind,
      crashAtMs,
      appVersion: this.deps.appVersion,
      pid: this.deps.pid,
      createdAt: new Date(this.deps.now()).toISOString(),
    };
    try {
      this.deps.fs.mkdirSync(this.deps.dir);
      // 直接写目标名:内容是本进程独有的新标记,不存在与其它实例竞争同名的可能
      // (token 唯一),所以不需要 tmp + rename 那一步。
      this.deps.fs.writeFileSync(this.pathOf(marker), JSON.stringify(marker));
      return marker;
    } catch (err) {
      this.deps.warn('failed to write pending log-upload marker', err);
      return null;
    }
  }

  private pathOf(marker: PendingMarker): string {
    return this.deps.joinPath(
      this.deps.dir,
      `${PENDING_PREFIX}${marker.crashAtMs}-${marker.token}${PENDING_SUFFIX}`,
    );
  }

  /**
   * 认领全部可补传的标记。
   *
   * 顺序：先回收过期 claim（被强杀的实例留下的），再逐个 rename 认领。同时丢弃超出本地
   * 日志保留期的标记（日志已被清理，补传无意义）。
   */
  claimAll(): ClaimedMarker[] {
    let names: string[];
    try {
      names = this.deps.fs.readdirSync(this.deps.dir);
    } catch {
      return []; // 目录不存在 = 没有待补传
    }
    this.recoverStaleClaims(names);

    let fresh: string[];
    try {
      fresh = this.deps.fs.readdirSync(this.deps.dir);
    } catch {
      return [];
    }

    const claimed: ClaimedMarker[] = [];
    const retentionCutoff = this.deps.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const name of fresh) {
      if (!isPendingName(name) || isClaimName(name)) continue;
      const originalPath = this.deps.joinPath(this.deps.dir, name);
      const claimPath = `${originalPath}${CLAIM_MARK}${this.deps.pid}.${this.runToken}`;
      // 认领 = 原子 rename。抢输的实例在这里拿 ENOENT,直接跳过这条。
      try {
        this.deps.fs.renameSync(originalPath, claimPath);
      } catch {
        continue;
      }
      const marker = this.readMarker(claimPath);
      if (!marker) {
        // 内容坏了(崩溃瞬间写了一半):删掉,不留下永远认领不动的垃圾。
        this.remove(claimPath);
        continue;
      }
      if (marker.crashAtMs < retentionCutoff) {
        this.remove(claimPath);
        continue;
      }
      claimed.push({ marker, claimPath, originalPath });
    }
    return claimed;
  }

  /** 把过期 claim 文件改回原名，让它能被重新认领。 */
  private recoverStaleClaims(names: readonly string[]): void {
    const cutoff = this.deps.now() - STALE_CLAIM_MS;
    for (const name of names) {
      if (!isClaimName(name)) continue;
      const claimPath = this.deps.joinPath(this.deps.dir, name);
      let mtime: number;
      try {
        mtime = this.deps.fs.statMtimeMs(claimPath);
      } catch {
        continue;
      }
      if (mtime > cutoff) continue; // 还新,可能是另一个实例正在处理
      const originalPath = this.deps.joinPath(this.deps.dir, originalNameOfClaim(name));
      try {
        this.deps.fs.renameSync(claimPath, originalPath);
      } catch (err) {
        this.deps.warn(`failed to recover stale log-upload claim ${name}`, err);
      }
    }
  }

  private readMarker(file: string): PendingMarker | null {
    try {
      const raw: unknown = JSON.parse(this.deps.fs.readFileSync(file));
      if (!raw || typeof raw !== 'object') return null;
      const r = raw as Record<string, unknown>;
      if (typeof r.token !== 'string' || !r.token) return null;
      if (r.kind !== 'crash' && r.kind !== 'native-crash') return null;
      if (typeof r.crashAtMs !== 'number' || !Number.isFinite(r.crashAtMs)) return null;
      return {
        v: 1,
        token: r.token,
        kind: r.kind,
        crashAtMs: r.crashAtMs,
        appVersion: typeof r.appVersion === 'string' ? r.appVersion : '',
        pid: typeof r.pid === 'number' ? r.pid : 0,
        createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
      };
    } catch {
      return null;
    }
  }

  /** 上传确实成功且非空 ⇒ 清除。只删自己那个 claim 文件名。 */
  resolveClaimed(claim: ClaimedMarker): void {
    this.remove(claim.claimPath);
  }

  /** 上传失败或采到 0 条 ⇒ 还原，下次启动重试。 */
  releaseClaimed(claim: ClaimedMarker): void {
    try {
      this.deps.fs.renameSync(claim.claimPath, claim.originalPath);
    } catch (err) {
      // 还原失败:claim 文件留在盘上,由 recoverStaleClaims 在 STALE_CLAIM_MS 后接回。
      this.deps.warn('failed to release log-upload claim (will be recovered later)', err);
    }
  }

  /**
   * 清空全部标记（含已被认领的）。授权被关闭时调用：用户关掉授权后，已有的待补传标记
   * 必须被清掉，不得在下次启动补传（需求 §4.3）。
   */
  clearAll(): number {
    let names: string[];
    try {
      names = this.deps.fs.readdirSync(this.deps.dir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      if (!isAnyMarkerName(name)) continue;
      if (this.remove(this.deps.joinPath(this.deps.dir, name))) removed += 1;
    }
    return removed;
  }

  private remove(file: string): boolean {
    try {
      this.deps.fs.unlinkSync(file);
      return true;
    } catch {
      return false;
    }
  }
}

export const __testing = {
  PENDING_PREFIX,
  CLAIM_MARK,
  STALE_CLAIM_MS,
  originalNameOfClaim,
  isAnyMarkerName,
};
