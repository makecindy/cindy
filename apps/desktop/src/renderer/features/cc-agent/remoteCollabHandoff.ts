/**
 * remoteCollabHandoff —— device-link 远程会话**开启协同**的执行与终态判定(issue #1170)。
 * ---------------------------------------------------------------------------
 * device-link 项目的 Lead / Worker / team 真身都在被控端,控制端只是镜像。围绕
 * 「草稿开了协同」这件事,三轮 review 收敛出两条方向相反的时序约束:
 *
 *   ① **首轮必须排在协同之后** —— 否则用户开了协同,首轮 Lead 却没有 cindy_orca 工具。
 *   ② **提交点之后不得插入远程等待** —— 被控端 `maker:create-session` 返回 sessionId
 *      那一刻就是提交点;此后每多一步 await,「对端会话已建好、用户输入还只在内存里」的
 *      窗口就长一分。而本函数是一次隧道往返,可能一路走到 invoke 默认 30s 超时。
 *
 * 两者只能靠**把等待挪到导航之后**同时满足:草稿路由登记完 `setPending` /
 * `setPendingGoal`(载荷带上 `remoteCollab`)就立刻 navigate;`CCAgentSessionView`
 * 消费 pending 时先 await 本函数、再发首轮 / 起目标。于是新建页不卡、用户输入已经交到
 * 会话视图手里,而首轮仍由同一个 await 串在协同之后。
 *
 * 另外两条不变量:
 *   · **隧道超时不是权威失败** —— 超时只删掉控制端的等待项,被控端那次 enableOrca 仍在跑
 *     (device-link ipc.ts 对 INVOKE_TIMEOUT 的既有判定就是「远端仍存活」)。所以超时后要
 *     回查被控端 DB 的权威终态再定性,查不到才 fail-closed 降级。
 *   · **镜像回流绝不能 await** —— `refreshRemoteDeviceSessions` 对瞬态错误有最长约 6.75 秒
 *     的退避重试。协同 tab 解析不到 worker 时会 fallback `listWorkersByLead`,worker 变更
 *     另有 ORCA_WORKER_CHANGED 推送兜底,镜像慢一拍能自愈 —— 本来就不值得等。
 *
 * 抽成一处的原因与 `remoteSessionHandoff` 相同:草稿的「发送」与「新建目标」两条路径
 * 逐字重复这段收尾,而 #807 的 review 反复证明**两处逐字重复漏改一处不会有任何编译或
 * 测试信号**。顺带满足 newMakerProjectPicker 那条守卫:组件不再自己 import 回流函数,
 * 回流只经共享 helper 使用。
 */
import {
  isTransientRemoteError,
  refreshRemoteDeviceSessions,
} from '@/features/device-link/refreshRemoteSessions';
import { createLogger } from '@/lib/logger';
import {
  agentCapabilitiesForDevice,
  makerApiForDevice,
  orcaWorkflowsForDevice,
} from '@/lib/makerTransport';
import { extractIpcError } from '@/utils/ipcError';
import {
  createDeferredUiAssignment,
  rememberDeferredUiAssignment,
  type DeferredUiAssignment,
} from './deferredUiAssignment';
import { buildDraftWorkerInitialTask } from './draftWorkerHandoff';

const log = createLogger('remoteCollabHandoff');

function remoteWorkerPermissionModeUnsupportedError(): Error {
  return new Error(
    '[DEVICE_LINK_CHANNEL_NOT_ALLOWED] controlled device does not support Orca Team Worker permission mode',
  );
}

async function readRemoteCollabCapabilities(
  deviceId: string,
  workerAgent: EnableOrcaOptions['workerAgent'],
): Promise<{
  supportsOrcaWorkerPermissionMode?: boolean;
  supportsDeferredOrcaUiAssignment?: boolean;
}> {
  const raw = await agentCapabilitiesForDevice(deviceId, workerAgent);
  if (
    !raw
    || typeof raw !== 'object'
    || Array.isArray(raw)
    || (raw as Record<string, unknown>).supportsOrcaWorkerPermissionMode !== true
  ) {
    throw remoteWorkerPermissionModeUnsupportedError();
  }
  return raw;
}

