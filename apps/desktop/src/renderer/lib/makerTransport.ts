/**
 * makerTransport —— device-link 透明传输层。
 * ---------------------------------------------------------------------------
 * 让 makerChatStore 的会话操作 / 读取**按 session 来源**自动切换:
 *   - 本地 session(本机 DB)→ 原样走 window.electronAPI.maker / messageService / sessionService
 *   - device-link 远程 session(被控设备)→ 走 deviceLink.invoke(deviceId, channel, args) 隧道
 *
 * 来源判定唯一依据 remoteProjectsStore 的 sessionId→deviceId 注册表(R1 注入)。
 * 上层调用点把 `window.electronAPI.maker` 换成 `makerApiFor(sessionId)`、把
 * `messageService.list/sessionService.get` 换成这里的 `listMessagesFor/getSessionFor`,
 * 其余逻辑零改动 —— 远程会话因此复用同一套 store / reducer / UI。
 *
 * 注意:被控端 handler 抛的 throwIpcError `[CODE] message` 经隧道原样透传为 reject,
 * 上层既有的 extractIpcError / decodeRemoteErrorMessage 继续解码,IPC 错误协议免改。
 */

import {
  getSessionDeviceId,
  remoteProjectsStore,
} from '@/features/device-link/remoteProjectsStore';
import {
  invalidationAtRequestStart,
  persistCachedMessages,
  sessionCacheInvalidationToken,
} from '@/features/device-link/mirrorCacheClient';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import type { Message, Session } from '@/lib/ccAgent.types';
import * as messageService from '@/lib/messageService';
import * as sessionService from '@/lib/sessionService';
import { extractIpcError } from '@/utils/ipcError';

type FullMaker = typeof window.electronAPI.maker;

/**
 * makerChatStore / ChatInput 经传输层调用的会话操作子集。本地直接复用
 * window.electronAPI.maker;远程转 deviceLink.invoke。所有 channel 均在
 * REMOTE_INVOKE_ALLOWLIST 白名单内(被控端执行前还会再校验一层)。
 */
export interface RoutableMaker {
  send: FullMaker['send'];
  setModel: FullMaker['setModel'];
  // session-agent-switch:跨引擎切换是**会话级**操作,数据真相(pending 意图注册表 +
  // 引擎交接)都在会话所在端。远程会话必须隧道到被控端,否则打到控制端本机 maker 上
  // 会因本机无此 session 直接失败。只读入口供重连 / 重开视图后恢复 main 权威意图。
  switchSessionAgent: FullMaker['switchSessionAgent'];
  getSessionAgentSwitchIntent: FullMaker['getSessionAgentSwitchIntent'];
  setEffort: FullMaker['setEffort'];
  setPermissionMode: FullMaker['setPermissionMode'];
  setFastMode: FullMaker['setFastMode'];
  setPlanMode: FullMaker['setPlanMode'];
  resolveInteraction: FullMaker['resolveInteraction'];
  getPendingInteractions: FullMaker['getPendingInteractions'];
  deleteMessage: FullMaker['deleteMessage'];
  // —— 完整对等:会话级功能(fork / rewind / context-usage / extra-dirs / close / orca)——
  // 本地分支返回完整 maker 天然带这些;远程分支在 remoteMakerApi 里逐一隧道映射。
  fork: FullMaker['fork'];
  forkStripEncrypted: FullMaker['forkStripEncrypted'];
  rewindPreview: FullMaker['rewindPreview'];
  rewindCommit: FullMaker['rewindCommit'];
  getContextUsage: FullMaker['getContextUsage'];
  setExtraDirs: FullMaker['setExtraDirs'];
  closeSession: FullMaker['closeSession'];
  enableOrca: FullMaker['enableOrca'];
  disableOrca: FullMaker['disableOrca'];
  input: Pick<
    FullMaker['input'],
    | 'enqueue'
    | 'compact'
    | 'steer'
    | 'stop'
    | 'getProjection'
    | 'setExpanded'
    | 'resume'
    | 'setInteractionLock'
    | 'setEditLock'
    | 'move'
    | 'remove'
    | 'updateText'
    | 'clearError'
    | 'retryLastError'
    | 'clearSession'
    | 'persistTurnErrorDeferred'
  >;
}

function invokeRemote(deviceId: string, channel: string, args: unknown[]): Promise<unknown> {
  return window.electronAPI.deviceLink.invoke(deviceId, channel, args);
}

