/**
 * pending-alert-attention:错误红点的**派生**真源。
 *
 * 语义(2026-07 统一决策,取代此前的「未读」模型):红点不是可独立清除的已读标记,
 * 而是「未处理告警」集合的投影 —— 只要输入框上方的红色横幅还在(没被继续 / 重试 /
 * 关闭处置掉),列表红点就一直在。不存在「看到了但没处理」这个中间态。
 *
 * 此前的模型是:banner 在视图里聚焦驻留 1.5s(useErrorReadAck)或干脆 mount 即
 * explicit 清点,于是「红点已灭、横幅仍在」—— 用户反馈的割裂点。现在展示不再产生
 * 已读,只有处置才收敛。
 *
 * 数据源是 main 侧纯 DB 查询,因此对**未打开的会话同样成立** —— 这是把红点从
 * renderer 内存态改为派生态的前提。makerChatStore 的 live error 有两个不可靠处
 * (LRU 驱逐、错误落库后主动清 live error),单靠它红点会在横幅仍在时消失。
 *
 * ⚠️ 两条腿的消费周期**必须分开**(PR #879 review P1):
 *  - **中断腿**(interruptedPending):一次性语义 —— 中断是「上一个进程留下的未收尾
 *    turn」,只增不减(用户 ack 后永久消失),所以只在启动首拉一次,清除靠
 *    sessions:patched 里的 lastTurnEndedAt(用户点「继续 / 忽略」、其它窗口或
 *    device-link 控制端的 ack)。查询本身带 startedAt < bootAt 守卫,即使被运行时
 *    调用也不会把正在跑的 turn 算进来。
 *  - **错误尾行腿**(errorTailPending):参与每轮重算。它与 turn 是否在跑无关 ——
 *    turn 一跑起来就插入新的 user 行,error 行不再是尾行,自然不命中。
 *
 * 两个账本因此独立:重算只差分错误尾行那本,不会顺手清掉中断点。
 *
 * 重算触发点(全量重查 + 差分,不做增量推断):
 *  - 错误行落库脏信号(local-db:session:error-persisted)—— 正是 makerChatStore 清掉
 *    live error 的同一个信号,交接窗口红点不掉;
 *  - refreshPendingAlerts() 显式调用 —— 横幅处置(dismiss / 继续 / 批量已读)后触发。
 *
 * 打点范围限定:只清**本 hook 自己打过**且当前仍是 'error' 的点,不误伤 live error、
 * done、awaiting 等其它来源。
 *
 * 模块级单例:sidebar 可能重挂载(路由切换),窗口生命周期内只首拉一次。
 */

import { useEffect } from 'react';
import { isDataOwnerPushCurrent } from '@/contexts/dataOwnerGeneration';
import {
  addSessionAttention,
  clearSessionAttention,
  getSessionAttentionKind,
} from '../lib/sessionAttentionStore';
import { createLogger } from '../lib/logger';

const log = createLogger('pending-alert-attention');

const MAX_INITIAL_ATTEMPTS = 5;
let _startedThisWindow = false;
/** 启动首拉打的**中断**点 —— 只由 lastTurnEndedAt patch 清除,不参与周期性重算。 */
const _interruptedOwned = new Set<string>();
/** 上一轮**错误尾行**查询命中的会话 —— 用于差分出「告警已消失」的清点范围,
 *  不作为「是否需要打点」的短路依据(见 reconcileErrorTail 的无条件重打点)。 */
const _errorTailOwned = new Set<string>();
/** 重查合流:进行中再来请求只置脏,完成后补跑一次(避免 turn 起落时打爆 IPC)。 */
let _refreshInFlight: Promise<void> | null = null;
let _refreshDirty = false;
/**
 * 查询代数:每次发起查询自增。首拉(带退避重试,不经合流)与重算可能并发,较早开始
 * 的查询若后返回,会用过期结果重新添加已处置会话的红点、或清掉刚产生的告警点。
 *
 * 丢弃判定用的是 _appliedGen(**已成功应用**的最大代)而不是 _queryGen:只有当更新的
 * 查询真的成功并应用了结果,旧结果才算过期。否则「更新的查询失败 + 旧结果被丢弃」
 * 会两边落空 —— 首拉自身已 resolve 不会重试,错误尾行会话就一直没有红点
 * (PR #879 review P1)。
 */
let _queryGen = 0;
let _appliedGen = 0;
/** bootstrap 窗口内收到的中断 ack —— 防止首拉用过期结果把已处置的中断重新打上点。
 *  首拉应用完中断腿后即清空(此后 ack 直接走 _interruptedOwned)。 */
