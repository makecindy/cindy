/**
 * localOwnerDataAdoption — local 模式(跳过登录)数据在登录后的一次性认领。
 *
 * 背景:local 模式的 dataOwnerId 固定为 `local-v1`(appSessionState),会话库
 * `<userData>/<prefix>-local-v1.db` 与 owner 命名空间 `owners/<localKey>/` 都按
 * 该命名空间隔离。用户登录后 dataOwnerId 切为账号 userId,UI 只读账号命名空间
 * ——local 模式期间创建的会话在盘上完好却不可见,观感是「登录把会话弄丢了」。
 *
 * 本模块在「登录成功、账号 db 尚未打开」时(registerLocalDbIpc 的
 * beforeEnsureReady 钩子,排在 mToc 首登迁移之后)做一次性的整体认领:
 *  - 触发前提(全部满足才弹窗):local 库存在**且含至少一条未删除会话**;账号库
 *    `<prefix>-<userId>.db` 不存在(本机全新账号);独占 userData(非 passive、
 *    无并发活实例);local 库已干净关闭(无 wal/shm 残留)。
 *  - 弹确认窗让用户二选一:「并入当前账号」或「保留在本机模式」。共用机器上
 *    A 的本机会话绝不能被 B 的账号静默吸收,确认窗是归属裁决,不可省略。
 *  - 并入 = 搬移而非复制:先合并搬 `owners/<localKey>` → `owners/<accountKey>`
 *    (不覆盖,冲突跳过),最后把 local 库改名为账号库(db rename 是提交点,
 *    之前任一步崩溃下次登录幂等续跑)。会话 working_dir 里指向 local 命名空间
 *    dialogues 的路径由 db ready 后的 sweepLegacyDialogueWorkingDirs 统一改写
 *    (bootstrap 已把 local dialogues 根加入 additionalLegacyDialogueRoots)。
 *  - marker `<userData>/.local-owner-adoption-v1.json`:认领成功记
 *    claimedOwnerKey(一次性,永久终结);用户拒绝记 declinedOwnerKeys(该账号
 *    不再询问,数据保持可被其它全新账号认领)。key 存 dataOwnerStorageKey 哈希,
 *    与 owners/ 目录同口径,不落明文 userId。
 *  - 任一步失败:不写 marker(下次登录重试)、warn 日志、failed 弹窗,不阻塞
 *    登录(ensureReady 照常建新账号库)。
 *
 * 账号库已存在(此前登录过/由 mToc 迁入)时不做行级合并——直接跳过,local 数据
 * 原地保留,回到 local 模式仍可见(与用户确认的 v1 失效契约一致)。
 *
 * 可测试性(engineering-conventions §3):核心流程 runLocalOwnerDataAdoption 全部
 * 依赖经 LocalOwnerAdoptionDeps 注入;electron 依赖只出现在默认实现的静态 import。
 */

import path from 'node:path';
import fsp from 'node:fs/promises';
import { app, BrowserWindow, ipcMain } from 'electron';
import Database from 'better-sqlite3';
import { BRAND_IDENTITY } from '@cindy/maker-shared/brand-identity';

import { LOCAL_DATA_OWNER_ID, dataOwnerStorageKey } from './appSessionState.js';
import {
  hasConcurrentLiveInstancesSharingUserData,
  moveWithoutOverwrite,
  type MoveFsDeps,
} from './ownerNamespaceMigration.js';
import { closeDb, getCurrentUserId } from './localDb/index.js';
import { assertTrustedAppRendererEvent } from './security/trustedAppRenderer.js';
import { throwIpcError } from './utils/ipcValidate.js';
import { createLogger } from './logger.js';

/** marker 文件名(userData 根下;认领终态与各账号的拒绝记录)。 */
export const LOCAL_OWNER_ADOPTION_MARKER_FILENAME = '.local-owner-adoption-v1.json';

/** owners 命名空间根目录名(与 appSessionState.ownerScopedUserDataPath 一致)。 */
const OWNERS_DIR_NAME = 'owners';

/** SQLite sidecar 后缀;残留 = 库仍被别的进程持有,认领必须推迟。 */
const DB_SIDECAR_SUFFIXES = ['-wal', '-shm'] as const;