/** 远程被控设备的 maker 操作适配器:每个方法把入参原样隧道到对应 channel。 */
function remoteMakerApi(deviceId: string): RoutableMaker {
  // 入参顺序与 window.electronAPI.maker.* / maker:* handler 完全一致,原样转发即可。
  const t =
    (channel: string) =>
    (...args: unknown[]): Promise<unknown> =>
      invokeRemote(deviceId, channel, args);
  return {
    send: t('maker:send') as FullMaker['send'],
    setModel: t('maker:set-model') as FullMaker['setModel'],
    switchSessionAgent: t('maker:switch-session-agent') as FullMaker['switchSessionAgent'],
    getSessionAgentSwitchIntent: t(
      'maker:get-session-agent-switch-intent',
    ) as FullMaker['getSessionAgentSwitchIntent'],
    setEffort: t('maker:set-effort') as FullMaker['setEffort'],
    setPermissionMode: t('maker:set-permission-mode') as FullMaker['setPermissionMode'],
    setFastMode: t('maker:set-fast-mode') as FullMaker['setFastMode'],
    setPlanMode: t('maker:set-plan-mode') as FullMaker['setPlanMode'],
    resolveInteraction: t('maker:resolve-interaction') as FullMaker['resolveInteraction'],
    getPendingInteractions: t(
      'maker:get-pending-interactions',
    ) as FullMaker['getPendingInteractions'],
    deleteMessage: t('maker:message:delete') as FullMaker['deleteMessage'],
    fork: t('maker:fork') as FullMaker['fork'],
    forkStripEncrypted: t('maker:fork-strip-encrypted') as FullMaker['forkStripEncrypted'],
    rewindPreview: t('maker:rewind:preview') as FullMaker['rewindPreview'],
    rewindCommit: t('maker:rewind:commit') as FullMaker['rewindCommit'],
    getContextUsage: t('maker:get-context-usage') as FullMaker['getContextUsage'],
    setExtraDirs: t('maker:set-extra-dirs') as FullMaker['setExtraDirs'],
    closeSession: t('maker:close-session') as FullMaker['closeSession'],
    enableOrca: t('maker:session:enable-orca') as FullMaker['enableOrca'],
    disableOrca: t('maker:session:disable-orca') as FullMaker['disableOrca'],
    input: {
      enqueue: t('maker:input:enqueue') as FullMaker['input']['enqueue'],
      compact: t('maker:input:compact') as FullMaker['input']['compact'],
      steer: t('maker:input:steer') as FullMaker['input']['steer'],
      stop: t('maker:input:stop') as FullMaker['input']['stop'],
      getProjection: t('maker:input:get-projection') as FullMaker['input']['getProjection'],
      setExpanded: t('maker:input:set-expanded') as FullMaker['input']['setExpanded'],
      resume: t('maker:input:resume') as FullMaker['input']['resume'],
      setInteractionLock: t(
        'maker:input:set-interaction-lock',
      ) as FullMaker['input']['setInteractionLock'],
      setEditLock: t('maker:input:set-edit-lock') as FullMaker['input']['setEditLock'],
      move: t('maker:input:move') as FullMaker['input']['move'],
      remove: t('maker:input:remove') as FullMaker['input']['remove'],
      updateText: t('maker:input:update-text') as FullMaker['input']['updateText'],
      clearError: t('maker:input:clear-error') as FullMaker['input']['clearError'],
      retryLastError: t('maker:input:retry-last-error') as FullMaker['input']['retryLastError'],
      clearSession: t('maker:input:clear-session') as FullMaker['input']['clearSession'],
      // device-link:auth error 重试失败/放弃时在被控端落库,经隧道路由到被控端 main。
      persistTurnErrorDeferred: t(
        'maker:persist-turn-error-deferred',
      ) as FullMaker['input']['persistTurnErrorDeferred'],
    },
  };
}

/** 已知稳定 deviceId 时直接返回远程 maker 适配器，不重新读取易失 session origin。 */
export function makerApiForDevice(deviceId: string): RoutableMaker {
  return remoteMakerApi(deviceId);
}

/**
 * 按 sessionId 来源返回 maker 操作入口:
 *   - 本地 → 真 window.electronAPI.maker(零开销,行为不变)
 *   - 远程 → 隧道适配器
 */
export function makerApiFor(sessionId: string): RoutableMaker {
  const deviceId = getSessionDeviceId(sessionId);
  return deviceId ? makerApiForDevice(deviceId) : window.electronAPI.maker;
}

