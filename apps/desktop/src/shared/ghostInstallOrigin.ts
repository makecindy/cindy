/**
 * 装入确认框的「发起来源」——主机侧填写、agent 不可伪造。
 *
 * 为什么需要它:插件装入有四个入口(设置页选文件 / 窗口拖入 / 双击 .cindy /
 * `ghost_forge_pack` 打包转交),前三个都是用户亲手操作、意图明确;唯独 forge
 * 转交是 **Agent 单方面调工具发起的**——注入攻击可以让 Agent 在处理外部内容时
 * 偷偷打包并弹装入框,而用户此刻刚让 Agent 干了一堆事,没有"我没让它装插件"的
 * 清晰记忆。确认框必须能如实告诉用户"这次是 Agent 发起的,不是你点的",用户才有
 * 判断依据。
 *
 * 该结论只能由主机产生:forge 转交路径在 main 侧记下来源,经既有的
 * `ghosts:install-requested` 广播 payload 送到 renderer(不经 agent 可控通道)。
 * 手动入口一律 `manual`,不加任何提示——亲手选文件本身就是意图表达。
 */
export type GhostInstallOrigin =
  | { kind: 'manual' }
  | {
      /**
       * Agent 经 `ghost_forge_pack` 打包并转交装入。字段都由主机填:sessionTitle
       * 取自会话行(agent 改不了),sourceRelPath 是源码目录相对会话工作目录的
       * 路径(forge 打包已强制源码必须在工作目录内,故该路径可靠)。
       */
      kind: 'agent-forge';
      /** 发起该次打包的任务标题(查不到时缺省,不编造)。 */
      sessionTitle?: string;
      /** 被打包的插件源码目录,相对当前会话工作目录。 */
      sourceRelPath?: string;
    };

/** 手动入口的缺省来源(拖入 / 双击 / 设置页选文件共用)。 */
export const MANUAL_GHOST_INSTALL_ORIGIN: GhostInstallOrigin = { kind: 'manual' };

/** 是否为 Agent 单方面发起(确认框据此决定是否展示来源横幅)。 */
export function isAgentForgeOrigin(
  origin: GhostInstallOrigin | null | undefined,
): origin is Extract<GhostInstallOrigin, { kind: 'agent-forge' }> {
  return origin?.kind === 'agent-forge';
}
