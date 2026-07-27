/**
 * localOwnerDataAdoption — local 模式(跳过登录)数据在登录后的一次性认领。
 *
 * 背景:local 模式的 dataOwnerId 固定为 `local-v1`(appSessionState),会话库
 * `<userData>/<prefix>-local-v1.db` 与 owner 命名空间 `owners/<localKey>/` 都按
 * 该命名空间隔离。用户登录后 dataOwnerId 切为账号 userId,UI 只读账号命名空间
 * ——local 模式期间创建的会话在盘上完好却不可见,观感是「登录把会话弄丢了」。
 *
 * 本模块在「账号库已 ready、renderer 尚未拉会话列表」时(bootstrap 的 onReady
 * 钩子,排在 sweepLegacyDialogueWorkingDirs 之前)做一次性认领:
 *  - 触发前提:`cindy-local-v1.db` 存在**且含至少一条未删除会话**;独占 userData
 *    (非 passive、无并发活实例)、local 库已干净关闭(无 wal/shm 残留)。账号库
 *    里有没有会话**不再是前提**——两边会话合并共存。
 *  - 弹确认窗让用户二选一:「并入当前账号」或「保留在本机模式」。共用机器上
 *    A 的本机会话绝不能被 B 的账号静默吸收,确认窗是归属裁决,不可省略。
 *  - 并入 = **行级导入**(localDb/localOwnerDataImport.ts):ATTACH 只读 local 库,
 *    单事务把业务行 INSERT OR IGNORE 进账号库。只写账号库、只读 local 库 →
 *    单库事务,提交天然原子;local 库在提交点前后都没被动过一个字节,「登录把
 *    会话弄丢了」在物理上不可能发生。导入幂等(主键冲突整行跳过),失败重试安全。
 *  - 导入提交后依次做三件收尾(都不再影响会话可见性,失败只 warn + 下次登录续跑;
 *    整段可被新出现的并发实例打断——收尾动的是共享 userData 里别人也在用的文件):
 *    ① local 库改名归档为 `<prefix>-local-v1.db.adopted-<ts>`(保留不删)——防止
 *       用户回到 local 模式后看到同一批会话的第二份副本各自分叉;**导入未能把数据
 *       全带过来时(droppedRows / unimportableTables 非空)不归档**,local 库留在
 *       原地,用户回 local 模式仍能看到全部原始数据;
 *    ② `owners/<localKey>` 下除 `dialogues` 外的项合并搬进 `owners/<accountKey>`
 *       (不覆盖,冲突跳过);`dialogues` 故意不搬——dialogue 会话的 working_dir
 *       由 db ready 后的 sweepLegacyDialogueWorkingDirs 逐行处理,它自带「新位置
 *       缺失且老位置在 → 先复制内容再改写、失败跳过下次重试」的保护,比这里
 *       整树搬移更安全;
 *    ③ 加密凭证(`safe-storage/owner_<key>_*.enc` 与 IM 的 `im_owner_<key>_*.enc`)
 *       不在 owners/ 树内,按前缀改名到账号命名空间,否则并入的自定义供应商 /
 *       MCP / IM 配置全部缺鉴权。
 *  - marker `<userData>/.local-owner-adoption-v1.json`:认领完成记 claimedOwnerKey
 *    (永久终结);导入已提交但收尾未完成记 importedOwnerKey(续跑凭据:下次登录
 *    静默续跑收尾,不再打扰用户);用户拒绝记 declinedOwnerKeys(该账号不再询问,
 *    数据保持可被其它账号认领)。key 存 dataOwnerStorageKey 哈希,不落明文 userId。
 *
 * 失效契约:导入未提交前的任何失败都退回原状(local 数据完好,下次登录重新询问);
 * 导入已提交则认领事实成立(会话已在账号下可见),收尾在下次登录静默续跑;确认窗
 * 停留期间另一窗口登出/切号 → 提交前复查 owner,过期即中止,绝不并进失效账号。
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
import { getDbClient } from './localDb/client/current.js';
import type { LocalOwnerImportResult } from './localDb/localOwnerDataImport.js';
import { DIALOGUES_DIR_NAME } from './localDb/dialogueWorkdirSelfHeal.js';
import { assertTrustedAppRendererEvent } from './security/trustedAppRenderer.js';
import { throwIpcError } from './utils/ipcValidate.js';
import { createLogger } from './logger.js';

/** marker 文件名(userData 根下;认领终态、续跑凭据与各账号的拒绝记录)。 */
export const LOCAL_OWNER_ADOPTION_MARKER_FILENAME = '.local-owner-adoption-v1.json';

