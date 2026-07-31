/**
 * relaunchBusyActivity.ts — 「现在重启会不会打断正在干的活」的单一判定。
 * ---------------------------------------------------------------------------
 * 背景:手动更新重启(侧栏 UpdateBanner 的「立即重启」)一旦执行就走 forceQuit() ——
 * 绕过 before-quit 链、destroyAll() 掉 Ghost Node runtime、process.exit(0)。所以点下去
 * 之前必须回答一个问题:**当前有没有正在跑的活会被这一下打断?**
 *
 * 这个问题的难点不在判断,而在**来源分散**:仓里「活动」由三个互不相干的跟踪器各自维护,
 * 谁都不知道另外两个的存在。此前 renderer 侧逐个枚举来源,结果是每加一个新来源就漏一次
 * (PR #1197 的 review 里连续被指出三轮),而漏掉的后果是静默打断用户任务、不可撤销。
 * 所以判定收在这里一处,renderer 只问一次结论:
 *
 *   1. 逻辑 turn        —— SessionTurnActivityTracker + live session 的 isTurnRunning()
 *   2. Claude 后台活动  —— turn 已结束但 CC 子进程仍在调模型(后台子 agent、后台 Bash)
 *   3. Ghost 后台活动   —— card-action 干活,**完全不经 LLM turn**(生成媒体等)
 *
 * 新增第 4 个来源时改这一个函数,不必再去翻每个调用点。
 *
 * **fail closed**:任一来源读取抛错都按「有活动」处理。理由是这里服务的是不可撤销的破坏性
 * 动作,「无法确认」不能当成「确认没有」;同样口径见 bootstrap-electron 托盘退出的
 * hasActiveTurn(「A failed busy probe must not turn the tray into an unguarded exit path.」)。
 * 代价只是多一次确认。
 *
 * 刻意**不**包含的两项:
 *  - scheduler 正在跑的 run(hasRunningRuns,SQLite 异步):这里保持同步、零 IO,好让 IPC
 *    handler 是一次同步读。run 真跑起来会产生 turn,落回来源 1。
 *  - 远程 controller / in-flight remote invoke:那是**无人值守**自动重启该管的
 *    (setUpdateAutoRelaunchBusyProbe),不该管手动重启 —— 用户主动点重启时,「有远程设备
 *    在看会话列表」不构成「会被打断的任务」,纳进来只会产生误报警告。
 *
 * 依赖全注入,便于单测(规则 14)。
 */

export interface RelaunchBusyActivitySources {
  /** 是否有任意 session 正在跑逻辑 turn。 */
  anySessionInTurn: () => boolean;
  /** 处于「turn 已结束但仍在调模型」后台活动态的会话 id 列表。 */
  listClaudeBackgroundSessions: () => readonly string[];
  /** 是否有任意会话存在在途的 Ghost card-action 后台活动。 */
  anyGhostSessionBusy: () => boolean;
}

/** 判定出的忙闲,附带命中的来源(只用于日志/诊断,不进 UI 文案)。 */
export interface RelaunchBusyActivity {
  busy: boolean;
  /** 命中的来源标签;fail-closed 时是抛错的那个来源。 */
  reasons: string[];
}

/**
 * 三个来源全查一遍(不短路),让 reasons 能完整反映现场 —— 诊断「为什么拦了我」时,
 * 只知道第一个命中的来源不够用。单次调用的成本是三次内存读,可忽略。
 */
export function evaluateRelaunchBusyActivity(
  sources: RelaunchBusyActivitySources,
): RelaunchBusyActivity {
  const reasons: string[] = [];

  const probe = (label: string, read: () => boolean): void => {
    try {
      if (read()) reasons.push(label);
    } catch {
      // fail closed:读不出来就当它忙(见文件头)。标签带 -probe-failed 后缀,便于在日志里
      // 区分「真的有活动」与「探针坏了」——两者都拦,但排查方向完全不同。
      reasons.push(`${label}-probe-failed`);
    }
  };

  probe('session-in-turn', () => sources.anySessionInTurn());
  probe('claude-background-activity', () => sources.listClaudeBackgroundSessions().length > 0);
  probe('ghost-background-activity', () => sources.anyGhostSessionBusy());

  return { busy: reasons.length > 0, reasons };
}