/**
 * 超时后回查被控端权威终态的次数与间隔。
 *
 * 等待已经挪到导航之后(见文件头),不再占着新建页、也不再压着用户的输入,所以这里可以
 * 比「挡在导航前」时期给得从容一些。但仍然**有界** —— 被控端可能永远不返回,无界等待只会
 * 把首轮永久挂起;查不到就 fail-closed 按失败降级,绝不把「没建成」猜成「建成了」。
 */
const TIMEOUT_RECOVERY_ATTEMPTS = 6;
const TIMEOUT_RECOVERY_DELAY_MS = 3000;
/**
 * 整段回查的总时限。
 *
 * 只限次数不限时间是不够的:链路「可连但每个 invoke 都黑洞」时,每次 listWorkersByLead
 * 自己就要走满 30s 隧道超时,6 次串行 + 5×3s 退避 ≈ 3 分钟 —— 而这段时间 composer 是
 * 锁住的、首轮压着不发。次数上限只约束了退避总和(15s),没约束探针自身的耗时
 * (codex P2 第五轮)。
 *
 * 所以再加一道总 deadline:两者谁先到都停,回查最坏 30s 收尾,叠加最初 enableOrca 的
 * 30s 超时,composer 最坏锁约 1 分钟而不是 3 分钟。超时后仍走 fail-closed 降级,
 * 并由 finally 的镜像回流让被控端稍后提交的情况自愈。
 */
