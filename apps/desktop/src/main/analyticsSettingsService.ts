/**
 * analyticsSettingsService —— 使用统计(TapDB)同意状态与开关的 main 侧服务。
 *
 * 职责:
 *  - 注册 analytics:* IPC(读取、开关、记录同意)
 *  - 状态变化时广播 `analytics:settings-change`,让 renderer 的 tapdbClient 即时
 *    初始化或 opt-out,不必等下次冷启动
 *  - 承接一次性存量迁移:本次改动之前就已登录的用户视为已同意
 *
 * 为什么 gate 放在 main:同意状态是持久真相,必须由 main 持有(见
 * docs/dev-rules/electron-security-and-process-boundaries.md §2)。renderer 只拿
 * 一个布尔结论,不自己判断也不自己落盘。
 */

import { BrowserWindow, ipcMain } from 'electron';

import * as authManager from './authManager';
import {
  acceptPrivacyConsent,
  clearAnalyticsEnabledOverride,
  closeLegacyConsentMigration,
  isAnalyticsAllowed,
  isAnalyticsEnabledCustomized,
  migrateExistingLoginAsConsented,
  readAnalyticsSettings,
  setAnalyticsEnabled,
} from './analytics-settings-store';
import { createLogger } from './logger';
import { onQuit } from './lifecycle';
import { assertTrustedAppRendererEvent } from './security/trustedAppRenderer.js';
import { throwIpcError } from './utils/ipcValidate.js';
import {
  ANALYTICS_SETTINGS_CHANGE_CHANNEL,
  type AnalyticsSettingsPayload,
} from '../shared/analyticsSettings';

const log = createLogger('analytics-settings');

let ipcRegistered = false;
/** 存量迁移只评估一次;评估过就不再看任何后续登录。 */
let migrationEvaluated = false;

/**
 * 落盘失败翻译成统一 IPC 错误协议。
 *
 * 直接把 fs 异常抛过进程边界会让 renderer 拿到(并 toast 出)内部绝对路径,
 * 违反 electron-security-and-process-boundaries.md §5「不把堆栈、内部路径原样
 * 返回 Renderer」。真实原因只留在 main 侧日志里。
 *
 * message 刻意用英文技术串:它只是给日志和调试看的,**不面向用户**。renderer 拿到
 * 的是稳定的 `code`,由它自己映射到当前语言的 i18n 文案(否则英/日/韩用户会看到
 * 一句中文错误)。
 */
function writeOrThrowIpcError(write: () => void, context: string): void {
  try {
    write();
  } catch (err) {
    log.error(context, err);
    throwIpcError('INTERNAL', 'failed to persist analytics settings');
  }
}

export function analyticsSettingsPayload(): AnalyticsSettingsPayload {
  const value = readAnalyticsSettings();
  return {
    privacyConsentAccepted: value.privacyConsentAccepted,
    analyticsEnabled: value.analyticsEnabled,
    analyticsEnabledCustomized: isAnalyticsEnabledCustomized(),
    allowed: isAnalyticsAllowed(),
  };
}

function broadcastSettingsChange(): void {
  const payload = analyticsSettingsPayload();
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(ANALYTICS_SETTINGS_CHANGE_CHANNEL, payload);
    } catch (err) {
      log.warn(`broadcast '${ANALYTICS_SETTINGS_CHANGE_CHANNEL}' failed (non-fatal)`, err);
    }
  }
}

/**
 * 一次性存量迁移的唯一入口,由 `auth:initialize` 在拿到**冷启动恢复结果**后调用。
 *
 * 为什么只认冷启动、不订阅后续登录:登录页的协议门豁免企业 SSO 入口,走 SSO 的
 * 用户从没点过「同意」。如果这里改成"任何时候观察到登录就算同意",新的 SSO 登录
 * 会被误判成已同意。冷启动恢复出来的登录态则不同——那是本次改动之前就存在的
 * 会话,属于产品拍板(2026-07-25)的"不再二次打扰"范围。
 *
 * 为什么本地模式(跳过登录)**不算**已登录:冷启动可能恢复出三种状态——
 *   1. 真实账号(cloud):经登录页进入,链路一直带《用户协议》《隐私政策》表述 → 可迁移
 *   2. 本地模式(跳过登录):2026-07-27 拍板「不创建账号、不上报数据」,刻意免协议门,
 *      这类用户从未同意过隐私协议 → 绝不可迁移
 *   3. 完全未登录:新装 → 不迁移
 * 把 2 当成 1 会让「跳过登录」的用户在下一次冷启动被静默写入 privacyConsentAccepted,
 * 等于未经同意打开采集(隐私红线)。
 *
 * 迁移本身还有第二道闸:store 里已经有 override 时一律跳过(见
 * analytics-settings-store.migrateExistingLoginAsConsented)。
 *
 * 第三道闸是**持久**的:本函数一旦明确判定「没有存量登录态」(情形 2 / 3),就把结论落盘
 * (`legacyConsentMigrationClosed`)。否则「跳过登录 → 从本地模式登录 → 企业 SSO」这类
 * 全程免协议门的链路会在下一次冷启动伪装成情形 1(真实账号 + 零记录)被静默迁移
 * (2026-07-28 review P1)。
 */
/**
 * 迁移是 best-effort 的埋点工作,**绝不能把登录拖下水**。
 *
 * 调用点在 `auth:initialize` 的 try 块里:userData 只读或写满时 writePatch 会同步
 * 抛出,那个异常会让一次本来成功的认证被判失败,renderer 直接把用户归一成未登录。
 * 写不进去就写不进去,下次冷启动还有机会;登录不能因此断。
 */
