#!/usr/bin/env node
/**
 * PR 心跳前置检查脚本(Cindy 自动化任务的 preRunHook gate)
 *
 * 每轮先跑只读 PR 快照,只有 PR 侧真的出现值得 AI 介入的变化时才放行;否则零
 * token 跳过本轮,绑定会话也不会被空转轮次污染。
 *
 * 退出码严格遵循宿主 preRunHook 协议:
 *   0  = 放行本轮(唤起 agent)
 *   2  = 跳过本轮(不建/不碰会话、不通知、照常重排下一次触发)
 *   其它 = fail-closed(阻止本轮并记 failed + 通知,让用户看见跟进坏了)
 *
 * 为什么必须包一层,不能直接把 pr-snapshot.mjs 填进 preRunHook.command:
 * pr-snapshot.mjs 查询失败时自己 exit 2(见其 main().catch),而 exit 2 在
 * preRunHook 协议里的语义是「静默跳过」—— gh 掉线 / auth 过期 / rate limit 会被
 * 翻译成「本轮无事」,心跳就此无声死掉,恰好违反 pr 技能「snapshot 失败时不得
 * 声称已闭环」那条规则。它的 --strict-exit 码(10/20/30/40)同样不匹配协议,会让
 * 每一轮都 fail-closed。本脚本负责把这些码翻译成协议语义:快照失败先容忍几轮
 * 瞬时抖动(跳过),连续失败到阈值才非零退出暴露出来。
 *
 * 状态文件刻意落在 worktree 之外(默认 ~/.cache/cindy-pr/):PR 心跳绑定
 * 的是被审查仓库的 worktree,收口时会被删掉,状态与脚本都不能放在那里。
 *
 * 指纹是**两段式**的,这是正确性关键:`fingerprint` 只记 agent 已确认处理完的状态
 * (由 --ack / --defer 提升),`pendingFingerprint` 记已放行但还没被确认处理完的。
 * 判定一律拿 confirmed 比 —— 所以放行之后宿主建会话失败、agent 启动失败或中途崩掉
 * 时,下一轮仍会看到「与已确认状态不同」并重试,不会把那次 PR 变化永久吞掉(这是
 * 单段式指纹的致命缺陷:READY / WAITING_CI / BLOCKED_HUMAN / NOT_READY 状态没有
 * work-pending 兜底,一旦漏掉就是永久漏掉)。
 *
 * `pendingFingerprint` 只登记**最早一个**未确认的变化、不被后续轮次覆盖:agent 跑得
 * 比心跳间隔慢时,下一轮 gate 可能已看到更新的指纹,而那个慢 agent 随后的无参数
 * --ack 会把它从没处理过的指纹提升成 confirmed。保留最早值后,confirmed 只会前进到
 * 某个确实放行过的指纹,更新的变化仍因「current != confirmed」继续被放行。
 *
 * 前提假设(改动心跳配置前必读):无参数 --ack 的正确性依赖「同一绑定会话上不会有两个
 * agent turn 并发」。PR 心跳固定 bindToCurrentSession=true,宿主对 heartbeat 撞忙会
 * 顺延本轮(runner 的 deferFire('session-running')),注入排队桥时也只是让消息排队、
 * 同一 session 的 turn 依旧串行 —— 所以不会出现「两个已放行轮次交错 ack」互相确认
 * 对方指纹的情况。若将来把心跳改成非绑定 / 每轮新建会话 / 允许并发的模式,这个假设
 * 就不再成立,必须改成让 ack 携带本轮的轮次标识(runId 或放行时的指纹)再提升。
 *
 * gate 同时是 **cadence 的唯一决策源**(见 suggestCadence):它按「距上次真实变化多久 +
 * 当前 verdict」算出该隔多久查一次 GitHub,并**自己执行**(见 cadenceThrottle):调度固定
 * 每 10 分钟触发一次,未到档位间隔的轮次直接跳过、不调 GitHub API。被跳过的轮次不唤起
 * agent,所以「长期安静 → 逐档降」只能由 gate 自己完成,不依赖 agent 或外部巡检去改调度。
 *
 * 用法:
 *   node pr-heartbeat-gate.mjs <PR_URL|PR号> [--repo owner/name] [选项]
 *   node pr-heartbeat-gate.mjs <PR_URL|PR号> --ack [--repo owner/name]
 *   node pr-heartbeat-gate.mjs <PR_URL|PR号> --defer <分钟> [--repo owner/name]
 *   node pr-heartbeat-gate.mjs <PR_URL|PR号> --suggest [--json]
 *   node pr-heartbeat-gate.mjs <PR_URL|PR号> --last-result [--json]
 *
 * 选项:
 *   --repo owner/name          PR 号形式时必填;URL 形式会自动解析
 *   --ack                      确认本轮已处理完:把 pending 指纹提升为已确认,并退出 0。
 *                              心跳每轮收尾必须调它,否则同一变化会被重放到上限。
 *                              输出里附带本轮该设成多少的 cadence 建议。
 *   --suggest                  只读状态文件输出 cadence 建议(零 API、不改状态),
 *                              供排查当前档位用。
 *   --last-result              只读输出最近一轮普通 gate 的 run/skip/block、reason 与
 *                              detail(零 API、不改状态),供被唤起的 AI 判断本轮是否通知。
 *   --defer <分钟>             把「下次最早放行时间」推后并退出 0(**隐含 --ack**:
 *                              显式 defer 意味着这轮已处理完)。给 agent 用:通知用户
 *                              等其决策后设定提醒节奏。软闸门 —— 期间 PR 真有
 *                              新变化仍然穿透放行。
 *   --snapshot <path>          pr-snapshot.mjs 路径(默认见 DEFAULT_SNAPSHOT)
 *   --state-dir <dir>          状态目录(默认 ~/.cache/cindy-pr,或 CINDY_PR_STATE_DIR)
 *   --max-snapshot-failures N  连续快照失败容忍轮数,超过则 fail-closed(默认 3)
 *                              明确限流首轮提醒并按响应头退避;同类故障一天内不重复提醒
 *   --max-pass-attempts N      同一未确认变化每轮快速重试的次数上限(含首轮,默认 3);
 *                              用尽后转入退避重试,不放弃也不再每轮唤起
 *   --retry-backoff-minutes N  退避重试间隔(默认 30):快速重试用尽后每这么久放行一次,
 *                              直到被 --ack 确认
 *   --max-work-pending-passes N  同一个**无变化**的 NEEDS_WORK 状态最多连续唤起几轮
 *                              (默认 2);用尽后转入退避(间隔同上)。agent 已确认过的
 *                              状态若连续几轮推不动,说明剩下的 blocker 短期不可操作,
 *                              不该每 10 分钟无限唤起
 *   --min-pass-spacing-minutes N  两次放行之间的最小有效间隔(默认 5):比这更密的放行
 *                              不计入重试/唤起计数 —— 宿主顺延、spawn 失败等「放行了
 *                              但 agent 根本没跑」不该消耗额度
 *   --max-silence-hours N      保底巡检闸门(默认 24):连续这么久没真正放行过就强制唤起
 *                              一次,兜住指纹看不到的变化与 gate 自身的静默失效
 *   --draft-reminder-hours N   草稿复提醒闸门(默认 24):PR 停在草稿期间每这么久唤起一次,
 *                              让 AI 复述一句「还卡在草稿、在等谁做什么」。
 *                              0 = 关闭(只在转草稿那一次提醒)
 *   --json                     决策以 JSON 输出(便于排查;不影响退出码)
 *   --no-cadence-throttle      关闭 gate 内的 cadence 节流:由调度自身按 --ack 给出的档位
 *                              调整触发间隔时使用(每次触发都查 GitHub)
 */

import { createHash } from 'node:crypto';
import { mergeQueueFingerprint } from './lib/merge-queue.mjs';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** preRunHook 协议退出码。 */
const EXIT_PASS = 0;
const EXIT_BLOCK = 1;
const EXIT_SKIP = 2;

/**
 * pr-snapshot.mjs 的默认位置:与本 gate 同目录的版本控制脚本(随 pr 技能一起
 * 演进,无需再维护仓外硬编码路径);需要时用 --snapshot 或 PR_SNAPSHOT_SCRIPT
 * 覆盖(测试即走这条)。
 */
const DEFAULT_SNAPSHOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'pr-snapshot.mjs',
);

const DEFAULT_MAX_SNAPSHOT_FAILURES = 3;

/**
 * 同一个「已放行但未 --ack」的变化最多**每轮**快速重试几次(含首次)。用尽后不放弃、
 * 也不继续每轮唤起,而是转入退避重试(见下)。
 *
 * 为什么不到顶就收敛成「已确认」:gate 分不清「agent 连续启动失败」和「agent 每轮都
 * 跑成了但 prompt 没调 --ack」——前者收敛会永久漏掉那次变化,后者不收敛会每 10 分钟
 * 无限烧 agent。退避重试对两种情况都是安全解:事件永不丢,成本也有界。
 */
const DEFAULT_MAX_PASS_ATTEMPTS = 3;

/**
 * 快速重试用尽后的重试间隔(分钟):此后每这么久放行一次,直到被 --ack 确认。
 * 技术问题不能因为一次长会话没能 ack 就静默四小时;30 分钟仍能抑制高频空转,
 * 同时保证失败/崩溃的 PR 任务在下一小时内重新获得执行机会。
 */
const DEFAULT_RETRY_BACKOFF_MINUTES = 30;

/**
 * 同一个**无变化**的 NEEDS_WORK 状态最多连续唤起几轮,用尽后转入退避(间隔复用
 * --retry-backoff-minutes)。
 *
 * work-pending 的语义是「上轮判定还有活要干,PR 侧没动也放行」——它防的是 agent 偷懒。
 * 但走到这条分支的前提是 current === confirmed:agent 已经完整处理并 --ack 过这个
 * 状态。确认之后连续几轮状态仍一字未变,说明剩下的 blocker 是 agent 当下推不动的
 * (上游 CI 故障、被禁用 workflow 留下的死红灯、等外部恢复),继续每轮唤起只是无限
 * 烧 token(实测:两个 PR 被一个已禁用 workflow 的残留红灯各烧掉十几轮
 * 「无变化」turn)。与未确认变化的退避重试同款节奏:永不放弃(每个退避周期仍re-nudge
 * 一次),也永不无限唤起。真实变化随时走 changed 立刻穿透;agent 的 --defer 仍可更早
 * 压住,但不再是唯一防线。
 */
const DEFAULT_MAX_WORK_PENDING_PASSES = 2;

/**
 * 两次放行之间的最小有效间隔(分钟):比这更密的放行**不计入**任何重试/唤起计数。
 *
 * gate 的两个计数器(pendingPassCount / workPendingPassCount)都以「放行了一次 =
 * agent 跑了一轮」为前提。宿主并不保证这一点:Cindy 的 preRunHook 跑在「这一轮到底
 * 跑不跑」的判定**之前**(runner.ts 里 hook 在 409 行,deferFire 在 561 行),于是
 * user-active 礼让、撞忙排队、队列恢复等顺延路径每次都会先敲一遍门再反悔 —— 每 90 秒
 * 一次,agent 一次都没起来(2026-08-01 实测:一个 PR 建好心跳后连吃 4 次 user-active
 * 顺延,把 3 次快速重试额度烧光并 armed 30 分钟短退避,而 schedule_runs 里那条心跳
 * 一条真正的 run 都没有)。宿主重启、agent spawn 失败也是同一类空放行。
 *
 * 判据用时间而不是别的:心跳最快档位是 10 分钟,一轮真实处理(拉快照 + 读 + 改 + 验证)
 * 也远不止几分钟,所以「上次放行才过了 90 秒又来敲门」只可能是空放行。空放行照样放行
 * (agent 确实还没跑,不能吞掉),但不消耗额度。
 */
