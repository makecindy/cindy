/**
 * analytics-settings-store —— 使用统计(TapDB)的同意状态与开关。
 *
 * File: <userData>/analytics-settings.json
 *
 * 两个字段是两件事,不要合并:
 *  - privacyConsentAccepted：用户是否**明示同意过《隐私政策》**。这是采集的前置
 *    条件,不是偏好设置。TapTap 官方合规要求「用户同意隐私协议后再初始化 SDK」,
 *    国内《APP违法违规收集使用个人信息行为认定方法》也把「未经同意收集」列为违规。
 *  - analyticsEnabled：同意之后的 opt-out 开关,默认开启,用户可随时在设置里关闭。
 *
 * 有效上报条件 = 正式构建 && privacyConsentAccepted && analyticsEnabled
 * (见 isAnalyticsAllowed;构建闸的理由见 isReportingBuild)。
 *
 * 关于「恢复默认」:consent 是事实记录而非配置,不提供 UI 级 reset。resetAnalyticsSettings
 * 只用于测试与显式的账号数据清理,调用后用户会重新落回「未同意」。
 */

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { desktopMakerLogger } from './maker-host/logger-adapter.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from './maker-host/override-settings-file.js';

const log = desktopMakerLogger.child('analytics-settings-store');

export interface AnalyticsSettings {
  /** 用户是否已明示同意《隐私政策》。false = 一律不得初始化 TapDB。 */
  privacyConsentAccepted: boolean;
  /** 同意后的统计开关(opt-out)。默认开启。 */
  analyticsEnabled: boolean;
  /**
   * 存量同意迁移的窗口是否已在本机**永久关闭**(持久标记,非用户偏好)。
   *
   * 存在的理由(2026-07-28 review P1):迁移的语义是「改版**之前**就已登录的账号视为
   * 已同意」,而它唯一的判据是「本机还没有 analytics-settings.json」。问题在于改版
   * **之后**新建的会话也可能一份记录都不写——「跳过登录」(本地模式)与企业 SSO 都被
   * 协议门刻意豁免。于是「跳过登录 → 从本地模式走登录入口 → 完成 SSO」这条链路走完,
   * 下一次冷启动会恢复出一个真实账号 + 零记录,和真正的存量账号长得一模一样,被静默
   * 写入 privacyConsentAccepted —— 未经同意打开采集(隐私红线)。纯 SSO 新装用户同理。
   *
   * 所以「本次冷启动确定没有存量登录态」这个结论必须**落盘**:一旦某次冷启动看到的是
   * 未登录 / 本地模式,本机就再也不是「存量账号」,窗口永久关闭。只有结论明确时才写
   * (冷启动结果异常 / 未决时不写,免得把真存量用户的窗口误关)。
   */
  legacyConsentMigrationClosed: boolean;
}

const DEFAULTS: AnalyticsSettings = {
  privacyConsentAccepted: false,
  analyticsEnabled: true,
  legacyConsentMigrationClosed: false,
};

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'analytics-settings.json');
}

function normalize(raw: unknown): AnalyticsSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    privacyConsentAccepted:
      typeof r.privacyConsentAccepted === 'boolean'
        ? r.privacyConsentAccepted
        : DEFAULTS.privacyConsentAccepted,
    analyticsEnabled:
      typeof r.analyticsEnabled === 'boolean' ? r.analyticsEnabled : DEFAULTS.analyticsEnabled,
    legacyConsentMigrationClosed:
      typeof r.legacyConsentMigrationClosed === 'boolean'
        ? r.legacyConsentMigrationClosed
        : DEFAULTS.legacyConsentMigrationClosed,
  };
}

const store = createOverrideSettingsFile<AnalyticsSettings>({
  filePath: settingsFilePath,
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'analytics',
});

