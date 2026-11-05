/**
 * 启动期「主进程先发起、renderer 后接上」的一次性调用。
 *
 * 用于 `auth:initialize`:以前要等窗口和 renderer 起来后才开始鉴权,渲染进程启动的
 * 耗时整段压在「打开 Cindy → 远程电脑在线」的关键路径上。现在 app ready 末尾由主进程
 * 先 `start()` 一次,renderer 的首个调用经 `handle()` 返回的处理函数接上:
 *
 * - 提前那次仍在途:复用同一个 promise,不重复跑鉴权。
 * - 提前那次已经落定:照常重新执行。提前那次可能在任何窗口挂载、订阅登录态推送之前
 *   就结束;它之后的广播(例如冷启动门超时后的迟到登录)没人收到,复用旧结果会让窗口
 *   停在过期状态。重新执行拿的是当下状态(已登录时走进程内快路径,不发网络请求)。
 * - renderer 先到(没有提前调用):与原来一样直接执行,之后的 `start()` 不再发起。
 */
export interface StartupInFlightCall<T> {
  /** 登记实际执行体,返回给 IPC 注册用的处理函数。 */
  handle(run: () => Promise<T>): () => Promise<T>;
  /** 主进程提前发起;只生效一次,调用方已先到或执行体未登记时不做事。 */
  start(): boolean;
}

export function createStartupInFlightCall<T>(): StartupInFlightCall<T> {
  let run: (() => Promise<T>) | null = null;
  let started = false;
  let inFlight: Promise<T> | null = null;
  return {
    handle(nextRun) {
      run = nextRun;
      return () => {
        started = true;
        return inFlight ?? nextRun();
      };
    },
    start() {
      if (started || !run) return false;
      started = true;
      const call = run();
      inFlight = call;
      const settle = (): void => {
        if (inFlight === call) inFlight = null;
      };
      // 同时充当提前调用的 rejection 处理:失败交给接上的调用方或下一次执行去面对。
      call.then(settle, settle);
      return true;
    },
  };
}