/** owners 命名空间根目录名(与 appSessionState.ownerScopedUserDataPath 一致)。 */
const OWNERS_DIR_NAME = 'owners';

/** SQLite sidecar 后缀;残留 = 库仍被别的进程持有,认领必须推迟。 */
const DB_SIDECAR_SUFFIXES = ['-wal', '-shm'] as const;

/** local 库导入后的归档名后缀(带时间戳;文件保留不删,是最后一道人工兜底)。 */
const ADOPTED_DB_SUFFIX = '.adopted-';

/** 归档名的进程内单调序号(同秒重入不撞名)。 */
let archiveSeq = 0;

/** 收尾期间发现并发实例时的中断信号(转成「收尾未完成」,下次登录续跑)。 */
class AdoptionInterruptedError extends Error {
  constructor() {
    super('local owner adoption tail interrupted by a concurrent instance');
  }
}

/** 推送给 renderer 的弹窗阶段(语义同 mToc:done/failed 后可解除)。 */
export type LocalAdoptionPhase = 'confirm' | 'running' | 'done' | 'failed';

/** 用户在确认窗上的裁决。 */
export type LocalAdoptionDecision = 'adopt' | 'keep';

interface AdoptionMarker {
  version: 1;
  /** 认领全部收尾完成的账号 ownerKey;存在即永久终结。 */
  claimedOwnerKey?: string;
  adoptedAt?: string;
  /**
   * 导入事务已提交、但收尾(归档/搬移)未走完的账号 ownerKey。会话此时已经在
   * 账号下可见,认领事实成立——下次登录凭它**静默续跑**收尾,不再弹窗打扰。
   */
  importedOwnerKey?: string;
  importedAt?: string;
  /** 拒绝过认领的账号 ownerKey 列表;这些账号不再询问,数据保持可认领。 */
  declinedOwnerKeys?: string[];
}