/**
 * 本机是否曾经有过记录 —— 存量迁移的唯一依据。
 *
 * 为什么不能在迁移时才 `existsSync`:renderer 挂载后第一件事就是
 * `analytics:settings-get`,它早于 `auth:initialize`。而 createOverrideSettingsFile
 * 读到坏 JSON 会**把文件删掉**并缓存一个未自定义的默认态。等到迁移真正执行时,
 * 盘上已经什么都没有了,一份损坏的记录(可能原本就是显式 opt-out)就会被判成
 * 「从没有过」,进而被静默迁移成「已同意 + 默认开启」。
 *
 * 所以在任何 store 读写之前先做一次只读探针,把结论钉在内存里:
 *   none    = 确实没有记录(新装)
 *   valid   = 有一份能解析的记录
 *   invalid = 有记录但内容非法(损坏 / 被改坏)——按 fail closed 处理,不可迁移
 */
type RecordProbe = 'none' | 'valid' | 'invalid';
let recordProbe: RecordProbe | null = null;

/** 本 store 会落盘的 boolean 字段。盘上若带这些键却不是 boolean,一定不是本 writer 写的。 */
const BOOLEAN_FIELDS = [
  'privacyConsentAccepted',
  'analyticsEnabled',
  'legacyConsentMigrationClosed',
] as const;

/**
 * 纯分类：给定盘上内容（`null` = 文件不存在）判 none / valid / invalid。抽出来是为了不碰 fs
 * 也能单测。
 *
 * 「能解析成 object」还不够（2026-08-04 review copilot）：`createOverrideSettingsFile` 的 writer
 * 在 override 清空时**删文件**、从不落 `{}`，写入时 `normalize` 保证已知字段都是 boolean。
 * 所以盘上出现空对象、或已知字段存在却非 boolean，都不可能来自本 writer —— 是外部手改或半截
 * 写入。当成 valid 会让 `isAnalyticsConsentRecordReadable()` 误判「可读但未同意」，闸走 denied
 * 清空待补传标记；判 invalid 让闸走 `unknown`（不传也不清）。
 *
 * 迁移不受影响：`migrateExistingLoginAsConsented` 只在 `=== 'none'` 时迁移，而 `{}` 无论算
 * valid 还是 invalid 都 `!== 'none'`，结论一致（都不迁移）。
 */
