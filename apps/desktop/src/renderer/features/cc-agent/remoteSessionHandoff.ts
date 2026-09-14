/**
 * remoteSessionHandoff —— 远程建会话**成功之后**的交接收尾(device-link)。
 * ---------------------------------------------------------------------------
 * 被控端 `maker:create-session` 返回 sessionId 的那一刻就是**提交点**:对端会话已经真的建出来了。
 * 此后这 4 步必须按序做完,而且任何一步失败都**不许**把流程退化成「创建失败」—— 用户会照着提示
 * 再点一次,于是对端多出第二个会话,第一个空着永久滞留。
 *
 * 抽成一处的原因(#807 review 的结构性教训):这段收尾原先在「发送」与「新建目标」两条路径上
 * 逐字重复,而它的三条不变量分别是被三轮 review 逐个抓出来补上的 ——
 *
 *   ① **先钉归属,再回流**。回流失败时镜像里没有这条会话,`getSessionDeviceId` 返回 undefined,
 *      `makerApiFor` 就把首条消息发给**本机** maker。钉子只影响 origin 判定,会话进列表仍等权威快照。
 *   ② **补一条临时行**。origin 钉子只解决「路由到哪」;交接还有第二道门槛 —— SessionView 的
 *      delayed-create effect 要求 `session` 非空**且** `workingDir` 非空才 consumePending。会话行
 *      只有权威快照能带来,回流失败时那条消息就一直不发;`gave-up` 里的永久错误(老被控端没把
 *      `local-db:sessions:list` 放进 allowlist / REMOTE_DISABLED)更是**永远**不会有快照,消息永久
 *      躺着不发,而草稿下面已经被清掉了。
 *   ③ **回流走 refreshRemoteDeviceSessions,且失败只 warn**。它不抛(瞬态错误退避重试 ~6.75s,
 *      覆盖被控端冷启动)、认 snapshot epoch(不覆盖更新的快照)、有界快照按 merge 落库(手写
 *      `sessions:list` 会把 200 行上限的窗口当权威 replace,把窗口外已缓存的会话连标题叠加层一起清掉)。
 *
 * 三条各自都曾**只在一条路径上**被修好过 —— 两处逐字重复的代码,漏改一处不会有任何编译或测试信号。
 * 收敛成一个函数后,「远程建会话之后该做什么」只有一个答案;将来第三条创建路径(例如侧边栏直建)
 * 直接调它就自动带齐这三条不变量。
 */

import { refreshRemoteDeviceSessions } from '@/features/device-link/refreshRemoteSessions';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { createLogger } from '@/lib/logger';
import { markSessionStarting } from '@/lib/sessionStartingStore';

import { buildProvisionalRemoteSession, type DeviceLinkCreateArgs } from './deviceLinkCreateArgs';

const log = createLogger('remoteSessionHandoff');

export interface RemoteSessionHandoffParams {
  deviceId: string;
  /** 展示名(回流落库时用);调用方已按 `?? deviceId` 兜底。 */
  deviceName: string;
  /** 被控端 create 响应里的会话 id —— 到手即提交点。 */
  remoteSessionId: string;
  /**
   * 被控端**真正分配**的运行目录(create 响应的 `workDir`)。缺省时跳过临时行 —— 编不出
   * 一个可信的运行目录,而 delayed-create 的门槛正是它非空;此时只能依赖权威快照。
   */
  workDir?: string;
  /** 刚提交给被控端的那份 args:临时行的 model / effort / permission / workspaceKind 都以它为准。 */
  createArgs: DeviceLinkCreateArgs;
  /** 当前时刻 ISO 串;由调用方注入便于单测固定时间。 */
  nowIso: string;
  /** 日志前缀,用于区分是哪条创建路径(如 'draft send' / 'draft goal')。 */
  logTag: string;
}

/**
 * 钉归属 → 补临时行 → 触发回流。**同步返回、不抛**:调用方到这一步已经过了提交点。
 *
 * 为什么是同步的(Codex review 第 33 轮 P1):这个函数原来 `await` 回流才返回,于是调用方要等它
 * 结束才 `setPending` / `setPendingGoal` 并 navigate。而 refreshRemoteDeviceSessions 对瞬态错误
 * 会退避重试,窗口最长约 6.75 秒 —— 应用在这段时间里被关掉,对端**已经**有了那个新会话,而用户
 * 的首条消息(或目标弹窗里刚写的内容)还没被记录下来。用户重开后再试一次,对端就多出第二个会话,
 * 第一个空着永久滞留;建目标那条还会连同只存在于弹窗里的编辑一起丢。
 *
 * 而交接**本来就不需要等权威快照** —— 上面第 ② 步补的临时行正是为此存在的(它带着对端真正分配的
 * workDir,足够 SessionView 的 delayed-create effect 完成 consumePending)。所以回流改为
 * fire-and-forget:先把用户的工作登记好、导航过去,镜像慢一拍无所谓。
 */
export function commitRemoteSessionHandoff(p: RemoteSessionHandoffParams): void {
  // ① 归属先落地:回流失败时它是首条消息能路由到对端的唯一依据。
  remoteProjectsStore.pinSessionOrigin(p.deviceId, p.remoteSessionId);
  // 刚提交的远程任务在对端 isRunning 回流前先按运行中排序,避免先沉底再跳顶。
  markSessionStarting(p.remoteSessionId);
  // ② 临时行:让 SessionView 的 delayed-create 交接不必等权威快照。
  if (p.workDir) {
    remoteProjectsStore.mergeDeviceSessions(p.deviceId, p.deviceName, [
      buildProvisionalRemoteSession({
        sessionId: p.remoteSessionId,
        workDir: p.workDir,
        args: p.createArgs,
        nowIso: p.nowIso,
      }),
    ]);
  }
  // ③ 权威快照回流:**不等它**(见上)。失败只记日志 —— sessions:created push 还会触发一次
  // 防抖重拉,不能因为镜像慢一拍就影响交接。refreshRemoteDeviceSessions 本身不抛,
  // catch 只是防御它未来变成会抛的形态。
  void refreshRemoteDeviceSessions(p.deviceId, p.deviceName)
    .then((refreshResult) => {
      if (refreshResult !== 'ok') {
        log.warn(`[${p.logTag}] remote sessions refresh after create`, refreshResult);
      }
    })
    .catch((err) => {
      log.warn(`[${p.logTag}] remote sessions refresh after create threw`, err);
    });
}
