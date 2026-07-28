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
}

const DEFAULTS: AnalyticsSettings = {
  privacyConsentAccepted: false,
  analyticsEnabled: true,
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

function probeRecordOnce(): RecordProbe {
  if (recordProbe !== null) return recordProbe;
  let probed: RecordProbe;
  try {
    const file = settingsFilePath();
    if (!fs.existsSync(file)) {
      probed = 'none';
    } else {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
      probed = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? 'valid' : 'invalid';
    }
  } catch {
    // 读不出来 / 解析失败都算「存在但非法」,绝不当成「没有记录」。
    probed = 'invalid';
  }
  recordProbe = probed;
  if (probed !== 'none') {
    log.info('analytics settings record probed', { probe: probed });
  }
  return probed;
}

export function readAnalyticsSettings(): AnalyticsSettings {
  probeRecordOnce();
  return store.read();
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
 * 调用点是登录页协议门放行的那一刻(手机号/邮箱/验证码/社交/游客),
 * 即用户已勾选或在弹窗里点了「同意」并继续使用。企业 SSO 入口被协议门豁免,
 * 因此走 SSO 的用户不会到达这里,也就不会被采集——这是刻意的。
 */
export function acceptPrivacyConsent(): AnalyticsSettings {
  probeRecordOnce();
  const current = store.read();
  if (current.privacyConsentAccepted) return current;
  // preserveDefaults 无关:true ≠ 默认值 false,override 会被保留。
  store.writePatch({ privacyConsentAccepted: true });
  log.info('privacy consent accepted');
  return store.read();
}

export function setAnalyticsEnabled(analyticsEnabled: boolean): AnalyticsSettings {
  probeRecordOnce();
  // preserveDefaults:analyticsEnabled 的默认值就是 true,不保留的话「用户主动打开」
  // 会被当成「未自定义」而删除 override。这里要留痕,否则无法区分「没碰过」和
  // 「关掉后又打开」——后者在合规问询时是需要能自证的。
  store.writePatch({ analyticsEnabled }, { preserveDefaults: true });
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
  store.writePatch({ privacyConsentAccepted: true });
  log.info('existing signed-in user migrated as consented');
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
  resetProbe(): void {
    recordProbe = null;
  },
  probe: () => recordProbe,
};
