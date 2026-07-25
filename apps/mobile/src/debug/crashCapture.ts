import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { Directory, File, Paths } from 'expo-file-system';

import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';

import { APP_BINARY_VERSION, AUTH_REGION, IS_OTA_SELFHOST } from '@/config/env';
import {
  appendWithCap,
  BOOT_PHASE_ORDER,
  formatCrashEntry,
  isAbnormalPreviousBoot,
  selectRejectionTracker,
  type BootPhase,
} from '@/debug/crashCaptureFormat';

// 纯格式化 / 判定逻辑与类型从 crashCaptureFormat 统一出口(方便调用方只从本模块引入)。
export * from '@/debug/crashCaptureFormat';

/**
 * 轻量崩溃捕获(端上、无第三方、纯本地落盘)。
 * ---------------------------------------------------------------------------
 * 背景:mobile(Expo/RN,安卓+iOS 共用)此前完全没有崩溃上报,也没有全局 JS 异常
 * 处理器与 ErrorBoundary——崩溃后什么都不留下,远端用户(如联想 Y700 平板一开即退)
 * 只能靠手动 adb / bugreport 取证,极其被动。这里补一层:崩溃现场同步写盘,用户在
 * 设置页一键导出/分享日志文件发回。
 *
 * 能抓:JS 未捕获异常(ErrorUtils global handler)、未处理的 Promise rejection、
 *       React 渲染期错误(经 recordReactError,由 CrashBoundary 调用)。
 * 抓不到:纯原生崩溃(native 模块 SIGSEGV 等)——JS 层拦不住。为此加「启动面包屑」:
 *        每次启动把进度阶段写盘,下次启动若发现上次没走到 ready,就补记一条
 *        「上次卡在阶段 X」,用来定位原生启动崩溃死在哪一步。
 *
 * 关键实现:SDK 56 的 expo-file-system 新 File API 的 write/textSync/exists/size 是
 * 同步的——致命 handler 里进程死亡前能同步落盘。所有 IO 都吞异常:日志设施本身
 * 绝不能把 App 搞崩。
 */

const CRASH_DIR_NAME = 'crash';
const CRASH_LOG_NAME = 'crash.log';
const BOOT_MARKER_NAME = 'boot.json';

// ── IO 层(全部吞异常)──────────────────────────────────────────────────────

let installed = false;
let previousAbnormalExit = false;
// 会话运行环境头惰性写入:首条真正的崩溃记录前才补一次。避免每次启动都写头,
// 否则 crash.log 恒非空 → 设置页 export/clear 永远可见、「无崩溃」态永不可达。
let sessionHeaderPending = true;
let sessionStartAt = 0;

function crashDir(): Directory {
  return new Directory(Paths.document, CRASH_DIR_NAME);
}

function logFile(): File {
  return new File(crashDir(), CRASH_LOG_NAME);
}

function bootMarkerFile(): File {
  return new File(crashDir(), BOOT_MARKER_NAME);
}

function ensureDir(): void {
  try {
    const dir = crashDir();
    if (!dir.exists) dir.create({ intermediates: true });
  } catch {
    /* ignore */
  }
}

function safeTextSync(file: File): string {
  try {
    return file.exists ? file.textSync() : '';
  } catch {
    return '';
  }
}

/** 同步追加一条记录到崩溃日志。任何异常都吞掉——日志设施绝不能把 App 搞崩。 */
function appendEntry(entry: string): void {
  try {
    ensureDir();
    const file = logFile();
    const merged = appendWithCap(safeTextSync(file), entry);
    file.write(merged);
  } catch {
    /* ignore */
  }
}

/**
 * 记录一条崩溃(唯一的崩溃写入入口):首条崩溃前惰性补一次本会话运行环境头,
 * 之后仅追加记录本身。保证无崩溃的正常会话不写任何 crash.log 内容。
 */
function recordCrash(entry: string): void {
  if (sessionHeaderPending) {
    appendEntry(buildSessionHeader(sessionStartAt || Date.now()));
    sessionHeaderPending = false;
  }
  appendEntry(entry);
}

/** 一次性运行环境头:App 版本 / OTA 运行信息 / 系统 / 机型 / 区域。 */
function buildSessionHeader(at: number): string {
  const parts: string[] = [`app=${APP_BINARY_VERSION}`, `region=${AUTH_REGION}`];
  parts.push(`os=${Platform.OS}${Platform.Version != null ? ` ${Platform.Version}` : ''}`);
  // 安卓 Platform.constants 带 Brand/Model/Manufacturer;iOS 用 Constants.deviceName 兜底。
  const androidConstants = (Platform as unknown as { constants?: Record<string, unknown> }).constants;
  const model =
    (androidConstants && (androidConstants.Model || androidConstants.Brand)) ||
    Constants.deviceName ||
    'unknown';
  parts.push(`model=${String(model)}`);
  parts.push(`selfhostOta=${IS_OTA_SELFHOST ? '1' : '0'}`);
  try {
    // expo-updates 在部分环境(Expo Go / 未启用)可能抛错,防御性读取。
    const Updates = require('expo-updates') as typeof import('expo-updates');
    parts.push(`rtv=${Updates.runtimeVersion ?? 'n/a'}`);
    parts.push(`updateId=${Updates.updateId ?? 'embedded'}`);
    parts.push(`channel=${Updates.channel ?? 'n/a'}`);
  } catch {
    /* updates 信息不可用则跳过 */
  }
  // 与其它落盘文本同口径脱敏,保证「写入文件的一切都已脱敏」这个不变量。
  return redactSensitiveText(`\n=== session ${new Date(at).toISOString()} ${parts.join(' ')} ===\n`);
}