/**
 * 粘滞归属版 maker 入口:曾解析到 deviceId 的会话,在 relay 瞬时重连清空注册表的窗口内
 * 仍走隧道,不会退回本机。
 *
 * 用于「误判本机会产生副作用」的 **mutation**(与 isRemoteSessionSticky 同一判据,只是那条
 * 服务于 gating、这条服务于调用)。协同开关就是典型:enableOrca / disableOrca 在瞬断窗口内
 * 被误判成本机,会在**控制端本机**建出或销毁一个 team —— 本机恰好存在同 id 会话时还会操作
 * 错对象,而用户看到的入口(按粘滞 remoteDeviceId 渲染)分明指向被控端(issue #1170 codex P2)。
 *
 * 普通高频操作(send / setModel / …)仍用 makerApiFor:它们本就跟随会话来源的实时判定,
 * 且误判的代价是一次失败重试,不是在错误的机器上留下持久状态。
 */
export function makerApiForSticky(sessionId: string): RoutableMaker {
  const deviceId = getStickySessionDeviceId(sessionId);
  return deviceId ? makerApiForDevice(deviceId) : window.electronAPI.maker;
}

/** 是否远程(device-link)会话。 */
export function isRemoteSession(sessionId: string): boolean {
  return getSessionDeviceId(sessionId) !== undefined;
}

/**
 * 粘滞版远程判定:曾解析到 deviceId 的会话在 relay 瞬时重连清空注册表的窗口内
 * 仍视为远程。用于「误判本机会产生副作用」的 gating(如 Stop 按钮 —— 瞬断窗口
 * 误判本机会放出按钮,点击走本地 stopAgentTask 假成功,任务在被控端继续跑)。
 */
export function isRemoteSessionSticky(sessionId: string): boolean {
  return getStickySessionDeviceId(sessionId) !== undefined;
}

/**
 * 重命名输入框 Magic 按钮:按会话最新对话重生成标题。
 * 远程会话隧道到被控端执行——对话素材与 provider 凭证的数据真相都在被控端;
 * 老被控端无此 channel 时 invoke 以 CHANNEL_NOT_ALLOWED 拒绝,调用方按生成失败提示。
 */
export function regenerateSessionTitleFor(sessionId: string): Promise<{ title: string | null }> {
  const deviceId = getSessionDeviceId(sessionId);
  if (!deviceId) return window.electronAPI.maker.regenerateSessionTitle(sessionId);
  return invokeRemote(deviceId, 'maker:regenerate-title', [{ sessionId }]) as Promise<{
    title: string | null;
  }>;
}

/** 读会话元数据:远程走隧道 local-db:sessions:get(本地 DB 没有该 row,直接调会 404)。 */
export function getSessionFor(sessionId: string): Promise<Session> {
  const deviceId = getSessionDeviceId(sessionId);
  if (!deviceId) return sessionService.get(sessionId);
  return invokeRemote(deviceId, 'local-db:sessions:get', [sessionId]) as Promise<Session>;
}

/**
 * 查被控端某会话的权威 turn 运行态(远程走隧道 maker:session-in-turn)。
 * 控制端 stall 看门狗用:卡死 Generating 但久未收 push 时核实被控端是否真的还在跑——
 * 答 false 才安全收尾,绝不误杀真正在跑的慢 turn。
 * 本机会话不走看门狗 → 直接 resolve(false)(调用方已 gate,这里仅防御)。
 */
export function isSessionTurnRunningFor(sessionId: string): Promise<boolean> {
  const deviceId = getSessionDeviceId(sessionId);
  if (!deviceId) return Promise.resolve(false);
  return invokeRemote(deviceId, 'maker:session-in-turn', [sessionId]) as Promise<boolean>;
}

/**
 * 读历史消息:远程走隧道 local-db:messages:list,返回形状与本地一致(camelCase Message[])。
 *
 * 远程会话取回**最新一页**(没有 before / beforeTs 游标)时顺手写进冷缓存
 * (`mirrorCacheClient`),供下次冷启动 / 被控端离线时乐观渲染。这是缓存的**唯一写点**:
 * 首拉、reconcileRemoteMessages、reconnect 重拉、turn 结束对账都经过这里,所以缓存
 * 自然跟着最近一次对账保持新鲜。翻页(before/beforeTs)与本机会话都不写 ——
 * 老窗口不是"最近一页",写进去会让下次冷开 hydrate 出一段历史中间的孤岛。
 */
