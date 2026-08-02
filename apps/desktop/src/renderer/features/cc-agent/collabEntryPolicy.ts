/**
 * 协同(Orca)入口的**单一判定口径** —— 新建草稿与已创建会话共用。
 *
 * 存在的理由:这两条路径曾各自写一份 eligible 判据,于是同一个 device-link 项目在草稿里
 * 看不到协同开关、发出第一条消息后开关又冒出来(issue #1170)。判据一旦分叉就没有任何
 * 编译或测试信号,只有用户实际走完两条路才会撞上,所以统一到这里,新增场景只改一处。
 *
 * 注意边界:这里只回答「**该不该挂入口**」和「项目级 collab 开关该向**谁**查」。
 * 「查出来是开还是关」由 useCollabProjectPolicy 负责,而最终授权始终是被控/执行端 main 的
 * `assertCollabProjectEnabled`(apps/desktop/src/main/maker-ipc/collabProjectPolicy.ts)——
 * renderer 这一层只是体验层,不构成权限边界。
 */

export interface CollabEntryTarget {
  /**
   * 会话/草稿的 workspace 形态。**必须由调用方显式给出,这里不从 workingDir 反推** ——
   * dialogue 会话也有 workingDir(main 按 workspaceKind='dialogue' 自动分配
   * `<userData>/dialogues/<date>/<sid>/` 作运行目录),反推会把纯对话误判成项目。
   * 草稿侧传 `workingDir ? 'project' : 'dialogue'`,与它提交给 createSession 的值同源。
   */
  workspaceKind?: string | null;
  workingDir?: string | null;
  /** sessions.orca_role。'worker' = Orca Worker 子会话,自己不能再开协同。草稿恒为空。 */
  orcaRole?: string | null;
  /** SSH 远端工作区所属 host。非空 = workingDir 是那台远端主机上的路径。 */
  remoteHostId?: string | null;
  /** device-link 被控设备 deviceId。非空 = 这个项目和会话的真身都在那台被控设备上。 */
  deviceLinkDeviceId?: string | null;
}

export interface CollabEntryPolicyScope {
  /** 该目标能否挂协同入口(不含插件开关本身,那由 policy 查询回答)。 */
  eligible: boolean;
  /**
   * 非空 = 项目级 collab 开关要**隧道到这台被控设备**去查。
   * 控制端本机查 `.cindy/plugins.json` 只会读到自己的用户级开关,与被控端 main 的
   * 权威授权可能相反 —— 那正是 #1170 里「入口能点但走不完」的来源之一。
   */
  policyDeviceId?: string;
  /**
   * true = 跳过项目级查询,只落用户级/全局级。
   * 尚未分配运行目录的 dialogue 草稿自然只读用户级开关;已有 workingDir 的本地 dialogue
   * 则把 kind 与目录交给 Main 的可信判据(托管 dialogue 强制只读全局,显式真实目录尊重项目覆盖)。
   * SSH 远端会话的 workingDir 属于远端机器,拿它在**执行查询的那台机器**的 fs 上找项目
   * 配置既无意义又会误判。远端项目级 collab 配置机制尚未存在(main 侧 remote 分支同口径)。
   */
  skipProjectQuery: boolean;
}

const NOT_ELIGIBLE: CollabEntryPolicyScope = { eligible: false, skipProjectQuery: false };

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * 五类场景一次说清:
 *
 * | 场景                              | eligible | 策略查询                        |
 * |-----------------------------------|----------|---------------------------------|
 * | 本地项目                          | ✅       | 本机项目级                      |
 * | SSH 远端项目(remoteHostId)        | ✅       | skipProjectQuery(仅用户/全局级) |
 * | device-link 项目(deviceLinkDeviceId) | ✅    | 隧道到该被控设备查项目级        |
 * | dialogue 草稿(尚无运行目录)       | ✅       | skipProjectQuery(仅用户/全局级) |
 * | 本地 dialogue(已有运行目录)       | ✅       | 查询目录;Main 区分托管/显式目录 |
 * | Orca Worker 子会话                | ❌       | —                               |
 *
 * 两个远端维度**可以同时成立**(在被控设备上打开的 SSH 远端项目):此时既要隧道到被控端,
 * 又要在被控端跳过项目级 —— 两个字段互相独立,不是二选一。
 */
export function resolveCollabEntryPolicy(target: CollabEntryTarget): CollabEntryPolicyScope {
  if (target.orcaRole === 'worker') return NOT_ELIGIBLE;
  if (target.workspaceKind !== 'project' && target.workspaceKind !== 'dialogue') {
    return NOT_ELIGIBLE;
  }
  const workingDir = nonEmpty(target.workingDir);
  if (target.workspaceKind === 'project' && workingDir === null) {
    return NOT_ELIGIBLE;
  }

  const deviceId = nonEmpty(target.deviceLinkDeviceId);
  return {
    eligible: true,
    ...(deviceId ? { policyDeviceId: deviceId } : {}),
    skipProjectQuery:
      nonEmpty(target.remoteHostId) !== null ||
      (target.workspaceKind === 'dialogue' && workingDir === null),
  };
}