function readBootMarker(): { phase?: string; at?: number } | null {
  try {
    const raw = safeTextSync(bootMarkerFile());
    if (!raw) return null;
    return JSON.parse(raw) as { phase?: string; at?: number };
  } catch {
    return null;
  }
}

function writeBootMarker(phase: BootPhase, at: number): void {
  try {
    ensureDir();
    bootMarkerFile().write(JSON.stringify({ phase, at }));
  } catch {
    /* ignore */
  }
}

type GlobalErrorUtils = {
  getGlobalHandler?: () => ((error: unknown, isFatal?: boolean) => void) | undefined;
  setGlobalHandler?: (handler: (error: unknown, isFatal?: boolean) => void) => void;
};

function installGlobalHandler(): void {
  const errorUtils = (globalThis as unknown as { ErrorUtils?: GlobalErrorUtils }).ErrorUtils;
  if (!errorUtils?.setGlobalHandler) return;
  const previous = errorUtils.getGlobalHandler?.();
  errorUtils.setGlobalHandler((error, isFatal) => {
    // 日志设施绝不能吞掉默认崩溃流程:即使记录本身抛错,也必须把 error 交回原 handler。
    try {
      recordCrash(formatCrashEntry({ source: 'uncaught', error, isFatal, at: Date.now() }));
      // 致命异常:把 boot 终态标记为 'crashed',让下次启动的「上次退出异常」反映真实的
      // 运行期崩溃(含 ready 之后崩溃),而非仅「启动没走到 ready」。同步写在默认 handler 前。
      if (isFatal) writeBootMarker('crashed', Date.now());
    } catch {
      /* ignore */
    }
    // 保留默认行为(dev red box / 生产默认崩溃流程)。始终执行。
    previous?.(error, isFatal);
  });
}

type RejectionTrackerOptions = {
  allRejections?: boolean;
  onUnhandled?: (id: unknown, error: unknown) => void;
  onHandled?: (id: unknown) => void;
};

type HermesInternal = {
  hasPromise?: () => boolean;
  enablePromiseRejectionTracker?: (options: RejectionTrackerOptions) => void;
};

/**
 * 安装未处理 Promise rejection 追踪。RN 0.85 正式包默认 Hermes,其原生 Promise 只被
 * HermesInternal.enablePromiseRejectionTracker 追踪(promise polyfill 的 tracker 追不到它);
 * RN 自己的两条安装路径又都被 __DEV__ 包裹,所以正式包里 RN 根本没装 tracker——这里在
 * 正式包按运行时引擎二选一安装,是纯增量,不会覆盖 RN。dev 让给 RN(见 selectRejectionTracker)。
 */
function installPromiseRejectionTracking(): void {
  const hermes = (globalThis as unknown as { HermesInternal?: HermesInternal }).HermesInternal;
  const kind = selectRejectionTracker({
    isDev: typeof __DEV__ !== 'undefined' && __DEV__,
    hermesHasPromise: hermes?.hasPromise?.() === true,
  });
  if (kind === 'none') return;
  const options: RejectionTrackerOptions = {
    allRejections: true,
    onUnhandled: (_id, error) => {
      // 未处理 rejection 不一定终止进程,只记录、不改 boot 终态(避免把可恢复的 rejection
      // 误标成 crashed)。
      recordCrash(formatCrashEntry({ source: 'unhandledRejection', error, at: Date.now() }));
    },
    onHandled: () => {},
  };
  try {
    if (kind === 'hermes') {
      // 可选链保护:个别 Hermes 构建可能未暴露该方法。
      hermes?.enablePromiseRejectionTracker?.(options);
      return;
    }
    // JSC / 非 Hermes:polyfill Promise 自带的 rejection tracker。
    const tracking = require('promise/setimmediate/rejection-tracking') as {
      enable: (opts: RejectionTrackerOptions) => void;
    };
    tracking.enable(options);
  } catch {
    /* rejection-tracking 不可用则跳过 */
  }
}

/**
 * 安装崩溃捕获(幂等)。应在 index.js 里尽可能早地调用(先于业务树模块初始化)。
 * 顺序:判定上次是否异常退出(异常才惰性写头 + 补记一条)→ 置本次 phase=starting → 装 handler。
 * 正常(上次干净退出、本次也没崩)的会话不写任何 crash.log 内容。
 */
