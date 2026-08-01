/**
 * tapdbClient.ts
 * ---------------------------------------------------------------------------
 * TapDB Web SDK 接入入口,用于上报应用的在线活跃(DAU / PV / page_show / page_hide)。
 *
 * ⚠️ 同意闸(2026-07-25):SDK **绝不能**在用户明示同意《隐私政策》之前初始化。
 *   TapDB 会读写设备标识符(Web 端 distinctId / deviceId,持久化在 localStorage),
 *   在 PIPL 与 GDPR 下都属于个人信息;TapTap 自己的合规文档也要求
 *   `if (用户同意隐私协议) { init(...) }`。真相由 main 持有,本模块只消费
 *   `electronAPI.getAnalyticsSettings().allowed` 这个结论:
 *     allowed = isReportingBuild() && 已同意隐私政策 && 使用统计开关开启
 *   (isReportingBuild = packaged 构建,或 dev 下显式 XDT_TAPDB_DEV=1)
 *
 * ⚠️ 构建闸(2026-07-26):dev 构建默认 allowed=false,SDK 不初始化。dev 的
 *   renderer 从 `http://localhost:<vite 端口>` 加载、沙箱各有独立 userData,
 *   localStorage 里的 device_id 每次都是新的,会凭空造出大量"新增设备"污染线上
 *   口径。理由与逃生口(XDT_TAPDB_DEV=1)见
 *   main/analytics-settings-store.ts 的 isReportingBuild。
 *
 * 为什么放在 renderer:
 *   TapDB SDK 依赖 `localStorage` / `document` / `window` / `XMLHttpRequest` /
 *   `navigator.sendBeacon` 等浏览器 API,只能在 renderer 进程跑;同时它消费的"登录
 *   状态变化"信号已经由 main 通过 `electronAPI.onAuthStateChange` 广播到 renderer。
 *   两端信息都在 renderer 这一侧汇合,没必要再绕一层 main-side orchestrator + 新
 *   IPC channel,直接订阅现有 fanOut 即可。
 *
 * 生命周期:
 *   - import 触发 initTapdb(主视图启动时,见 renderer/index.tsx)——它只挂闸、
 *     订阅信号,不碰 SDK
 *   - main 回报 allowed=true 才 init SDK,并立即上报 page_view (#tag=app_start)
 *   - autoTrack 接管 page_show;page_hide 由本模块自己发(SDK 的 beacon 路径没有
 *     采集闸,详见 initTapdb 内 visibilitychange 处的注释)
 *   - 运行期用户在设置里关掉统计 → optOutTracking():SDK 内部 _isCollectData()
 *     变 false,主动上报与 page_show 全部停止,且状态持久化在 localStorage;
 *     page_hide 由 reportPageHide 自行守闸
 *   - 重新打开 → optInTracking() 并补一次 app_start
 *
 * 活跃口径(2026-07-30 起,交互 + 工作驱动):
 *   活跃事件(page_view #tag=app_engaged)由两类真实使用信号触发:
 *   - 用户对 Cindy 窗口的动作:窗口获得焦点 / 窗口内按键 / 窗口内按下指针;
 *   - Cindy 会话确实处于 makerChatStore 的 running 状态。
 *   两类信号共用 30 分钟节流。running 期间保留一条只在工作时存在的滚动 timer,
 *   避免长工具调用没有 renderer 事件时整小时缺数;工作停止或统计关闭即取消。
 *   TapDB 的活跃指标按天与小时去重,账号口径的 setUser(→ user_login,TapDB
 *   账号 DAU 的唯一触发源)跟随当天首条活跃事件发出。
 *
 *   刻意不做的事:
 *   - 不监听 mousemove(高频)与 wheel(高频且涉及滚动合成路径);纯滚动阅读
 *     超过节流窗口且全程不点不敲的场景,由下一次 focus / 点击 / 按键兜住
 *   - 不做整点/跨天定时续报:第二天首条真人操作会自然触发;持续 running 则按
 *     上次活跃时刻滚动 30 分钟,不对齐 0 点。曾经 main 的 tapdbTimer →
 *     tapdb:daily-active 广播会把所有过夜挂机设备压在 00:00-00:01,且把
 *     「进程活着」误报成「用户活跃」,该机制仍保持删除
 *   - 节流状态不持久化:窗口 reload 后最多提前一条,服务端按天去重,无害
 *
 *   SDK 发送层已核实(vendored 1.0.0):未配置 batch 时无 BatchConsumer,每条
 *   事件独立 AjaxTask 即发即弃(失败至多原地重试 3 次后丢弃),不存在堆积面。
 *
 * Overlay 窗口(voice-input-overlay / voice-input-dictionary-toast)不引入此模块,
 * 避免一次浮窗弹出被算成一次 PV。
 */