const _interruptedAckedEarly = new Set<string>();

/** 测试专用:重置单例守卫与打点账本。 */
export function _resetPendingAlertAttentionForTests(): void {
  _startedThisWindow = false;
  _interruptedOwned.clear();
  _errorTailOwned.clear();
  _interruptedAckedEarly.clear();
  _refreshInFlight = null;
  _refreshDirty = false;
  _queryGen = 0;
  _appliedGen = 0;
}

/** 打点:无条件调用(store 幂等),让被别的 explicit 路径清掉的点能重新建立。 */
function markAlert(sessionId: string): void {
  addSessionAttention(sessionId, 'error');
}

/** 清点:只清仍是 'error' 的 —— 会话可能已升级成 awaiting / done,那是别的语义。 */
function clearAlertIfStillError(sessionId: string): void {
  if (getSessionAttentionKind(sessionId) !== 'error') return;
  clearSessionAttention(sessionId, { intent: 'explicit' });
}

/**
 * 重算**错误尾行**告警并收敛红点。中断腿不参与(见文件头 ⚠️)。
 * 已被更新结果取代的过期数据整个丢弃,不打点也不清点(判定见 _appliedGen)。
 */
async function reconcileErrorTail(): Promise<void> {
  const gen = ++_queryGen;
  const ids = await window.electronAPI.localDb.sessions.errorTailPending();
  // 只有更新的查询**已成功应用**才作废本次结果(见 _appliedGen 注释)。
  if (gen < _appliedGen) return;
  _appliedGen = gen;
  const next = new Set(ids);

  // 无条件重打点,不做「已 owned 就跳过」的短路:红点是查询结果的投影,每次重算都要
  // 对齐。别的 explicit 路径(Retry / 关闭 live ErrorBanner / turn 启动的 orphan 清理 /
  // worktree 横幅处置)会清掉共享的 attention 条目,若这里短路跳过,未 dismissed 的
  // 横幅仍在而红点再也不会回来 —— 正是本次要消灭的割裂。addSessionAttention 自身幂等
  // (kind 未变时直接 return,不 emit、不发 IPC),所以无额外开销。
  for (const id of next) {
    _errorTailOwned.add(id);
    markAlert(id);
  }

  // 中断腿仍认领的会话也重新打点。中断点不参与本轮差分(它是 startup-only 的一次性
  // 结果,只由 lastTurnEndedAt patch 收敛),但它和错误尾行共享同一条 attention
  // 条目 —— 别的 explicit 路径(worktree 横幅处置、Retry 等)清掉那条条目后,只重查
  // 错误尾行是恢复不了中断红点的,中断横幅仍在而红点消失(PR #879 review P1)。
  for (const id of _interruptedOwned) markAlert(id);

  for (const id of [..._errorTailOwned]) {
    if (next.has(id)) continue;
    _errorTailOwned.delete(id);
    // 中断腿仍认领的会话不清:它的告警还没被处置,只是不在错误尾行结果里。
    if (_interruptedOwned.has(id)) continue;
    clearAlertIfStillError(id);
  }
}

/**
 * 重算未处理告警并收敛红点。返回的 promise 在本次(含合流补跑)收敛完成后 resolve;
 * 生产调用点一律 fire-and-forget,返回值只服务测试的确定性等待。
 *
 * 失败(localDb 未 ready / IPC reject)只落日志,**绝不**把「查不到结果」当成
 * 「告警都消失了」去清点 —— 那会让红点在数据库抖动时集体消失。
 */
export function refreshPendingAlerts(): Promise<void> {
  if (_refreshInFlight) {
    _refreshDirty = true;
    return _refreshInFlight;
  }
  const run = reconcileErrorTail()
    .catch((err) => {
      log.warn('error-tail refresh failed:', err);
    })
    .then(() => {
      _refreshInFlight = null;
      if (_refreshDirty) {
        _refreshDirty = false;
        return refreshPendingAlerts();
      }
      return undefined;
    });
  _refreshInFlight = run;
  return run;
}

/**
 * 中断 ack 到达(本窗口 / 其它窗口 / device-link 控制端写了 lastTurnEndedAt)。
 * 也记进 _interruptedAckedEarly:ack 可能早于首拉返回,那时 _interruptedOwned 还是空的,
 * 若不记下来,首拉会把这个已被处置的中断重新打上点(窄但真实的 bootstrap 竞态)。
 */