export function listMessagesFor(
  sessionId: string,
  opts?: { limit?: number; before?: string; beforeTs?: number },
): Promise<Message[]> {
  const deviceId = getSessionDeviceId(sessionId);
  if (!deviceId) return messageService.list(sessionId, opts);
  const promise = invokeRemote(deviceId, 'local-db:messages:list', [sessionId, opts]) as Promise<
    Message[]
  >;
  if (!opts?.before && opts?.beforeTs == null) {
    // 发起时的作废令牌:/clear、rewind、删消息都会自增它(见 clearCachedMessages)。
    const invalidationAtStart = sessionCacheInvalidationToken(sessionId);
    // 同时记下 main 侧的会话级作废计数(跨窗口 / 跨进程可见);落盘时交给 main 比对。
    // 还没有已知值时**在这里**(与远端请求同时)补读一次 —— main 拒绝没带令牌的非空写入,
    // 而补读若拖到落盘前做,拿到的是清理之后的值,屏障就失效了(见 invalidationAtRequestStart)。
    const mainInvalidationAtStart = invalidationAtRequestStart(deviceId, sessionId);
    void promise
      .then((rows) => {
        if (!Array.isArray(rows)) return;
        // 请求在途期间权威侧作废过这个会话的历史 → 手里这批是作废前的行,丢弃这次写,
        // 否则它会排在那次空写之后落地,把已被清掉的正文重新写回盘上(review: pr-code-review)。
        if (sessionCacheInvalidationToken(sessionId) !== invalidationAtStart) return;
        // 请求在途期间这台设备可能已被撤销 / 关闭被控 / 本机停用控制,那条路径已经
        // clearCachedDevice 清过盘了。迟到的响应若照写,会用清理**之后**的 main 代际
        // 把被撤销对端的明文重新落盘,main 侧的作废闸挡不住它(review: codex P1)。
        // 落盘前重核归属:mapping 已经不在(或已换设备)就直接丢弃这次写入。
        if (getSessionDeviceId(sessionId) !== deviceId) return;
        // 把"我取到内容时 main 侧的会话级作废计数"一起交上去:main 会再比对一次,于是
        // **另一个窗口 / 另一个进程**的作废也能挡住这次写(renderer 令牌只在本进程内可见)。
        persistCachedMessages(deviceId, sessionId, rows, mainInvalidationAtStart);
      })
      // 拉取失败由调用方处理;这里只是不写缓存(旧缓存保留,离线时正好还能用)。
      .catch(() => undefined);
  }
  return promise;
}

// 已确认不支持 maker:get-workflow-progress 的被控设备(收到过 CHANNEL_NOT_ALLOWED):
// 短路一段时间不再空耗隧道往返。带 TTL 而非进程级永久 —— deviceId 跨升级稳定,
// 被控端升级到支持版本后负缓存到期自动重探,无需重启控制端。
const WORKFLOW_PROGRESS_UNSUPPORTED_TTL_MS = 10 * 60 * 1000;
const workflowProgressUnsupportedUntil = new Map<string, number>();

/**
 * workflow 逐 agent 进度树(只读,best-effort):记录文件真相在会话归属端 HOME,
 * 远程会话必须隧道到被控端读(控制端本机读必落空)。老被控端无此 channel →
 * CHANNEL_NOT_ALLOWED → 记入带 TTL 的短路表;其余错误一律返回 null,调用方回退
 * workflow 级卡片。
 */
export function getWorkflowProgressFor(
  sessionId: string,
  taskId: string,
): Promise<import('../../shared/workflow-progress').WorkflowProgress | null> {
  // 粘滞归属(与 listSessionBackgroundTasksFor 同款):relay 瞬时重连清空注册表的
  // 窗口内误判本机会在本地读必空,且详情视图不会因归属恢复而重试。
  const deviceId = getStickySessionDeviceId(sessionId);
  if (!deviceId) return window.electronAPI.maker.getWorkflowProgress(sessionId, taskId);
  const blockedUntil = workflowProgressUnsupportedUntil.get(deviceId);
  if (blockedUntil !== undefined && blockedUntil > Date.now()) return Promise.resolve(null);
  return (
    invokeRemote(deviceId, 'maker:get-workflow-progress', [sessionId, taskId]) as Promise<
      import('../../shared/workflow-progress').WorkflowProgress | null
    >
  ).catch((err) => {
    if (extractIpcError(err)?.code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED') {
      workflowProgressUnsupportedUntil.set(
        deviceId,
        Date.now() + WORKFLOW_PROGRESS_UNSUPPORTED_TTL_MS,
      );
    }
    return null;
  });
}

/**
 * 会话仍在运行的后台任务快照(只读,best-effort):后台任务面板挂载时补回
 * 「订阅前已启动 / 重载清空 taskUpdates 后」的存量任务。远程会话任务真身在
 * 被控端,必须隧道读(控制端 main 无该会话 handle,本机读必空);老被控端无此
 * channel 或隧道失败一律降级空表,面板退化为事件流 + 消息扫描两源。
 * 归属用粘滞解析(与 estimatedSessionValueFor 同款):这是一次性水合,relay
 * 瞬时重连清空注册表的窗口内若误判为本机,会 seed 一张空表且面板不重试。
 */
