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
import { makerApiForDevice } from '@/lib/makerTransport';

const log = createLogger('remoteCollabHandoff');

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
 * **失败按原样抛出**:调用方各自决定降级语气(草稿两条路径都是
 * `getCollaborationStartErrorMessage(err, t, { remoteDevice: true })` + 继续单会话)。
 * 这里不吞错 —— 吞掉就没人告诉用户「协同没开起来」,而会话已经建好了。
 */
export async function enableRemoteCollabForSession(
  p: RemoteCollabEnableParams,
): Promise<{ focusWorkerSessionId: string }> {
  try {
    const result = await makerApiForDevice(p.deviceId).enableOrca(p.leadSessionId, p.options);
    return { focusWorkerSessionId: result.workerSessionId };
  } finally {
    // 被控端刚建出的 worker session 还没进控制端注册表。fire-and-forget(见文件头 ②)。
    //
    // 失败路径也刷:控制端的 invoke 超时**不会取消**被控端正在跑的 enableOrca,所以
    // 「控制端报失败、对端稍后仍建成 team」是真实可能的终态(codex review P1)。刷一次
    // 镜像让 orcaRole 尽快回流,CCAgentSessionView 的 external-enable 边沿检测会据此
    // 自动打开协同 tab,UI 最终与被控端的真实状态收敛。
    void refreshRemoteDeviceSessions(p.deviceId).catch((err) => {
      log.warn(`[${p.logTag}] refresh remote sessions after enableOrca failed`, err);
    });
  }
}