const DEFAULT_MIN_PASS_SPACING_MINUTES = 5;

/**
 * 回合止损线(与 references/review-convergence.md 同一套数字):第 5 轮起每轮先做收敛盘点,
 * 第 10 轮起禁止再打补丁、必须换策略(重设计/划范围/拆 PR,自主执行,纯技术不上抛)。
 *
 * 为什么要在 gate 的 stdout 里喊出来:止损规则最初只写在 skill 文字里,靠 agent 自觉
 * 去读状态文件 —— 2026-08-01 实测一个 PR 一夜跑到 33 commits / 146 reviews / 25 轮,
 * 规则一次都没触发,因为 agent 每轮醒来根本不知道自己在第几轮。gate 本来就在数
 * (roundCount),把数字连同止损指令直接打进放行 detail,是唯一保证 agent 每轮必看到
 * 的通道(detail 会进 run 记录与 agent 的唤起上下文)。
 */
const ROUND_CHECKPOINT = 5;
const ROUND_HARD_STOP = 10;

/**
 * 无底洞信号:同一个文件累计这么多条 review thread,说明这片代码的 review 收益已经
 * 耗尽 —— 修一处 reviewer 就能在同一片里找出下一处(锁/并发/时钟类代码尤甚)。此时
 * 该划范围/转 issue,而不是让 agent 继续在里面逐条打补丁(那个 PR 的一个文件
 * 一个文件攒了 69 条 thread 中的大多数)。
 */
const HOTSPOT_THREAD_THRESHOLD = 8;

/**
 * 只有人类能推进的 blocker:agent 修再多代码也消不掉。gate 用它识别「临门
 * 一脚」状态 —— agent 可干的活将尽而人类动作还没发生时,该提醒 agent 去挂 🔴 请人,
 * 而不是为了「有活干」继续卷 bot 反馈(那次失控的直接机制)。
 */
const HUMAN_ONLY_BLOCKERS = new Set(['branch_protection_blocked', 'approval_required']);

/** 这些 blocker 在,说明 agent 手上还有硬活,「临门一脚」提示不该出现。 */
const HARD_AGENT_BLOCKERS = new Set([
  'ci_failing', 'merge_conflict', 'branch_behind_base',
  'merge_queue_removed', 'merge_queue_ci_failing', 'merge_queue_unavailable', 'merge_queue_unmergeable',
]);

/**
 * 明确属于 agent 自己的技术待办。它们可以长期不改变 GitHub 指纹,所以 work-pending
 * 每次放行都要重申行动边界,避免 agent 把「还有活」误读成「等用户授权」。
 */
const ACTIONABLE_WORK_BLOCKERS = new Set([
  'unresolved_review_threads',
  ...HARD_AGENT_BLOCKERS,
]);

/**
 * 只有人工批准才能推进的 review 语言。普通技术 review 即使同时出现
 * branch_protection_blocked，也不能靠这个判据静默；必须明确写出批准/放行要求。
 */
const HUMAN_APPROVAL_LANGUAGE =
  /人工批准|指定[^\n]{0,24}(?:批准|approve|同意)|明确[^\n]{0,24}(?:批准|approve|同意)|\b(?:approve|approval|codeowners?|maintainers?|required\s+reviewer)\b/i;

/**
 * 判断 NEEDS_WORK 中的 unresolved thread 是否已经退化为纯人工批准等待。
 *
 * 这个判据故意要求：
 * - 有 human-only blocker 且没有 CI/冲突/落后基线等 agent-owned blocker；
 * - active thread 数量很少且快照完整；
 * - 每条 active thread 的评论都出现明确批准语义。
 * 缺任一条件都继续按技术待办处理，避免把普通 review 误静默。
 */
export function isHumanOnlyReviewPending(snap) {
  const blockers = snap?.blockers ?? [];
  if (!blockers.some((b) => HUMAN_ONLY_BLOCKERS.has(b))) return false;
  if (blockers.some((b) => HARD_AGENT_BLOCKERS.has(b))) return false;

  const threads = snap?.reviewThreads ?? {};
  if (threads.truncated) return false;
  const activeCount = Number(threads.activeUnresolvedCount ?? threads.unresolvedCount);
  if (!Number.isFinite(activeCount) || activeCount < 1 || activeCount > 2) return false;

  const activeThreads = (threads.nodes ?? []).filter((t) => !t?.isResolved && !t?.isOutdated);
  if (activeThreads.length !== activeCount) return false;
  return activeThreads.every((thread) => {
    const body = (thread?.comments ?? [])
      .map((comment) => String(comment?.body ?? ''))
      .join('\n');
    return HUMAN_APPROVAL_LANGUAGE.test(body);
  });
}

function humanOnlyReviewDetail(snap) {
  const blockers = (snap?.blockers ?? []).filter((b) => HUMAN_ONLY_BLOCKERS.has(b));
  const count = Number(snap?.reviewThreads?.activeUnresolvedCount ?? snap?.reviewThreads?.unresolvedCount);
  return `only ${Number.isFinite(count) ? count : 'a few'} review thread(s) left that explicitly require human approval, blocker=${blockers.join('/') || 'approval_required'}; not waking the agent again, waiting for the designated approver to Approve`;
}

/**
 * 范围膨胀判据:diff 相比建档基线**同时**满足「绝对增量 ≥300 行」与「≥1.5 倍」才提示。
 *
 * 防的是被 reviewer 带着造机制(2026-08-01 教训):一个「算不出报价就显示 token」
 * 的 UI 兜底,实现时顺手加了落盘缓存 → reviewer 指出缓存竞态 → 加文件锁 → reviewer 指出
 * 锁的时钟/回收 bug → 加原子回收与租约协议……25 轮后 diff 从约 +1100 涨到 +3644,最终
 * 整套锁子系统被扔掉、缩回 +1091 才合并。reviewer 的意见永远针对已写出的代码,不针对
 * 需求 —— 代码不存在,意见就不存在。两个阈值都要,避免小 PR 的正常补测试被误报。
 */
const SCOPE_GROWTH_MIN_LINES = 300;
const SCOPE_GROWTH_MIN_RATIO = 1.5;

/**
 * 连续退避周期无进展达到这个数,detail 里要求通知用户(2026-08-01 明确:
 * 反复解决不了、卡了很久的事必须能被他看见,静默重试不算处理)。按默认 30 分钟退避间隔,
 * 3 个周期 ≈ 卡了半天以上。
 */
const STUCK_NOTIFY_BACKOFF_CYCLES = 3;

/** 快照输出可含全部评论正文,给足缓冲(与 pr-snapshot 自身口径一致)。 */
const SNAPSHOT_MAX_BUFFER = 50 * 1024 * 1024;

/**
 * 保底巡检:连续这么久没有真正放行过,就强制唤起 agent 看一次(默认 24 小时)。
 *
 * 为什么需要 —— **指纹的覆盖面就是 gate 的视野上限**,而 AI 能看到 gate 看不到的东西:
 *   - pr-snapshot 不抓的信号(base 落后多少值得 rebase、CI 全绿但有 flaky 迹象、
 *     这个 PR 是不是已经该关掉 / 该催人了 / 该换策略);
 *   - gate 自身的未知故障(状态文件被写成一个永不变化的指纹、某个边界让它恒 skip)——
 *     这类静默失效没有任何报错,只有定期强制放行能兜住;
 *   - "长期停滞"本身就是个需要人判断的信号,而不是一个可以无限静默的稳态。
 *
 * 触发的那一轮刻意**不刷新** lastChangedAt(它不是真实变化),所以 cadence 不会因为
 * 保底巡检而回弹到高频。
 */
const DEFAULT_MAX_SILENCE_HOURS = 24;

/**
 * 草稿复提醒:PR 停在草稿状态期间,每这么久强制唤起一次(默认 24 小时)。
 *
 * 为什么草稿要单独一条闸门,而不是靠保底巡检兜:两者语义与锚点都不同。
 *   - 保底巡检问的是「gate 是不是瞎了」,锚点是 lastPassAt —— 任何不相关的放行(一次
 *     CI 变化)都会把它的 24 小时推后。草稿等的是**人**,它的钟不该被 PR 侧的杂音重置。
 *   - 草稿意味着某处改动被要求挪到新建 issue 里讨论,而那个讨论需要人来回复
 *     确认修改并说明目的 —— 这是一件挂在人名下的待办,漏掉不会有任何别的机制发现。
 *
 * 所以它有独立锚点 lastDraftReminderAt(转草稿那一轮初始化),只被草稿相关的放行推进。
 * 与保底巡检同样刻意**不刷新** lastChangedAt:复提醒不是真实变化,不该把 cadence 拉回高频。
 */
const DEFAULT_DRAFT_REMINDER_HOURS = 24;

/**
 * 草稿期间 cadence 的下限:取「不粗于复提醒闸门一半」的**最粗**档位。
 *
 * 为什么必须由闸门推导而不是写死一个常量:最坏延迟 = 闸门 + 轮询间隔(某轮恰好落在闸门
 * 到点前一刻 → 本轮 idle,要再等一个完整轮询周期)。所以把轮询间隔压到闸门的一半以内,
 * 提醒最多晚 50%。写死 8h 只对默认的 24h 闸门成立;`--draft-reminder-hours 2` 时 8h 仍比
 * 闸门粗 4 倍,2 小时的提醒会拖到约 10 小时。
 *
 * 闸门关成 0(不复提醒)时没有要兑现的承诺,不设下限,让阶梯自由降到 1d。
 * 闸门比阶梯最细档(10m)的两倍还短时只能给到最细档,此时延迟仍可能超过 50% —— 这是
 * 阶梯粒度的下限,不是本函数的缺陷。
 */
/**
 * 解析本次调用该用哪个复提醒闸门。
 *
 * 三个入口是三个独立进程:普通 gate 轮由 `preRunHook.command` 带参数,而 agent 的 `--ack`
 * 与排查用的 `--suggest` 按 skill 里的写法只带 PR URL。若各自独立取默认值,配了
 * `--draft-reminder-hours 2` 的心跳会在 `--ack` 里按 24h 推出 8h 档,把短闸门顶掉 ——
 * 相位问题原样复发。
 *
 * 所以:**普通 gate 轮是配置的权威来源**,它把生效值写进 state;`--ack` / `--suggest`
 * 没显式传参时从 state 读。显式传参始终优先。0 是合法值(关闭复提醒),不能被当成缺省。
 */
function resolveDraftReminderMs(explicitMs, state) {
  if (explicitMs !== undefined) return explicitMs;
  const stored = state?.draftReminderMs;
  if (typeof stored === 'number' && Number.isFinite(stored) && stored >= 0) return stored;
  return DEFAULT_DRAFT_REMINDER_HOURS * 3_600_000;
}

function draftCadenceFloor(draftReminderMs) {
  if (!(draftReminderMs > 0)) return null;
  const budget = draftReminderMs / 2;
  // CADENCE_LADDER 由细到粗;倒序找第一个「够细」的,即最粗的可接受档位
  return [...CADENCE_LADDER].reverse().find((t) => t.intervalMs <= budget) ?? CADENCE_LADDER[0];
}