export function listSessionBackgroundTasksFor(
  sessionId: string,
): ReturnType<typeof window.electronAPI.maker.listSessionBackgroundTasks> {
  const deviceId = getStickySessionDeviceId(sessionId);
  if (!deviceId) return window.electronAPI.maker.listSessionBackgroundTasks(sessionId);
  return (
    invokeRemote(deviceId, 'maker:session-background-tasks:list', [sessionId]) as ReturnType<
      typeof window.electronAPI.maker.listSessionBackgroundTasks
    >
  ).catch(() => ({ tasks: [] }));
}

/**
 * 订阅形态会话「本会话价值」历史汇总:远程走隧道(否则查控制端空库恒为 0,底部 $ chip
 * 的历史初值永远缺失)。归属用粘滞解析(relay 瞬时重连清空注册表的窗口内不误判为本机,
 * 与 goal/learn 链路同款);老被控端无此 channel → CHANNEL_NOT_ALLOWED,调用方 catch
 * 后退化为只显示已加载消息 + 实时推送的部分值。
 */
export function estimatedSessionValueFor(sessionId: string): Promise<{
  totalValueMoney?: import('../../shared/regionalMoney').RegionalMoney | null;
  totalValueUsd?: number;
  entries: Array<{
    clientId: string;
    money?: import('../../shared/regionalMoney').RegionalMoney;
    costUsd?: number;
    turnUsageDetails?: unknown;
  }>;
}> {
  const deviceId = getStickySessionDeviceId(sessionId);
  if (!deviceId) return messageService.estimatedSessionValue(sessionId);
  return invokeRemote(deviceId, 'local-db:messages:estimatedSessionValue', [
    sessionId,
  ]) as ReturnType<typeof estimatedSessionValueFor>;
}

/**
 * 插件启停状态(只读):**按目标设备**读项目级 / 用户级 collab 等开关。
 *
 * device-link 会话与草稿的 workingDir 是**被控端**机器上的路径,拿它在控制端本机查
 * `.cindy/plugins.json` 读到的是控制端自己的用户级开关 —— 与被控端 main 的权威授权
 * (assertCollabProjectEnabled)可能相反,于是入口看得见却开不起来(issue #1170)。
 * 所以这里按 deviceId 分流:本机 → 真 IPC;远程 → 隧道到被控端读它自己的真相。
 *
 * 路径归一化由调用方在控制端完成:normalizeWorkingDirForProjectSettings 是纯路径形态
 * 推导(不依赖 process.platform / 本机 userData),跨 macOS ↔ Windows 控制同样成立。
 *
 * 老被控端未收录该 channel 时隧道回 DEVICE_LINK_CHANNEL_NOT_ALLOWED,调用方据此
 * fail-closed 置灰入口并说明「设备版本过旧」,不会放行到 enableOrca 才撞错。
 */
export function pluginEnableStateFor(
  deviceId: string | null | undefined,
  pluginId: string,
  workingDir?: string,
): ReturnType<typeof window.electronAPI.maker.plugins.getState> {
  if (!deviceId) return window.electronAPI.maker.plugins.getState(pluginId, workingDir);
  return invokeRemote(deviceId, 'maker:plugins:get-state', [pluginId, workingDir]) as ReturnType<
    typeof window.electronAPI.maker.plugins.getState
  >;
}

/** 会话内搜索跳转定位:远程走隧道 local-db:messages:around(否则查控制端空库,跳转必失败)。 */
export function aroundMessagesFor(
  sessionId: string,
  messageId: string,
  opts?: { radius?: number },
): Promise<Message[]> {
  const deviceId = getSessionDeviceId(sessionId);
  if (!deviceId) return messageService.around(sessionId, messageId, opts);
  return invokeRemote(deviceId, 'local-db:messages:around', [
    sessionId,
    messageId,
    opts,
  ]) as Promise<Message[]>;
}

/**
 * error-tail-banner「关闭/忽略」:按会话来源路由 dismiss-error(main 侧 merge
 * dismissed:true)。远程会话必须写到被控端 DB —— 只改控制端内存的话,重连 /
 * 历史重拉 / 重启后错误行的 dismissed 仍为空,红条会复活(review P2)。
 * 老被控端未收录该 channel 时隧道回 CHANNEL_NOT_ALLOWED,调用方 catch 后
 * 退化为本视图内存隐藏。
 */