export function installCrashCapture(): void {
  if (installed) return;
  installed = true;
  const now = Date.now();
  sessionStartAt = now;

  const previous = readBootMarker();
  previousAbnormalExit = isAbnormalPreviousBoot(previous);

  if (previousAbnormalExit) {
    const priorPhase = previous?.phase ?? 'unknown';
    // 区分「运行期崩溃」与「启动没走到 ready」,给出更贴切的补记文案。
    const reason =
      priorPhase === 'crashed'
        ? 'previous launch crashed (last phase=crashed)'
        : `previous launch did not reach 'ready' (last phase=${priorPhase})`;
    recordCrash(formatCrashEntry({ source: 'uncaught', error: reason, at: now }));
  }

  writeBootMarker('starting', now);
  installGlobalHandler();
  installPromiseRejectionTracking();
}

/**
 * 记录一次启动阶段推进(由 _layout 的闸门处调用)。
 * 顺序阶段(starting…ready)只前进不回退——React 的 effect 执行顺序是「子先于父」,
 * auth 子树的 markBootPhase('auth') 会先于父层的 markBootPhase('ota') 执行,若不设防
 * 父层会把已推进的 'auth' 写回 'ota',污染面包屑精度。终态('reloading'/'crashed')
 * 不在顺序表内,总是写入(它们语义上就是要覆盖当前阶段)。
 */
export function markBootPhase(phase: BootPhase): void {
  const order = BOOT_PHASE_ORDER.indexOf(phase);
  if (order >= 0) {
    const currentPhase = readBootMarker()?.phase;
    const currentOrder =
      typeof currentPhase === 'string'
        ? (BOOT_PHASE_ORDER as readonly string[]).indexOf(currentPhase)
        : -1;
    if (currentOrder > order) return; // 不回退到更早的顺序阶段
  }
  writeBootMarker(phase, Date.now());
}

/**
 * 预期内主动重载的统一入口:先同步写入正常终态 'reloading',再触发 reload。
 * 用于冷启动 OTA 换包、设置页手动检查更新等——避免把「进程被主动换掉、没走到
 * ready」误判成上次异常退出。传入 reloadAsync 便于注入测试其调用顺序。
 */
export async function reloadWithMarker(reloadAsync: () => Promise<void>): Promise<void> {
  const previous = readBootMarker();
  const previousPhase = previous?.phase;
  markBootPhase('reloading');
  try {
    await reloadAsync();
  } catch (err) {
    // reload 失败:恢复调用前的 phase 原值(不限于已知枚举——损坏/前向兼容的未知 phase
    // 也照原样写回,而不是把它留在 'reloading' 掩盖后续异常;未知 phase 经
    // isAbnormalPreviousBoot 会被保守判为异常,符合预期)。
    if (typeof previousPhase === 'string' && previousPhase.length > 0) {
      writeBootMarker(previousPhase as BootPhase, previous?.at ?? Date.now());
    }
    throw err;
  }
}

/** 记录 React 渲染期错误(由 CrashBoundary.componentDidCatch 调用)。 */
export function recordReactError(error: unknown, componentStack?: string): void {
  recordCrash(
    formatCrashEntry({ source: 'react-render', error, at: Date.now(), extra: componentStack }),
  );
  // 渲染崩溃即已崩溃:标 'crashed',下次启动如实报「上次异常退出」(即使崩在 ready 之后)。
  writeBootMarker('crashed', Date.now());
}

/** 上次启动是否异常退出(安装时判定并缓存;供设置页展示)。 */
export function hasPreviousAbnormalExit(): boolean {
  return previousAbnormalExit;
}

/** 崩溃日志文件句柄(供设置页分享;未必存在,读取前查 exists/size)。 */
export function getCrashLogFile(): File {
  return logFile();
}

/** 同步读取崩溃日志全文(不存在返回空串)。 */
export function readCrashLog(): string {
  return safeTextSync(logFile());
}

/** 清空崩溃日志(保留 boot 面包屑,不影响后续异常退出判定)。 */
export function clearCrashLog(): void {
  try {
    const file = logFile();
    if (file.exists) file.delete();
  } catch {
    /* ignore */
  }
  // 重置惰性头标志:清空后若本会话再次崩溃,需重新补写运行环境头,否则导出的日志
  // 会缺 App 版本 / 系统 / 机型 / runtime 等定位信息。
  sessionHeaderPending = true;
}

/** 崩溃日志当前是否有内容(供设置页判断能否导出)。 */
export function hasCrashLog(): boolean {
  try {
    const file = logFile();
    return file.exists && file.size > 0;
  } catch {
    return false;
  }
}

/** 仅供测试:重置模块内部状态。 */
export function __resetCrashCaptureForTest(): void {
  installed = false;
  previousAbnormalExit = false;
  sessionHeaderPending = true;
  sessionStartAt = 0;
}
