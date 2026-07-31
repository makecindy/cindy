/**
 * relaunchBusyActivity.ts — 「现在重启会不会打断正在干的活」的单一判定。
 * ---------------------------------------------------------------------------
 * 背景:手动更新重启(侧栏 UpdateBanner 的「立即重启」)一旦执行就走 forceQuit() ——
 * 绕过 before-quit 链、destroyAll() 掉 Ghost Node runtime、process.exit(0)。所以点下去
 * 之前必须回答一个问题:**当前有没有正在跑的活会被这一下打断?**
 *
 * 这个问题的难点不在判断,而在**来源分散**:仓里「活动」由六个互不相干的跟踪器各自维护,
 * 谁都不知道其它几个的存在。判定收在这里一处,renderer 只问一次结论 —— 新增来源只改这里:
 *
 *   1. 逻辑 turn        —— SessionTurnActivityTracker + live session 的 isTurnRunning()
 *   2. Claude 后台活动  —— turn 已结束但 CC 子进程仍在调模型(后台 subagent;**不含**后台 Bash)
 *   3. Ghost 后台活动   —— card-action 干活,**完全不经 LLM turn**(生成媒体等)
 *   4. scheduler 在跑的 run —— **script 模式与 pre-run hook 阶段都不创建 session**
 *      (script-runner.ts 明确 'script execution does not support worktrees or bound
 *      sessions'、sessionId 落空串),所以前三个内存探针全都看不到它
 *   5. 后台 Bash 任务 —— run_in_background 的 Bash(dev server、长跑脚本)。它**不调模型**,
 *      所以永远点不亮来源 2 的 loopback 信号(useBackgroundBashTasks.ts 的头注释明写这一点);
 *      也不折算 makerChatStore 的 running,所以来源 1 同样看不到。快照来源是每个 live session
 *      的 listBackgroundTasks()
 *   6. Cindy slot 的在途代办 —— 异步(mode:'submit' 的视频生成,`void runExec()` 脱链跑)与
 *      同步(gen_image / gen_video 的同步等待、不进会话的 oneshot_text)两半,在 GhostCindySlot
 *      里分别记在 jobs 与 inflight 两个 Map。插件面板发起的请求还可能完全不伴随 turn 或
 *      card-action,所以前五个来源都可能不命中
 *
 * 新增第 7 个来源时改这一个函数,不必再去翻每个调用点。
 *
 * 一个刻意的边界:这份清单**不保证完备** —— 仓里的异步活动持有者是开放集合,每个模块各自在
 * 私有结构里管在途状态,没有统一注册处。但漏掉某个来源**不构成回归**:改动前那次二次确认
 * 同样不做任何活动判定(文案只是「应用会自动重启」),对所有来源都是「点一下就 forceQuit」。
 * 所以覆盖到的来源是净收益,没覆盖到的与改动前行为一致。发现新来源就往这里加一条。
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
 * 五个内存源同步、scheduler 源要查 SQLite,所以整体是 async:先读同步源,**都空闲**才去
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
   * 是否有任意 live session 存在仍在运行的后台 Bash 任务(run_in_background)。
   * **必须单独查**:后台 Bash 不调模型 → 点不亮 Claude 后台活动信号;也不折算 running →
   * 逻辑 turn 看不到。重启会直接杀掉这些子进程(dev server / 长跑脚本)。
   */
  anyBackgroundBashRunning: () => boolean;
  /**
   * 是否有任意 Cindy slot 在途代办(异步 jobs + 同步 inflight 两半都算)。
   * **必须单独查**:两半各自独立记账、都可能不伴随 turn 或 card-action,而 forceQuit() 会连
   * Ghost Node runtime 一起销毁 —— 正在生成的付费结果直接丢掉。
   */
  anyCindySlotJobRunning: () => boolean;
  /**
   * scheduler 里是否有 run 处于 running。**必须单独查**:script 模式与 pre-run hook 阶段
   * 都不创建 session,内存来源全看不到它们,而重启会让 run 来不及落终态、脚本子进程变成
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
 * 五个内存来源每次都全查(不短路),让 reasons 能完整反映现场 —— 诊断「为什么拦了我」时,
 * 只知道第一个命中的来源不够用。成本是五次内存读,可忽略。
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
    probe('background-bash', () => sources.anyBackgroundBashRunning());
    probe('cindy-slot-async-job', () => sources.anyCindySlotJobRunning());
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