export function dismissErrorMessageFor(sessionId: string, clientId: string): Promise<unknown> {
  const deviceId = getSessionDeviceId(sessionId);
  if (!deviceId) return messageService.dismissError(sessionId, clientId);
  return invokeRemote(deviceId, 'local-db:messages:dismiss-error', [sessionId, clientId]);
}

/** 消息删除：user 只删目标行，assistant 删除所属整轮输出。 */
export interface MessageDeletionResult {
  sessionId: string;
  clientId: string;
  /** 老被控端只回 clientId；新 host 返回本次原子删除的完整范围。 */
  clientIds?: string[];
}

export function deleteMessageFor(
  sessionId: string,
  clientId: string,
): Promise<MessageDeletionResult> {
  const deviceId = getSessionDeviceId(sessionId);
  if (!deviceId) return window.electronAPI.maker.deleteMessage(sessionId, clientId);
  return invokeRemote(deviceId, 'maker:message:delete', [
    sessionId,
    clientId,
  ]) as Promise<MessageDeletionResult>;
}

/** interrupted-turn-resume:中断提示「忽略」的显式确认(写一次 last_turn_ended_at),
 *  远程会话经隧道落被控端 DB;老被控端 CHANNEL_NOT_ALLOWED 由调用方吞错降级。
 *  「继续任务」主路径在执行端 main 的 onDispatchedUserTurn 里 durable ack
 *  （排队阶段不 ack，便于取消后恢复横幅）；session 行缺失走 direct-send 兜底时，
 *  ack 由执行端 maker:send 事务在 accepted 后完成，本函数只服务显式「忽略」。 */
export function ackInterruptedTurnFor(sessionId: string): Promise<unknown> {
  const deviceId = getSessionDeviceId(sessionId);
  if (!deviceId) return window.electronAPI.localDb.sessions.ackInterrupted(sessionId);
  return invokeRemote(deviceId, 'local-db:sessions:ack-interrupted', [sessionId]);
}

/** fork 来源定位:forkedAtMessageId 存的是 clientId,远程同样走被控端 DB。 */
export function aroundMessagesByClientIdFor(
  sessionId: string,
  clientId: string,
  opts?: { radius?: number },
): Promise<Message[]> {
  const deviceId = getSessionDeviceId(sessionId);
  if (!deviceId) return messageService.aroundClientId(sessionId, clientId, opts);
  return invokeRemote(deviceId, 'local-db:messages:around-client-id', [
    sessionId,
    clientId,
    opts,
  ]) as Promise<Message[]>;
}

// ─── /goal:device-link 远程路由 ────────────────────────────────────────────────
// goal-host 在「会话归属设备」上跑(目标随会话在被控端自主续跑,控制端断链不中断)。
// GoalIndicator / NewGoalDialog / useGoalStatus 经这里按会话来源路由;状态推送
// (maker:goal:status-changed,带 sessionId → session:<id> topic)经 subscribeGoalStatusChanged。
// 归属解析是**惰性 + 粘滞**的(Codex review #548,learnTransport 同款):不在构造时
// 快照(origin 注入前会钉死在本机),解析到过 deviceId 后不因 relay 重连清镜像而降级回本机。

type FullGoalMaker = Pick<
  FullMaker,
  'setGoal' | 'clearGoal' | 'pauseGoal' | 'resumeGoal' | 'updateGoal' | 'getGoalStatus'
>;

/** goal 操作的可路由子集(订阅另走 subscribeGoalStatusChanged)。 */
export type RoutableGoal = FullGoalMaker;

// goal 归属解析:粘滞状态在模块级缓存(stickySessionOrigin),跨适配器重建 /
// effect 重跑存活 —— relay 重连清镜像触发的重建不会丢掉归属。

/**
 * 按会话来源返回 goal 操作入口:本机 → 真 window.electronAPI.maker;远程 → 隧道到
 * 归属设备(channel/args 与 preload goal 块逐一对齐;updateGoal 在 preload 里把位置参
 * 打包成 { sessionId, patch },这里同样打包)。每次方法调用时重新解析归属。
 */