function migrateOrLog(): void {
  try {
    if (migrateExistingLoginAsConsented(true)) broadcastSettingsChange();
  } catch (err) {
    log.warn('existing-login consent migration failed (non-fatal)', err);
  }
}

/**
 * 冷启动**明确**判定「本机没有存量登录态」时,把这个结论落盘,永久关闭迁移窗口。
 *
 * 为什么必须持久化(2026-07-28 review P1):模块级 `migrationEvaluated` 只活一个进程,
 * 下次冷启动窗口照常打开。而「跳过登录」与企业 SSO 都被协议门刻意豁免、一份记录都不写,
 * 于是「跳过登录 → 从本地模式走登录入口 → 完成 SSO」之后的那次冷启动会看到「真实账号 +
 * 零记录」,与真正的存量账号无法区分,被静默迁移成已同意 —— 未经同意打开采集。纯 SSO
 * 新装用户同理。落盘之后,本机就再也不满足「改版前存量账号」的定义。
 *
 * 只在结论**明确**时调用:冷启动结果未决 / 异常时不写,免得把真存量用户的窗口误关
 * (弱网存量用户凭空少统计)。同样是 best-effort,写不进去绝不能把登录拖下水。
 */
function closeMigrationWindowOrLog(): void {
  try {
    closeLegacyConsentMigration();
  } catch (err) {
    log.warn('closing legacy consent migration window failed (non-fatal)', err);
  }
}

export function noteAuthColdStartState(
  state: { isAuthenticated: boolean },
  pendingCompletion: Promise<{ isAuthenticated: boolean }> | null,
): void {
  if (migrationEvaluated) return;

  // `!isLocalMode()` 在当前实现下是冗余的(local 会话拿不到 isAuthenticated),但这里
  // 保留它做 fail closed:哪天本地模式改成也带 canEnterApp / authenticated 语义,
  // 也不会静默把免协议门的用户迁移成「已同意」。
  const signedIn = state.isAuthenticated && !authManager.isLocalMode();
  if (signedIn) {
    migrationEvaluated = true;
    migrateOrLog();
    return;
  }

  // 冷启动 refresh 超时:renderer 先拿到未登录兜底态,真结果还在路上。这时候
  // 不能急着定论,否则慢网上的存量用户会被当成新用户,凭空少掉统计。
  if (pendingCompletion) {
    void pendingCompletion
      .then((finalState) => {
        if (migrationEvaluated) return;
        migrationEvaluated = true;
        const finalSignedIn = finalState.isAuthenticated && !authManager.isLocalMode();
        if (finalSignedIn) migrateOrLog();
        // 明确判定「没有存量登录态」→ 落盘关窗(见 closeMigrationWindowOrLog)。
        else closeMigrationWindowOrLog();
      })
      .catch(() => {
        // 结果异常 = 结论不明确:只关本进程的窗,不落盘(否则弱网存量用户会被永久误判)。
        migrationEvaluated = true;
      });
    return;
  }

  // 冷启动确定没有真实账号(未登录 / 跳过登录的本地模式)= 不迁移,并把这个结论**落盘**:
  // 本机从此不再是「改版前存量账号」,后续冷启动即便恢复出真实账号也不迁移。此后只有登录页
  // 的协议门能写入同意——本地模式用户之后真登录走的就是那道门,与新装用户一致(企业 SSO 被
  // 协议门豁免,那类用户就是不采集,这是刻意的)。
  migrationEvaluated = true;
  closeMigrationWindowOrLog();
}

export function initAnalyticsSettingsService(): void {
  if (ipcRegistered) {
    log.warn('initAnalyticsSettingsService called twice, ignoring');
    return;
  }
  ipcRegistered = true;

  ipcMain.handle('analytics:settings-get', (event) => {
    assertTrustedAppRendererEvent(event);
    return analyticsSettingsPayload();
  });

  ipcMain.handle('analytics:settings-set-enabled', (event, rawEnabled: unknown) => {
    assertTrustedAppRendererEvent(event);
    // payload 只信运行时校验过的布尔;非布尔一律当关闭处理(fail closed)。
    const enabled = rawEnabled === true;
    writeOrThrowIpcError(() => setAnalyticsEnabled(enabled), 'write analytics setting failed');
    broadcastSettingsChange();
    return analyticsSettingsPayload();
  });

  // 「恢复默认」= 删掉 enabled override 跟随当前默认值,同意事实不动
  // (configuration-and-overrides §4)。
  ipcMain.handle('analytics:settings-reset-enabled', (event) => {
    assertTrustedAppRendererEvent(event);
    writeOrThrowIpcError(
      () => clearAnalyticsEnabledOverride(),
      'clear analytics enabled override failed',
    );
    broadcastSettingsChange();
    return analyticsSettingsPayload();
  });

  ipcMain.handle('analytics:consent-accept', (event) => {
    assertTrustedAppRendererEvent(event);
    writeOrThrowIpcError(() => acceptPrivacyConsent(), 'record privacy consent failed');
    broadcastSettingsChange();
    return analyticsSettingsPayload();
  });

  onQuit('analytics-settings', () => {
    ipcRegistered = false;
  });
}

export const __testing = {
  resetForTests(): void {
    ipcRegistered = false;
    migrationEvaluated = false;
  },
  broadcastSettingsChange,
};