import type { CindyRegion } from '@cindy/maker-shared/brand-identity';
import TapDBAPI from '@/vendor/tapdb/tapdb.esm.min.js';
import { createLogger } from '@/lib/logger';
import { makerChatStore } from '@/lib/makerChatStore';
import { CURRENT_CINDY_REGION } from '../../shared/brandRegion';
import { TAPDB_EVENT_URL_BY_REGION } from '../../shared/endpoints';

const log = createLogger('tapdb');

// ── Config ──────────────────────────────────────────────────────────────────
//
// TapDB 项目按构建区域二选一,appId 与采集端点(serverUrl,SDK 直接 POST、不再
// 追加路径)必须同区配对。appId 是公开应用标识(服务端 tapdbChargeReporter 同样
// 硬编码同一对 ID),不属于凭证。
//
// ⚠️ 服务端把充值(charge)事件按部署区域报进对应 TapDB 项目,而 TapDB 只统计
// 「同一项目里通过 SDK 上报过 user_login 的 user_id」的充值。客户端曾把两个区域
// 都报进国内项目,导致国际项目全部充值因 user_id 无效不计入收入——这里的区域
// 配对就是那次事故的修复,两侧 ID 必须与服务端 model-access-server 的
// TAPDB_PROJECTS 保持一致。
//
// dev 是内部构建身份,行为语义归 cn 系(region-and-editions.md §1.1);其上报
// 本身已被 isReportingBuild 闸住,仅 XDT_TAPDB_DEV=1 逃生口可达。
export const TAPDB_PROJECT_BY_REGION: Readonly<
  Record<CindyRegion, { appId: string; serverUrl: string }>
> = Object.freeze({
  cn: { appId: 'gczef0ey3e8ogpmizs', serverUrl: TAPDB_EVENT_URL_BY_REGION.cn },
  global: { appId: 'h08anxdfrvfocfs894', serverUrl: TAPDB_EVENT_URL_BY_REGION.global },
  dev: { appId: 'gczef0ey3e8ogpmizs', serverUrl: TAPDB_EVENT_URL_BY_REGION.dev },
});

const TAPDB_CONFIG = TAPDB_PROJECT_BY_REGION[CURRENT_CINDY_REGION];

// ── Internal state ──────────────────────────────────────────────────────────

/** 同意闸是否已挂载(订阅 main 广播 + auth + 日活节拍),与 SDK 是否初始化无关。 */
let gateMounted = false;
/** SDK 是否已经 init。init 不可逆,关闭统计走 optOutTracking。 */
let sdkInitialized = false;
/**
 * 我们自己的闸:用户意图。所有由本模块主动发起的上报(app_start / daily_active /
 * setUser / page_hide)都看它。关闭是**立即生效**的,不等 SDK 侧同步成功。
 */
let reportingAllowed = false;
/**
 * SDK 侧已经成功应用到的状态;null = 还没应用过任何状态。
 *
 * 与 reportingAllowed 分开,是因为两者会短暂不一致:optOutTracking() 可能抛
 * (比如它依赖的 localStorage 不可用)。这时用户意图已经是「关」(reportingAllowed
 * 立刻置 false,我们自己的上报全停),但 SDK 内部仍在采集,需要靠后续广播重试。
 * guard 同时看这两个值,才能既 fail closed 又不把重试吃掉。
 */
let sdkAppliedAllowed: boolean | null = null;
/** 每收到一次广播 +1;用于丢弃 IPC 往返期间已经过期的初始快照。 */
let settingsEpoch = 0;
let currentUserId: string | null = null;
let lastSetUserDate: string | null = null;

// ── Engagement throttle ─────────────────────────────────────────────────────