export function goalApiFor(sessionId: string): RoutableGoal {
  const resolve = () => getStickySessionDeviceId(sessionId);
  const t =
    (channel: string, local: (...args: never[]) => unknown) =>
    (...args: unknown[]): Promise<unknown> => {
      const deviceId = resolve();
      if (!deviceId) return Promise.resolve(local(...(args as never[])));
      return invokeRemote(deviceId, channel, args);
    };
  const localApi = window.electronAPI.maker;
  return {
    setGoal: t('maker:goal:set', localApi.setGoal) as FullMaker['setGoal'],
    clearGoal: t('maker:goal:clear', localApi.clearGoal) as FullMaker['clearGoal'],
    pauseGoal: t('maker:goal:pause', localApi.pauseGoal) as FullMaker['pauseGoal'],
    resumeGoal: t('maker:goal:resume', localApi.resumeGoal) as FullMaker['resumeGoal'],
    updateGoal: ((sid: string, patch: unknown) => {
      const deviceId = resolve();
      if (!deviceId)
        return localApi.updateGoal(sid, patch as Parameters<FullMaker['updateGoal']>[1]);
      return invokeRemote(deviceId, 'maker:goal:update', [{ sessionId: sid, patch }]);
    }) as FullMaker['updateGoal'],
    getGoalStatus: t('maker:goal:get-status', localApi.getGoalStatus) as FullMaker['getGoalStatus'],
  };
}

/**
 * 订阅某会话的 goal 状态变化(payload = { sessionId, goal }):
 *  - 本机会话 → 本机 onGoalStatusChanged IPC(按 sessionId 过滤);
 *  - 远程会话 → device-link 远程推送(被控端 maker:goal:status-changed 经
 *    session:<id> topic 转发;打开该会话视图即已订阅),按 deviceId + sessionId 过滤。
 * 归属在订阅期间可能变化(origin 注入 / 重连恢复)—— 内部监听 remoteProjectsStore,
 * 解析结果变化时自动拆旧绑新。返回 unsubscribe。
 */
export function subscribeGoalStatusChanged(
  sessionId: string,
  cb: (payload: { sessionId: string; goal: GoalStatusPayload | null }) => void,
): () => void {
  const resolve = () => getStickySessionDeviceId(sessionId);

  const bind = (deviceId: string | undefined): (() => void) => {
    if (!deviceId) {
      return window.electronAPI.maker.onGoalStatusChanged((payload) => {
        if (payload.sessionId !== sessionId) return;
        cb(payload);
      });
    }
    return (
      window.electronAPI.deviceLink?.onRemotePush?.((push) => {
        if (push.deviceId !== deviceId || push.channel !== 'maker:goal:status-changed') return;
        const payload = push.payload as { sessionId?: string; goal?: GoalStatusPayload | null };
        if (payload?.sessionId !== sessionId) return;
        cb(payload as { sessionId: string; goal: GoalStatusPayload | null });
      }) ?? (() => {})
    );
  };

  let current = resolve();
  let offInner = bind(current);
  const offStore = remoteProjectsStore.subscribe(() => {
    const next = resolve();
    if (next === current) return;
    current = next;
    offInner();
    offInner = bind(next);
  });
  return () => {
    offStore();
    offInner();
  };
}

// ─── orca 团队读 / 管理:device-link 远程路由 ───────────────────────────────────
// 远程会话开协同:worker session 真身在被控端,控制端纯镜像。团队读模型(get-by-lead /
// list-workers-by-lead / get-by-worker-session)与管理动作(create/switch/idle/archive/end-team)
// 都按 ctx session 的来源路由——本机原样走 localDb.orcaWorkflows,远程隧道到被控端。

type FullOrca = typeof window.electronAPI.localDb.orcaWorkflows;

/**
 * orca 读/管理的可路由子集(排除 onOrcaWorkerChanged 订阅,见 subscribeOrcaWorkerChanged)。
 * 只列「确有远程调用方 + channel 在 REMOTE_INVOKE_ALLOWLIST 内」的方法。刻意不暴露
 * updateWorkerStatus / setCollaborationSetting:它们无远程调用方,且对应 channel 不在
 * allowlist(远程调会 CHANNEL_NOT_ALLOWED)。Team / Worker 创建只能走 maker lifecycle
 * IPC，以便 Main 在写入前执行实时项目策略授权。
 * makerTransportOrcaRouting.test.ts 有 drift 守卫:适配器里每个 channel 串都必须在 allowlist 内。
 */
export interface RoutableOrcaWorkflows {
  getByLeadSession: FullOrca['getByLeadSession'];
  getByWorkerSession: FullOrca['getByWorkerSession'];
  listWorkersByLead: FullOrca['listWorkersByLead'];
  createWorker: FullOrca['createWorker'];
  switchFocus: FullOrca['switchFocus'];
  idleWorker: FullOrca['idleWorker'];
  archiveWorker: FullOrca['archiveWorker'];
  endTeam: FullOrca['endTeam'];
  getCollaborationSettings: FullOrca['getCollaborationSettings'];
}

