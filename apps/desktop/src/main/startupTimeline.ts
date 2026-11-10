/**
 * 冷启动里程碑计时:一行一个里程碑,`t+<ms>` 相对本进程启动。
 *
 * 用来回答「打开 Cindy 到远程电脑显示在线花了多久、卡在哪一跳」:端点清单 → 建窗口 →
 * 鉴权完成 → 拿到 device-link 持有权 → relay 上线 → 第一份设备目录。每个里程碑只打一次
 * (重连 / 刷新不再记),所以读日志时一眼能看出整条链。renderer 侧首台设备 bootstrap 完成的
 * 那条以 renderer 启动为基准,单独打在 `device-link-remote-projects` 作用域里。
 *
 * 只记名字和毫秒,不带设备名、账号或路径。
 */

import { createLogger } from './logger';

const log = createLogger('startup');
const reached = new Set<string>();

/** 进程启动到现在的毫秒数(整数)。 */
export function msSinceProcessStart(): number {
  return Math.round(process.uptime() * 1000);
}

/** 记录一个启动里程碑;同名只记第一次。返回是否真的记录了。 */
export function markStartupMilestone(name: string): boolean {
  if (reached.has(name)) return false;
  reached.add(name);
  log.info(`milestone ${name} t+${msSinceProcessStart()}ms`);
  return true;
}

/** 仅测试:清空已记录的里程碑。 */
export function __resetStartupMilestonesForTests(): void {
  reached.clear();
}
