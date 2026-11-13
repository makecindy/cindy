/**
 * 项目列表变化的进程内通知。
 *
 * 侧栏的本机项目由三处数据拼成: 登记过的目录(recent_workdirs)、用户起的名字
 * (project_aliases)、移除标记(sidebar hiddenProjectKeys)。它们各自向窗口广播,
 * main 里要跟着项目列表走的模块(官方 IM 机器人的可选项目)订阅这一个信号即可,
 * 不必分别认识三个存储。只说「变了」, 不带内容; 订阅方自己重读。
 */

type Listener = () => void;

const listeners = new Set<Listener>();

export function onProjectCatalogChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitProjectCatalogChanged(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      /* 订阅方自己记日志; 一个订阅方出错不影响项目操作本身 */
    }
  }
}