const TIMEOUT_RECOVERY_DEADLINE_MS = 30_000;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * `DEVICE_LINK_TIMEOUT` **不是权威失败** —— 隧道超时只删掉控制端的等待项,被控端那次
 * enableOrca 仍在继续跑(device-link ipc.ts 对 INVOKE_TIMEOUT 的判定就是「远端仍存活」)。
 * 把它和 PRECONDITION_FAILED / INVALID_PARAMS 这类权威拒绝混为一谈,会让「被控端起 Worker
 * 慢了一点」被当成「协同没开起来」:首轮照普通单会话发出,而团队其实马上就建好了
 * (issue #1170 codex P1 第二轮)。
 */
function isAmbiguousTimeout(err: unknown): boolean {
  return extractIpcError(err)?.code === 'DEVICE_LINK_TIMEOUT';
}

/**
 * 超时后回查被控端 DB 的权威终态:worker 已落库 = 团队真的建成了。
 *
 * 用 `listWorkersByLead` 而不是 `getByLeadSession`:非空 worker 列表同时证明 team 与首个
 * Worker 都已提交(team 建了但 worker 还没落库的中间态按未完成处理,fail-closed),而且
 * 顺带拿到 reveal 需要的 workerSessionId。
 *
 * 归属用调用方手里的 deviceId(`orcaWorkflowsForDevice`),不重新解析易失的 session origin。
 */
async function recoverTimedOutTeam(
  p: RemoteCollabEnableParams,
): Promise<{ focusWorkerSessionId: string } | null> {
  const deadline = Date.now() + TIMEOUT_RECOVERY_DEADLINE_MS;
  for (let attempt = 0; attempt < TIMEOUT_RECOVERY_ATTEMPTS; attempt += 1) {
    // 次数与时间两道闸,谁先到都停 —— 探针自身可能各走满 30s 隧道超时(见常量注释)。
    if (Date.now() >= deadline) {
      log.warn(`[${p.logTag}] remote team probe hit the overall deadline`, {
        leadSessionId: p.leadSessionId,
        attempt,
      });
      return null;
    }
    if (attempt > 0) await delay(TIMEOUT_RECOVERY_DELAY_MS);
    try {
      const workers = await orcaWorkflowsForDevice(p.deviceId).listWorkersByLead(p.leadSessionId);
      const workerSessionId = workers?.[0]?.sessionId;
      if (workerSessionId) {
        log.info(`[${p.logTag}] remote enableOrca timed out but the team is committed`, {
          leadSessionId: p.leadSessionId,
          attempt,
        });
        return { focusWorkerSessionId: workerSessionId };
      }
    } catch (probeErr) {
      // 回查本身失败要**分性质**,不能一律放弃剩余预算(codex P2 第三轮):
      // 触发回查的前提就是链路刚抖过(enableOrca 超时),第一次回查撞上同一段抖动
      // 是常态。此时直接 return null,等于「因为链路抖所以判定协同没建成」——
      // 而被控端那次 enableOrca 很可能正在跑完。
      //
      // 判据复用 device-link 既有的 isTransientRemoteError(同一条传输、同一类判断,
      // 永久错误优先、未知错误不重试)。为它另写一份等价判据,正是本 PR 一路在消灭的形状。
      const transient = isTransientRemoteError(
        probeErr instanceof Error ? probeErr.message : String(probeErr),
      );
      log.warn(`[${p.logTag}] probing remote team after timeout failed`, {
        attempt,
        transient,
        error: probeErr,
      });
      // 永久错误(被控端版本过旧 / 远程已禁用)重试多少次都是同一个结果 → 立即降级。
      if (!transient) return null;
      // 瞬态错误:继续用完剩余轮次;全部用尽后走循环外的 fail-closed。
    }
  }
  return null;
}

type EnableOrcaOptions = Parameters<typeof window.electronAPI.maker.enableOrca>[1];

export interface RemoteCollabEnableParams {
  /** 被控设备 deviceId —— Worker 在这台机器上 spawn。 */
  deviceId: string;
  /** 刚在被控端建出的 Lead 会话 id。 */
  leadSessionId: string;
  /**
   * enableOrca 入参。**必须按被控端的模型 / 供应商目录收窄**(草稿侧走
   * `draftEnableOrcaOptions(collab, deviceProviders, …)`)—— 拿控制端目录配出来的模型
   * 在被控端多半不存在,会撞它的精确 preflight。
   */
  options: EnableOrcaOptions;
  /** 新建 Lead 的待发送输入，仅供不支持 deferred handoff 的老被控端兼容。 */
  pendingLeadInput?: string;
  /** 日志前缀,用于区分是哪条创建路径(如 'draft send' / 'draft goal')。 */
  logTag: string;
}

/**
 * 隧道到被控端 enableOrca,回传可用于 navigate state 的 reveal 载荷。
 *
 * **权威失败按原样抛出**:调用方各自决定降级语气(草稿两条路径都是
 * `getCollaborationStartErrorMessage(err, t, { remoteDevice: true })` + 继续单会话)。
 * 这里不吞错 —— 吞掉就没人告诉用户「协同没开起来」,而会话已经建好了。
 *
 * **隧道超时先回查再定性**(见 `isAmbiguousTimeout`):超时只说明响应没回来,不说明被控端
 * 没建成。直接当失败放行,会让「被控端起 Worker 慢了几秒」变成「用户明确开了协同,首轮却以
 * 普通单会话跑」。回查到 worker 已落库就照成功返回;查不到才把原始超时抛出去降级。
 */
export async function enableRemoteCollabForSession(
  p: RemoteCollabEnableParams,
): Promise<{
  focusWorkerSessionId: string;
  deferredUiAssignment?: DeferredUiAssignment;
  assignmentUnconfirmed?: boolean;
}> {
  // 弹窗展示时的 capability 只是一份快照。真正 mutation 前重新向同一被控端确认，
  // 防止断线重连后设备降级到旧版本、把显式权限字段静默忽略。
  const capabilities = await readRemoteCollabCapabilities(p.deviceId, p.options.workerAgent);
  const deferDelegateTask =
    p.options.deferDelegateTask === true
    && capabilities.supportsDeferredOrcaUiAssignment === true;
  // 老被控端没有 deferred capability：删掉新字段，沿用它的 enableOrca 即时派单。
  // 不能在新通道失败后再回退即时派发，否则响应丢失时会把同一任务派两遍。
  // Even when the capability probe says “new”, preserve the pending Lead text on the wire:
  // the peer may reconnect/downgrade between capability and mutation. A new handler defers this
  // wrapped text until history is ready; an old handler still receives the context it cannot query.
  const enableOptions = (() => {
    const compatible = { ...p.options };
    compatible.delegateTask = buildDraftWorkerInitialTask(
      compatible.delegateTask,
      p.pendingLeadInput,
    );
    if (!deferDelegateTask) delete compatible.deferDelegateTask;
    return compatible;
  })();
  const withDeferredAssignment = (
    workerSessionId: string,
    snapshotBeforeMs: number | null,
    assignmentUnconfirmed = false,
  ) => {
    const deferredUiAssignment = deferDelegateTask && snapshotBeforeMs !== null
      ? createDeferredUiAssignment({
            // The later assignment can rely on queryable history, so retain the user's raw task;
            // the legacy Pending Lead input wrapper above exists only for the one-shot enable wire.
            options: p.options,
            workerSessionId,
            snapshotBeforeMs,
            deviceId: p.deviceId,
        })
      : undefined;
    rememberDeferredUiAssignment(p.leadSessionId, deferredUiAssignment);
    return {
      focusWorkerSessionId: workerSessionId,
      ...(deferredUiAssignment ? { deferredUiAssignment } : {}),
      ...(assignmentUnconfirmed ? { assignmentUnconfirmed: true } : {}),
    };
  };
  try {
    const result = await makerApiForDevice(p.deviceId).enableOrca(
      p.leadSessionId,
      enableOptions,
    );
    return withDeferredAssignment(
      result.workerSessionId,
      result.dispatched === false && Number.isFinite(result.uiAssignmentSnapshotBeforeMs)
        ? result.uiAssignmentSnapshotBeforeMs
        : null,
    );
  } catch (err) {
    if (!isAmbiguousTimeout(err)) throw err;
    const recovered = await recoverTimedOutTeam(p);
    // enableOrca 响应丢失时拿不到被控端时间；这些 defer 调用只用于刚创建、尚无历史的
    // Lead，0 可安全表达「等第一条 user 行」，同时不依赖控制端/被控端时钟同步。
    // 响应丢失时无法证明实际被控端采用了 deferred handler，也无法证明任务尚未派发。
    // 只恢复 Team 可见性，不生成可二次派发的 receipt。
    if (recovered) {
      return withDeferredAssignment(
        recovered.focusWorkerSessionId,
        null,
        deferDelegateTask,
      );
    }
    throw err;
  } finally {
    // 被控端刚建出的 worker session 还没进控制端注册表。fire-and-forget(见文件头 ②)。
    //
    // 放在 finally 而不是成功分支里,拿到两件事:
    //  · 超时回查判定为「没建成」后仍刷一次 —— 被控端可能在回查窗口之后才提交,刷新让
    //    orcaRole 回流,CCAgentSessionView 的 external-enable 边沿检测据此补开协同 tab,
    //    UI 最终与被控端的真实状态收敛(降级只影响首轮,不会永久错判)。
    //  · finally 在 catch(含回查)之后才执行,所以这次刷新不会早于被控端提交的判定结果 ——
    //    成功路径上 enableOrca 返回即代表 DB 已提交,回查路径上则已经确认过 worker 落库。
    void refreshRemoteDeviceSessions(p.deviceId).catch((err) => {
      log.warn(`[${p.logTag}] refresh remote sessions after enableOrca failed`, err);
    });
  }
}

/**
 * SessionView 侧的消费入口:发首轮 / 起目标之前先把协同开起来。
 *
 * 两处 pending 消费(首条消息、新建目标)共用这一份 —— 逐字重复两遍正是本 PR 反复踩过的
 * 形状。**永不抛出**:协同开不起来时会话本身仍然可用,首轮照单会话继续,只是要如实告诉
 * 用户「这条仍会发出去」(否则用户会以为没发,再提交一次)。
 *
 * 返回 true 表示协同已就绪(调用方据此展开协同 tab)。
 */
export async function consumePendingRemoteCollab(
  pending: { deviceId: string; options: Record<string, unknown>; pendingLeadInput?: string },
  ctx: {
    leadSessionId: string;
    logTag: string;
    /** 失败时的用户可见提示;调用方注入以复用视图的 i18n / toast。 */
    onFailed: (err: unknown) => void;
    /** Team 已建成，但延迟派单响应丢失，不能安全重试。 */
    onAssignmentUnconfirmed?: () => void;
  },
): Promise<{ ok: boolean; deferredUiAssignment?: DeferredUiAssignment }> {
  try {
    const result = await enableRemoteCollabForSession({
      deviceId: pending.deviceId,
      leadSessionId: ctx.leadSessionId,
      options: pending.options as Parameters<typeof window.electronAPI.maker.enableOrca>[1],
      pendingLeadInput: pending.pendingLeadInput,
      logTag: ctx.logTag,
    });
    if (result.assignmentUnconfirmed) ctx.onAssignmentUnconfirmed?.();
    return { ok: true, deferredUiAssignment: result.deferredUiAssignment };
  } catch (err) {
    log.error(`[${ctx.logTag}] remote enableOrca failed (continuing as single session)`, err);
    ctx.onFailed(err);
    return { ok: false };
  }
}
