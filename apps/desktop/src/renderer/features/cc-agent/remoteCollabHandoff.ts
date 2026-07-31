/**
 * remoteCollabHandoff —— device-link 远程会话**开启协同**的收尾(issue #1170)。
 * ---------------------------------------------------------------------------
 * device-link 项目的 Lead / Worker / team 真身都在被控端,控制端只是镜像。所以
 * 「草稿开了协同」这件事落地需要两步,而两步的时序约束方向相反:
 *
 *   ① `enableOrca` **必须** await —— Lead 的第一个 turn 就要带上协同 MCP,否则用户
 *      开了协同却发现首轮 Lead 根本没有 cindy_orca 工具(与本机分支同口径:本机也是
 *      createSession → enableOrca → setPending)。
 *   ② 镜像回流**绝不能** await —— `refreshRemoteDeviceSessions` 对瞬态错误有最长约
 *      6.75 秒的退避重试。挡在首条消息 / 目标文案的交接前面,就是
 *      `remoteSessionHandoff` 那条不变量说的事:窗口期内应用被关掉,对端会话已经建好
 *      而用户的输入还没被记录下来,重试一次对端就多出第二个会话。协同 tab 解析不到
 *      worker 时会 fallback `listWorkersByLead`,worker 变更另有 ORCA_WORKER_CHANGED
 *      推送兜底,镜像慢一拍能自愈 —— 所以这一步本来就不值得等。
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
 * 隧道到被控端 enableOrca,成功后**不等**镜像回流,直接回传可用于 navigate state 的
 * reveal 载荷。
 *
 * **失败按原样抛出**:调用方各自决定降级语气(草稿两条路径都是
 * `getCollaborationStartErrorMessage(err, t, { remoteDevice: true })` + 继续单会话)。
 * 这里不吞错 —— 吞掉就没人告诉用户「协同没开起来」,而会话已经建好了。
 */
export async function enableRemoteCollabForSession(
  p: RemoteCollabEnableParams,
): Promise<{ focusWorkerSessionId: string }> {
  const result = await makerApiForDevice(p.deviceId).enableOrca(p.leadSessionId, p.options);
  // 被控端刚建出的 worker session 还没进控制端注册表。fire-and-forget(见文件头 ②)。
  void refreshRemoteDeviceSessions(p.deviceId).catch((err) => {
    log.warn(`[${p.logTag}] refresh remote sessions after enableOrca failed`, err);
  });
  return { focusWorkerSessionId: result.workerSessionId };
}
