/**
 * 「崩溃时自动上传日志」开关的持久层。
 *
 * File: `<userData>/log-upload-settings.json`
 *
 * 为什么单独一份文件、不并进 `analytics-settings.json`：那份文件承载的是「隐私政策同意」
 * 这个**事实记录**与使用统计的 opt-out 偏好；日志上报是另一件事，混在一起会让「恢复默认」
 * 与迁移语义互相纠缠。同意事实照旧复用 analytics 那份（不再存第二份），这里只存本功能
 * 自己的开关。
 *
 * override 语义（configuration-and-overrides §2/§4）：
 *  - 默认值 `false`（默认关闭，需求 §4.3）；
 *  - 持久化只记 override，不把默认值抄进用户配置；
 *  - 「恢复默认」= 删掉这条 override 重新跟随版本默认值，不是写一份静态 false。
 *    因为默认值就是 false，用户「打开又关掉」必须留痕（`preserveDefaults`），
 *    否则无法区分「没碰过」与「关过」——后者在合规问询时需要能自证。
 */

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';

const log = desktopMakerLogger.child('log-upload-settings');

export interface LogUploadSettings {
  /** 崩溃时自动上传日志。默认关闭。 */
  crashAutoUploadEnabled: boolean;
}

const DEFAULTS: LogUploadSettings = {
  crashAutoUploadEnabled: false,
};

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'log-upload-settings.json');
}

function normalize(raw: unknown): LogUploadSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    crashAutoUploadEnabled:
      typeof r.crashAutoUploadEnabled === 'boolean'
        ? r.crashAutoUploadEnabled
        : DEFAULTS.crashAutoUploadEnabled,
  };
}

const store = createOverrideSettingsFile<LogUploadSettings>({
  filePath: settingsFilePath,
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'log-upload',
});

/**
 * 盘上这条记录**第一次被本进程看到时**是什么状态。与 analytics 那份同款，理由也同款：
 * `createOverrideSettingsFile` 读到坏 JSON 会**把文件删掉**并缓存一个未自定义的默认态,
 * 于是「现读」再也看不到损坏 —— 而设置页挂载即调的 `logUploadSettingsPayload()` 就会触发
 * 这次读取，它远早于延迟执行的启动补传（2026-08-04 review P2）。
 *
 * 所以在任何 store 读写之前先做一次只读探针，把结论钉在内存里：
 *   none    = 没有记录（从未自定义，跟随默认值关闭）
 *   valid   = 有一份**本 writer 可能产出**的记录（object + 非空 + crashAutoUploadEnabled 若在则为 boolean）
 *   invalid = 有记录但解析不出来、或形状不可能来自本 writer（空对象 / 非 boolean 值）——
 *             授权闸据此判 `unknown`，否则会当成「用户把开关关了」并清空待补传标记，
 *             一次坏文件永久丢掉崩溃现场
 */
type RecordProbe = 'none' | 'valid' | 'invalid';
let recordProbe: RecordProbe | null = null;

/**
 * 纯分类：给定盘上内容（`null` = 文件不存在），判成 none / valid / invalid。抽出来是为了
 * 不拉 electron 也能单测——fs 访问留在 `probeSettingsFile`。
 *
 * 「能解析成 object」还不够（2026-08-04 review copilot）：本 store 的 writer 在 override 清空时
 * **删文件**、从不落 `{}`，写入时 `normalize` 保证 `crashAutoUploadEnabled` 一定是 boolean。
 * 所以盘上出现空对象、或该键存在却不是 boolean，都不可能来自本 writer —— 是外部手改或半截
 * 写入。当成 valid 会让 `isCrashAutoUploadEnabled()` 回落默认 false、闸判 crash-auto-off 并
 * 清空待补传标记；判 invalid 走 `unknown`（不传也不清），与坏 JSON 同款保守处理。
 */
function classifyProbe(fileContent: string | null): RecordProbe {
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
  if ('crashAutoUploadEnabled' in obj && typeof obj.crashAutoUploadEnabled !== 'boolean') {
    return 'invalid';
  }
  return 'valid';
}

function probeSettingsFile(): RecordProbe {
  try {
    const file = settingsFilePath();
    if (!fs.existsSync(file)) return 'none';
    return classifyProbe(fs.readFileSync(file, 'utf-8'));
  } catch {
    // 读盘本身失败(权限等):当「在、但非法」,绝不当成「没有记录」。
    return 'invalid';
  }
}

function probeRecordOnce(): RecordProbe {
  if (recordProbe !== null) return recordProbe;
  recordProbe = probeSettingsFile();
  if (recordProbe !== 'none') {
    log.info('log-upload settings record probed', { probe: recordProbe });
  }
  return recordProbe;
}

/**
 * 现读盘。授权闸每次判定前调用：开发版与正式版共享 userData，用户可能在另一个实例里刚刚
 * 关掉开关，进程内的旧缓存不能继续放行上传（需求 §4.3）。
 * mtime 守卫让「文件没变」时零开销。
 */
export function refreshLogUploadSettingsFromDisk(): void {
  probeRecordOnce();
  store.invalidateIfChanged();
}

/**
 * 盘上的开关记录**现在是否可读**。语义与 `isAnalyticsConsentRecordReadable()` 一致：
 * 文件不存在算可读（= 从未自定义，跟随默认值关闭），只有「在、但解析不出来」算不可读。
 *
 * 两道判据取交集：一是**现读**（捕捉此刻仍在盘上的损坏），二是启动期那次 `probeRecordOnce()`
 * 的结论（store 读到坏文件会把它删掉，之后现读什么都看不到了）。任一判为损坏即不可读。
 */
export function isLogUploadSettingsReadable(): boolean {
  if (recordProbe === 'invalid') return false;
  return probeSettingsFile() !== 'invalid';
}

export function readLogUploadSettings(): LogUploadSettings {
  probeRecordOnce();
  return store.read();
}

export function isCrashAutoUploadEnabled(): boolean {
  probeRecordOnce();
  return store.read().crashAutoUploadEnabled;
}

/** 用户是否显式设置过开关（盘上有这条 override）。 */
export function isCrashAutoUploadCustomized(): boolean {
  probeRecordOnce();
  return store.readState().customizedKeys.includes('crashAutoUploadEnabled');
}

export function setCrashAutoUploadEnabled(enabled: boolean): LogUploadSettings {
  probeRecordOnce();
  // preserveDefaults:默认值就是 false,不保留的话「用户打开后又关掉」会被当成「未自定义」
  // 而删除 override,从此再也分不清「没碰过」与「显式关掉」。
  store.writePatch({ crashAutoUploadEnabled: enabled }, { preserveDefaults: true });
  // 写入整份替换了文件内容,之前那次「损坏」的结论到此作废。不清掉的话本进程会一直把闸判成
  // unknown —— 用户明明已经重新设过开关了,崩溃补传还得等下次重启才恢复。
  recordProbe = 'valid';
  return store.read();
}

/** 「恢复默认」：删掉 override，重新跟随当前版本默认值。 */
export function clearCrashAutoUploadOverride(): LogUploadSettings {
  probeRecordOnce();
  store.writePatch({ crashAutoUploadEnabled: DEFAULTS.crashAutoUploadEnabled });
  recordProbe = 'valid';
  return store.read();
}

export const __testing = {
  DEFAULTS,
  normalize,
  settingsFilePath,
  classifyProbe,
  resetProbe: (): void => {
    recordProbe = null;
  },
};
