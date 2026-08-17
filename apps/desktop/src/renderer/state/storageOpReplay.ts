/**
 * storageOpReplay —— `modelFavorites` 与 `modelEnginePrefs` 两个 localStorage store 的
 * **跨 renderer 单写串行**小工具。刻意只服务这两个文件,不做成通用存储框架:它依赖
 * 「写操作能表达成可重放且幂等的 op」这一前提,而那是那两个 store 自己的设计约束。
 *
 * 要解决的问题(2026-08-17 review H1):
 *   两个 store 都是**整表写回**。上一轮把写路径的基底换成了「写前重读 localStorage」,
 *   这只能修「另一窗口先写完、事件还没到」那一路;两个 renderer 若**都在对方写回之前**
 *   读了同一份旧快照,后写者仍然整表覆盖先写者 —— 新增丢失、编辑丢失,删除与编辑交错时
 *   已删的收藏还会复活(A 拿旧快照 update 一条 B 刚删掉的记录,整表写回把它带回来)。
 *   localStorage 没有 CAS,同进程 JS 单线程,但**跨 renderer 进程**的 getItem / setItem
 *   可以任意交错,所以「重读 → 应用 → 整表写」这三步在跨窗口视角下不是原子的。
 *
 * 机制 —— **同步乐观写 + 串行权威重放**:
 *   1. 写路径先照旧同步落盘(不能放弃:热更 relaunch 走 `app.exit()` 强退,纯异步写会丢
 *      掉最近一次改动),此时可能覆盖掉另一窗口的并发写;
 *   2. 随后在 **Web Locks**(`navigator.locks`,同源下所有 renderer 互斥)里重放同一个 op:
 *      重读此刻的 localStorage → 把**自己那一个 op** 施加在对方已落盘的最新状态上 →
 *      有差异才写回。两个窗口的重放互相排队,谁也不会拿旧快照整表覆盖谁。
 *   3. op 的语义天然幂等(add 按配置身份去重、update 未命中即 no-op、remove 幂等、
 *      seed 有 seeded 门),所以「同一个 op 被同步写与重放各应用一次」不会做出第二份效果;
 *      也因此窗口 B 删掉某条后,窗口 A 的 update 重放在「已删」状态上是 no-op —— 已删
 *      条目不会复活。
 *
 * 退化路径:`navigator.locks` 不存在(旧环境 / 单测的 node env)时**跳过重放**,行为退回
 * 改动前的「重读基底 + 整表写回」,不劣化、不抛错。与 analytics/tapdbClient 里 Web Locks
 * 的既有取舍一致(受控 Electron Chromium 提供该 API,缺失时走退化路径而不是阻断主流程)。
 *
 * 锁名用**该 store 当前的 storageKey**(含 dataOwnerId 分区后缀):不同账号分区各排各的队,
 * 互不阻塞;同一分区的所有 renderer 排同一条队。
 */

/**
 * 在同源全局锁 `lockName` 下跑一次权威重放。锁不可用时静默跳过(见文件头退化路径)。
 * `replay` 内部的异常一律吞掉:重放是**收敛**机制,失败最多回到「同步写的结果」,
 * 不该把用户当次操作变成一个报错。
 */
export function replayWriteUnderLock(lockName: string, replay: () => void): void {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks || typeof locks.request !== 'function') return;
  try {
    void Promise.resolve(
      locks.request(lockName, () => {
        try {
          replay();
        } catch {
          // 重放失败 = 保持同步写的结果,不影响用户当次操作。
        }
      }),
    ).catch(() => {
      // 锁请求本身失败(极端兼容环境)—— 同上,不打断主流程。
    });
  } catch {
    // navigator.locks 存在但调用即抛(受限上下文):按不可用处理。
  }
}