/**
 * cadence 阶梯(gate 是 cadence 的**唯一决策源**,并由 cadenceThrottle 自己执行)。
 *
 * 为什么 gate 守门之后还要降档:gate 只把 **agent token** 压到零,轮询本身仍有成本 ——
 * 每轮 2-3 次 GitHub API 请求、一条 skipped run 记录(13 个心跳 × 每 10 分钟 ≈ 每天
 * 1900 条)、一次 node + gh spawn。两层节流互补:cadence 降档省轮询次数,gate 省 token。
 * 降档后那一轮若无变化,仍然只是 gate 跑一次、不唤起 agent,gate 的价值一点没丢。
 *
 * 按 quiet(距上次真实变化多久)选档。第一档同时兼作「必须保持敏感」的兜底档。
 */
const CADENCE_LADDER = [
  { maxQuietMs: 30 * 60_000, intervalMs: 10 * 60_000, cronExpr: '*/10 * * * *', label: '10m' },
  { maxQuietMs: 2 * 3_600_000, intervalMs: 3_600_000, cronExpr: '0 * * * *', label: '1h' },
  { maxQuietMs: 8 * 3_600_000, intervalMs: 4 * 3_600_000, cronExpr: '0 */4 * * *', label: '4h' },
  { maxQuietMs: 3 * 86_400_000, intervalMs: 8 * 3_600_000, cronExpr: '0 */8 * * *', label: '8h' },
  { maxQuietMs: Infinity, intervalMs: 86_400_000, cronExpr: '0 9 * * *', label: '1d' },
];

function formatDuration(ms) {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 6) / 10;
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

/**
 * 建议 cadence(纯函数,可测)。只读状态文件,不跑快照、不改状态 —— 所以每轮 gate
 * 可以零 API 成本地先问一句「现在该多久查一次」。
 *
 * 一个刻意的设计:**被跳过的轮次不唤起 agent**,所以「长期安静 → 逐档降」这个方向
 * agent 自己做不到(最该降档的心跳恰恰全是跳过的轮次)。因此调度固定 10 分钟触发,
 * 由 gate 每轮用本函数 + cadenceThrottle 决定这一轮要不要真的去查 GitHub;
 * 一有变化(回弹到 10m 档)下一轮就恢复高频,不需要任何人改调度。
 */
export function suggestCadence(
  state,
  now = Date.now(),
  draftReminderMs = DEFAULT_DRAFT_REMINDER_HOURS * 3_600_000,
) {
  const pick = (tier, reason, detail) => ({
    intervalMs: tier.intervalMs,
    cronExpr: tier.cronExpr,
    label: tier.label,
    reason,
    detail,
  });
  const fast = (reason, detail) => pick(CADENCE_LADDER[0], reason, detail);

  if (!state || typeof state !== 'object') {
    return fast('no-state', 'no previous state; poll fast to establish a baseline');
  }
  if (state.merged || state.closed) {
    return fast('terminal', 'PR is merged/closed; keep polling fast while wrapping up');
  }
  if (state.pendingFingerprint) {
    return fast('unacked', 'a released change has not been acknowledged with --ack yet; keep the retry pace');
  }
  if ((Number(state.nextAllowAt) || 0) > now) {
    // defer 期间不降档:压制提醒交给 defer(软闸门),cadence 仍要对真变化敏感
    return fast('deferred', 'a defer is active; defer, not cadence, holds wake-ups back');
  }
  if ((state.blockers ?? []).includes('merge_queue_pending')) {
    return fast('merge-queue', 'PR is in the merge queue; poll every 10 minutes, wake the agent only on change');
  }
  if (state.humanOnlyPending) {
    const anchor = Number(state.lastChangedAt) || Number(state.lastCheckedAt) || now;
    const quietMs = Math.max(0, now - anchor);
    const tier = CADENCE_LADDER.find((t) => quietMs < t.maxQuietMs) ?? CADENCE_LADDER.at(-1);
    return pick(tier, 'human-only', `only human approval left; polling quietly (quiet for about ${formatDuration(quietMs)})`);
  }
  if (state.verdict === 'NEEDS_WORK') {
    return fast('work-pending', 'verdict=NEEDS_WORK, there is work left');
  }
  const anchor = Number(state.lastChangedAt) || Number(state.lastCheckedAt) || now;
  const quietMs = Math.max(0, now - anchor);
  const tier = CADENCE_LADDER.find((t) => quietMs < t.maxQuietMs) ?? CADENCE_LADDER.at(-1);

  // 草稿期间给档位设下限:**轮询粒度必须比复提醒闸门细,否则闸门兑现不了**。
  // 反例(cadence=1d + 闸门 24h,两者同粒度):某轮恰好落在 lastDraftReminderAt+23h,
  // 本轮未到点 → idle,而下一轮要等「本轮完成 + 24h」,于是实际提醒间隔接近 47 小时,
  // 而不是承诺的每天一次。下限由闸门推导(见 draftCadenceFloor),代价只是多几次
  // gate 查询 —— 零 agent token。
  const floor = state.wasDraft ? draftCadenceFloor(draftReminderMs) : null;
  if (floor && tier.intervalMs > floor.intervalMs) {
    return pick(
      floor,
      'draft-floor',
      `draft (quiet for about ${formatDuration(quietMs)}); cadence held at ${floor.label} to honour the ${formatDuration(draftReminderMs)} reminder`,
    );
  }
  return pick(tier, 'quiet', `about ${formatDuration(quietMs)} since the last change`);
}

/**
 * 调度触发间隔的容差:调度每 10 分钟触发一次,「上次检查 + 档位间隔」很少恰好落在某次
 * 触发上。留半个触发周期的余量,让 1h 档实际约 1h 一查,而不是被推到 1h10m。
 */
const CADENCE_SLACK_MS = 5 * 60_000;

/**
 * cadence 的执行者(纯函数,可测):按 suggestCadence 的档位,决定本轮是否不查 GitHub、
 * 直接跳过。返回 null = 照常查;否则返回 { cadence, nextCheckAt }。
 *
 * 只在「上次成功检查」之后计时(lastCheckedAt 只在拿到完整快照时写入);档位为最细
 * 一档(未确认变化、defer、NEEDS_WORK、合并队列、终态等)时从不节流,所以节流只会
 * 发生在 PR 确实安静的时候。代价与降档调度相同:安静越久,新变化被发现得越晚(最多
 * 一个档位间隔)。
 */
export function cadenceThrottle(state, now, draftReminderMs = DEFAULT_DRAFT_REMINDER_HOURS * 3_600_000) {
  if (!state || typeof state !== 'object') return null;
  const lastCheckedAt = Number(state.lastCheckedAt) || 0;
  if (!lastCheckedAt) return null;
  const cadence = suggestCadence(state, now, draftReminderMs);
  if (cadence.intervalMs <= CADENCE_LADDER[0].intervalMs) return null;
  const nextCheckAt = lastCheckedAt + cadence.intervalMs - CADENCE_SLACK_MS;
  return now < nextCheckAt ? { cadence, nextCheckAt } : null;
}

function usage(err = (text) => process.stderr.write(text)) {
  err(
    'Usage: node pr-heartbeat-gate.mjs <PR_URL|number> [--repo owner/name] ' +
      '[--ack] [--defer <minutes>] [--suggest] [--last-result] [--snapshot <path>] [--state-dir <dir>] ' +
      '[--max-snapshot-failures <n>] [--max-pass-attempts <n>] [--max-work-pending-passes <n>] ' +
      '[--retry-backoff-minutes <n>] [--max-silence-hours <n>] ' +
      '[--draft-reminder-hours <n>] [--no-cadence-throttle] [--json]\n',
  );
}

/** 参数解析。失败一律 throw,由 main 翻译成 fail-closed(确定性配置错误不该静默跳过)。 */
export function parseArgs(argv, env = process.env) {
  let spec;
  let repo;
  let deferMinutes;
  let ack = false;
  let suggest = false;
  let lastResult = false;
  let snapshot = env.PR_SNAPSHOT_SCRIPT?.trim() || DEFAULT_SNAPSHOT;
  let stateDir = env.CINDY_PR_STATE_DIR?.trim() || '';
  let maxSnapshotFailures = DEFAULT_MAX_SNAPSHOT_FAILURES;
  let maxPassAttempts = DEFAULT_MAX_PASS_ATTEMPTS;
  let maxWorkPendingPasses = DEFAULT_MAX_WORK_PENDING_PASSES;
  let retryBackoffMinutes = DEFAULT_RETRY_BACKOFF_MINUTES;
  let minPassSpacingMinutes = DEFAULT_MIN_PASS_SPACING_MINUTES;
  let maxSilenceHours = DEFAULT_MAX_SILENCE_HOURS;
  // 刻意不预设默认值:留 undefined 才能区分「没传」与「显式传了 24」——
  // 前者要允许从 state 继承(见 resolveDraftReminderMs),后者是显式覆盖。
  let draftReminderHours;
  let json = false;
  let cadenceThrottleEnabled = true;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--ack') {
      ack = true;
      continue;
    }
    if (arg === '--no-cadence-throttle') {
      cadenceThrottleEnabled = false;
      continue;
    }
    if (arg === '--suggest') {
      suggest = true;
      continue;
    }
    if (arg === '--last-result') {
      lastResult = true;
      continue;
    }
    if (arg === '--repo') {
      repo = argv[++i];
      continue;
    }
    if (arg === '--snapshot') {
      snapshot = argv[++i];
      continue;
    }
    if (arg === '--state-dir') {
      stateDir = argv[++i];
      continue;
    }
    if (arg === '--defer') {
      const raw = argv[++i];
      deferMinutes = Number(raw);
      if (!Number.isFinite(deferMinutes) || deferMinutes <= 0) {
        throw new Error(`--defer expects a positive number of minutes, got: ${raw}`);
      }
      continue;
    }
    if (arg === '--max-snapshot-failures') {
      const raw = argv[++i];
      maxSnapshotFailures = Number(raw);
      if (!Number.isInteger(maxSnapshotFailures) || maxSnapshotFailures < 1) {
        throw new Error(`--max-snapshot-failures expects a positive integer, got: ${raw}`);
      }
      continue;
    }
    if (arg === '--max-pass-attempts') {
      const raw = argv[++i];
      maxPassAttempts = Number(raw);
      if (!Number.isInteger(maxPassAttempts) || maxPassAttempts < 1) {
        throw new Error(`--max-pass-attempts expects a positive integer, got: ${raw}`);
      }
      continue;
    }
    if (arg === '--max-work-pending-passes') {
      const raw = argv[++i];
      maxWorkPendingPasses = Number(raw);
      if (!Number.isInteger(maxWorkPendingPasses) || maxWorkPendingPasses < 1) {
        throw new Error(`--max-work-pending-passes expects a positive integer, got: ${raw}`);
      }
      continue;
    }
    if (arg === '--max-silence-hours') {
      const raw = argv[++i];
      maxSilenceHours = Number(raw);
      if (!Number.isFinite(maxSilenceHours) || maxSilenceHours <= 0) {
        throw new Error(`--max-silence-hours expects a positive number, got: ${raw}`);
      }
      continue;
    }
    // 与上面几个不同:这里允许 0 = 关闭复提醒(只在转草稿那一次提醒)
    if (arg === '--draft-reminder-hours') {
      const raw = argv[++i];
      draftReminderHours = Number(raw);
      if (!Number.isFinite(draftReminderHours) || draftReminderHours < 0) {
        throw new Error(
          `--draft-reminder-hours expects a non-negative number (0 disables), got: ${raw}`,
        );
      }
      continue;
    }
    if (arg === '--retry-backoff-minutes') {
      const raw = argv[++i];
      retryBackoffMinutes = Number(raw);
      if (!Number.isFinite(retryBackoffMinutes) || retryBackoffMinutes <= 0) {
        throw new Error(`--retry-backoff-minutes expects a positive number, got: ${raw}`);
      }
      continue;
    }
    // 允许 0 = 关闭间隔判据(每次放行都计数,回到旧行为)
    if (arg === '--min-pass-spacing-minutes') {
      const raw = argv[++i];
      minPassSpacingMinutes = Number(raw);
      if (!Number.isFinite(minPassSpacingMinutes) || minPassSpacingMinutes < 0) {
        throw new Error(
          `--min-pass-spacing-minutes expects a non-negative number (0 disables), got: ${raw}`,
        );
      }
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    if (spec === undefined) {
      spec = arg;
      continue;
    }
    throw new Error(`unexpected extra argument: ${arg}`);
  }

  if (!spec) throw new Error('missing PR url or number');
  // --suggest / --last-result 是互斥的只读查询,--ack / --defer 要写状态。混用会让
  // 其中一个被静默跳过(dispatch 顺序决定谁赢),而"以为 ack 了其实没 ack"会让
  // 同一变化继续重试。fail-closed 拒绝,不猜意图。
  if (suggest && lastResult) {
    throw new Error('--suggest and --last-result are separate read-only queries');
  }
  if ((suggest || lastResult) && (ack || deferMinutes !== undefined)) {
    throw new Error(
      '--suggest / --last-result are read-only and cannot be combined with --ack / --defer; run them as separate commands',
    );
  }
  const target = parseTarget(spec, repo);
  return {
    help: false,
    spec,
    repo: target.repo,
    number: target.number,
    deferMinutes,
    ack,
    suggest,
    lastResult,
    snapshot,
    stateDir: stateDir || path.join(os.homedir(), '.cache', 'cindy-pr'),
    maxSnapshotFailures,
    maxPassAttempts,
    maxWorkPendingPasses,
    retryBackoffMs: Math.round(retryBackoffMinutes * 60_000),
    minPassSpacingMs: Math.round(minPassSpacingMinutes * 60_000),
    maxSilenceMs: Math.round(maxSilenceHours * 3_600_000),
    draftReminderMs:
      draftReminderHours === undefined ? undefined : Math.round(draftReminderHours * 3_600_000),
    json,
    cadenceThrottle: cadenceThrottleEnabled,
  };
}