/** 活跃上报的统一节流窗口。真人交互与 working 共用,一天上限 48 条。 */
const ENGAGED_REPORT_INTERVAL_MS = 30 * 60 * 1000;
/**
 * 跨窗口共享的「上次 app_engaged 上报时刻」localStorage key。detached 侧栏等
 * 窗口跑同一 renderer 入口,module 态各窗口独立 —— 只靠内存窗口,多窗口交替
 * 交互会成倍多发 app_engaged。
 */
const ENGAGED_SHARED_LAST_REPORT_KEY = 'tapdb.lastEngagedReportAt';
/**
 * localStorage 的单次读写同步,但「读 → 判断 → 写」不是跨 renderer 原子事务。
 * working timer 会把多个窗口对齐到同一截止时刻,因此用 Chromium Web Locks
 * 串行化 app_engaged 的领取,并在锁内重读共享时间。
 */
const ENGAGED_SHARED_LOCK_NAME = 'cindy.tapdb.app-engaged';
/**
 * 下一次允许上报活跃的时刻(epoch ms)。仅内存:reload 丢失只会让上报提前一条,
 * 服务端按天去重,无害。任何 tag 的上报(含 app_start)都会推进它,避免冷启动
 * app_start 后紧跟的第一次点击立刻再发一条。
 */
let nextEngagedReportAt = 0;
/**
 * 上次上报那天的本地午夜(epoch ms)。跨过它意味着换日:即便还在节流窗口内
 * (如 23:55 报过、00:03 再交互),也放行补报,否则新一天头 30 分钟的活跃
 * (连同当日 setUser)会被前一天的窗口整个吞掉。
 */
let engagedDayEndsAt = 0;
/** 只在至少一个会话 running 时存在;不对齐整点,避免重造 0 点尖峰。 */
let workingReportTimer: ReturnType<typeof setTimeout> | null = null;
/** makerChatStore 全会话 running 快照订阅。 */
let unsubscribeWorkingState: (() => void) | null = null;
/** 当前 renderer 已有一条 Web Lock 请求在途;高频交互不重复排队。 */
let engagedReportLockPending = false;
/** 在途 working 请求可被后到的真人信号升级,保留跨日立即上报语义。 */
let engagedReportLockAllowsNewDay = false;

/**
 * 在当前状态下实际尝试一次上报。Web Lock 路径会在获得锁后再调用这里,
 * 重新读取跨窗口时间并复核闸与节流条件。
 */
function reportEngagedNowIfDue(allowNewDay: boolean): void {
  const now = Date.now();
  if (now < nextEngagedReportAt && (!allowNewDay || now < engagedDayEndsAt)) return;
  if (!sdkInitialized || !reportingAllowed) return;
  if (!allowNewDay && !hasWorkingSession()) return;
  try {
    reportActive('app_engaged');
  } catch (err) {
    log.error('engaged report failed (non-fatal)', err);
  }
}

/**
 * 活跃信号统一入口。真人操作允许跨日首条立即上报,保留原有「不吞次日首次
 * 交互」语义;working 只按滚动窗口上报,避免 0 点后的 progress notify 重造尖峰。
 * 闸检查放在节流窗口推进之前:未放行期间的信号不消耗窗口。
 */
function reportEngagedIfDue(allowNewDay: boolean): void {
  const now = Date.now();
  if (now < nextEngagedReportAt && (!allowNewDay || now < engagedDayEndsAt)) return;
  if (!sdkInitialized || !reportingAllowed) return;
  if (engagedReportLockPending) {
    if (allowNewDay) engagedReportLockAllowsNewDay = true;
    return;
  }

  // Cindy 的受控 Electron Chromium 提供 Web Locks。测试/极端兼容环境缺失时
  // 维持原有 localStorage 去重退化路径,不能因统计锁不可用影响主流程。
  const lockManager = navigator.locks;
  if (!lockManager) {
    reportEngagedNowIfDue(allowNewDay);
    return;
  }

  engagedReportLockPending = true;
  engagedReportLockAllowsNewDay = allowNewDay;
  try {
    void lockManager
      .request(ENGAGED_SHARED_LOCK_NAME, () => {
        reportEngagedNowIfDue(engagedReportLockAllowsNewDay);
      })
      .catch((err) => {
        log.warn('engagement Web Lock failed; falling back to local throttle', err);
        reportEngagedNowIfDue(engagedReportLockAllowsNewDay);
      })
      .finally(() => {
        engagedReportLockPending = false;
        engagedReportLockAllowsNewDay = false;
        // working timer 在锁请求期间不另起 1ms 空转;锁释放后按新窗口重新排期。
        syncWorkingReport();
      });
  } catch (err) {
    const fallbackAllowNewDay = engagedReportLockAllowsNewDay;
    engagedReportLockPending = false;
    engagedReportLockAllowsNewDay = false;
    log.warn('engagement Web Lock unavailable; falling back to local throttle', err);
    reportEngagedNowIfDue(fallbackAllowNewDay);
  }
}