/** 推送给 renderer 的弹窗阶段(语义同 mToc:done/failed 后可解除)。 */
export type LocalAdoptionPhase = 'confirm' | 'running' | 'done' | 'failed';

/** 用户在确认窗上的裁决。 */
export type LocalAdoptionDecision = 'adopt' | 'keep';

interface AdoptionMarker {
  version: 1;
  /** 认领成功的账号 ownerKey(dataOwnerStorageKey 哈希);存在即永久终结。 */
  claimedOwnerKey?: string;
  adoptedAt?: string;
  /** 拒绝过认领的账号 ownerKey 列表;这些账号不再询问,数据保持可认领。 */
  declinedOwnerKeys?: string[];
}

/** 内存可替身的最小 fs 面;默认实现见 realFsDeps。全部异步。 */
export interface LocalAdoptionFsDeps extends MoveFsDeps {
  pathExists(p: string): Promise<boolean>;
  readFile(p: string): Promise<string>;
  writeFile(p: string, content: string): Promise<void>;
}

/** UI 桥:main→renderer 弹窗阶段推送 + 等待用户裁决。 */
export interface LocalAdoptionUiDeps {
  publish(phase: LocalAdoptionPhase): void;
  waitForDecision(): Promise<LocalAdoptionDecision>;
}

/** runLocalOwnerDataAdoption 的全量依赖注入面。 */
export interface LocalOwnerAdoptionDeps {
  userDataDir: string;
  /** 主库文件名前缀(`<prefix>-<ownerId>.db`)。 */
  dbFilePrefix: string;
  fs: LocalAdoptionFsDeps;
  /**
   * 统计 local 库里未删除会话数;打开失败/表缺失时 throw(调用方按不可读跳过)。
   * 默认实现顺带完成 wal checkpoint(open+close),让 sidecar 检查有意义。
   */
  countLocalSessions(dbPath: string): Promise<number>;
  /** 共享 userData 的 passive dev 实例必须保持只读。 */
  passiveSharedUserData(): boolean;
  /** 是否有其它活实例共享本 userData(rename 前的独占确认)。 */
  hasConcurrentLiveInstances(): boolean;
  /** 若 main 进程仍以 local-v1 打开着库(inproc fallback),先关闭再动文件。 */
  closeLocalDbIfOpen(): void;
  now(): Date;
  log: { info(msg: string, ...args: unknown[]): void; warn(msg: string, ...args: unknown[]): void };
  ui: LocalAdoptionUiDeps;
}

export type LocalOwnerAdoptionResult =
  | { status: 'skipped-local-owner' }
  | { status: 'already-claimed' }
  | { status: 'declined-before' }
  | { status: 'no-local-db' }
  | { status: 'no-local-sessions' }
  | { status: 'account-db-exists' }
  | { status: 'local-db-unreadable'; error: string }
  | {
      status: 'deferred';
      reason: 'passive-shared-user-data' | 'concurrent-live-instances' | 'local-db-busy';
    }
  | { status: 'declined' }
  | { status: 'adopted'; ownersMoved: number; ownersConflicts: number }
  | { status: 'failed'; error: string };