/**
 * 解析出 repo + PR 号。刻意不从 cwd 的 git remote 推导:hook 的 cwd 是绑定会话的
 * 工作目录,对 PR 心跳来说未必是目标仓(也可能已被收口删掉),靠它推导会静默盯错
 * 仓库。所以要么给完整 URL,要么 PR 号 + --repo。
 */
export function parseTarget(spec, repoArg) {
  const url = /github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/.exec(spec);
  if (url) {
    return { repo: `${url[1]}/${url[2]}`, number: Number(url[3]) };
  }
  if (/^\d+$/.test(spec)) {
    const repo = repoArg?.trim();
    if (!repo) {
      throw new Error(
        'a bare PR number needs --repo owner/name (cwd is not a reliable repo source for PR heartbeats)',
      );
    }
    if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error(`invalid --repo value: ${repo}`);
    return { repo, number: Number(spec) };
  }
  throw new Error(`cannot parse PR target: ${spec}`);
}

export function stateFilePath(stateDir, repo, number) {
  return path.join(stateDir, `${repo.replace(/\//g, '__')}-${number}.json`);
}

function readState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    // 不存在 / 被截断 / 手改坏了:一律当没有历史(退化成首轮放行,方向保守)
    return null;
  }
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 临时文件 + rename:避免进程被 abort 树杀时留下半截 JSON
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 指纹只取语义稳定的标量与排序后的名字/id 列表。
 *
 * 绝不整块塞入 checks / threads 原始对象:`fetchedAt` 每轮都变,check run 的
 * `detailsUrl` / `startedAt` 每次重跑都变——任何抖动字段进了指纹,gate 就会永远
 * 判「有变化」,等于没装。反过来漏一个字段的后果只是「该唤起没唤起」,方向上
 * 宁可漏也不要抖。
 *
 * 注意 CI 状态变化不会更新 PR 的 updatedAt,review thread 的 resolve 也不一定会,
 * 所以 checks 与 threads 摘要必须各自进指纹,不能只靠 updatedAt。
 *
 * **合并态字段(mergeable / mergeStateStatus / mergeableState)与其推导物(verdict、
 * 合并态类 blockers)刻意不进指纹**:GitHub 在 base 移动等时机异步重算合并态,窗口内
 * 这些字段会瞬时变成 UNKNOWN/null 再变回来 —— 一次重算 = 成对的无谓唤起(2026-07-30
 * 实测:一个 PR 三连无变化唤起、另一个空转 21 轮,单轮 agent turn 可达数美元)。真正值得
 * 唤起的合并态信号只有「出现/解除真实冲突」,由 normalizeConflicting 归一提供:未知
 * 窗口沿用上次已知值(lastKnownConflicting,由状态文件跨轮携带),不抖。verdict 与
 * blockers 的其余信息量(checks、threads、reviewDecision、draft、state)都已各自
 * 独立进指纹,排除它们不丢真实信号。
 */

/** 由合并态推导、会随 GitHub 异步重算瞬时翻转的 blocker,不进指纹(见上方说明)。 */
const MERGE_STATE_BLOCKERS = new Set([
  'mergeability_pending',
  'merge_state_unstable',
  'merge_conflict',
  'branch_behind_base',
  'branch_protection_blocked',
]);

/**
 * 把合并态归一成稳定布尔「是否存在真实冲突」:
 * - 明确冲突(GraphQL CONFLICTING / REST mergeable=false / mergeStateStatus DIRTY)→ true
 * - 明确无冲突(MERGEABLE / true,或合并态已算出且非 DIRTY)→ false
 * - 未知窗口(GitHub 正在重算)→ 沿用 lastKnownConflicting;没有历史值时当 false
 *   (宁可漏一次冲突提醒 —— 下轮算出后会作为真实变化放行 —— 也不要抖)
 */
export function normalizeConflicting(snap, lastKnownConflicting = null) {
  const ms = snap?.mergeStateStatus ?? null;
  const m = snap?.mergeable ?? null;
  if (ms === 'DIRTY' || m === false || m === 'CONFLICTING') return true;
  if (m === true || m === 'MERGEABLE') return false;
  if (ms !== null && ms !== 'UNKNOWN') return false;
  return typeof lastKnownConflicting === 'boolean' ? lastKnownConflicting : false;
}

/** 合并态是否已算出(供 main 决定本轮要不要刷新 lastKnownConflicting)。 */
export function mergeSignalKnown(snap) {
  const ms = snap?.mergeStateStatus ?? null;
  const m = snap?.mergeable ?? null;
  if (ms === 'DIRTY' || m === false || m === 'CONFLICTING') return true;
  if (m === true || m === 'MERGEABLE') return true;
  return ms !== null && ms !== 'UNKNOWN';
}

export function fingerprintPayload(snap, lastKnownConflicting = null) {
  const checks = snap.checksSummary ?? {};
  const mergeQueue = mergeQueueFingerprint(snap.mergeQueue);
  const threads = snap.reviewThreads ?? {};
  const runNames = (runs) =>
    (runs ?? [])
      .map((r) => `${r?.name ?? ''}:${r?.status ?? ''}:${r?.conclusion ?? ''}`)
      .sort();

  return {
    updatedAt: snap.updatedAt ?? null,
    latestCommitOid: snap.latestCommitOid ?? null,
    // Queue position/time estimates are noise. No queue preserves the old fingerprint.
    ...(mergeQueue ? { mergeQueue } : {}),
    // 只在 CI 已失败时观察 base HEAD。这样 main 修好旧基线问题会立刻穿透退避；
    // 健康 PR / 单纯 pending CI 的 main 日常推进不改变旧指纹，也不会在上线时集体误唤醒。
    ...((snap.blockers ?? []).some(b => ['ci_failing', 'merge_queue_ci_failing'].includes(b)) && snap.baseCommitOid
      ? { ciFailingBaseCommitOid: snap.baseCommitOid }
      : {}),
    state: snap.state ?? null,
    closed: Boolean(snap.closed),
    merged: Boolean(snap.merged),
    isDraft: Boolean(snap.isDraft),
    reviewDecision: snap.reviewDecision ?? null,
    conflicting: normalizeConflicting(snap, lastKnownConflicting),
    blockers: [...(snap.blockers ?? [])].filter((b) => !MERGE_STATE_BLOCKERS.has(b)).sort(),
    checks: {
      total: checks.total ?? null,
      totalCount: checks.totalCount ?? null,
      pending: checks.pending ?? null,
      failed: checks.failed ?? null,
      actionRequired: checks.actionRequired ?? null,
      unavailable: Boolean(checks.unavailable),
      truncated: Boolean(checks.truncated),
      pendingRuns: runNames(checks.pendingRuns),
      failingRuns: runNames(checks.failingRuns),
      actionRequiredRuns: runNames(checks.actionRequiredRuns),
    },
    threads: {
      totalCount: threads.totalCount ?? null,
      activeUnresolvedCount: threads.activeUnresolvedCount ?? null,
      outdatedUnresolvedCount: threads.outdatedUnresolvedCount ?? null,
      rawUnresolvedCount: threads.rawUnresolvedCount ?? null,
      truncated: Boolean(threads.truncated),
      // 每条 thread:id + 解决态 + 评论数 + 最新评论时间,足够捕捉新回复与 resolve
      nodes: (threads.nodes ?? [])
        .map((t) => {
          const comments = t?.comments ?? [];
          const latest = comments
            .map((c) => c?.updatedAt ?? c?.createdAt ?? '')
            .sort()
            .at(-1);
          return [
            t?.id ?? '',
            t?.isResolved ? 1 : 0,
            t?.isOutdated ? 1 : 0,
            comments.length,
            latest ?? '',
          ].join('|');
        })
        .sort(),
    },
    reviews: (snap.reviews ?? [])
      .map((r) => `${r?.id ?? ''}:${r?.state ?? ''}:${r?.submittedAt ?? ''}`)
      .sort(),
    comments: (snap.comments ?? [])
      .map((c) => `${c?.id ?? ''}:${c?.updatedAt ?? c?.createdAt ?? ''}`)
      .sort(),
  };
}

export function fingerprint(snap, lastKnownConflicting = null) {
  return createHash('sha256')
    .update(JSON.stringify(fingerprintPayload(snap, lastKnownConflicting)))
    .digest('hex');
}

/**
 * 每个顶层指纹成分的短哈希。随状态文件逐轮保存,放行时与上一轮所见对比,把
 * 「这次到底是哪个字段变了」写进 detail —— 若再有抖动字段混进指纹,run 记录里
 * 一眼可见,不用再靠事后连抓两份快照推断(2026-07-30 的排障教训)。
 */
export function fingerprintFieldHashes(snap, lastKnownConflicting = null) {
  return Object.fromEntries(
    Object.entries(fingerprintPayload(snap, lastKnownConflicting)).map(([k, v]) => [
      k,
      createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex').slice(0, 12),
    ]),
  );
}

/** 与上一轮所见的逐字段哈希对比;旧状态还没有 fieldHashes 时返回 null(不猜)。 */
function diffFingerprintFields(prevFields, currentFields) {
  if (!prevFields || typeof prevFields !== 'object') return null;
  const keys = new Set([...Object.keys(prevFields), ...Object.keys(currentFields)]);
  const changed = [...keys].filter((k) => prevFields[k] !== currentFields[k]).sort();
  return changed.length ? changed.join(',') : null;
}