/** 内存可替身的最小 fs 面;默认实现见 realFsDeps。全部异步。 */
export interface LocalAdoptionFsDeps extends MoveFsDeps {
  pathExists(p: string): Promise<boolean>;
  readFile(p: string): Promise<string>;
  writeFile(p: string, content: string): Promise<void>;
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
   * 行级导入(提交点):把 local 库的业务行并入**当前已 ready 的账号库**,单事务
   * 全成或全不成。抛错即未发生任何写入。
   */
  importLocalData(localDbPath: string): Promise<LocalOwnerImportResult>;
  /** 共享 userData 的 passive dev 实例必须保持只读。 */
  passiveSharedUserData(): boolean;
  /** 是否有其它活实例共享本 userData(动文件前的独占确认)。 */
  hasConcurrentLiveInstances(): boolean;
  /** 若 main 进程仍以 local-v1 打开着库(inproc fallback),先关闭再动文件。 */
  closeLocalDbIfOpen(): void;
  /**
   * userId 是否仍是当前有效登录 owner。确认窗可以停留任意久,期间另一窗口
   * 登出/切号会让本次认领的目标 owner 过期——导入前必须复查,过期即中止,
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
  | { status: 'local-db-unreadable'; error: string }
  | {
      status: 'deferred';
      reason: 'passive-shared-user-data' | 'concurrent-live-instances' | 'local-db-busy';
    }
  | { status: 'declined' }
  | { status: 'stale-owner' }
  | { status: 'adopted'; imported: number; resumed: boolean }
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
    // 损坏的 marker 当作缺失。丢失的只是「问过没问过」的记录:最坏是再问一次,
    // 用户选并入则导入幂等(主键冲突整行跳过),不会产生重复会话。方向安全。
    deps.log.warn(
      'local owner adoption: marker unreadable, treating as absent: %s',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/** marker tmp 文件的进程内单调序号(同进程并发写也不撞名)。 */
let markerTmpSeq = 0;

async function writeAdoptionMarker(
  deps: LocalOwnerAdoptionDeps,
  markerPath: string,
  marker: AdoptionMarker,
): Promise<void> {
  // tmp + 原子改名入位:直接截断重写在中途崩溃时会留下半份 JSON。tmp 名带
  // pid + 进程内序号,共享 userData 的两个实例同时写也不会互相截断出撕裂文件。
  const tmpPath = `${markerPath}.${process.pid}.${markerTmpSeq++}.tmp`;
  await deps.fs.writeFile(tmpPath, JSON.stringify(marker, null, 2));
  await deps.fs.replaceFile(tmpPath, markerPath);
}

/** 库文件的 sidecar(-wal/-shm)任一存在 = 仍被持有,不能动文件。 */
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
 * 导入提交后的收尾:归档 local 库 → 搬 owners 非 dialogues 项 → 搬凭证前缀。
 * 全部是「已提交之后」的整理动作,任一步失败都不影响会话可见性,因此只 warn 并
 * 让调用方保留 importedOwnerKey 续跑凭据(下次登录静默重来,各步都幂等)。
 * 返回 true 表示三步全部走完,可以写 claimed 终态。
 */
async function finishAdoption(
  deps: LocalOwnerAdoptionDeps,
  userId: string,
  localDbPath: string,
  keepLocalDb: boolean,
): Promise<boolean> {
  let complete = true;
  const warn = (step: string, err: unknown): void => {
    complete = false;
    if (err instanceof AdoptionInterruptedError) {
      deps.log.info(
        'local owner adoption: %s stopped, another live instance appeared (will resume next login)',
        step,
      );
      return;
    }
    deps.log.warn(
      'local owner adoption: %s failed after commit (will resume next login): %s',
      step,
      err instanceof Error ? err.message : String(err),
    );
  };
  // 收尾要动的是「共享 userData 里别人也可能在用」的文件:local 库本体、owner
  // 命名空间、加密凭证。确认窗停留期间可能有新的 local 实例启动——它正开着
  // local 库、读着那些配置,把文件从它脚下搬走会让它打不开库、设置与记忆凭空
  // 消失(Greptile review)。因此收尾整段都要能被并发实例打断:进场先复查一次,
  // 递归搬移期间按 500ms 节流继续复查,发现即中断。中断视为收尾未完成,
  // importedOwnerKey 留着,下次独占启动时续跑(每一步都幂等)。
  if (deps.hasConcurrentLiveInstances()) {
    deps.log.info('local owner adoption: tail deferred, another live instance appeared');
    return false;
  }
  let lastAbortScanMs = 0;
  const abortCheck = async (): Promise<void> => {
    const nowMs = deps.now().getTime();
    if (nowMs - lastAbortScanMs < 500) return;
    lastAbortScanMs = nowMs;
    if (deps.hasConcurrentLiveInstances()) throw new AdoptionInterruptedError();
  };

  // ① local 库归档:防止用户回到 local 模式后看到同一批会话的第二份副本。
  //    秒级时间戳 + 进程内序号,同秒重入不撞已存在的归档名。
  //    keepLocalDb = 导入没能把数据全带过来,此时**绝不归档**:归档才是让那些
  //    没导入的行在账号侧和 local 模式两边都消失的原因(Greptile review)。
  //    留在原地 = 用户回到 local 模式仍能看到全部原始数据,代价是已导入的那部分
  //    在两边并存;「不丢」优先于「不重复」。
  if (keepLocalDb) {
    deps.log.warn(
      'local owner adoption: local db kept in place (not archived) because some rows could not be imported; local mode still shows the original data',
    );
  } else if (await deps.fs.pathExists(localDbPath)) {
    try {
      const stamp = deps.now().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
      const archivePath = `${localDbPath}${ADOPTED_DB_SUFFIX}${stamp}-${archiveSeq++}`;
      const archived = await moveWithoutOverwrite(deps.fs, localDbPath, archivePath);
      if (archived.moved === 0) throw new Error(`archive target already exists: ${archivePath}`);
      deps.log.info('local owner adoption: local db archived as %s', path.basename(archivePath));
    } catch (err) {
      warn('local db archive', err);
    }
  }

  // ② owners/<localKey> 下除 dialogues 外的项(learn / maker-memory / ghost-kv /
  //    各类 settings json 等)合并搬进账号命名空间。dialogues 交给
  //    sweepLegacyDialogueWorkingDirs 逐行处理,见模块头注释。
  const localOwnerDir = path.join(
    deps.userDataDir,
    OWNERS_DIR_NAME,
    dataOwnerStorageKey(LOCAL_DATA_OWNER_ID),
  );
  const accountOwnerDir = path.join(deps.userDataDir, OWNERS_DIR_NAME, dataOwnerStorageKey(userId));
  if (await deps.fs.pathExists(localOwnerDir)) {
    let moved = 0;
    let conflicts = 0;
    try {
      for (const name of await deps.fs.readdir(localOwnerDir)) {
        if (name === DIALOGUES_DIR_NAME) continue;
        await abortCheck();
        const result = await moveWithoutOverwrite(
          deps.fs,
          path.join(localOwnerDir, name),
          path.join(accountOwnerDir, name),
          abortCheck,
        );
        moved += result.moved;
        conflicts += result.conflicts;
      }
      if (moved > 0 || conflicts > 0) {
        deps.log.info(
          'local owner adoption: owner files merged (moved=%d conflicts=%d)',
          moved,
          conflicts,
        );
      }
    } catch (err) {
      warn('owner namespace merge', err);
    }
  }

  // ③ 加密凭证按 owner 前缀改名(不在 owners/ 树内)。目标已存在跳过不覆盖。
  const secretsDir = path.join(deps.userDataDir, SAFE_STORAGE_DIR_NAME);
  const secretPrefixPairs: ReadonlyArray<{ from: string; to: string }> = [
    { from: ownerSecretStoragePrefix(LOCAL_DATA_OWNER_ID), to: ownerSecretStoragePrefix(userId) },
    { from: ownerScopedImSecretPrefix(LOCAL_DATA_OWNER_ID), to: ownerScopedImSecretPrefix(userId) },
  ];
  if (await deps.fs.pathExists(secretsDir)) {
    let moved = 0;
    let conflicts = 0;
    try {
      for (const name of await deps.fs.readdir(secretsDir)) {
        if (!name.endsWith('.enc')) continue;
        const pair = secretPrefixPairs.find((candidate) => name.startsWith(candidate.from));
        if (!pair) continue;
        await abortCheck();
        const target = `${pair.to}${name.slice(pair.from.length)}`;
        const result = await moveWithoutOverwrite(
          deps.fs,
          path.join(secretsDir, name),
          path.join(secretsDir, target),
        );
        moved += result.moved;
        conflicts += result.conflicts;
      }
      if (moved > 0 || conflicts > 0) {
        deps.log.info(
          'local owner adoption: owner secrets renamed (moved=%d conflicts=%d)',
          moved,
          conflicts,
        );
      }
    } catch (err) {
      warn('owner secrets rename', err);
    }
  }

  return complete;
}

/**
 * local 模式数据认领核心流程。纯 DI,不 import electron 运行时对象;绝不 throw
 * (所有失败收敛成结果值),调用方(onReady 钩子)无需 try/catch。
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
    // 上次导入已提交、收尾没走完:静默续跑,不再问用户(会话已经在账号下了)。
    const resuming = marker?.importedOwnerKey === ownerKey;
    if (!resuming && marker?.declinedOwnerKeys?.includes(ownerKey)) {
      return { status: 'declined-before' };
    }

    const localDbPath = path.join(
      deps.userDataDir,
      `${deps.dbFilePrefix}-${LOCAL_DATA_OWNER_ID}.db`,
    );
    if (!(await deps.fs.pathExists(localDbPath))) {
      // 续跑时 local 库不在了 = 归档其实成功过(只是 marker 没来得及写终态):
      // 补齐剩余收尾并落终态,否则每次登录都要白跑一遍探测。
      if (resuming) return await commitAdoptionTail(deps, userId, markerPath, marker, 0, true);
      return { status: 'no-local-db' };
    }

    // 1. 独占确认:passive 只读实例与并发活实例都只推迟,不取消(下次登录重来)。
    //    不写任何 marker——本流程此刻还没动过任何数据,前提在下次登录同样成立。
    if (deps.passiveSharedUserData()) {
      deps.log.info('local owner adoption deferred: passive shared-userData instance');
      return { status: 'deferred', reason: 'passive-shared-user-data' };
    }
    if (deps.hasConcurrentLiveInstances()) {
      deps.log.info('local owner adoption deferred: other live instances share this userData');
      return { status: 'deferred', reason: 'concurrent-live-instances' };
    }

    // 2. 本进程若仍持有 local 库(inproc fallback 路径)先关闭;随后 open+close
    //    统计会话数,顺带完成 wal checkpoint。0 条会话 = 无可认领,静默跳过
    //    (不写 marker:之后 local 模式产生了会话,再次登录仍可认领)。
    //    **续跑路径也必须走这一步**:sidecar 检查的前提就是紧跟在一次干净的
    //    open+close(checkpoint 会删掉 -wal/-shm)之后,跳过它会让残留 sidecar
    //    把续跑永久卡在 local-db-busy(Copilot review)。续跑时只是不再拿会话数
    //    当门槛——导入早已提交,0 条会话也要把收尾做完。
    deps.closeLocalDbIfOpen();
    let sessionCount: number;
    try {
      sessionCount = await deps.countLocalSessions(localDbPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.log.warn('local owner adoption: local db unreadable, skipped: %s', message);
      return { status: 'local-db-unreadable', error: message };
    }
    if (!resuming && sessionCount <= 0) return { status: 'no-local-sessions' };
    // checkpoint 之后仍有 sidecar = 库确实被别的进程持有,推迟。
    if (await dbSidecarsPresent(deps, localDbPath)) {
      deps.log.info('local owner adoption deferred: local db sidecars still present');
      return { status: 'deferred', reason: 'local-db-busy' };
    }

    // 3. 归属裁决:弹窗等待用户二选一。拒绝 = 记录该账号,数据保持可认领。
    if (!resuming) {
      deps.ui.publish('confirm');
      const decision = await deps.ui.waitForDecision();
      if (decision === 'keep') {
        try {
          await writeAdoptionMarker(deps, markerPath, {
            version: 1,
            declinedOwnerKeys: [...new Set([...(marker?.declinedOwnerKeys ?? []), ownerKey])],
          });
        } catch (err) {
          // 拒绝记录写失败(磁盘满/权限)只影响「下次是否再问」,本次拒绝依然
          // 生效;必须继续走 done 解除弹窗,否则 phase 卡在 confirm 且 resolver
          // 已消费,remount 后弹窗永远清不掉。
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
    }

    deps.ui.publish('running');
    try {
      // 4. 确认窗可能停留很久,提交前复查:owner 仍有效(另一窗口可能已登出/切号
      //    ——绝不并进失效账号)、独占仍成立(与 ownerNamespaceMigration 的
      //    mid-claim 复查同一姿势)。
      if (!deps.isOwnerStillCurrent(userId)) {
        deps.log.info('local owner adoption aborted: owner changed while confirming');
        deps.ui.publish('done');
        return { status: 'stale-owner' };
      }
      if (deps.hasConcurrentLiveInstances()) {
        deps.log.info('local owner adoption interrupted: instance appeared while confirming');
        deps.ui.publish('failed');
        return { status: 'deferred', reason: 'concurrent-live-instances' };
      }

      // 5. 提交点:行级导入。单事务,抛错即零写入,local 库分毫未动。续跑时重跑
      //    一遍也安全(幂等 no-op),省掉一条「跳过导入」的分支。
      const imported = await deps.importLocalData(localDbPath);
      deps.log.info(
        'local owner adoption: imported %d rows (%s)',
        imported.inserted,
        Object.entries(imported.perTable)
          .map(([table, count]) => `${table}=${count}`)
          .join(' ') || 'no new rows',
      );
      // 数据没能并过来的三种形态(都只在两库 schema 不兼容时出现),任一非空都是
      // 用户口中的「会话弄丢」,必须留下明确日志:
      //  - droppedRows:行级违规被 OR IGNORE 吞掉;
      //  - unimportableTables:账号库缺表 / 列完全不重叠,整表没导入;
      //  - unverifiedTables:无主键可核验,该表究竟丢没丢无法断言。
      // local 库随后归档为 `.adopted-<ts>` 保留不删,是找回的唯一依据,所以这里
      // 只如实 warn,不把已提交的导入判成失败(判失败只会让用户永远认领不了)。
      const dropped = Object.entries(imported.droppedRows);
      if (dropped.length > 0) {
        deps.log.warn(
          'local owner adoption: %d rows could not be imported (%s); the local db is kept as an .adopted-* archive for recovery',
          dropped.reduce((sum, [, count]) => sum + count, 0),
          dropped.map(([table, count]) => `${table}=${count}`).join(' '),
        );
      }
      if (imported.unimportableTables.length > 0) {
        deps.log.warn(
          'local owner adoption: account db has no compatible table for %s; those rows stay only in the archived local db',
          imported.unimportableTables.join(' '),
        );
      }
      if (imported.unverifiedTables.length > 0) {
        deps.log.warn(
          'local owner adoption: could not verify row completeness for %s (no usable primary key)',
          imported.unverifiedTables.join(' '),
        );
      }
      // 有数据没能并过来时保留 local 库不归档:归档才是让那些行在账号侧与
      // local 模式两边都消失的原因(Greptile review)。unverifiedTables 只是
      // 「无法断言」,不作为保留依据,否则正常路径也可能永不归档。
      const incomplete =
        Object.keys(imported.droppedRows).length > 0 || imported.unimportableTables.length > 0;
      return await commitAdoptionTail(
        deps,
        userId,
        markerPath,
        marker,
        imported.inserted,
        resuming,
        localDbPath,
        incomplete,
      );
    } catch (err) {
      // 导入阶段失败:未写任何 marker,local 数据完好,下次登录重新询问。
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

/**
 * 提交之后的落簿与收尾。顺序刻意如此:
 *  1. 先写 importedOwnerKey —— 导入已提交是既成事实,这条记录保证后续收尾崩了也
 *     不会再拿同一批数据去问用户第二次;
 *  2. 再做收尾(归档 / 搬移),全部幂等;
 *  3. 收尾全成才落 claimedOwnerKey 终态,否则留着续跑凭据下次静默重来。
 */
async function commitAdoptionTail(
  deps: LocalOwnerAdoptionDeps,
  userId: string,
  markerPath: string,
  marker: AdoptionMarker | null,
  imported: number,
  resumed: boolean,
  localDbPath?: string,
  keepLocalDb = false,
): Promise<LocalOwnerAdoptionResult> {
  const ownerKey = dataOwnerStorageKey(userId);
  const declined = marker?.declinedOwnerKeys?.length
    ? { declinedOwnerKeys: marker.declinedOwnerKeys }
    : {};
  if (!resumed) {
    try {
      await writeAdoptionMarker(deps, markerPath, {
        version: 1,
        importedOwnerKey: ownerKey,
        importedAt: deps.now().toISOString(),
        ...declined,
      });
    } catch (err) {
      // 提交点已过,认领事实成立。这条记录只用于「收尾崩了不再重复问用户」,
      // 写不进去最坏是下次登录再问一次(导入幂等,不会产生重复会话)。
      deps.log.warn(
        'local owner adoption: imported marker write failed (adoption stands): %s',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const complete = await finishAdoption(
    deps,
    userId,
    localDbPath ??
      path.join(deps.userDataDir, `${deps.dbFilePrefix}-${LOCAL_DATA_OWNER_ID}.db`),
    keepLocalDb,
  );
  if (complete) {
    try {
      await writeAdoptionMarker(deps, markerPath, {
        version: 1,
        claimedOwnerKey: ownerKey,
        adoptedAt: deps.now().toISOString(),
        ...declined,
      });
    } catch (err) {
      deps.log.warn(
        'local owner adoption: claimed marker write failed (adoption stands): %s',
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  deps.ui.publish('done');
  deps.log.info(
    'local owner adoption completed: imported=%d resumed=%s tailComplete=%s',
    imported,
    resumed,
    complete,
  );
  return { status: 'adopted', imported, resumed };
}

// ─────────────────────────────────────────────────────────────────────────────
// Electron 默认实现(IPC 桥 + 真实 fs)。
// ─────────────────────────────────────────────────────────────────────────────

const log = createLogger('localOwnerDataAdoption');

/** 当前推送给 renderer 的阶段(renderer 挂载晚于推送时经 get-state 补拉)。 */
let currentPhase: LocalAdoptionPhase | null = null;
/** 确认窗的 pending resolver(同一时刻至多一个认领在等裁决)。 */
let pendingDecisionResolver: ((decision: LocalAdoptionDecision) => void) | null = null;
/** 并发防重入:onReady 可能被重复触发,共享同一个 in-flight promise。 */
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
  replaceFile: async (source, target) => {
    try {
      await fsp.rename(source, target);
    } catch (err) {
      // POSIX 的 rename 直接覆盖目标;Windows 上目标被占用/只读时会 EPERM 或
      // EEXIST(libuv 的 MOVEFILE_REPLACE_EXISTING 并非总能成功)。按本仓既有
      // 模式(plugin-market/ledger.ts 同款)先删目标再改名——marker 写不进去会让
      // 认领反复弹窗、终态永远落不下来(Copilot review)。
      const code = (err as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EEXIST')) throw err;
      await fsp.rm(target, { force: true });
      await fsp.rename(source, target);
    }
  },
};

/**
 * 统计已关闭库文件的未删除会话数。这里直连 better-sqlite3 而非 DbClient:探测
 * 对象是**已关闭的 local 库文件**,而 DbClient 只面向当前 owner 的库——这是迁移
 * 工具语境(与 mToc/ownerNamespaceMigration 同层),不是运行期业务查询。
 * open+close 顺带完成 wal checkpoint,使 sidecar 检查成立。
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
 * bootstrap 挂载点:账号库 ready 之后、renderer 拉会话列表之前调用(onReady 里
 * 排在 sweepLegacyDialogueWorkingDirs 之前——导入进来的 dialogue 会话要靠那趟
 * sweep 把 working_dir 从 local 命名空间改写过来)。
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
    importLocalData: (localDbPath) =>
      getDbClient().tx('localOwner.importData', { localDbPath }),
    passiveSharedUserData: () => process.env.XDT_PASSIVE_SHARED_USER_DATA === '1',
    hasConcurrentLiveInstances: () => hasConcurrentLiveInstancesSharingUserData(),
    closeLocalDbIfOpen: () => {
      if (getCurrentUserId() === LOCAL_DATA_OWNER_ID) closeDb();
    },
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

export const __testing = { countSessionsInClosedDb };
