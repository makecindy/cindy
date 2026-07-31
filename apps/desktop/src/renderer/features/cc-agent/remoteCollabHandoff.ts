/**
 * remoteCollabHandoff —— device-link 远程会话**开启协同**的收尾(issue #1170)。
 * ---------------------------------------------------------------------------
 * device-link 项目的 Lead / Worker / team 真身都在被控端,控制端只是镜像。所以
 * 「草稿开了协同」这件事落地需要两步,而两步的时序约束方向相反:
 *
 *   ① `enableOrca` **必须** await,且必须排在 `navigate` 之前 —— Lead 的第一个 turn
 *      就要带上协同 MCP,否则用户开了协同却发现首轮 Lead 根本没有 cindy_orca 工具。
 *      首条消息由 `CCAgentSessionView` mount 后 `consumePending` 发出,而它要等
 *      navigate,所以「navigate 在后」就足够保证这一点。
 *   ② 镜像回流**绝不能** await —— `refreshRemoteDeviceSessions` 对瞬态错误有最长约
 *      6.75 秒的退避重试。协同 tab 解析不到 worker 时会 fallback `listWorkersByLead`,
 *      worker 变更另有 ORCA_WORKER_CHANGED 推送兜底,镜像慢一拍能自愈 —— 本来就不值得等。
 *
 * **调用点的位置约束(codex review P1)**:本函数会阻塞一次隧道往返,被控端起 Worker
 * 本就慢,还可能一路走到 invoke 默认 30s 超时。而被控端 `maker:create-session` 返回
 * sessionId 那一刻就是**提交点**,此后每多一步 await,「对端会话已建好、用户的首条消息
 * 或目标文案还没被登记」的窗口就长一分 —— 窗口内应用被关掉,用户重开重试就会在对端建出
 * 第二个会话,第一个空着滞留(`remoteSessionHandoff` 第 33 轮 P1 是同一条不变量)。
 * 所以调用点必须卡在 `setPending` / `setPendingGoal` **之后**、`navigate` **之前**。
 *
 * 抽成一处的原因与 `remoteSessionHandoff` 相同:草稿的「发送」与「新建目标」两条路径
 * 逐字重复这段收尾,而 #807 的 review 反复证明**两处逐字重复漏改一处不会有任何编译或
 * 测试信号**。顺带满足 newMakerProjectPicker 那条守卫:组件不再自己 import 回流函数,
 * 回流只经共享 helper 使用。
 */

import { refreshRemoteDeviceSessions } from '@/features/device-link/refreshRemoteSessions';
import { createLogger } from '@/lib/logger';
import { makerApiForDevice, orcaWorkflowsForDevice } from '@/lib/makerTransport';
import { extractIpcError } from '@/utils/ipcError';

const log = createLogger('remoteCollabHandoff');

/**
 * 超时后回查被控端权威终态的次数与间隔。刻意保守:这是 best-effort 的补救,不是等待机制。
 * 查不到就按失败降级(fail-closed),不会把「没建成」误报成「建成了」。
 */
const TIMEOUT_RECOVERY_ATTEMPTS = 3;
const TIMEOUT_RECOVERY_DELAY_MS = 2000;

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
  for (let attempt = 0; attempt < TIMEOUT_RECOVERY_ATTEMPTS; attempt += 1) {
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
      // 回查本身失败(链路又抖了 / 老被控端)→ 不再猜,按超时降级。
      log.warn(`[${p.logTag}] probing remote team after timeout failed`, probeErr);
      return null;
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
): Promise<{ focusWorkerSessionId: string }> {
  try {
    const result = await makerApiForDevice(p.deviceId).enableOrca(p.leadSessionId, p.options);
    return { focusWorkerSessionId: result.workerSessionId };
  } catch (err) {
    if (!isAmbiguousTimeout(err)) throw err;
    const recovered = await recoverTimedOutTeam(p);
    if (recovered) return recovered;
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