/**
 * 决策(纯函数,可测)。返回本轮退出码与**下一轮状态**,由 main 原样落库:
 *   { exitCode, reason, detail, fingerprint,
 *     nextConfirmed, nextPending, nextPendingCount, keepNextAllowAt }
 *
 * 判定一律拿 `previous.fingerprint`(已 --ack 确认处理完的指纹)比,而不是拿上一轮
 * 见过的指纹比 —— 见文件头「两段式」说明:放行后 agent 没能真正处理完时必须还能重试。
 *
 * 优先级:
 *   1. merged / closed         → 放行:收口(汇报 + 删调度 + cleanup)必须有 agent 出场
 *   2. 首轮(既无 confirmed 也无 pending) → 放行:先让 agent 建立基线
 *   3. 快照被截断              → 放行:数据不全时不得判定「无变化 / 已闭环」
 *   4. 与已确认指纹不同        → 放行:真实新变化(changed),或上一轮放行后未被确认
 *                                处理完的重试(retry-unacked)。每轮快速重试
 *                                maxPassAttempts 次后转入退避重试:到点放行一次
 *                                (retry-backoff-attempt),未到点跳过(retry-backoff),
 *                                直到被 --ack 确认 —— 永不放弃,也永不每轮无限唤起
 *   5. defer 未到点            → 跳过:agent 显式设定的提醒/退避节奏
 *   6. 纯人工批准等待         → 跳过:review thread 已明确要求指定批准人,agent 不应
 *                                把等待批准误当技术待办反复唤起;真实 review/CI/冲突变化仍穿透
 *   7. NEEDS_WORK              → 放行:还有活要干,不能因为 PR 侧没动就停手(本身就是
 *                                重试路径,不需要 pending 参与)。但同一个无变化状态
 *                                连续放行 maxWorkPendingPasses 轮后转入退避(与第 4 条
 *                                同款节奏):agent 确认过又推不动的活不该无限唤起,
 *                                真实变化仍随时走第 4 条穿透
 *   8. 其余(READY/WAITING_CI/
 *      BLOCKED_HUMAN/NOT_READY) → 跳过:在等外部,等到有变化再说
 */
export function decide({
  snap,
  previous,
  now,
  maxPassAttempts = DEFAULT_MAX_PASS_ATTEMPTS,
  maxWorkPendingPasses = DEFAULT_MAX_WORK_PENDING_PASSES,
  retryBackoffMs = DEFAULT_RETRY_BACKOFF_MINUTES * 60_000,
  minPassSpacingMs = DEFAULT_MIN_PASS_SPACING_MINUTES * 60_000,
  maxSilenceMs = DEFAULT_MAX_SILENCE_HOURS * 3_600_000,
  draftReminderMs = DEFAULT_DRAFT_REMINDER_HOURS * 3_600_000,
}) {
  const lastKnownConflicting =
    typeof previous?.lastKnownConflicting === 'boolean' ? previous.lastKnownConflicting : null;
  const current = fingerprint(snap, lastKnownConflicting);
  const confirmed = previous?.fingerprint;
  const pending = previous?.pendingFingerprint;
  const pendingCount = Number(previous?.pendingPassCount) || 0;
  // 上一轮 gate 见到的指纹(纯计数用):区分「PR 又变了」和「同一状态没被处理掉」
  const lastSeen = previous?.currentFingerprint;
  const sameAsLastSeen = lastSeen !== undefined && lastSeen === current;
  // 距上次放行太近 = 上一次放行没换来一轮真实处理(宿主顺延/spawn 失败/重启),
  // 本轮照常放行但不消耗额度。理由见 DEFAULT_MIN_PASS_SPACING_MINUTES 的注释。
  const lastPassAt = Number(previous?.lastPassAt) || 0;
  const emptyPass = minPassSpacingMs > 0 && lastPassAt > 0 && now - lastPassAt < minPassSpacingMs;
  // 排查时最想看到的一句:为什么连续放行了好几轮,计数却一直没动
  const emptyPassNote = emptyPass
    ? ` (previous release was only ${formatDuration(now - lastPassAt)} ago and produced no real run; not counted)`
    : '';

  /**
   * 放行并登记「已放行未确认」。每轮快速重试 maxPassAttempts 次后转入退避重试:
   * 既不永久放弃(那会漏事件),也不继续每轮唤起(那会无限烧 token)。
   */
  const passPending = (reason, detail) => {
    // pending 只记**最早一个**未确认的变化,不被后续轮次覆盖:agent 跑得比心跳间隔
    // 慢时,下一轮 gate 可能已经看到更新的指纹,而那个慢 agent 随后的无参数 --ack
    // 会把它从没处理过的指纹提升为 confirmed,把那次变化永久吞掉。保留最早值后,
    // confirmed 只会被提升到某个确实放行过的指纹,而只要 current 仍与 confirmed
    // 不同就会继续放行 —— 新变化不会丢。
    const nextPending = pending ?? current;
    // 计数衡量「同一个未处理状态被放行了几次」。PR 持续有新变化时每轮都该放行,
    // 所以按 current 是否与上一轮所见相同判定,而不是看 pending 在不在。
    const attempt = sameAsLastSeen ? Math.max(1, emptyPass ? pendingCount : pendingCount + 1) : 1;
    if (attempt > maxPassAttempts) {
      const backoffUntil = Number(previous?.retryBackoffUntil) || 0;
      if (backoffUntil > now) {
        return {
          exitCode: EXIT_SKIP,
          reason: 'retry-backoff',
          detail: `${detail}; retried ${pendingCount} times without --ack, next try at ${new Date(backoffUntil).toISOString()}`,
          fingerprint: current,
          nextConfirmed: confirmed,
          nextPending,
          // 本轮没放行,不累加尝试次数
          nextPendingCount: pendingCount,
          nextRetryBackoffUntil: backoffUntil,
        };
      }
      // 快速重试额度之外的都是退避周期;连续多个周期没被 ack,说明这条心跳反复没跑成
      const stuckCycles = attempt - maxPassAttempts;
      const stuckNote =
        stuckCycles >= STUCK_NOTIFY_BACKOFF_CYCLES
          ? `; ⚠️ the same change has gone unacknowledged for ${stuckCycles} backoff cycles: notify the user (schedule_notify_current_run) with what is stuck and what it is waiting for; do not keep retrying silently`
          : '';
      return {
        exitCode: EXIT_PASS,
        reason: 'retry-backoff-attempt',
        detail: `${detail}; attempt=${attempt} (backoff retry, next in ${Math.round(retryBackoffMs / 60_000)} min)${stuckNote}`,
        fingerprint: current,
        nextConfirmed: confirmed,
        nextPending,
        nextPendingCount: attempt,
        nextRetryBackoffUntil: now + retryBackoffMs,
      };
    }
    return {
      exitCode: EXIT_PASS,
      reason: attempt > 1 ? 'retry-unacked' : reason,
      detail: `${detail}; attempt=${attempt}/${maxPassAttempts}${emptyPassNote}`,
      fingerprint: current,
      nextConfirmed: confirmed,
      nextPending,
      nextPendingCount: attempt,
    };
  };

  if (snap.merged || snap.closed) {
    // 收口每轮都必须放行,不受 pending 上限约束(agent 收口失败就得再来一轮)
    return {
      exitCode: EXIT_PASS,
      reason: 'terminal',
      detail: snap.merged ? 'merged' : 'closed',
      fingerprint: current,
      nextConfirmed: confirmed,
      nextPending: pending ?? current,
      nextPendingCount: sameAsLastSeen ? pendingCount + 1 : 1,
    };
  }
  if (!confirmed && !pending) {
    return passPending('first-round', 'no previous state');
  }
  if (snap.gate?.truncated) {
    return passPending('truncated', 'snapshot truncated');
  }
  // 纯人工批准等待期间,CI 从 pending→pass、评论时间抖动等外部变化不需要
  // 再唤起 agent。只在上一轮已经确认这是 human-only 时自动吸收变化；首次
  // 退化成 human-only 仍放行一次,让 agent 看到并留下必要的收尾说明。
  if (current !== confirmed && previous?.humanOnlyPending === true && isHumanOnlyReviewPending(snap)) {
    return {
      exitCode: EXIT_SKIP,
      reason: 'blocked-human',
      detail: `${humanOnlyReviewDetail(snap)}; only external state changed, new fingerprint confirmed without waking the agent`,
      fingerprint: current,
      nextConfirmed: current,
      nextPending: null,
      nextPendingCount: 0,
    };
  }
  if (current !== confirmed) {
    // 草稿翻转单独给个 reason:run 记录里能一眼看出「就是这一轮被设成草稿的」,
    // SKILL.md 也有个具体串可以引用。仍然走 passPending —— 草稿转换是挂在
    // 人名下的阻塞事件,必须享受两段式指纹的重试保护,不能因一次建会话失败被吞掉。
    // previous.wasDraft 为 undefined(旧状态迁移)时不猜:当普通 changed 处理。
    const wasDraft = previous?.wasDraft;
    if (typeof wasDraft === 'boolean' && wasDraft !== Boolean(snap.isDraft)) {
      return passPending(
        snap.isDraft ? 'draft-entered' : 'draft-exited',
        snap.isDraft
          ? `PR was converted to draft (often because a change was asked to move to a separate discussion), verdict=${snap.verdict}`
          : `PR left draft, verdict=${snap.verdict}`,
      );
    }
    const changedKeys = diffFingerprintFields(
      previous?.fingerprintFields,
      fingerprintFieldHashes(snap, lastKnownConflicting),
    );
    return passPending(
      'changed',
      `verdict=${snap.verdict}${changedKeys ? `; changedFields=[${changedKeys}]` : ''}`,
    );
  }

  const nextAllowAt = Number(previous.nextAllowAt) || 0;
  if (nextAllowAt > now) {
    return {
      exitCode: EXIT_SKIP,
      reason: 'deferred',
      detail: `nextAllowAt=${new Date(nextAllowAt).toISOString()}`,
      fingerprint: current,
      nextConfirmed: confirmed,
      nextPending: pending ?? null,
      nextPendingCount: pendingCount,
      keepNextAllowAt: true,
    };
  }
  // 草稿复提醒:PR 还停在草稿里,且距上次草稿提醒已超过闸门 —— 复述一句,别让这件挂在
  // 人名下的事无声躺着。放在 defer 之后:agent 通知用户后往往会 --defer 240,那 4
  // 小时内不该重复打扰(defer 压不住 24h 闸门,所以第二天照样提醒)。放在保底巡检之前:
  // 草稿是更具体的原因,不该被笼统的 silence-guard 吃掉。
  //
  // 锚点回落链与写侧保持一致(lastDraftReminderAt → lastDraftEnteredAt → lastPassAt →
  // lastCheckedAt):旧版 gate 写的状态没有前两个字段,若这里直接当 0 处理,第一轮就会
  // 误判「已静默无限久」而立刻提醒;若直接当 now,则已卡了三天的草稿要再等一天才提醒。
  const draftAnchor =
    Number(previous.lastDraftReminderAt) ||
    Number(previous.lastDraftEnteredAt) ||
    Number(previous.lastPassAt) ||
    Number(previous.lastCheckedAt) ||
    0;
  if (snap.isDraft && draftReminderMs > 0 && draftAnchor > 0 && now - draftAnchor >= draftReminderMs) {
    return {
      exitCode: EXIT_PASS,
      reason: 'draft-reminder',
      // 与保底巡检同款:不产生 pending(这不是未处理的变化,漏一次下个窗口还会来)
      detail: `PR is still a draft, about ${formatDuration(now - draftAnchor)} since the last draft reminder; remind once (verdict=${snap.verdict})`,
      fingerprint: current,
      nextConfirmed: confirmed,
      nextPending: null,
      nextPendingCount: 0,
    };
  }
  // 保底巡检:确认过的状态但太久没有真正放行过 —— 指纹看不到的东西该让 AI 看一眼了。
  // 放在 defer 之后:agent 显式说过「别烦我」时先尊重它(defer 通常 ≤4h,压不住 24h 的闸门)。
  const silenceAnchor =
    Number(previous.lastPassAt) || Number(previous.lastChangedAt) || Number(previous.lastCheckedAt) || 0;
  if (silenceAnchor > 0 && now - silenceAnchor >= maxSilenceMs) {
    return {
      exitCode: EXIT_PASS,
      reason: 'silence-guard',
      // 刻意不产生 pending:这不是"未处理的变化",漏一次也不会丢事件,下一个闸门周期还会来
      detail: `the agent has not been woken for ${formatDuration(now - silenceAnchor)}; safety check-in (verdict=${snap.verdict})`,
      fingerprint: current,
      nextConfirmed: confirmed,
      nextPending: null,
      nextPendingCount: 0,
    };
  }
  if (isHumanOnlyReviewPending(snap)) {
    return {
      exitCode: EXIT_SKIP,
      reason: 'blocked-human',
      detail: humanOnlyReviewDetail(snap),
      fingerprint: current,
      nextConfirmed: confirmed,
      nextPending: null,
      nextPendingCount: 0,
    };
  }
  // 以下两条的前提是 current === confirmed(已确认处理过这个状态),pending 无意义,清掉
  if (snap.verdict === 'NEEDS_WORK') {
    const blockerList = [...(snap.blockers ?? [])].sort().join(',') || 'none';
    const actionableBlockers = [...new Set(snap.blockers ?? [])]
      .filter((b) => ACTIONABLE_WORK_BLOCKERS.has(b))
      .sort();
    const actionableNote = actionableBlockers.length
      ? `; agent-owned blocker=${actionableBlockers.join(',')}: technical review, CI, conflict and base sync must be pushed forward autonomously; do not just reply "waiting for the user" and --ack. When scope has grown, deleting, reverting or shrinking back to the original goal is technical convergence, not splitting the PR, and needs no user confirmation; only when keeping or adding complex machinery (concurrency, locks, caches, persistence, retries) or changing product behaviour, state the exact decision for the user and --defer 240`
      : '';
    // 同一个无变化状态的连续唤起计数;状态一变(指纹不同)自动从头数。
    // 上限与退避的理由见 DEFAULT_MAX_WORK_PENDING_PASSES 的注释。
    const sameState = previous?.workPendingFingerprint === current;
    const wpCount = sameState ? Number(previous?.workPendingPassCount) || 0 : 0;
    if (wpCount < maxWorkPendingPasses) {
      // 空放行(宿主顺延等)同样不计数,否则 agent 一次没跑就被压进短退避
      const attempt = Math.max(1, emptyPass ? wpCount : wpCount + 1);
      return {
        exitCode: EXIT_PASS,
        reason: 'work-pending',
        detail: `blockers=${blockerList}; attempt=${attempt}/${maxWorkPendingPasses}${emptyPassNote}${actionableNote}`,
        fingerprint: current,
        nextConfirmed: confirmed,
        nextPending: null,
        nextPendingCount: 0,
        nextWorkPendingCount: attempt,
        // 最后一轮快速唤起时顺手立好退避闸门:下一轮同状态直接进入退避,不再多烧一轮
        ...(attempt === maxWorkPendingPasses
          ? { nextWorkPendingBackoffUntil: now + retryBackoffMs }
          : {}),
      };
    }
    const backoffUntil = sameState ? Number(previous?.workPendingBackoffUntil) || 0 : 0;
    if (backoffUntil > now) {
      return {
        exitCode: EXIT_SKIP,
        reason: 'work-pending-backoff',
        detail: `blockers=${blockerList}; the same state was woken ${wpCount} times without progress, backing off until ${new Date(backoffUntil).toISOString()}. Backoff limits cost; it does not mean "no work"${actionableNote}`,
        fingerprint: current,
        nextConfirmed: confirmed,
        nextPending: null,
        nextPendingCount: 0,
        nextWorkPendingCount: wpCount,
        nextWorkPendingBackoffUntil: backoffUntil,
      };
    }
    // 超出快速唤起额度后的都是退避周期;连着几个周期状态一字不动 = 卡死,用户必须知道
    const wpStuckCycles = wpCount + 1 - maxWorkPendingPasses;
    const wpStuckNote =
      wpStuckCycles >= STUCK_NOTIFY_BACKOFF_CYCLES
        ? `; ⚠️ the same unchanged state has been stuck for ${wpStuckCycles} backoff cycles (over ${Math.round((wpStuckCycles * retryBackoffMs) / 3_600_000)} h): notify the user (schedule_notify_current_run) with what is stuck and what it is waiting for; do not keep waiting silently`
        : '';
    return {
      exitCode: EXIT_PASS,
      reason: 'work-pending-backoff-attempt',
      detail: `blockers=${blockerList}; attempt=${wpCount + 1} (backoff wake-up, next in ${Math.round(retryBackoffMs / 60_000)} min)${wpStuckNote}${actionableNote}`,
      fingerprint: current,
      nextConfirmed: confirmed,
      nextPending: null,
      nextPendingCount: 0,
      nextWorkPendingCount: wpCount + 1,
      nextWorkPendingBackoffUntil: now + retryBackoffMs,
    };
  }
  return {
    exitCode: EXIT_SKIP,
    reason: 'idle',
    detail: `verdict=${snap.verdict}`,
    fingerprint: current,
    nextConfirmed: confirmed,
    nextPending: null,
    nextPendingCount: 0,
  };
}