/** 真人交互(focus / keydown / pointerdown)入口。 */
function onEngagedSignal(): void {
  reportEngagedIfDue(true);
}

function hasWorkingSession(): boolean {
  for (const info of makerChatStore.getRunningSnapshot().values()) {
    if (info.isRunning) return true;
  }
  return false;
}

function clearWorkingReportTimer(): void {
  if (workingReportTimer === null) return;
  clearTimeout(workingReportTimer);
  workingReportTimer = null;
}

/**
 * 把 working 状态接入既有 app_engaged 路径。状态翻起时立即尝试一次;若被
 * app_start / 真人操作的共享窗口挡住,定时器直接对齐该窗口终点,不会顺延。
 */
function syncWorkingReport(): void {
  if (!sdkInitialized || !reportingAllowed || !hasWorkingSession()) {
    clearWorkingReportTimer();
    return;
  }

  reportEngagedIfDue(false);
  if (engagedReportLockPending) return;
  // makerChatStore 会随 text/tool progress 高频 notify。已有 timer 时保持原定时点,
  // 不在每一帧 clear + 重建;真人操作若推进了窗口,旧 timer 到点后会自行重新对齐。
  if (workingReportTimer !== null) return;
  const delayMs = Math.max(1, nextEngagedReportAt - Date.now());
  workingReportTimer = setTimeout(() => {
    workingReportTimer = null;
    syncWorkingReport();
  }, delayMs);
}

// ── Gate ────────────────────────────────────────────────────────────────────

/**
 * 挂载同意闸。多次调用安全(内部有 guard)。
 * 由 renderer/index.tsx 在主视图启动时调用一次。
 *
 * 本函数**不碰 TapDB SDK** —— 是否初始化完全取决于 main 回报的 allowed。
 */
