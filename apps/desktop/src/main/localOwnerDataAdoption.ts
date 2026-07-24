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
 *    `<prefix>-<userId>.db` 不存在——唯一例外是本流程此前对该账号推迟/失败过
 *    (marker pendingOwnerKeys):那次退出后登录自动创建的空占位库不能堵死承诺
 *    的重试,pending + 使用面探测全空 + 未被持有时,占位库在提交阶段改名备份
 *    让位(保留不删),绝不覆盖;普通已存在账号库(无论多空)一律跳过,不做
 *    行级合并。另需独占 userData(非 passive、无并发活实例)、local 库已干净
 *    关闭(无 wal/shm 残留)。
 *  - 弹确认窗让用户二选一:「并入当前账号」或「保留在本机模式」。共用机器上
 *    A 的本机会话绝不能被 B 的账号静默吸收,确认窗是归属裁决,不可省略。
 *  - 并入 = 搬移而非复制:先合并搬 `owners/<localKey>` → `owners/<accountKey>`
 *    (不覆盖,冲突跳过),最后把 local 库改名为账号库(db rename 是提交点,
 *    之前任一步崩溃下次登录幂等续跑)。会话 working_dir 里指向 local 命名空间
 *    dialogues 的路径由 db ready 后的 sweepLegacyDialogueWorkingDirs 统一改写
 *    (bootstrap 已把 local dialogues 根加入 additionalLegacyDialogueRoots)。
 *  - marker `<userData>/.local-owner-adoption-v1.json`:认领成功记
 *    claimedOwnerKey(一次性,永久终结);用户拒绝记 declinedOwnerKeys(该账号
 *    不再询问,数据保持可被其它全新账号认领);推迟/失败记 pendingOwnerKeys
 *    (空占位库让位的唯一凭据,成功/拒绝时清除)。key 存 dataOwnerStorageKey
 *    哈希,与 owners/ 目录同口径,不落明文 userId。
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

import {
  LOCAL_DATA_OWNER_ID,
  dataOwnerStorageKey,
  getActiveAppSession,
  isAppSessionBoundaryPending,
} from './appSessionState.js';
import { isLocalDbOwnerCurrent } from './appSessionPolicy.js';
import {
  SAFE_STORAGE_DIR_NAME,
  ownerSecretStoragePrefix,
} from './secrets/providerSecretStore.js';
import { ownerScopedImSecretPrefix } from './im/ownerScopedStorage.js';
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

/** 空账号库让位时的备份名后缀(带时间戳防多次重试撞名;文件保留不删)。 */
const ACCOUNT_DB_BACKUP_SUFFIX = '.pre-adoption-';

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
  /**
   * 认领被推迟/失败过的账号 ownerKey 列表:随后的登录会照常创建空账号库,
   * 「账号库存在即跳过」会把重试永久堵死——pending 是唯一放行「空库改名
   * 备份让位」的凭据,把让位严格限定在本流程自己造成的占位库上;普通
   * 已存在账号库(无论多空)一律不动。成功或拒绝后清除。
   */
  pendingOwnerKeys?: string[];
}