async function readAdoptionMarker(
  deps: LocalOwnerAdoptionDeps,
  markerPath: string,
): Promise<AdoptionMarker | null> {
  if (!(await deps.fs.pathExists(markerPath))) return null;
  try {
    const parsed = JSON.parse(await deps.fs.readFile(markerPath)) as Partial<AdoptionMarker>;
    if (parsed.version !== 1) throw new Error('unsupported marker version');
    return parsed as AdoptionMarker;
  } catch (err) {
    // 损坏的 marker 当作缺失:前置条件(账号库存在检查 / local 库存在检查)本身
    // 就能防住重复认领,丢失的只是拒绝记录(最多再问一次),方向安全。
    deps.log.warn(
      'local owner adoption: marker unreadable, treating as absent: %s',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

async function writeAdoptionMarker(
  deps: LocalOwnerAdoptionDeps,
  markerPath: string,
  marker: AdoptionMarker,
): Promise<void> {
  await deps.fs.writeFile(markerPath, JSON.stringify(marker, null, 2));
}

/** local 库的 sidecar(-wal/-shm)任一存在 = 仍被持有,不能 rename。 */
async function localDbSidecarsPresent(
  deps: LocalOwnerAdoptionDeps,
  localDbPath: string,
): Promise<boolean> {
  for (const suffix of DB_SIDECAR_SUFFIXES) {
    if (await deps.fs.pathExists(`${localDbPath}${suffix}`)) return true;
  }
  return false;
}

/**
 * local 模式数据认领核心流程。纯 DI,不 import electron 运行时对象;绝不 throw
 * (所有失败收敛成结果值),调用方(beforeEnsureReady)无需 try/catch。
 */
export async function runLocalOwnerDataAdoption(
  userId: string,
  deps: LocalOwnerAdoptionDeps,
): Promise<LocalOwnerAdoptionResult> {
  try {
    // 0. 防御:local 模式自身的 ensureReady(local-v1)绝不能触发认领。
    if (!userId || userId === LOCAL_DATA_OWNER_ID) return { status: 'skipped-local-owner' };

    const markerPath = path.join(deps.userDataDir, LOCAL_OWNER_ADOPTION_MARKER_FILENAME);
    const ownerKey = dataOwnerStorageKey(userId);
    const marker = await readAdoptionMarker(deps, markerPath);
    if (marker?.claimedOwnerKey) return { status: 'already-claimed' };
    if (marker?.declinedOwnerKeys?.includes(ownerKey)) return { status: 'declined-before' };

    // 1. 前置探测(全部廉价 pathExists,不满足则静默返回,绝不弹窗)。
    const localDbPath = path.join(
      deps.userDataDir,
      `${deps.dbFilePrefix}-${LOCAL_DATA_OWNER_ID}.db`,
    );
    if (!(await deps.fs.pathExists(localDbPath))) return { status: 'no-local-db' };
    const accountDbPath = path.join(deps.userDataDir, `${deps.dbFilePrefix}-${userId}.db`);
    if (await deps.fs.pathExists(accountDbPath)) return { status: 'account-db-exists' };

    // 2. 独占确认:passive 只读实例与并发活实例都只推迟,不取消(下次登录重来)。
    if (deps.passiveSharedUserData()) {
      deps.log.info('local owner adoption deferred: passive shared-userData instance');
      return { status: 'deferred', reason: 'passive-shared-user-data' };
    }
    if (deps.hasConcurrentLiveInstances()) {
      deps.log.info('local owner adoption deferred: other live instances share this userData');
      return { status: 'deferred', reason: 'concurrent-live-instances' };
    }

    // 3. 本进程若仍持有 local 库(inproc fallback 路径)先关闭;随后 open+close
    //    统计会话数,顺带完成 wal checkpoint。0 条会话 = 无可认领,静默跳过
    //    (不写 marker:之后 local 模式产生了会话,再次登录仍可认领)。
    deps.closeLocalDbIfOpen();
    let sessionCount: number;
    try {
      sessionCount = await deps.countLocalSessions(localDbPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.log.warn('local owner adoption: local db unreadable, skipped: %s', message);
      return { status: 'local-db-unreadable', error: message };
    }
    if (sessionCount <= 0) return { status: 'no-local-sessions' };
    if (await localDbSidecarsPresent(deps, localDbPath)) {
      deps.log.info('local owner adoption deferred: local db sidecars still present');
      return { status: 'deferred', reason: 'local-db-busy' };
    }

    // 4. 归属裁决:弹窗等待用户二选一。拒绝 = 记录该账号,数据保持可认领。
    deps.ui.publish('confirm');
    const decision = await deps.ui.waitForDecision();
    if (decision === 'keep') {
      await writeAdoptionMarker(deps, markerPath, {
        version: 1,
        declinedOwnerKeys: [...(marker?.declinedOwnerKeys ?? []), ownerKey],
      });
      // done 语义 = 弹窗解除;renderer 对 done 不渲染。
      deps.ui.publish('done');
      deps.log.info('local owner adoption declined by user; local data stays in local mode');
      return { status: 'declined' };
    }

    deps.ui.publish('running');
    try {
      // 5. 确认窗可能停留很久,搬移前重做独占确认(与 ownerNamespaceMigration 的
      //    mid-claim 复查同一姿势);账号库若在窗口期出现也绝不覆盖。
      if (deps.hasConcurrentLiveInstances()) {
        deps.log.info('local owner adoption interrupted: instance appeared while confirming');
        deps.ui.publish('failed');
        return { status: 'deferred', reason: 'concurrent-live-instances' };
      }
      if (
        (await deps.fs.pathExists(accountDbPath)) ||
        (await localDbSidecarsPresent(deps, localDbPath))
      ) {
        deps.log.warn('local owner adoption aborted: target db or sidecars appeared mid-flow');
        deps.ui.publish('failed');
        return { status: 'failed', error: 'target db or sidecars appeared mid-flow' };
      }

      // 6. 先合并搬 owners 命名空间(不覆盖,冲突跳过;幂等,崩溃后可续跑),
      //    最后 rename 主库 —— db 改名是提交点:它成功前,下次登录的前置探测
      //    (local 库在 + 账号库不在)仍成立,整个流程自然重试。
      const localOwnerDir = path.join(
        deps.userDataDir,
        OWNERS_DIR_NAME,
        dataOwnerStorageKey(LOCAL_DATA_OWNER_ID),
      );
      const accountOwnerDir = path.join(deps.userDataDir, OWNERS_DIR_NAME, ownerKey);
      let ownersMoved = 0;
      let ownersConflicts = 0;
      if (await deps.fs.pathExists(localOwnerDir)) {
        const moveResult = await moveWithoutOverwrite(deps.fs, localOwnerDir, accountOwnerDir);
        ownersMoved = moveResult.moved;
        ownersConflicts = moveResult.conflicts;
      }
      await deps.fs.rename(localDbPath, accountDbPath);
      await writeAdoptionMarker(deps, markerPath, {
        version: 1,
        claimedOwnerKey: ownerKey,
        adoptedAt: deps.now().toISOString(),
        ...(marker?.declinedOwnerKeys?.length
          ? { declinedOwnerKeys: marker.declinedOwnerKeys }
          : {}),
      });
      deps.ui.publish('done');
      deps.log.info(
        'local owner adoption completed: sessions=%d ownersMoved=%d ownersConflicts=%d',
        sessionCount,
        ownersMoved,
        ownersConflicts,
      );
      return { status: 'adopted', ownersMoved, ownersConflicts };
    } catch (err) {
      // 搬移阶段失败:不写 marker(下次登录重试)、failed 弹窗、不阻塞登录。
      const message = err instanceof Error ? err.message : String(err);
      deps.log.warn('local owner adoption failed (will retry next login): %s', message);
      deps.ui.publish('failed');
      return { status: 'failed', error: message };
    }
  } catch (err) {
    // marker/探测阶段的意外失败:不弹窗(还没进确认流程),不阻塞登录。
    const message = err instanceof Error ? err.message : String(err);
    deps.log.warn('local owner adoption aborted: %s', message);
    return { status: 'failed', error: message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Electron 默认实现(IPC 桥 + 真实 fs)。
// ─────────────────────────────────────────────────────────────────────────────

const log = createLogger('localOwnerDataAdoption');

/** 当前推送给 renderer 的阶段(renderer 挂载晚于推送时经 get-state 补拉)。 */
let currentPhase: LocalAdoptionPhase | null = null;
/** 确认窗的 pending resolver(同一时刻至多一个认领在等裁决)。 */
let pendingDecisionResolver: ((decision: LocalAdoptionDecision) => void) | null = null;
/** 并发防重入:beforeEnsureReady 可能被重复触发,共享同一个 in-flight promise。 */
let inFlight: Promise<LocalOwnerAdoptionResult> | null = null;

function broadcastPhase(phase: LocalAdoptionPhase): void {
  currentPhase = phase;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('local-adoption:state', { phase });
    }
  }
}

const realFsDeps: LocalAdoptionFsDeps = {
  pathExists: async (p) => {
    try {
      await fsp.access(p);
      return true;
    } catch {
      return false;
    }
  },
  readFile: (p) => fsp.readFile(p, 'utf8'),
  writeFile: (p, content) => fsp.writeFile(p, content, 'utf8'),
  lstat: (p) => fsp.lstat(p),
  readdir: (dir) => fsp.readdir(dir),
  mkdir: async (dir) => {
    await fsp.mkdir(dir, { recursive: true });
  },
  rename: (source, target) => fsp.rename(source, target),
  rmdir: (dir) => fsp.rmdir(dir),
};

/**
 * 统计 local 库未删除会话数。这里直连 better-sqlite3 而非 DbClient:此时账号库
 * 尚未 ensureReady,DbClient 也只面向「当前 owner 的库」,而 local 库是另一个
 * owner 的已关闭文件——这是迁移工具语境(与 mToc/ownerNamespaceMigration 同层),
 * 不是运行期业务查询。open+close 顺带完成 wal checkpoint,使 sidecar 检查成立。
 */
async function countSessionsInLocalDb(dbPath: string): Promise<number> {
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS c FROM sessions WHERE status != 'deleted'")
      .get() as { c?: number | bigint } | undefined;
    return Number(row?.c ?? 0);
  } finally {
    db.close();
  }
}

const electronUiDeps: LocalAdoptionUiDeps = {
  publish: broadcastPhase,
  waitForDecision: () =>
    new Promise<LocalAdoptionDecision>((resolve) => {
      pendingDecisionResolver = resolve;
    }),
};

/**
 * 注册认领弹窗的 IPC handler(bootstrap 里在 registerLocalDbIpc 前调用一次)。
 *  - `local-adoption:decide`:renderer 传回用户裁决('adopt' | 'keep');failed/
 *    done 态下的解除也走这条(无 pending resolver 时仅清态)。
 *  - `local-adoption:get-state`:renderer 弹窗组件挂载时补拉当前阶段,避免
 *    「main 先推送、renderer 后订阅」丢事件。
 */
export function registerLocalOwnerAdoptionIpc(): void {
  ipcMain.handle('local-adoption:decide', (event, decision: unknown) => {
    // 裁决影响数据归属,只接受 Cindy 自有顶层 Renderer(WebView/Ghost 页面拒绝)。
    assertTrustedAppRendererEvent(event);
    if (decision !== 'adopt' && decision !== 'keep') {
      throwIpcError('INVALID_PARAMS', 'decision must be "adopt" or "keep"');
    }
    const resolver = pendingDecisionResolver;
    pendingDecisionResolver = null;
    if (resolver != null) {
      resolver(decision);
      return;
    }
    // failed/done 态下的解除:清态,防止 renderer 重挂载后经 get-state 再弹。
    if (currentPhase === 'failed' || currentPhase === 'done') currentPhase = null;
  });
  ipcMain.handle('local-adoption:get-state', (event) => {
    assertTrustedAppRendererEvent(event);
    return { phase: currentPhase };
  });
}

/**
 * bootstrap 挂载点:登录成功后、ensureReady 打开账号库前调用(排在 mToc 之后,
 * mToc 若为该账号迁入了老库,这里的「账号库已存在」前置检查会自然跳过认领)。
 * 幂等 + 防重入;绝不 throw。全部操作发生在当前生效的 userData 内部,因此
 * dev --isolated 沙箱无需特判(沙箱内的 local 数据认领进沙箱内的账号库,语义自洽)。
 */
export async function runLocalOwnerDataAdoptionForUser(userId: string): Promise<void> {
  if (inFlight != null) {
    await inFlight;
    return;
  }
  inFlight = runLocalOwnerDataAdoption(userId, {
    userDataDir: app.getPath('userData'),
    dbFilePrefix: BRAND_IDENTITY.dbFilePrefix,
    fs: realFsDeps,
    countLocalSessions: countSessionsInLocalDb,
    passiveSharedUserData: () => process.env.XDT_PASSIVE_SHARED_USER_DATA === '1',
    hasConcurrentLiveInstances: () => hasConcurrentLiveInstancesSharingUserData(),
    closeLocalDbIfOpen: () => {
      if (getCurrentUserId() === LOCAL_DATA_OWNER_ID) closeDb();
    },
    now: () => new Date(),
    log,
    ui: electronUiDeps,
  });
  try {
    await inFlight;
  } finally {
    inFlight = null;
  }
}