export function initTapdb(): void {
  if (gateMounted) return;
  gateMounted = true;

  // 登录态订阅必须先于 SDK 初始化:冷启动若已登录,auth:state-change 只广播一次,
  // 而那一刻用户可能还没同意协议(SDK 未 init)。这里无论如何都记录 userId,
  // 等 SDK 真正 init 时再补一次 setUser,避免漏绑。
  try {
    window.electronAPI.onAuthStateChange((state) => {
      try {
        const nextUserId = state.isAuthenticated && state.user ? state.user.id : null;
        const previousUserId = currentUserId;
        currentUserId = nextUserId;
        if (!sdkInitialized || !reportingAllowed) return;

        if (nextUserId === null) {
          if (previousUserId === null) return;

          // README 推荐的退登接口。不传参时与 clearUser 等价(仅清本地 accountId,不
          // 发任何 HTTP);传 true 才会重置 distinctId,这里我们不需要切设备身份。
          TapDBAPI.logout();
          log.info('logout');
          lastSetUserDate = null;
        } else if (nextUserId !== previousUserId) {
          // 仅在身份真正变化时绑定。auth:state-change 也会由**定时 token 刷新**
          // 广播 —— 若这里按「跨天」补 setUser,挂机过夜的机器会在无人交互时
          // 凭空产生当日账号活跃,正是本次「活跃改交互驱动」要消灭的假 DAU;
          // 跨天重绑由交互路径(reportActive)负责,只在真实交互时发生。
          reportSetUser(nextUserId, 'auth_state');
        }
      } catch (err) {
        log.error('auth state binding failed (non-fatal)', err);
      }
    });
  } catch (err) {
    log.error('onAuthStateChange subscription failed (non-fatal)', err);
  }

  // 身份补种:登录**之后**才打开的二级窗口(独立侧栏等)错过了 auth:state-change
  // 的初始广播,currentUserId 停在 null —— 半夜定时 token 刷新的广播会被误判成
  // 「身份变化」触发非交互 setUser(假 DAU)。挂完订阅后主动读一次当前身份;
  // 只在仍未从广播学到身份时写入,不与并发广播竞争,也不触发任何上报。
  try {
    const seed = window.electronAPI.authInitialize?.();
    if (seed) {
      void seed
        .then((state) => {
          if (currentUserId !== null) return;
          if (state?.isAuthenticated && state.user?.id) currentUserId = state.user.id;
        })
        .catch(() => {
          // 静默:读不到就维持广播驱动的原行为。
        });
    }
  } catch (err) {
    log.error('auth identity seed failed (non-fatal)', err);
  }

  // 交互驱动的活跃信号(见文件头「活跃口径」)。capture 挂在 window 捕获阶段,
  // 业务代码的 stopPropagation 挡不住;onEngagedSignal 自带节流与同意闸。
  try {
    window.addEventListener('focus', onEngagedSignal);
    window.addEventListener('keydown', onEngagedSignal, { capture: true });
    window.addEventListener('pointerdown', onEngagedSignal, { capture: true });
  } catch (err) {
    log.error('engagement listeners failed (non-fatal)', err);
  }

  // 复用 Sidebar/通知的全会话 running 真相源。这里不使用
  // sessionBackgroundActivityStore:它的契约明确是纯视觉且接受短暂 stale,不能升级
  // 为统计行为依据,否则一次漏掉 false push 就会产生持续假活跃。
  try {
    unsubscribeWorkingState = makerChatStore.subscribeAll(syncWorkingReport);
    syncWorkingReport();
  } catch (err) {
    log.error('working-state subscription failed (non-fatal)', err);
  }

  // page_hide 由本模块自己发,不走 SDK 的 autoTrack —— SDK 的 trackPageHideEvent
  // 内部用 trackWithBeacon,而那个方法**没有** _isCollectData() 闸(见 vendored
  // tapdb.esm.min.js)。沿用 SDK 自动上报的话,用户关掉统计后每次切走窗口仍会发出
  // 一条带 deviceId 的 beacon。这里改由 reportPageHide 统一把关。
  try {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) return;
      reportPageHide();
    });
  } catch (err) {
    log.error('page_hide subscription failed (non-fatal)', err);
  }

  // 同意 / 开关变化即时生效,不必等下次冷启动。
  try {
    window.electronAPI.onAnalyticsSettingsChange((payload) => {
      settingsEpoch += 1;
      applyReportingAllowed(payload.allowed === true);
    });
  } catch (err) {
    log.error('analytics settings subscription failed (non-fatal)', err);
  }

  // 初始结论。读失败一律 fail closed(保持不上报),不做乐观兜底。
  const epochAtRead = settingsEpoch;
  void window.electronAPI
    .getAnalyticsSettings()
    .then((payload) => {
      // IPC 往返期间用户可能已经关掉开关,而广播先一步到达。那条广播比这个快照
      // 新,不能被这里的旧结果覆盖 —— 否则 optInTracking() 会把刚关掉的上报又打开。
      if (epochAtRead !== settingsEpoch) {
        log.info('stale initial settings snapshot discarded');
        return;
      }
      applyReportingAllowed(payload.allowed === true);
    })
    .catch((err) => {
      // 冷启动早期 main 侧 handler 可能还没注册完(渲染进程先跑到这里)。这时候
      // 不能永久放弃:后续 analytics:settings-change 广播仍会把结论送来,而用户
      // 「已同意」的情况下 main 在任何一次设置变更时都会重播状态。
      log.error('analytics settings read failed; reporting stays disabled', err);
    });
}

/**
 * page_hide 上报。SDK 的 beacon 路径绕过 _isCollectData(),所以闸必须由我们自己守:
 * 未初始化或未放行时一个字节都不发。
 */
function reportPageHide(): void {
  if (!sdkInitialized || !reportingAllowed) return;
  try {
    TapDBAPI.track('page_hide');
  } catch (err) {
    log.error('page_hide report failed (non-fatal)', err);
  }
}

