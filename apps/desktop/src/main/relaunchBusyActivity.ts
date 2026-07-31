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
 *   4. scheduler 在跑的 run —— **script 模式与 pre-run hook 阶段都不创建 session**
 *      (script-runner.ts 明确 'script execution does not support worktrees or bound
 *      sessions'、sessionId 落空串),所以前三个内存探针全都看不到它
 *
 * 新增第 5 个来源时改这一个函数,不必再去翻每个调用点。
 *
 * **fail closed**:任一来源读取抛错都按「有活动」处理。理由是这里服务的是不可撤销的破坏性
 * 动作,「无法确认」不能当成「确认没有」;同样口径见 bootstrap-electron 托盘退出的
 * hasActiveTurn(「A failed busy probe must not turn the tray into an unguarded exit path.」)。
 * 代价只是多一次确认。
 *
 * 刻意**不**包含:远程 controller / in-flight remote invoke。那是**无人值守**自动重启该管的
 * (setUpdateAutoRelaunchBusyProbe),不该管手动重启 —— 用户主动点重启时,「有远程设备在看
 * 会话列表」不构成「会被打断的任务」,纳进来只会产生误报警告。
 *
 * 三个内存源同步、scheduler 源要查 SQLite,所以整体是 async:先读三个同步源,**都空闲**才去
 * 查 scheduler(省掉绝大多数情况下的一次 SQLite 往返);拿到 scheduler 结果后再复采一次同步源,
 * 关掉「查库期间新 turn 起来了」的窗口 —— 同样的二次采样理由见 updateRelaunchSafety.ts 的
 * hasUpdateRelaunchBusyActivity。
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
  /**
   * scheduler 里是否有 run 处于 running。**必须单独查**:script 模式与 pre-run hook 阶段
   * 都不创建 session,前三个来源全看不到它们,而重启会让 run 来不及落终态、脚本子进程变成
   * 失联进程。走 SQLite,所以是异步。
   */
  anySchedulerRunRunning: () => Promise<boolean>;
}

/** 判定出的忙闲,附带命中的来源(只用于日志/诊断,不进 UI 文案)。 */
export interface RelaunchBusyActivity {
  busy: boolean;
  /** 命中的来源标签;fail-closed 时是抛错的那个来源。 */
  reasons: string[];
}

/**
 * 三个内存来源每次都全查(不短路),让 reasons 能完整反映现场 —— 诊断「为什么拦了我」时,
 * 只知道第一个命中的来源不够用。成本是三次内存读,可忽略。
 */
export async function evaluateRelaunchBusyActivity(
  sources: RelaunchBusyActivitySources,
): Promise<RelaunchBusyActivity> {
  const readSyncSources = (): string[] => {
    const hits: string[] = [];
    const probe = (label: string, read: () => boolean): void => {
      try {
        if (read()) hits.push(label);
      } catch {
        // fail closed:读不出来就当它忙(见文件头)。标签带 -probe-failed 后缀,便于在日志里
        // 区分「真的有活动」与「探针坏了」——两者都拦,但排查方向完全不同。
        hits.push(`${label}-probe-failed`);
      }
    };
    probe('session-in-turn', () => sources.anySessionInTurn());
    probe('claude-background-activity', () => sources.listClaudeBackgroundSessions().length > 0);
    probe('ghost-background-activity', () => sources.anyGhostSessionBusy());
    return hits;
  };

  const firstPass = readSyncSources();
  // 已经确定要拦了就不必再查库 —— 结论不会变,省一次 SQLite 往返。
  if (firstPass.length > 0) return { busy: true, reasons: firstPass };

  const reasons: string[] = [];
  try {
    if (await sources.anySchedulerRunRunning()) reasons.push('scheduler-run-running');
  } catch {
    reasons.push('scheduler-run-probe-failed');
  }

  // 查库期间可能有新 turn / 后台活动起来,复采一次同步源(理由同
  // updateRelaunchSafety.hasUpdateRelaunchBusyActivity 的二次采样)。
  reasons.push(...readSyncSources());

  return { busy: reasons.length > 0, reasons };
}