/** 内存可替身的最小 fs 面;默认实现见 realFsDeps。全部异步。 */
export interface LocalAdoptionFsDeps extends MoveFsDeps {
  pathExists(p: string): Promise<boolean>;
  readFile(p: string): Promise<string>;
  writeFile(p: string, content: string): Promise<void>;
  /**
   * 目标已存在时必须失败(EEXIST)而非覆盖的改名。库文件的提交 rename 必须走
   * 这条:POSIX rename 会静默替换目标,而提交点若撞上窗口期出现的账号库,
   * 覆盖即数据丢失。默认实现用 link+unlink(原子 EEXIST),不支持硬链接的
   * 文件系统退化为「检查 + rename」。
   */
  renameNoReplace(source: string, target: string): Promise<void>;
  /** 允许覆盖目标的原子改名(marker 的 tmp+rename 原子落盘用)。 */
  replaceFile(source: string, target: string): Promise<void>;
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
   * 统计 local 库里未删除会话数(认领触发门槛);打开失败/表缺失时 throw
   * (调用方按不可读跳过)。默认实现顺带完成 wal checkpoint(open+close),
   * 让 sidecar 检查有意义。
   */
  countLocalSessions(dbPath: string): Promise<number>;
  /**
   * 账号库是否「被实际使用过」。必须比 local 侧探针更保守:任何 sessions 行
   * (**含软删除**——用户删光会话不等于库空置,里面还有消息/定时任务/绑定)、
   * schedules、custom providers/MCP、IM 绑定,任一存在即算使用过,不可让位。
   * 打开失败时 throw(调用方按不可读跳过)。
   */
  accountDbLooksUsed(dbPath: string): Promise<boolean>;
  /** 共享 userData 的 passive dev 实例必须保持只读。 */
  passiveSharedUserData(): boolean;
  /** 是否有其它活实例共享本 userData(rename 前的独占确认)。 */
  hasConcurrentLiveInstances(): boolean;
  /** 若 main 进程仍以 local-v1 打开着库(inproc fallback),先关闭再动文件。 */
  closeLocalDbIfOpen(): void;
  /**
   * 账号库当前正被本进程打开(同账号 ensure-ready 重入,如 LocalDbGate 重试)。
   * 此时绝不能动账号库文件;worker 持有的场景由 sidecar 检查兜底。
   */
  accountDbCurrentlyOpen(userId: string): boolean;
  /**
   * userId 是否仍是当前有效登录 owner。确认窗可以停留任意久,期间另一窗口
   * 登出/切号会让本次认领的目标 owner 过期——搬移前必须复查,过期即中止,
   * 绝不把数据并进已失效的账号命名空间。
   */
  isOwnerStillCurrent(userId: string): boolean;
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
  | { status: 'account-db-in-use' }
  | { status: 'account-db-unreadable'; error: string }
  | { status: 'local-db-unreadable'; error: string }
  | {
      status: 'deferred';
      reason:
        | 'passive-shared-user-data'
        | 'concurrent-live-instances'
        | 'local-db-busy'
        | 'account-db-busy';
    }
  | { status: 'declined' }
  | { status: 'stale-owner' }
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
  // tmp + 原子改名入位:直接截断重写在中途崩溃时会留下半份 JSON,读取端把
  // 损坏 marker 当缺失,pending 凭据一丢,占位库让位路径就被永久关闭。
  const tmpPath = `${markerPath}.tmp`;
  await deps.fs.writeFile(tmpPath, JSON.stringify(marker, null, 2));
  await deps.fs.replaceFile(tmpPath, markerPath);
}

/**
 * 推迟/失败退出前登记 pending(best-effort,失败只 warn):没有它,本次退出后
 * 登录自动创建的空账号库会把下次重试挡在「账号库已存在」外面。passive 推迟
 * 同样要记——passive 实例的登录也会创建占位库,不记就永久堵死(Greptile
 * review);marker 是认领自己的簿记(tmp+原子改名的小 JSON,不搬任何数据),
 * 不在 passive「不得搬动共享数据」的禁区内,并发覆写最坏丢一条记录,由
 * 使用面探测与前置检查兜底,方向安全。
 */