/** 把 main 的结论落到 SDK:首次放行 → init;关闭 → opt-out;重新放行 → opt-in。 */
function applyReportingAllowed(next: boolean): void {
  // 只有「用户意图」和「SDK 已应用状态」都已经等于目标值时才可以早返回。
  // 单看 reportingAllowed 会把 SDK 侧失败后的重试吃掉;单看 sdkAppliedAllowed 又
  // 会在每次同值广播上重复做无用功。
  if (next === reportingAllowed && next === sdkAppliedAllowed && (!next || sdkInitialized)) {
    return;
  }

  // 关闭是用户的明确意图:**先立刻停掉我们自己的上报**,再去管 SDK。这一步不放在
  // try 里,因为它不可能失败,也绝不该因为后面 SDK 抛异常而回退(fail closed)。
  if (!next) {
    reportingAllowed = false;
    clearWorkingReportTimer();
  }

  try {
    if (!next) {
      if (!sdkInitialized) {
        sdkAppliedAllowed = false;
        log.info('reporting not allowed; TapDB stays uninitialized');
        return;
      }
      // optOutTracking 清掉 superProperties / accountId,并把 opt_tracking 写成
      // false(持久化在 localStorage)。此后 _isCollectData() 恒 false,SDK 的
      // page_show 与我们所有主动上报都会被挡下。
      // page_hide 不在此列 —— SDK 的 beacon 路径没有这道闸,所以我们没有开启
      // autoTrack.pageHide,改由 reportPageHide 自己守闸(见 initTapdb)。
      TapDBAPI.optOutTracking();
      sdkAppliedAllowed = false;
      lastSetUserDate = null;
      log.info('reporting disabled (opt-out)');
      return;
    }

    if (!sdkInitialized) {
      // initSdk 自己在成功后置 sdkInitialized;失败时保持未初始化,下次广播重试。
      initSdk();
      if (!sdkInitialized) return;
      reportingAllowed = true;
      sdkAppliedAllowed = true;
      syncWorkingReport();
      return;
    }

    // 已 init 过、中途被关掉:重新放行要恢复 opt_tracking 与 superProperties
    // (optOutTracking 把它们清空了)。
    TapDBAPI.optInTracking();
    applySuperProperties();
    reportingAllowed = true;
    sdkAppliedAllowed = true;
    reportActive('app_start');
    syncWorkingReport();
    log.info('reporting re-enabled (opt-in)');
  } catch (err) {
    // sdkAppliedAllowed 没提交 = 下一次同值广播不会被 guard 挡掉,会重新尝试。
    // 关闭方向上 reportingAllowed 已经是 false,期间我们自己一条都不会发。
    log.error('apply analytics permission failed; will retry on next change', err);
  }
}

function initSdk(): void {
  try {
    TapDBAPI.init({
      appId: TAPDB_CONFIG.appId,
      serverUrl: TAPDB_CONFIG.serverUrl,
      // 数据发送方式:ajax 兼容性最好;beacon 在页面关闭场景更可靠但部分代理会丢
      send_method: 'ajax',
      // ajax 走 form 编码,与 tapdb 默认后端兼容
      textContent: 'form',
      // init 时自动上报一个 device_login 事件。TapDB 后台用 device_login 认定
      // "新增设备"指标 — pvEvent / page_view 都不算数,必须开这个。
      isInitDeviceLogin: true,
      // 自动采集页面展示,用于会话时长统计。
      // pageHide 必须保持 false:SDK 的 trackPageHideEvent 走 trackWithBeacon,
      // 那条路径没有 _isCollectData() 闸,opt-out 之后依然会发。我们自己监听
      // visibilitychange 并在 reportPageHide 里守闸(时长仍由 SDK 在
      // trackPageShowEvent 里打的 timeEvent(page_hide) 计算,口径不变)。
      autoTrack: {
        pageShow: true,
        pageHide: false,
      },
    });

    // 曾经 opt-out 过的设备,localStorage 里的 opt_tracking=false 会在 init 时被读
    // 回来,把上面那条 device_login 挡掉。这里补一次 optInTracking 扳回开关;被挡掉
    // 的只是一条"新增设备"——而这类设备此前必然已经上报过 device_login,新增设备
    // 口径不受影响。
    TapDBAPI.optInTracking();

    sdkInitialized = true;
    applySuperProperties();
    reportActive('app_start');
    log.info(`initialized, region=${CURRENT_CINDY_REGION}, appId=${TAPDB_CONFIG.appId}`);
  } catch (err) {
    // SDK 自身崩溃绝不能影响主流程
    log.error('init failed (non-fatal)', err);
  }
}