function classifyAnalyticsContent(fileContent: string | null): RecordProbe {
  if (fileContent === null) return 'none';
  let parsed: unknown;
  try {
    parsed = JSON.parse(fileContent);
  } catch {
    return 'invalid';
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'invalid';
  const obj = parsed as Record<string, unknown>;
  if (Object.keys(obj).length === 0) return 'invalid';
  for (const field of BOOLEAN_FIELDS) {
    if (field in obj && typeof obj[field] !== 'boolean') return 'invalid';
  }
  return 'valid';
}

/** 现读盘一次并分类（文件不存在 ⇒ none；读盘本身失败 ⇒ invalid，绝不当「没有记录」）。 */
function probeSettingsFileNow(): RecordProbe {
  try {
    const file = settingsFilePath();
    if (!fs.existsSync(file)) return 'none';
    return classifyAnalyticsContent(fs.readFileSync(file, 'utf-8'));
  } catch {
    return 'invalid';
  }
}

function probeRecordOnce(): RecordProbe {
  if (recordProbe !== null) return recordProbe;
  const probed = probeSettingsFileNow();
  recordProbe = probed;
  if (probed !== 'none') {
    log.info('analytics settings record probed', { probe: probed });
  }
  return probed;
}

/**
 * 一次成功写入之后刷新探针结论（2026-08-04 review P2）。
 *
 * 若首次分类是 `invalid`，`probeRecordOnce()` 会一直返回 `invalid`，于是本会话里
 * `isAnalyticsConsentRecordReadable()` 一直判「不可读」—— 用户即便重新同意、日志上报的授权闸
 * 也仍然把它当读取故障，手动上报走 consent-required、崩溃补传卡到重启。写入成功后盘上内容
 * 就是本 writer 刚写的(合法),或 override 清空后被删(= none),据此把陈旧的 `invalid` 结论作废。
 */
function refreshProbeAfterWrite(): void {
  recordProbe = store.readState().isCustomized ? 'valid' : 'none';
}

/**
 * 盘上的同意记录**现在是否可读**。
 *
 * 「文件不存在」算可读:那是「从未同意」这个合法状态,不是读取故障。只有「文件在、但内容
 * 解析不出来」才算不可读。
 *
 * 为什么需要它(2026-08-04 review P2):`createOverrideSettingsFile` 读到坏 JSON 会**吞掉
 * 异常并返回默认值**,于是 `privacyConsentAccepted` 变成 `false`——与「用户明确没同意」
 * 无法区分。日志上报的授权闸据此会判成「明确拒绝」并**清空待补传标记**,一次设置文件
 * 读取故障就永久丢掉一个崩溃现场。有了这个探针,闸才能把它判成 `unknown`(不传、也不清)。
 *
 * 两道判据取交集:一是进程启动期那次 `probeRecordOnce()` 的结论(store 读到坏文件时会把它
 * **删掉**,现读就再也看不到了,而那次探针的结论是删除之前抓到的),二是**现读**盘上的文件
 * (捕捉此刻仍在盘上的损坏)。任一判为损坏即返回 false。
 *
 * ⚠️ 先跑一次 `probeRecordOnce()`(2026-08-04 review copilot):本函数原先只读 `recordProbe`
 * 的现值,若从没有别的入口触发过探针,那次「删除之前」的启动快照就丢了,损坏文件被删后现读
 * 看到「文件不存在 ⇒ 可读」,闸误判「可读但未同意」清空标记。probeRecordOnce 幂等,首次调用
 * 抓快照,之后是零成本读缓存。
 */
export function isAnalyticsConsentRecordReadable(): boolean {
  if (probeRecordOnce() === 'invalid') return false;
  return probeSettingsFileNow() !== 'invalid';
}

export function readAnalyticsSettings(): AnalyticsSettings {
  probeRecordOnce();
  return store.read();
}

/**
 * 现读盘一次(mtime 守卫,文件没变时零开销)。
 *
 * 消费方是日志上报的授权闸:开发版与正式版共享同一份 userData,用户可能在另一个实例里
 * 刚刚撤回同意,而崩溃 / 启动这类自动路径在判定前必须看到最新值,不能用进程内的旧缓存
 * 继续上传(需求 §4.3)。
 *
 * 刻意做成**显式入口**而不是在 readAnalyticsSettings 里默认现读:既有的
 * `analytics:settings-get` 是 renderer 挂载即调的高频路径,给它加一次 stat 没有必要,
 * 而且会改变现有缓存语义。
 */
export function refreshAnalyticsSettingsFromDisk(): void {
  probeRecordOnce();
  store.invalidateIfChanged();
}

export function readAnalyticsSettingsState(): OverrideSettingsState<AnalyticsSettings> {
  probeRecordOnce();
  return store.readState();
}

/**
 * dev 逃生口:严格 `XDT_TAPDB_DEV=1` 才让非 packaged 构建上报,其它任何值
 * ('0' / 'true' / 空串)都视为关——与 devCliFlags 的 XDT_ISOLATED 同款约定,不做
 * 布尔猜测。只在需要验证上报链路本身时手动打开,打开即污染线上口径。
 */
const DEV_REPORTING_ENV = 'XDT_TAPDB_DEV';

/** 构建闸的结论只在第一次求值时记一条日志,避免每次广播都刷屏。 */
let buildGateLogged = false;

/**
 * 构建 flavor 闸:默认只有 packaged 构建允许上报,dev 可通过 XDT_TAPDB_DEV=1 手动放行。
 *
 * 为什么必须有这道闸:TapDB Web SDK 的设备身份(device_id)写在 renderer 的
 * localStorage 里,而 localStorage 按 **origin + userData 目录** 分家 ——
 *   - dev 的 renderer 从 `http://localhost:<vite 端口>` 加载(packaged 走 file://),
 *     并行多开时端口自增(5173 / 5174 / …),每个端口一份全新 localStorage;
 *   - `--isolated[=<名字>]` / `XDT_USER_DATA_DIR` 每条沙箱一份独立 localStorage,
 *     沙箱删掉重建又是一份。
 * 而 SDK init 时的 `isInitDeviceLogin` 会发 device_login,正是 TapDB 后台认定
 * 「新增设备」的事件。于是一个开发者每天能凭空造出几十台"新增设备",把线上
 * 新增设备 / 转化率 / 次日留存全部带偏(2026-07-26 复盘:某地区单人一天 78 台设备、
 * 新增账号 1、次日留存 2.6%)。dev 与 release 目前共用同一个 TapDB appId,只能在
 * 闸上区分;将来 dev 拿到独立 appId 后这道闸仍应保留(默认不上报)。
 *
 * 严格判 `=== true`:非 Electron 宿主或测试 mock 拿不到 isPackaged 时按 dev 处理
 * (fail closed,宁可少报不可乱报)。
 */
function isReportingBuild(): boolean {
  if (app.isPackaged === true) return true;
  const devOptIn = process.env[DEV_REPORTING_ENV] === '1';
  if (!buildGateLogged) {
    buildGateLogged = true;
    log.info('analytics build gate evaluated', { packaged: false, devOptIn });
  }
  return devOptIn;
}

/**
 * 有效上报条件:构建闸在最前,然后同意在先、开关在后。任一为 false 都不得上报。
 *
 * 构建闸不写盘、不改 privacyConsentAccepted / analyticsEnabled —— 那两个字段是用户
 * 的持久真相(dev 与正式版共享同一份 userData 时必须保持一致),设置页照常显示真实
 * 开关状态,dev 下只是没有任何字节发出去。
 */
export function isAnalyticsAllowed(): boolean {
  probeRecordOnce();
  if (!isReportingBuild()) return false;
  const value = store.read();
  return value.privacyConsentAccepted && value.analyticsEnabled;
}

/**
 * 记录用户明示同意《隐私政策》。幂等。
 *
 * 调用点是登录页协议门放行的那一刻(手机号/邮箱/验证码/社交等个人**账号**登录),
 * 即用户已勾选或在弹窗里点了「同意」并继续使用。企业 SSO 入口与「跳过登录」
 * (本地模式,2026-07-27 拍板免协议门)都被协议门豁免,因此这两类用户不会到达这里,
 * 也就不会被采集——这是刻意的。
 */
export function acceptPrivacyConsent(): AnalyticsSettings {
  probeRecordOnce();
  const current = store.read();
  if (current.privacyConsentAccepted) return current;
  // preserveDefaults 无关:true ≠ 默认值 false,override 会被保留。
  store.writePatch({ privacyConsentAccepted: true });
  refreshProbeAfterWrite();
  log.info('privacy consent accepted');
  return store.read();
}

export function setAnalyticsEnabled(analyticsEnabled: boolean): AnalyticsSettings {
  probeRecordOnce();
  // preserveDefaults:analyticsEnabled 的默认值就是 true,不保留的话「用户主动打开」
  // 会被当成「未自定义」而删除 override。这里要留痕,否则无法区分「没碰过」和
  // 「关掉后又打开」——后者在合规问询时是需要能自证的。
  store.writePatch({ analyticsEnabled }, { preserveDefaults: true });
  refreshProbeAfterWrite();
  log.info('analytics setting written', { analyticsEnabled });
  return store.read();
}

/**
 * 一次性迁移:本次改动之前就已登录的存量用户视为已同意。
 *
 * 判定依据是「本机还没有 analytics-settings.json」(isCustomized === false),
 * 而不是猜测旧值——新装用户同样没有文件,但未登录,不会命中。
 *
 * 产品拍板 2026-07-25:存量已登录用户不再二次打扰。他们此前经由登录页进入,
 * 登录链路一直带《用户协议》《隐私政策》的同意表述。
 */
export function migrateExistingLoginAsConsented(isSignedIn: boolean): boolean {
  if (!isSignedIn) return false;
  // 只认探针结论,不在这里 existsSync —— 到这一步时,更早的 settings-get 可能已经把
  // 一份损坏的记录删掉了(见 probeRecordOnce 的注释)。损坏 ≠ 不存在。
  if (probeRecordOnce() !== 'none') return false;
  const state = store.readState();
  if (state.isCustomized) return false;
  // 本机曾经历过「无存量登录态」的冷启动 = 之后出现的账号都是改版后新建的,不可迁移
  // (见 legacyConsentMigrationClosed 注释;标记本身会让上面两道闸也命中,这里显式
  // 再判一次,免得将来有人改动探针/override 语义时静默失守)。
  if (state.value.legacyConsentMigrationClosed) return false;
  store.writePatch({ privacyConsentAccepted: true });
  refreshProbeAfterWrite();
  log.info('existing signed-in user migrated as consented');
  return true;
}

/**
 * 永久关闭本机的存量同意迁移窗口(幂等)。
 *
 * 由 `analyticsSettingsService` 在冷启动**明确**判定「没有存量登录态」(未登录 /
 * 本地模式)时调用。写的是一个内部持久标记,不是用户偏好:它不出现在
 * `analyticsSettingsPayload`、不影响 `analyticsEnabled` 的 customized 判定,
 * 也不会让 `isAnalyticsAllowed` 变 true —— 唯一作用是让后续冷启动不再迁移。
 */
export function closeLegacyConsentMigration(): boolean {
  probeRecordOnce();
  const current = store.read();
  if (current.legacyConsentMigrationClosed) return false;
  // true ≠ 默认值 false,override 会被保留(无需 preserveDefaults)。
  store.writePatch({ legacyConsentMigrationClosed: true });
  refreshProbeAfterWrite();
  log.info('legacy consent migration window closed for this machine');
  return true;
}

/** enabled 是否被用户显式设置过(即盘上有这条 override)。 */
export function isAnalyticsEnabledCustomized(): boolean {
  probeRecordOnce();
  return store.readState().customizedKeys.includes('analyticsEnabled');
}

/**
 * 「恢复默认」:只删掉 enabled override,保留同意这个事实。
 *
 * 有了 override 语义之后这个入口是必须的 —— 用户把开关拨回当前默认值时写入的是
 * 一个显式 true,从此不再跟随未来的默认值变化(configuration-and-overrides §4)。
 * 传入默认值且不带 preserveDefaults,writePatch 会把这条 override 删除。
 */
export function clearAnalyticsEnabledOverride(): AnalyticsSettings {
  probeRecordOnce();
  store.writePatch({ analyticsEnabled: DEFAULTS.analyticsEnabled });
  // 这条可能把最后一个 override 删掉(文件随之删除)⇒ 结论应为 none 而非 valid;
  // refreshProbeAfterWrite 按 isCustomized 区分,不会误标 valid。
  refreshProbeAfterWrite();
  log.info('analytics enabled override cleared');
  return store.read();
}

/** 仅用于测试与显式的本机数据清理;会让用户回到「未同意」。 */
export function resetAnalyticsSettings(): AnalyticsSettings {
  const value = store.reset();
  recordProbe = 'none';
  return value;
}

export const __testing = {
  normalize,
  DEFAULTS,
  isReportingBuild,
  DEV_REPORTING_ENV,
  classifyAnalyticsContent,
  resetProbe(): void {
    recordProbe = null;
  },
  probe: () => recordProbe,
};