async function recordPendingAdoption(
  deps: LocalOwnerAdoptionDeps,
  markerPath: string,
  marker: AdoptionMarker | null,
  ownerKey: string,
): Promise<void> {
  try {
    await writeAdoptionMarker(deps, markerPath, {
      version: 1,
      ...(marker?.declinedOwnerKeys?.length
        ? { declinedOwnerKeys: marker.declinedOwnerKeys }
        : {}),
      pendingOwnerKeys: [...new Set([...(marker?.pendingOwnerKeys ?? []), ownerKey])],
    });
  } catch (err) {
    deps.log.warn(
      'local owner adoption: pending marker write failed: %s',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** owners 递归合并期间发现并发实例时的中断信号(转成 deferred,不算失败)。 */
class AdoptionInterruptedError extends Error {
  constructor() {
    super('local owner adoption interrupted by a concurrent instance');
  }
}

/** 库文件的 sidecar(-wal/-shm)任一存在 = 仍被持有,不能 rename。 */
async function dbSidecarsPresent(
  deps: LocalOwnerAdoptionDeps,
  dbPath: string,
): Promise<boolean> {
  for (const suffix of DB_SIDECAR_SUFFIXES) {
    if (await deps.fs.pathExists(`${dbPath}${suffix}`)) return true;
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

    // 2. 独占确认:passive 只读实例与并发活实例都只推迟,不取消(下次登录重来)。
    if (deps.passiveSharedUserData()) {
      deps.log.info('local owner adoption deferred: passive shared-userData instance');
      await recordPendingAdoption(deps, markerPath, marker, ownerKey);
      return { status: 'deferred', reason: 'passive-shared-user-data' };
    }
    if (deps.hasConcurrentLiveInstances()) {
      deps.log.info('local owner adoption deferred: other live instances share this userData');
      await recordPendingAdoption(deps, markerPath, marker, ownerKey);
      return { status: 'deferred', reason: 'concurrent-live-instances' };
    }

    // 2.5 账号库已存在时默认跳过(v1 契约:不做行级合并)。唯一例外:本流程
    //     此前对该账号推迟/失败过(marker pending)——那次退出后登录自动创建的
    //     空占位库不能堵死承诺的重试。只有 pending + 使用面探测全空 + 未被持有
    //     三者同时成立,才在提交阶段把占位库改名备份让位,绝不覆盖。
    let accountDbToDisplace = false;
    if (await deps.fs.pathExists(accountDbPath)) {
      if (deps.accountDbCurrentlyOpen(userId)) {
        // 同账号 ensure-ready 重入(LocalDbGate 重试等):账号库正开着,不动。
        return { status: 'account-db-in-use' };
      }
      if (!marker?.pendingOwnerKeys?.includes(ownerKey)) {
        return { status: 'account-db-exists' };
      }
      let accountUsed: boolean;
      try {
        accountUsed = await deps.accountDbLooksUsed(accountDbPath);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.log.warn('local owner adoption: account db unreadable, skipped: %s', message);
        return { status: 'account-db-unreadable', error: message };
      }
      if (accountUsed) return { status: 'account-db-exists' };
      if (await dbSidecarsPresent(deps, accountDbPath)) {
        deps.log.info('local owner adoption deferred: account db sidecars still present');
        await recordPendingAdoption(deps, markerPath, marker, ownerKey);
        return { status: 'deferred', reason: 'account-db-busy' };
      }
      accountDbToDisplace = true;
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
    if (await dbSidecarsPresent(deps, localDbPath)) {
      deps.log.info('local owner adoption deferred: local db sidecars still present');
      await recordPendingAdoption(deps, markerPath, marker, ownerKey);
      return { status: 'deferred', reason: 'local-db-busy' };
    }

    // 4. 归属裁决:弹窗等待用户二选一。拒绝 = 记录该账号,数据保持可认领。
    deps.ui.publish('confirm');
    const decision = await deps.ui.waitForDecision();
    if (decision === 'keep') {
      try {
        // 拒绝同时清掉本账号的 pending:占位库让位凭据只服务「还想认领」的重试。
        const pendingRest = (marker?.pendingOwnerKeys ?? []).filter((k) => k !== ownerKey);
        await writeAdoptionMarker(deps, markerPath, {
          version: 1,
          declinedOwnerKeys: [...new Set([...(marker?.declinedOwnerKeys ?? []), ownerKey])],
          ...(pendingRest.length ? { pendingOwnerKeys: pendingRest } : {}),
        });
      } catch (err) {
        // 拒绝记录写失败(磁盘满/权限)只影响「下次是否再问」,本次拒绝依然
        // 生效;必须继续走 done 解除弹窗,否则 phase 卡在 confirm 且 resolver
        // 已消费,remount 后弹窗永远清不掉(Copilot/Codex review)。
        deps.log.warn(
          'local owner adoption: decline marker write failed (will ask again next login): %s',
          err instanceof Error ? err.message : String(err),
        );
      }
      // done 语义 = 弹窗解除;renderer 对 done 不渲染。
      deps.ui.publish('done');
      deps.log.info('local owner adoption declined by user; local data stays in local mode');
      return { status: 'declined' };
    }

    deps.ui.publish('running');
    try {
      // 5. 确认窗可能停留很久,搬移前重做三重复查:owner 仍有效(另一窗口可能
      //    已登出/切号——绝不并进失效账号)、独占仍成立(与 ownerNamespaceMigration
      //    的 mid-claim 复查同一姿势)、账号库若在窗口期出现也绝不覆盖。
      if (!deps.isOwnerStillCurrent(userId)) {
        deps.log.info('local owner adoption aborted: owner changed while confirming');
        deps.ui.publish('done');
        await recordPendingAdoption(deps, markerPath, marker, ownerKey);
        return { status: 'stale-owner' };
      }
      if (deps.hasConcurrentLiveInstances()) {
        deps.log.info('local owner adoption interrupted: instance appeared while confirming');
        deps.ui.publish('failed');
        await recordPendingAdoption(deps, markerPath, marker, ownerKey);
        return { status: 'deferred', reason: 'concurrent-live-instances' };
      }
      if (
        (!accountDbToDisplace && (await deps.fs.pathExists(accountDbPath))) ||
        (await dbSidecarsPresent(deps, localDbPath)) ||
        (accountDbToDisplace && (await dbSidecarsPresent(deps, accountDbPath)))
      ) {
        deps.log.warn('local owner adoption aborted: target db or sidecars appeared mid-flow');
        deps.ui.publish('failed');
        await recordPendingAdoption(deps, markerPath, marker, ownerKey);
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
      // owners 树可能很大,递归合并期间新实例可能启动:子项之间做节流(500ms)
      // 并发复查,发现即中断(与 ownerNamespaceMigration 的 mid-claim 复查同一
      // 姿势);moveWithoutOverwrite 幂等,中断后下次登录续跑。
      let lastAbortScanMs = 0;
      const abortCheck = async (): Promise<void> => {
        const nowMs = deps.now().getTime();
        if (nowMs - lastAbortScanMs < 500) return;
        lastAbortScanMs = nowMs;
        if (deps.hasConcurrentLiveInstances()) throw new AdoptionInterruptedError();
      };
      if (await deps.fs.pathExists(localOwnerDir)) {
        const moveResult = await moveWithoutOverwrite(
          deps.fs,
          localOwnerDir,
          accountOwnerDir,
          abortCheck,
        );
        ownersMoved = moveResult.moved;
        ownersConflicts = moveResult.conflicts;
      }
      // 加密凭证不在 owners/ 树内,而在 safe-storage 下的两族 owner 前缀文件
      // (providerSecretStore 的 owner_<key>_* 与 IM 的 im_owner_<key>_*):随认领
      // 按前缀改名到账号命名空间,否则被并入的自定义供应商/MCP/ghost/IM 配置
      // 全部缺鉴权(Codex review)。目标已存在跳过不覆盖;幂等。
      const secretsDir = path.join(deps.userDataDir, SAFE_STORAGE_DIR_NAME);
      const secretPrefixPairs: ReadonlyArray<{ from: string; to: string }> = [
        {
          from: ownerSecretStoragePrefix(LOCAL_DATA_OWNER_ID),
          to: ownerSecretStoragePrefix(userId),
        },
        {
          from: ownerScopedImSecretPrefix(LOCAL_DATA_OWNER_ID),
          to: ownerScopedImSecretPrefix(userId),
        },
      ];
      let secretsMoved = 0;
      let secretsConflicts = 0;
      if (await deps.fs.pathExists(secretsDir)) {
        for (const name of await deps.fs.readdir(secretsDir)) {
          if (!name.endsWith('.enc')) continue;
          const pair = secretPrefixPairs.find((candidate) => name.startsWith(candidate.from));
          if (!pair) continue;
          await abortCheck();
          const target = `${pair.to}${name.slice(pair.from.length)}`;
          try {
            await deps.fs.renameNoReplace(
              path.join(secretsDir, name),
              path.join(secretsDir, target),
            );
            secretsMoved += 1;
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
            secretsConflicts += 1;
          }
        }
      }
      // 提交前最后一次复查:owner 未过期 + 独占仍成立(owners/secrets 搬移可能
      // 耗时)。renameNoReplace 的 EEXIST 原子性兜住目标侧,这里把「新实例已
      // 打开旧名」的窗口也收到最小。
      if (!deps.isOwnerStillCurrent(userId)) {
        deps.log.info('local owner adoption aborted: owner changed before db commit');
        deps.ui.publish('done');
        await recordPendingAdoption(deps, markerPath, marker, ownerKey);
        return { status: 'stale-owner' };
      }
      if (deps.hasConcurrentLiveInstances()) throw new AdoptionInterruptedError();
      if (accountDbToDisplace) {
        // 空账号库(前置已验证未被使用)改名备份让位:文件保留不删,时间戳后缀
        // 防多次重试撞名。窗口期内该库可能残留的少量非关键数据随备份保留,可找回。
        const stamp = deps
          .now()
          .toISOString()
          .replace(/[-:.TZ]/g, '')
          .slice(0, 14);
        const backupPath = `${accountDbPath}${ACCOUNT_DB_BACKUP_SUFFIX}${stamp}`;
        await deps.fs.renameNoReplace(accountDbPath, backupPath);
        deps.log.info(
          'local owner adoption: unused account db displaced to %s',
          path.basename(backupPath),
        );
      }
      // 提交点:目标已存在(窗口期另一实例创建/打开了账号库)必须失败而非覆盖。
      await deps.fs.renameNoReplace(localDbPath, accountDbPath);
      try {
        // claimed 即全局终态,pending 一并清空(不再有任何可让位场景)。
        await writeAdoptionMarker(deps, markerPath, {
          version: 1,
          claimedOwnerKey: ownerKey,
          adoptedAt: deps.now().toISOString(),
          ...(marker?.declinedOwnerKeys?.length
            ? { declinedOwnerKeys: marker.declinedOwnerKeys }
            : {}),
        });
      } catch (err) {
        // 提交点(库改名)已过,认领事实上已完成:marker 写失败只能按成功收尾
        // (报 failed 会误导用户「下次会重试」——下次前置探测到 local 库已消失,
        // 只会静默跳过)。丢失的只是 claimed 终态记录,方向安全。
        deps.log.warn(
          'local owner adoption: claimed marker write failed after commit (adoption stands): %s',
          err instanceof Error ? err.message : String(err),
        );
      }
      deps.ui.publish('done');
      deps.log.info(
        'local owner adoption completed: sessions=%d ownersMoved=%d ownersConflicts=%d secretsMoved=%d secretsConflicts=%d',
        sessionCount,
        ownersMoved,
        ownersConflicts,
        secretsMoved,
        secretsConflicts,
      );
      return { status: 'adopted', ownersMoved, ownersConflicts };
    } catch (err) {
      if (err instanceof AdoptionInterruptedError) {
        deps.log.info('local owner adoption interrupted: instance appeared mid-move');
        deps.ui.publish('failed');
        await recordPendingAdoption(deps, markerPath, marker, ownerKey);
        return { status: 'deferred', reason: 'concurrent-live-instances' };
      }
      // 搬移阶段失败:不写终态 marker、只登记 pending(下次登录凭它重试),
      // failed 弹窗,不阻塞登录。
      const message = err instanceof Error ? err.message : String(err);
      deps.log.warn('local owner adoption failed (will retry next login): %s', message);
      deps.ui.publish('failed');
      await recordPendingAdoption(deps, markerPath, marker, ownerKey);
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
  // Node 的 fs.rename 在 POSIX 与 Windows(libuv MOVEFILE_REPLACE_EXISTING)上
  // 都覆盖已存在的目标文件,正是 marker 原子落盘要的语义。
  replaceFile: (source, target) => fsp.rename(source, target),
  renameNoReplace: async (source, target) => {
    try {
      await fsp.link(source, target);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') throw err;
      // 文件系统不支持硬链接(FAT/exFAT 等):退化为「检查 + rename」,窗口
      // 收窄到毫秒级(上层还有并发实例 gate 兜底)。fail-closed:只有确认
      // 目标不存在(ENOENT)才 rename;EACCES 等「存在与否不可知」一律拒绝,
      // 绝不冒覆盖风险。
      try {
        await fsp.access(target);
      } catch (accessErr) {
        if ((accessErr as NodeJS.ErrnoException).code === 'ENOENT') {
          await fsp.rename(source, target);
          return;
        }
        throw accessErr;
      }
      const eexist = new Error(`EEXIST: file already exists, rename '${source}' -> '${target}'`);
      (eexist as NodeJS.ErrnoException).code = 'EEXIST';
      throw eexist;
    }
    try {
      await fsp.unlink(source);
    } catch (err) {
      // 源清理失败不能当成功:留下同 inode 双名,库文件场景意味着 local 模式
      // 与账号会打开同一个数据库(跨 owner 串库)。回滚目标名并把错误上抛,
      // 让调用方按失败重试;回滚也失败时如实上抛(下次登录前置探测 fail-safe)。
      try {
        await fsp.unlink(target);
      } catch (rollbackErr) {
        log.warn(
          'local owner adoption: rollback of linked target failed: %s',
          rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
        );
      }
      throw err;
    }
  },
};

/**
 * 统计已关闭库文件的未删除会话数。这里直连 better-sqlite3 而非 DbClient:此时
 * 账号库尚未 ensureReady,DbClient 也只面向「当前 owner 的库」,而探测对象是
 * 已关闭的库文件——这是迁移工具语境(与 mToc/ownerNamespaceMigration 同层),
 * 不是运行期业务查询。open+close 顺带完成 wal checkpoint,使 sidecar 检查成立。
 */
async function countSessionsInClosedDb(dbPath: string): Promise<number> {
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

/**
 * 账号库「被使用过」探测采用**反转清单**:枚举库内全部表,除下方 denylist
 * (仅登录/启动会自动写入、或内容可由其它表推导的基建/影子表)外,任何表有行
 * 即算使用过。方向性:未来新增的业务表默认「使用过」(不让位,fail-safe),
 * 「探针漏了某张表导致数据被让位」这一类问题就此关闭(Greptile review);
 * denylist 只含纯自动写入项,占位库不会因启动噪音行堵死 pending 重试。
 */
const ACCOUNT_DB_AUTO_WRITTEN_TABLES = new Set([
  // schema/迁移簿记(ensureReady 建库即写)。
  'migration_meta',
  'migration_history',
  // 登录/启动期自动落库:账号用量快照、device-link 单持有者仲裁行。
  'account_usage_snapshots',
  'device_link_ownership',
  // 嵌入/向量基建簿记与派生任务(内容源于其它表;源表有数据自然判使用过)。
  'embedding_meta',
  'embedding_jobs',
  'vec_table_meta',
  // 派生用量统计(有真实用量必有 sessions/messages,源表兜底)。
  'daily_spend',
  'daily_model_usage',
  // 会话/定时任务的派生子状态(源表兜底)。
  'schedule_runs',
  'agent_input_queue_snapshots',
  'skill_usage_sources',
  'skill_usage_exposures',
]);

/** 基建/影子表名模式:SQLite 内部、drizzle 簿记、FTS 与 sqlite-vec 影子表。 */
function isAccountDbInfraTable(name: string): boolean {
  return (
    name.startsWith('sqlite_') ||
    name.startsWith('__drizzle') ||
    // FTS5 影子表(<base>_fts_data/_config 等)空索引也带结构行,必须排除;
    // fts 主虚表行数与源表同步,排除它不损失信号(源表自身兜底)。
    name.includes('_fts') ||
    name.startsWith('vec_') ||
    ACCOUNT_DB_AUTO_WRITTEN_TABLES.has(name)
  );
}

async function accountDbLooksUsedInClosedDb(dbPath: string): Promise<boolean> {
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    // fail-closed:枚举或取行失败(SQLITE_CORRUPT/BUSY 等)一律上抛,调用方按
    // 不可读跳过认领,绝不让位。表名取自 sqlite_master 并按标识符转义,无注入面。
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    for (const { name } of tables) {
      if (isAccountDbInfraTable(name)) continue;
      const row = db.prepare(`SELECT 1 FROM "${name.replaceAll('"', '""')}" LIMIT 1`).get();
      if (row !== undefined) return true;
    }
    return false;
  } finally {
    db.close();
  }
}

/**
 * 与 registerLocalDbIpc 的 isOwnerCurrent 同一判定语义(isLocalDbOwnerCurrent):
 * dataOwnerId 直接取 appSessionState 提交态(authManager.getAuthState 的
 * dataOwnerId 亦源于此),避免把 authManager 拉进本模块依赖图。
 */
function isOwnerStillCurrentDefault(userId: string): boolean {
  return isLocalDbOwnerCurrent(
    { dataOwnerId: getActiveAppSession().dataOwnerId },
    userId,
    isAppSessionBoundaryPending(),
  );
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
    countLocalSessions: countSessionsInClosedDb,
    accountDbLooksUsed: accountDbLooksUsedInClosedDb,
    passiveSharedUserData: () => process.env.XDT_PASSIVE_SHARED_USER_DATA === '1',
    hasConcurrentLiveInstances: () => hasConcurrentLiveInstancesSharingUserData(),
    closeLocalDbIfOpen: () => {
      if (getCurrentUserId() === LOCAL_DATA_OWNER_ID) closeDb();
    },
    accountDbCurrentlyOpen: (uid) => getCurrentUserId() === uid,
    isOwnerStillCurrent: (uid) => isOwnerStillCurrentDefault(uid),
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

export const __testing = { countSessionsInClosedDb, accountDbLooksUsedInClosedDb };