/**
 * 把应用版本和平台挂到 super properties,之后每条事件自动带这两个字段。
 *
 * ⚠️ 这两个 key 都不是 SDK preset(SDK preset 只有 #os / #browser / #device_id
 * 等)。属于自定义属性,需要 tapdb 后台预先注册 `#app_version` / `#platform`
 * (string 类型),否则上报数据可能被丢弃。
 *
 * - #app_version:用 Electron 的 app.getVersion(),与 release 版本号严格一致
 * - #platform:用 process.platform('darwin' / 'win32'),比 SDK preset 的
 *   `#os` (userAgent 解析得到的 "Mac OS" / "Windows") 更精准,且和 release
 *   pipeline 用的同一套口径
 */
function applySuperProperties(): void {
  TapDBAPI.setSuperProperties({
    '#app_version': window.electronAPI.appVersion,
    '#platform': window.electronAPI.platform,
  });
}

function reportActive(tag: 'app_start' | 'app_engaged'): void {
  // 先推进节流窗口再上报:即便 pvEvent 抛异常,30 分钟内也不再重试(fire-and-forget,
  // 防止持续输入在 SDK 故障时反复触发)。app_start 同样消耗窗口,避免启动瞬间双发。
  const now = Date.now();
  nextEngagedReportAt = now + ENGAGED_REPORT_INTERVAL_MS;
  engagedDayEndsAt = nextLocalMidnightMs(now);

  // 跨窗口去重(仅 app_engaged;低频路径,localStorage 读写开销无关紧要):
  // 同 origin 全窗口共享上次上报时刻,窗口内且同一天则本窗口静默让位 ——
  // 内存窗口已推进,不重复发。localStorage 不可用时退化为每窗口独立节流。
  // app_start 是窗口生命周期语义,不参与共享去重;setUser 幂等,不做跨窗口协调。
  if (tag === 'app_engaged') {
    try {
      const sharedLast = Number(window.localStorage.getItem(ENGAGED_SHARED_LAST_REPORT_KEY));
      if (
        Number.isFinite(sharedLast) &&
        now - sharedLast < ENGAGED_REPORT_INTERVAL_MS &&
        getLocalDateKey(new Date(sharedLast)) === getLocalDateKey(new Date(now))
      ) {
        // 让位时本窗口的下一次尝试对齐共享窗口终点,而不是从现在顺延满 30 分钟 ——
        // 否则两窗口交替交互会把实际上报间隔拉长到近 60 分钟。
        nextEngagedReportAt = sharedLast + ENGAGED_REPORT_INTERVAL_MS;
        return;
      }
      window.localStorage.setItem(ENGAGED_SHARED_LAST_REPORT_KEY, String(now));
    } catch {
      // localStorage 不可用:退化为每窗口独立节流(原行为)。
    }
  }

  TapDBAPI.pvEvent({ '#tag': tag });
  log.info(`active ${tag}`);

  const today = getLocalDateKey();
  if (currentUserId !== null && lastSetUserDate !== today) {
    reportSetUser(currentUserId, tag, today);
  }
}

function reportSetUser(
  userId: string,
  reason: 'auth_state' | 'app_engaged' | 'app_start',
  dateKey = getLocalDateKey(),
): void {
  TapDBAPI.setUser(userId);
  lastSetUserDate = dateKey;
  log.info(`setUser ${userId} (${reason})`);
}

function getLocalDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** nowMs 所在本地日的下一个午夜(epoch ms)。 */
function nextLocalMidnightMs(nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

export const __testing = {
  reset(): void {
    gateMounted = false;
    sdkInitialized = false;
    reportingAllowed = false;
    sdkAppliedAllowed = null;
    settingsEpoch = 0;
    currentUserId = null;
    lastSetUserDate = null;
    nextEngagedReportAt = 0;
    engagedDayEndsAt = 0;
    engagedReportLockPending = false;
    engagedReportLockAllowsNewDay = false;
    clearWorkingReportTimer();
    unsubscribeWorkingState?.();
    unsubscribeWorkingState = null;
    try {
      window.localStorage.removeItem(ENGAGED_SHARED_LAST_REPORT_KEY);
    } catch {
      // 测试环境无 localStorage 时忽略。
    }
  },
};