/**
 * 放行轮附加的机判提示(打进 detail,agent 每轮必看到)。纯函数,只读快照与回合数。
 *
 * 三类提示对应三种已实测过的失控模式(常量注释里有出处):
 *   1. 回合收敛 —— 回合数每轮如实报数,过检查点/收敛提醒线时直接给行动指令;
 *   2. 临门一脚 —— agent 可干的活将尽、只剩人类动作时,静默等待而不是继续找活;
 *   3. 无底洞 —— 单文件 thread 数超阈值时点名,提示划范围/转 issue。
 * 草稿与终态(merged/closed)轮不加:那两种状态各有自己的专用指令。
 */
export function passAdvisories(snap, roundCount, extras = {}) {
  const notes = [];
  if (Number.isFinite(roundCount) && roundCount > 0) {
    if (roundCount >= ROUND_HARD_STOP) {
      notes.push(
        `round=${roundCount} ⚠️ convergence mode (${ROUND_HARD_STOP} rounds): this is not a stop condition, but stop patching comment by comment. The goal is a mergeable PR: this round, group same-family issues per references/review-convergence.md §3/§6 and land one verifiable fix, or reply to out-of-scope feedback and resolve it, then continue with the remaining technical blockers; notify the user only if you decide to keep or add complex machinery (concurrency, locks, caches, persistence, retries). Also tell the user the round count and the failure families once`,
      );
    } else if (roundCount >= ROUND_CHECKPOINT) {
      notes.push(
        `round=${roundCount} ⚠️ past the convergence checkpoint (${ROUND_CHECKPOINT} rounds): before editing, ask "what is still between this PR and mergeable?", group feedback into failure families and complete the checkpoint (references/review-convergence.md §2), then fix each family in one go instead of patching comment by comment`,
      );
    } else {
      notes.push(`round=${roundCount}`);
    }
  }
  const blockers = snap.blockers ?? [];
  const humanBlockers = blockers.filter((b) => HUMAN_ONLY_BLOCKERS.has(b));
  const hardAgentWork = blockers.some((b) => HARD_AGENT_BLOCKERS.has(b));
  const activeUnresolved = Number(snap.reviewThreads?.unresolvedCount);
  if (humanBlockers.length && !hardAgentWork && Number.isFinite(activeUnresolved) && activeUnresolved <= 2) {
    notes.push(
      `almost there: only ${activeUnresolved} active thread(s) left and blockers include ${humanBlockers.join('/')} (only a human can move these). Finish the remaining threads, then wait **silently**: waiting for approval or merge is not a decision for the user, so do not notify, and do not widen the fix just to find work`,
    );
  }
  const additions = Number(snap.additions);
  const initialAdditions = Number(extras.initialAdditions);
  if (
    Number.isFinite(additions) &&
    Number.isFinite(initialAdditions) &&
    initialAdditions > 0 &&
    additions - initialAdditions >= SCOPE_GROWTH_MIN_LINES &&
    additions >= initialAdditions * SCOPE_GROWTH_MIN_RATIO
  ) {
    notes.push(
      `scope growth: the diff grew from +${initialAdditions} to +${additions} lines since following started. Machinery grown during review is usually forced by feedback (reviewers comment on the code that exists, not on the requirement). Ask "if the newly grown machinery were deleted, would the PR's original goal still hold?" If yes, delete or revert it this round and shrink back to the original goal: that is autonomous technical convergence, not splitting the PR, needs no user confirmation, and must not be parked behind --ack waiting for "scope confirmation". Only if the original goal fails without it, and you decide to keep or add complex machinery (concurrency, locks, caches, persistence, retries), ask the user first`,
    );
  }
  const threadsByPath = new Map();
  for (const t of snap.reviewThreads?.nodes ?? []) {
    if (!t?.path) continue;
    threadsByPath.set(t.path, (threadsByPath.get(t.path) ?? 0) + 1);
  }
  let hotPath = null;
  let hotCount = 0;
  for (const [p, n] of threadsByPath) {
    if (n > hotCount) {
      hotPath = p;
      hotCount = n;
    }
  }
  if (hotPath && hotCount >= HOTSPOT_THREAD_THRESHOLD) {
    notes.push(
      `hotspot: ${hotPath} has accumulated ${hotCount} review threads, a bottomless-pit signal: this code needs a redesign (remove the failure family) or a scope statement (reply to out-of-scope feedback and resolve), not more one-by-one fixes that only produce the next round of feedback`,
    );
  }
  return notes;
}

/** --ack / --defer 共用:把 pending 指纹提升为已确认。无 pending 时是 no-op。 */
function promotePending(state, now) {
  const pending = state.pendingFingerprint;
  if (!pending) return { ...state, lastAckAt: now };
  const next = { ...state, fingerprint: pending, lastAckAt: now };
  delete next.pendingFingerprint;
  delete next.pendingPassCount;
  // 重试结束,退避闸门一并清掉
  delete next.retryBackoffUntil;
  return next;
}

/** 跑快照。永不 throw:把退出码与输出原样交回,由调用方翻译成协议语义。 */
function runSnapshot(snapshotPath, repo, number) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [snapshotPath, String(number), '--repo', repo],
      { encoding: 'utf8', maxBuffer: SNAPSHOT_MAX_BUFFER },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          spawnError: err && typeof err.code !== 'number' ? err.message : undefined,
        });
      },
    );
  });
}