/**
 * 远程被控设备的 orca 适配器:每个方法把入参隧道到对应 channel,channel/args 与 preload 的
 * orcaWorkflows 块逐一对齐。多数方法 preload 直接把入参透传给 invoke(故通用 t 转发即可);
 * idle/archive 在 preload 里把位置参打包成单对象,这里同样打包后再隧道。
 * 仅暴露 allowlist 内、确有远程调用方的方法(见 RoutableOrcaWorkflows 注释)。
 */
function remoteOrcaWorkflows(deviceId: string): RoutableOrcaWorkflows {
  const t =
    (channel: string) =>
    (...args: unknown[]): Promise<unknown> =>
      invokeRemote(deviceId, channel, args);
  return {
    getByLeadSession: t('local-db:orca-workflows:get-by-lead') as FullOrca['getByLeadSession'],
    getByWorkerSession: t(
      'local-db:orca-workflows:get-by-worker-session',
    ) as FullOrca['getByWorkerSession'],
    listWorkersByLead: t(
      'local-db:orca-workflows:list-workers-by-lead',
    ) as FullOrca['listWorkersByLead'],
    createWorker: t('maker:worker:create') as FullOrca['createWorker'],
    switchFocus: t('maker:worker:switch-focus') as FullOrca['switchFocus'],
    idleWorker: ((leadSessionId: string, workerId: string, expectedStatus?: 'done') => {
      if (expectedStatus === 'done') {
        return invokeRemote(deviceId, 'maker:worker:acknowledge-done', [
          { leadSessionId, workerId },
        ]);
      }
      return invokeRemote(deviceId, 'maker:worker:idle', [
        {
          leadSessionId,
          workerId,
          ...(expectedStatus ? { expectedStatus } : {}),
        },
      ]);
    }) as FullOrca['idleWorker'],
    archiveWorker: ((leadSessionId: string, workerId: string) =>
      invokeRemote(deviceId, 'maker:worker:archive', [
        { leadSessionId, workerId },
      ])) as FullOrca['archiveWorker'],
    endTeam: t('maker:team:end') as FullOrca['endTeam'],
    getCollaborationSettings: t(
      'maker:collaboration-settings:get',
    ) as FullOrca['getCollaborationSettings'],
  };
}

/**
 * 按 ctx session 来源返回 orca 操作入口:本机 → 真 window.electronAPI.localDb.orcaWorkflows;
 * 远程 → 隧道适配器。lead 相关方法传 leadSessionId 作 ctx;getByWorkerSession 传 workerSessionId
 * 作 ctx(reseed 后 worker sessionId 已注册到被控端 deviceId)。
 */
export function orcaWorkflowsFor(contextSessionId: string): RoutableOrcaWorkflows {
  const deviceId = getSessionDeviceId(contextSessionId);
  return deviceId ? remoteOrcaWorkflows(deviceId) : window.electronAPI.localDb.orcaWorkflows;
}

/**
 * 已知稳定 deviceId 时直接返回远程 orca 适配器,不重新读取易失的 session origin
 * (与 makerApiForDevice 同款)。用于「调用方手里已经握着权威 deviceId」的场景 ——
 * 例如刚在该被控端建出会话、要回查它的权威团队终态。
 */
export function orcaWorkflowsForDevice(deviceId: string): RoutableOrcaWorkflows {
  return remoteOrcaWorkflows(deviceId);
}

/**
 * 订阅某 lead 的 orca worker 变更并在变更时回调:
 *   - 本机 lead → 本机 `onOrcaWorkerChanged` IPC(按 leadSessionId 过滤)。
 *   - 远程 lead → device-link 远程推送(被控端 `maker:orca:worker-changed` 经隧道转发;
 *     前提是该 lead 会话已订阅 `session:<leadId>` 重 topic,即 orca lead 视图已打开)。
 * 返回 unsubscribe。
 */
export function subscribeOrcaWorkerChanged(leadSessionId: string, cb: () => void): () => void {
  const deviceId = getSessionDeviceId(leadSessionId);
  if (!deviceId) {
    return (
      window.electronAPI.localDb.orcaWorkflows.onOrcaWorkerChanged?.((payload: unknown) => {
        if ((payload as { leadSessionId?: string })?.leadSessionId === leadSessionId) cb();
      }) ?? (() => {})
    );
  }
  return (
    window.electronAPI.deviceLink?.onRemotePush?.((push) => {
      if (
        push.channel === 'maker:orca:worker-changed' &&
        (push.payload as { leadSessionId?: string })?.leadSessionId === leadSessionId
      ) {
        cb();
      }
    }) ?? (() => {})
  );
}