function noteInterruptedAck(sessionId: string): void {
  _interruptedAckedEarly.add(sessionId);
  if (!_interruptedOwned.delete(sessionId)) return;
  // 错误尾行腿仍认领时不清:同一会话可能同时停在未 dismissed 的错误行上。
  if (_errorTailOwned.has(sessionId)) return;
  clearAlertIfStillError(sessionId);
}

/** 启动首拉:中断腿 + 错误尾行腿各拉一次,分别记账。 */
async function initialFetch(): Promise<void> {
  const gen = ++_queryGen;
  const sessions = window.electronAPI.localDb.sessions;
  const [interrupted, errorTail] = await Promise.all([
    sessions.interruptedPending(),
    sessions.errorTailPending(),
  ]);
  // 中断腿**不受代数守卫**:它是 startup-only 的一次性结果,没有「更新的版本」会
  // 取代它。若跟着错误尾行一起被丢弃,这个窗口内的中断会话就永远拿不到红点了
  // (PR #879 review P1)。期间已被 ack 的除外。
  for (const id of interrupted) {
    if (_interruptedAckedEarly.has(id)) continue;
    _interruptedOwned.add(id);
    markAlert(id);
  }
  _interruptedAckedEarly.clear();
  // 错误尾行受代数守卫:仅当更晚的重算**已成功应用**结果时才跳过(见 _appliedGen)。
  if (gen < _appliedGen) return;
  _appliedGen = gen;
  for (const id of errorTail) {
    _errorTailOwned.add(id);
    markAlert(id);
  }
  const total = new Set([...interrupted, ...errorTail]).size;
  if (total > 0) log.info(`marked ${total} session(s) with pending alerts`);
}

export function usePendingAlertAttention(): void {
  useEffect(() => {
    if (_startedThisWindow) return;
    _startedThisWindow = true;
    // 首拉带线性退避重试(2s / 4s / 6s / 8s):localDb 在登录后才 ready,过早会被
    // handler reject。走 initialFetch 而非 refreshPendingAlerts —— 需要看到真实
    // reject 才能决定是否重试;并发安全由 _queryGen 保证(过期结果整个丢弃)。
    const tryFetch = (attempt: number): void => {
      initialFetch().catch((err) => {
        if (attempt >= MAX_INITIAL_ATTEMPTS) {
          log.warn('pending-alerts initial fetch gave up:', err);
          return;
        }
        setTimeout(() => tryFetch(attempt + 1), 2000 * attempt);
      });
    };
    tryFetch(1);
  }, []);

  // 中断提示的 ack(本窗口 / 其它窗口 / device-link 控制端)会写 lastTurnEndedAt
  // 并广播 patch —— 中断点据此收敛。不重跑中断查询(那会误判运行中的会话)。
  useEffect(() => {
    const sessionsPush = window.electronAPI?.localDb?.sessionsPush;
    if (!sessionsPush) return;
    return sessionsPush.onPatched(({ sessionId, patch }, ownerStamp) => {
      if (!isDataOwnerPushCurrent(ownerStamp)) return;
      if (patch && typeof patch === 'object' && 'lastTurnEndedAt' in patch) {
        noteInterruptedAck(sessionId);
      }
    });
  }, []);

  // 错误行落库脏信号:makerChatStore 用同一个信号清掉 live error(会话不在活跃视图
  // 时),此刻持久化尾行接管红点 —— 必须在同一拍重算,否则交接窗口红点会掉。
  useEffect(() => {
    const onErrorPersisted = window.electronAPI?.localDb?.messages?.onErrorPersisted;
    if (!onErrorPersisted) return;
    return onErrorPersisted((_payload, ownerStamp) => {
      if (!isDataOwnerPushCurrent(ownerStamp)) return;
      void refreshPendingAlerts();
    });
  }, []);

  // error 行的**更新**广播(peer 收敛):另一个窗口 / device-link 端点点「忽略」时,
  // dismissErrorMessage 会把 merge 后的行经 messages:created 广播出去,peer 的横幅
  // 据此即时熄灭 —— 但 error-persisted 只在错误**首次落库**时发,peer 的红点因此会
  // 一直残留到某个无关的重算(PR #879 review P1)。这里按 role 过滤后重算,把
  // dismiss / 新错误行两种情况都收敛掉;非 error 行不触发,避免每条消息都查一次库。
  useEffect(() => {
    const onCreated = window.electronAPI?.localDb?.messages?.onCreated;
    if (!onCreated) return;
    return onCreated(({ message }, ownerStamp) => {
      if (!isDataOwnerPushCurrent(ownerStamp)) return;
      if (message?.role === 'error') void refreshPendingAlerts();
    });
  }, []);
}