function emit(args, payload, out = (text) => process.stdout.write(text)) {
  if (args.json) {
    out(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  const decision =
    payload.exitCode === EXIT_PASS ? 'PASS' : payload.exitCode === EXIT_SKIP ? 'SKIP' : 'BLOCK';
  out(
    `[pr-heartbeat-gate] ${decision} ${payload.repo}#${payload.number} ` +
      `reason=${payload.reason}${payload.detail ? ` (${payload.detail})` : ''}\n`,
  );
}

/** Per-PR existing state owns backoff; no global lock or shared service. */
export function snapshotFailurePlan(run, previous, now, threshold = DEFAULT_MAX_SNAPSHOT_FAILURES) {
  const rateLimited = /rate limit|\[gh-rate-limit\]/i.test(run.stderr);
  const normalized = rateLimited ? 'rate-limit' : run.stderr.trim().split('\n').slice(-3).join(' ')
    .replace(/\b\d{4}-\d{2}-\d{2}T\S+/g, '<time>')
    .replace(/\b(?:request|trace)[-_ ]?id[=: ]+\S+/gi, 'request-id=<id>');
  const fingerprint = createHash('sha256').update(`${run.code}:${normalized}`).digest('hex');
  const failures = (Number(previous?.consecutiveSnapshotFailures) || 0) + 1;
  const eligible = rateLimited || failures >= threshold;
  const reports = Object.fromEntries(Object.entries(previous?.snapshotFailureReports ?? {})
    .filter(([, at]) => Number.isFinite(at) && at > now - 24 * 60 * 60_000));
  const alreadyReported = Number(reports[fingerprint]) > now - 24 * 60 * 60_000;
  const retryAt = Number(/\[gh-rate-limit\] retryAt=(\d+)/.exec(run.stderr)?.[1]);
  const until = eligible ? (rateLimited && retryAt > now ? retryAt + 1000 : now + 30 * 60_000) : 0;
  const block = eligible && !alreadyReported;
  if (block) reports[fingerprint] = now;
  return { failures, fingerprint, rateLimited, block, until, reports: Object.fromEntries(Object.entries(reports).slice(-8)) };
}

async function gateMain(argv, ctx) {
  const { env, out, err } = ctx;
  const args = parseArgs(argv, env);
  if (args.help) {
    usage(err);
    return EXIT_PASS;
  }

  const file = stateFilePath(args.stateDir, args.repo, args.number);
  const now = ctx.now();

  // --last-result:只读最近一轮普通 gate 的实际结果。preRunHook 本身只负责 run/skip；
  // 被 run 唤起的 AI 再结合这份 reason/detail 与 fresh snapshot 自主决定是否通知。
  if (args.lastResult) {
    const state = readState(file);
    const lastResult =
      state?.lastResult ??
      (state?.lastDecision
        ? {
            decision:
              state.lastDecision === 'pass'
                ? 'run'
                : state.lastDecision === 'block'
                  ? 'block'
                  : 'skip',
            reason: state.lastDecisionReason ?? 'unknown',
            checkedAt: state.lastCheckedAt ?? state.lastSnapshotFailureAt ?? null,
          }
        : null);
    emit(args, {
      exitCode: EXIT_PASS,
      repo: args.repo,
      number: args.number,
      reason: 'last-result',
      detail: lastResult
        ? `decision=${lastResult.decision} reason=${lastResult.reason}${lastResult.detail ? ` (${lastResult.detail})` : ''}`
        : 'no gate result recorded yet',
      lastResult,
    }, out);
    return EXIT_PASS;
  }

  // --suggest:只读状态文件给出 cadence 建议,不跑快照、不改状态(零 API 成本)
  if (args.suggest) {
    const state = readState(file);
    // 没显式传参时用普通 gate 轮落进 state 的闸门,否则短闸门会被默认 24h 顶掉
    const cadence = suggestCadence(state, now, resolveDraftReminderMs(args.draftReminderMs, state));
    emit(args, {
      exitCode: EXIT_PASS,
      repo: args.repo,
      number: args.number,
      reason: `suggest-${cadence.reason}`,
      detail: `cadence=${cadence.label} intervalMs=${cadence.intervalMs} cron="${cadence.cronExpr}" (${cadence.detail})`,
      cadence,
    }, out);
    return EXIT_PASS;
  }

  // --ack / --defer:纯管理命令,不跑快照、不做门禁判定(供 agent 收尾时调用)
  if (args.ack || args.deferMinutes !== undefined) {
    const previous = readState(file) ?? {};
    let next = promotePending(previous, now);
    let detail = `confirmed=${(next.fingerprint ?? '').slice(0, 12) || 'none'}`;
    if (args.deferMinutes !== undefined) {
      // defer 隐含 ack:显式推后提醒意味着这一轮已经处理完了
      const nextAllowAt = now + Math.round(args.deferMinutes * 60_000);
      // deferredHeadOid:把「当前 head 已用掉一次等待额度」持久化(回合制的机判依据)。
      // nextAllowAt 被穿透放行后会被消费掉,deferredAt 也只反映最近一次 defer 的时间;
      // 只有按 head 登记才能让 worker 在被 CI 变化等穿透唤醒后仍知道"这轮已经等过了"。
      // head 一变(新 push)由普通 gate 轮的写侧自动清掉,等待额度随新回合重置。
      next = {
        ...next,
        nextAllowAt,
        deferredAt: now,
        ...(next.headOid ? { deferredHeadOid: next.headOid } : {}),
      };
      detail += ` nextAllowAt=${new Date(nextAllowAt).toISOString()}`;
    }
    writeState(file, next);
    // 顺带给出 cadence 建议:agent 收尾只调一次命令就能拿到该设成多少,不必再问一遍。
    // 注意要用**写入后**的状态算(ack 已清掉 pending,否则会恒命中 unacked 档)。
    // 同上:闸门从 state 继承(next 由 previous 展开而来,带着它)
    const cadence = suggestCadence(next, now, resolveDraftReminderMs(args.draftReminderMs, next));
    detail += ` | cadence=${cadence.label} intervalMs=${cadence.intervalMs} cron="${cadence.cronExpr}" (${cadence.reason}: ${cadence.detail})`;
    emit(args, {
      exitCode: EXIT_PASS,
      repo: args.repo,
      number: args.number,
      reason: args.deferMinutes !== undefined ? 'defer-set' : 'acked',
      detail,
      cadence,
    }, out);
    return EXIT_PASS;
  }

  if (!fs.existsSync(args.snapshot)) {
    // 确定性配置错误:必须暴露,不能当瞬时抖动跳过
    throw new Error(`snapshot script not found: ${args.snapshot}`);
  }

  const previous = readState(file);
  // Persist CLI configuration even while snapshot requests are backing off.
  const effectiveDraftReminderMs =
    args.draftReminderMs ?? DEFAULT_DRAFT_REMINDER_HOURS * 3_600_000;
  if (Number(previous?.snapshotFailureBackoffUntil) > now) {
    const detail = `nextProbeAt=${new Date(previous.snapshotFailureBackoffUntil).toISOString()}`;
    const lastResult = { decision: 'skip', exitCode: EXIT_SKIP, reason: 'snapshot-failure-backoff', detail, checkedAt: now };
    writeState(file, { ...previous, draftReminderMs: effectiveDraftReminderMs, lastDecision: 'skip', lastDecisionReason: lastResult.reason, lastResult });
    emit(args, { ...lastResult, repo: args.repo, number: args.number }, out);
    return EXIT_SKIP;
  }
  const throttle = args.cadenceThrottle && cadenceThrottle(
    previous,
    now,
    resolveDraftReminderMs(args.draftReminderMs, previous),
  );
  if (throttle) {
    const detail = `cadence=${throttle.cadence.label} (${throttle.cadence.detail}); nextCheckAt=${new Date(throttle.nextCheckAt).toISOString()}`;
    const lastResult = { decision: 'skip', exitCode: EXIT_SKIP, reason: 'cadence-throttle', detail, checkedAt: now };
    writeState(file, { ...previous, lastDecision: 'skip', lastDecisionReason: lastResult.reason, lastResult });
    emit(args, { ...lastResult, repo: args.repo, number: args.number }, out);
    // 节流是健康的跳过(上次检查成功、只是还没到档位间隔),与普通 idle 轮一样标记成功。
    if (!args.json) out('CINDY_PRECHECK_OK\n');
    return EXIT_SKIP;
  }
  const run = await ctx.runSnapshot(args.snapshot, args.repo, args.number);

  let snap = null;
  if (run.code === 0) {
    try {
      snap = JSON.parse(run.stdout);
    } catch (err) {
      snap = null;
      run.stderr += `\n[gate] snapshot stdout is not valid JSON: ${err.message}`;
    }
  }

  // 普通故障容忍 N 轮抖动;明确限流立即退避,已提醒的故障不每轮重复报警。
  if (!snap) {
    const plan = snapshotFailurePlan(run, previous, now, args.maxSnapshotFailures);
    const { failures } = plan;
    const tail = run.stderr.trim().split('\n').slice(-3).join(' / ').slice(0, 500);
    const detail = `${plan.rateLimited ? 'rate limit; ' : ''}snapshotExit=${run.code} failures=${failures}/${args.maxSnapshotFailures}${tail ? ` stderr=${tail}` : ''}`;
    writeState(file, {
      ...(previous ?? {}),
      // 闸门与快照无关,失败轮也要落盘(见上面的说明)
      draftReminderMs: effectiveDraftReminderMs,
      consecutiveSnapshotFailures: failures,
      lastSnapshotFailureAt: now,
      snapshotFailureFingerprint: plan.fingerprint,
      snapshotFailureBackoffUntil: plan.until,
      snapshotFailureReports: plan.reports,
      lastDecision: plan.block ? 'block' : 'skip',
      lastDecisionReason: 'snapshot-failed',
      lastResult: {
        decision: plan.block ? 'block' : 'skip',
        exitCode: plan.block ? EXIT_BLOCK : EXIT_SKIP,
        reason: 'snapshot-failed',
        detail,
        checkedAt: now,
      },
    }, out);
    if (plan.block) {
      throw new Error(`PR snapshot failed ${failures} consecutive rounds; ${detail}`);
    }
    emit(args, {
      exitCode: EXIT_SKIP,
      repo: args.repo,
      number: args.number,
      reason: 'snapshot-failed',
      detail,
    }, out);
    return EXIT_SKIP;
  }

  const checkSucceeded = !snap.gate?.truncated && !snap.checksSummary?.unavailable
    && !(snap.blockers ?? []).includes('merge_queue_unavailable');
  const decision = decide({
    snap,
    previous,
    now,
    maxPassAttempts: args.maxPassAttempts,
    maxWorkPendingPasses: args.maxWorkPendingPasses,
    retryBackoffMs: args.retryBackoffMs,
    minPassSpacingMs: args.minPassSpacingMs,
    maxSilenceMs: args.maxSilenceMs,
    draftReminderMs: effectiveDraftReminderMs,
  });
  const passed = decision.exitCode === EXIT_PASS;
  // cadence 阶梯的锚点:只有「真的看到新东西」才刷新,同一状态的重试 / work-pending /
  // idle 都不算 —— 否则 quiet 永远归零,永远降不下来。truncated 数据不全,保守当变化。
  // 回落顺序与 suggestCadence 的读取侧保持一致:旧版 gate 写的状态没有 lastChangedAt,
  // 若这里直接落 now,第一个 idle / 重试 / work-pending 轮就会把锚点重置成"现在",
  // 把本可从 lastCheckedAt 推断出的安静时长抹掉(已安静 3 天的心跳会重新从 10m 起跳)。
  // draft-entered / draft-exited 是真实变化(该回弹到高频);draft-reminder 不是,
  // 与 silence-guard 一样刻意不刷新锚点,否则复提醒会把 cadence 自己拉回 10m。
  const isChange = ['changed', 'first-round', 'truncated', 'draft-entered', 'draft-exited'].includes(
    decision.reason,
  );
  const lastChangedAt = isChange
    ? now
    : Number(previous?.lastChangedAt) || Number(previous?.lastCheckedAt) || now;
  // 草稿闸门的锚点:只被草稿相关的放行推进,不被其它放行重置 —— 否则草稿期间来一次
  // 不相关的 CI 变化就把「等人回复」的钟推后一天,复提醒形同虚设。
  // 回落链与 decide() 的读侧逐项对齐(见那里的注释),避免迁移轮抹平可推断的等待时长。
  // 草稿期间把回落值**固化**下来,正是这一步让不相关的放行推不动这个钟:一旦落成具体
  // 时间戳,后面 lastPassAt 再怎么前进,读侧都优先取这个固化值。
  // 不在草稿时落 0(等价于不保留),下次真的转草稿时由 draft-entered 重新起钟。
  const draftReminderAnchor = ['draft-entered', 'draft-reminder'].includes(decision.reason)
    ? now
    : snap.isDraft
      ? Number(previous?.lastDraftReminderAt) ||
        Number(previous?.lastDraftEnteredAt) ||
        Number(previous?.lastPassAt) ||
        Number(previous?.lastCheckedAt) ||
        now
      : 0;
  // 回合状态:per-head 持久化,供「回合制与收敛止损」的机判使用(references/review-convergence.md)。
  // 这些信息理论上能从即时快照推导,但快照的 reviews 窗口只有 50 条、defer 痕迹又只活
  // 一轮,推导出的判据在边界上会失效 —— 所以由 gate 用确定性代码跨轮累积:
  // - headOid / roundCount:head 每变一次算新一轮,不受 reviews 窗口截断影响;
  // - reviewersSeen:见过的 review 作者全集(含人类与作者本人的 inline 回复,worker
  //   自行剔除后作为「应等待的 bot reviewer」集合);
  // - deferredHeadOid:当前 head 是否已用掉一次等待额度,head 变化即清零。
  const prevHeadOid = previous?.headOid ?? null;
  const headOid = snap.latestCommitOid ?? prevHeadOid ?? null;
  const headChanged = Boolean(snap.latestCommitOid) && snap.latestCommitOid !== prevHeadOid;
  // 首次建档(中途给老 PR 挂 gate / 状态文件丢失重建)不能从 1 起数,否则已打了十轮
  // 补丁的 PR 会被当成第 1 轮、永远够不到止损线 —— 用可见 reviews 窗口里不同的
  // review 目标 commit 数保守播种(窗口被截断时仍是下界,读侧另与快照近似取较大值)。
  const seededRounds = Math.max(
    1,
    new Set((snap.reviews ?? []).map((r) => r?.commitOid).filter(Boolean)).size,
  );
  const roundCount = !prevHeadOid
    ? Math.max(Number(previous?.roundCount) || 0, seededRounds)
    : headChanged
      ? (Number(previous?.roundCount) || 0) + 1
      : Number(previous?.roundCount) || seededRounds;
  const reviewersSeen = [
    ...new Set([
      ...(Array.isArray(previous?.reviewersSeen) ? previous.reviewersSeen : []),
      ...(snap.reviews ?? []).map((r) => r?.author).filter(Boolean),
    ]),
  ].sort();
  const deferredHeadOid = headChanged ? null : (previous?.deferredHeadOid ?? null);
  // 范围膨胀基线:首次见到有效 additions 时锚定,此后跨轮携带不变(中途建档的老 PR
  // 从建档时刻起算,增长只会被低估不会误报)。
  const initialAdditions = Number.isFinite(Number(previous?.initialAdditions))
    ? Number(previous.initialAdditions)
    : Number.isFinite(Number(snap.additions))
      ? Number(snap.additions)
      : undefined;
  // 机判提示打进放行 detail(回合止损/范围膨胀/临门一脚/无底洞,见 passAdvisories 注释)。
  // 草稿与终态(merged/closed)轮不掺和 —— 那两种状态各有专用指令。
  if (passed && !snap.merged && !snap.closed && !snap.isDraft) {
    const advisories = passAdvisories(snap, roundCount, { initialAdditions });
    if (advisories.length) decision.detail = `${decision.detail}; ${advisories.join('; ')}`;
  }
  // 合并态 carry-forward:本轮已算出就刷新,未知窗口(GitHub 重算中)保留上次已知值。
  // 指纹里的 conflicting 靠它在抖动窗口保持稳定;decide() 用的是 previous 里的值,
  // 与本轮持久化的新值天然衔接(下一轮的 previous 就是它)。
  const lastKnownConflicting = mergeSignalKnown(snap)
    ? normalizeConflicting(snap, null)
    : typeof previous?.lastKnownConflicting === 'boolean'
      ? previous.lastKnownConflicting
      : null;
  writeState(file, {
    // confirmed 指纹只由 --ack / --defer 推进,绝不在放行时直接推进
    ...(decision.nextConfirmed ? { fingerprint: decision.nextConfirmed } : {}),
    ...(decision.nextPending
      ? { pendingFingerprint: decision.nextPending, pendingPassCount: decision.nextPendingCount }
      : {}),
    ...(decision.nextRetryBackoffUntil
      ? { retryBackoffUntil: decision.nextRetryBackoffUntil }
      : {}),
    currentFingerprint: decision.fingerprint,
    lastChangedAt,
    verdict: snap.verdict ?? null,
    blockers: snap.blockers ?? [],
    // NEEDS_WORK 里若只剩明确的人工批准 thread,下一轮 gate 静默跳过而不是
    // 把同一状态再次当成 agent-owned work-pending。
    humanOnlyPending: isHumanOnlyReviewPending(snap),
    merged: Boolean(snap.merged),
    closed: Boolean(snap.closed),
    // 下一轮靠它判断草稿是否刚翻转(旧状态没有这个字段时 decide 不猜,当普通 changed)
    wasDraft: Boolean(snap.isDraft),
    // 让 --ack / --suggest 能拿到同一个闸门:它们的命令行按 skill 写法只带 PR URL
    draftReminderMs: effectiveDraftReminderMs,
    // writeState 是整对象替换,所以这两个字段每轮都要显式带上,否则下一轮就没了
    // (与上面 lastAckAt 同一套写法)。撤回草稿后不再保留,下次转草稿重新起算。
    ...(decision.reason === 'draft-entered'
      ? { lastDraftEnteredAt: now }
      : snap.isDraft && previous?.lastDraftEnteredAt
        ? { lastDraftEnteredAt: previous.lastDraftEnteredAt }
        : {}),
    ...(draftReminderAnchor > 0 ? { lastDraftReminderAt: draftReminderAnchor } : {}),
    url: snap.url ?? null,
    consecutiveSnapshotFailures: !checkSucceeded
      ? Number(previous?.consecutiveSnapshotFailures) || 0 : 0,
    ...(!checkSucceeded && previous?.snapshotFailureReports
      ? { snapshotFailureReports: previous.snapshotFailureReports } : {}),
    lastCheckedAt: now,
    lastDecision: passed ? 'pass' : 'skip',
    lastDecisionReason: decision.reason,
    lastResult: {
      decision: passed ? 'run' : 'skip',
      exitCode: decision.exitCode,
      reason: decision.reason,
      detail: decision.detail,
      verdict: snap.verdict ?? null,
      blockers: snap.blockers ?? [],
      checkedAt: now,
    },
    ...(previous?.lastAckAt ? { lastAckAt: previous.lastAckAt } : {}),
    // 跳过的轮次也要把上次放行时间带下去:writeState 是整对象替换,不显式携带就丢了,
    // 而「距上次放行多久」正是 decide 判定空放行(宿主顺延等)的唯一依据
    ...(passed
      ? { lastPassAt: now }
      : previous?.lastPassAt
        ? { lastPassAt: previous.lastPassAt }
        : {}),
    // 放行即消费掉 defer(下一轮由 agent 自己决定是否重新 defer);
    // 跳过时原样保留,否则 defer 永远只生效一轮。
    ...(decision.keepNextAllowAt ? { nextAllowAt: previous.nextAllowAt } : {}),
    // 回合状态(见上方注释):writeState 是整对象替换,必须显式带上才能跨轮存活
    ...(initialAdditions !== undefined ? { initialAdditions } : {}),
    ...(headOid ? { headOid, roundCount } : {}),
    ...(reviewersSeen.length ? { reviewersSeen } : {}),
    ...(deferredHeadOid ? { deferredHeadOid } : {}),
    // 合并态 carry-forward 与逐字段短哈希(变化定位诊断),同样每轮显式携带
    ...(typeof lastKnownConflicting === 'boolean' ? { lastKnownConflicting } : {}),
    fingerprintFields: fingerprintFieldHashes(
      snap,
      typeof previous?.lastKnownConflicting === 'boolean' ? previous.lastKnownConflicting : null,
    ),
    // work-pending 退避计数:decide 只在 NEEDS_WORK 分支给出新值;其它轮次(deferred /
    // draft-reminder / silence-guard 等)只要状态没变就原样携带,状态一变自动作废
    ...(decision.nextWorkPendingCount !== undefined
      ? {
          workPendingPassCount: decision.nextWorkPendingCount,
          workPendingFingerprint: decision.fingerprint,
          ...(decision.nextWorkPendingBackoffUntil
            ? { workPendingBackoffUntil: decision.nextWorkPendingBackoffUntil }
            : {}),
        }
      : previous?.workPendingFingerprint === decision.fingerprint
        ? {
            workPendingPassCount: previous.workPendingPassCount,
            workPendingFingerprint: previous.workPendingFingerprint,
            ...(previous.workPendingBackoffUntil
              ? { workPendingBackoffUntil: previous.workPendingBackoffUntil }
              : {}),
          }
        : {}),
  });

  emit(args, {
    exitCode: decision.exitCode,
    repo: args.repo,
    number: args.number,
    reason: decision.reason,
    detail: decision.detail,
    verdict: snap.verdict ?? null,
  }, out);
  // Optional host marker: healthy SKIP is recovery, backoff SKIP is not.
  if (!args.json && checkSucceeded) {
    out('CINDY_PRECHECK_OK\n');
  }
  return decision.exitCode;
}

/**
 * 把路径归一到真实路径;取不到(argv[1] 不是真实文件等)就原样返回,不为此中断启动。
 */
function realpathOrSelf(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

/**
 * 直接执行时才跑 main(被测试 import 时只取纯函数)。
 *
 * **两侧都要先归一到真实路径再比。** Cindy 把内置技能经软链(`.active` 等)投影给各 Agent,agent 会话
 * 里看到的 skill 目录就是那个软链路径;照它拼出的命令会让 `process.argv[1]` 带着软链前缀,
 * 而 `import.meta.url` 默认已被 Node 解析成真实路径 —— 两者不等,main 被静默跳过,脚本
 * exit 0 什么都不做。而 exit 0 在 preRunHook 协议里的语义恰好是「放行」,于是 gate 退化成
 * 「每轮无条件唤起 agent、一个判定都不做」,`--ack` 也一并静默失效(2026-08-01 实测)。
 *
 * 反向同样要防:`node --preserve-symlinks` 下反而是 `import.meta.url` 保留软链,所以不能
 * 只归一 argv 那一侧。
 */
/**
 * 可注入入口:CLI 与测试共用同一条判定路径。测试在进程内调用,注入时钟、快照执行器与输出,
 * 不必为每一轮各起两个 node 进程;CLI 使用真实实现。任何未预期错误按协议 fail-closed。
 */
export async function runGate(argv, {
  env = process.env,
  now = Date.now,
  runSnapshot: snapshotRunner = runSnapshot,
  out = (text) => process.stdout.write(text),
  err = (text) => process.stderr.write(text),
} = {}) {
  try {
    return await gateMain(argv, { env, now, runSnapshot: snapshotRunner, out, err });
  } catch (error) {
    err(`[pr-heartbeat-gate] ${error.message}\n`);
    return EXIT_BLOCK;
  }
}

const entryPath = process.argv[1] ? realpathOrSelf(process.argv[1]) : null;
if (entryPath && entryPath === realpathOrSelf(fileURLToPath(import.meta.url))) {
  runGate(process.argv.slice(2)).then((code) => process.exit(code));
}
