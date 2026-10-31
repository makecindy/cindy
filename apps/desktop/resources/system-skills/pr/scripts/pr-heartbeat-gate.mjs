#!/usr/bin/env node
/**
 * PR 心跳前置检查脚本(Cindy 自动化任务的 preRunHook gate)
 *
 * 只有 PR 上出现需要 AI 处理的新情况(事件)时才放行,并把「发生了什么」附在输出里;否则零
 * token 跳过本轮,绑定会话也不会被空转轮次污染。事件规则参考 T3 Code 的 PR watch:
 *   - 某个检查新失败了(同一个 head 上按名字只报一次);
 *   - 必需检查全部通过(没有必需检查时看全部),仍在跑的其它检查结束时再报一次;
 *   - 别人的新评论或 review(自己账号的不算);
 *   - 分支开始与 base 冲突;新 head 迟迟没有任何检查;
 *   - 草稿转换、合并队列出问题;合并或关闭(每轮放行,直到收口)。
 * 推送本身、检查在跑、失败一直没变,都不唤起。连续 10 次只有评论的唤起后要求停止跟进,
 * 防止与机器人来回回复。
 *
 * 退出码严格遵循宿主 preRunHook 协议:
 *   0  = 放行本轮(唤起 agent)
 *   2  = 跳过本轮(不建/不碰会话、不通知、照常重排下一次触发)
 *   其它 = fail-closed(阻止本轮并记 failed + 通知,让用户看见跟进坏了)
 *
 * 为什么必须包一层,不能直接把 pr-snapshot.mjs 填进 preRunHook.command:
 * pr-snapshot.mjs 查询失败时自己 exit 2,而 exit 2 在 preRunHook 协议里是「静默跳过」——
 * gh 掉线 / auth 过期 / rate limit 会被翻译成「本轮无事」,心跳就此无声死掉。本脚本把快照
 * 失败先容忍几轮瞬时抖动,连续失败到阈值才非零退出暴露出来。
 *
 * 状态文件刻意落在 worktree 之外(默认 ~/.cache/cindy-pr/):PR 心跳绑定的是被审查仓库的
 * worktree,收口时会被删掉。
 *
 * 状态是**两段式**的,这是正确性关键:`watch` 记 agent 已确认处理完的基线(由 --ack / --defer
 * 提升;没有新事件时直接前进),`pendingWatch` 记已放行但还没被确认的那一份。事件一律拿已确认
 * 的 watch 算 —— 所以放行之后宿主建会话失败、agent 启动失败或中途崩掉时,同一批事件下一轮
 * 还在,会被重试。`pendingWatch` 只登记**最早一份**:慢 agent 随后的 --ack 只能把基线推进到
 * 它确实被告知过的状态,之后的新事件仍会再报。
 *
 * 前提假设(改动心跳配置前必读):无参数 --ack 的正确性依赖「同一绑定会话上不会有两个
 * agent turn 并发」。PR 心跳固定 bindToCurrentSession=true,宿主对 heartbeat 撞忙会顺延本轮,
 * 同一 session 的 turn 串行。若将来改成非绑定 / 每轮新建会话 / 允许并发,必须让 ack 携带
 * 本轮的标识再提升。
 *
 * 成本:调度固定每 10 分钟触发。每次先跑一个很小的探测查询(pr-snapshot.mjs --probe),与上次
 * 完整读取一致就直接跳过;有变化、有未确认的放行、检查在跑或超过 30 分钟没完整读过时,才做
 * 完整快照(三四个接口)。
 *
 * 用法:
 *   node pr-heartbeat-gate.mjs <PR_URL|PR号> [--repo owner/name] [选项]
 *   node pr-heartbeat-gate.mjs <PR_URL|PR号> --ack [--repo owner/name]
 *   node pr-heartbeat-gate.mjs <PR_URL|PR号> --defer <分钟> [--repo owner/name]
 *   node pr-heartbeat-gate.mjs <PR_URL|PR号> --last-result [--json]
 *
 * 选项:
 *   --repo owner/name          PR 号形式时必填;URL 形式会自动解析
 *   --ack                      确认本轮已处理完:把 pendingWatch 提升为已确认,并退出 0。
 *                              心跳每轮收尾必须调它,否则同一批事件会被重放。
 *   --last-result              只读输出最近一轮普通 gate 的 run/skip/block、reason、detail 与
 *                              事件清单(零 API、不改状态)。
 *   --defer <分钟>             **隐含 --ack**,并约定到点再唤起一次(期间有新事件照常唤起)。
 *                              用于等一会儿再看,例如等这次推送的机器人 review。
 *   --snapshot <path>          pr-snapshot.mjs 路径(默认见 DEFAULT_SNAPSHOT)
 *   --state-dir <dir>          状态目录(默认 ~/.cache/cindy-pr,或 CINDY_PR_STATE_DIR)
 *   --max-snapshot-failures N  连续快照失败容忍轮数,超过则 fail-closed(默认 3)
 *                              明确限流首轮提醒并按响应头退避;同类故障一天内不重复提醒
 *   --max-pass-attempts N      同一批未确认事件每轮快速重试的次数上限(含首轮,默认 3);
 *                              用尽后转入退避重试,不放弃也不再每轮唤起
 *   --retry-backoff-minutes N  退避重试间隔(默认 30)
 *   --min-pass-spacing-minutes N  两次放行之间的最小有效间隔(默认 5):比这更密的放行
 *                              不计入重试计数 —— 宿主顺延、spawn 失败等「放行了但 agent 根本
 *                              没跑」不该消耗额度
 *   --max-silence-hours N      保底巡检闸门(默认 24):连续这么久没真正放行过就强制唤起一次
 *   --json                     决策以 JSON 输出(便于排查;不影响退出码)
 *   已退役、接受并忽略:--suggest(只读兼容输出)、--no-cadence-throttle、
 *   --draft-reminder-hours N、--max-work-pending-passes N
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
 */
const DEFAULT_MAX_SILENCE_HOURS = 24;

/**
 * 事件制唤醒(参考 T3 Code 的 PR watch):只有出现需要 agent 处理的新情况才唤起,同一件事只说一次。
 * 推送本身、检查从排队到运行、失败一直没变、我们自己的评论都不唤起 —— 实测(2026-09-26 至 10-31,
 * 本机 284 次唤起)41% 是同一个红灯被反复唤起,12% 是有变化但无事可做。
 */
/** 新 head 这么久还没有任何检查上报,告诉 agent 一次(仓库以前在这个 PR 上跑过检查时才算)。 */
const NO_CHECKS_MS = 15 * 60_000;
/** 连续只有评论的唤起达到这个数就停止跟进(防与机器人来回回复);检查、冲突或推送消息清零。 */
const COMMENT_WAKE_LIMIT = 10;
/** 新跟进的首次检查最多晚一个调度间隔,这段时间里别人的评论仍算新消息。 */
const FIRST_CHECK_LOOKBACK_MS = 10 * 60_000;
/** 低成本探测看不到 review thread 里的评论编辑,隔这么久无条件完整读一次。 */
const FULL_REREAD_MS = 30 * 60_000;
const LISTED_ITEMS = 10;
const SNIPPET_LENGTH = 200;

function formatDuration(ms) {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 6) / 10;
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

function usage(err = (text) => process.stderr.write(text)) {
  err(
    'Usage: node pr-heartbeat-gate.mjs <PR_URL|number> [--repo owner/name] ' +
      '[--ack] [--defer <minutes>] [--last-result] [--snapshot <path>] [--state-dir <dir>] ' +
      '[--max-snapshot-failures <n>] [--max-pass-attempts <n>] ' +
      '[--retry-backoff-minutes <n>] [--max-silence-hours <n>] [--json]\n',
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
  let retryBackoffMinutes = DEFAULT_RETRY_BACKOFF_MINUTES;
  let minPassSpacingMinutes = DEFAULT_MIN_PASS_SPACING_MINUTES;
  let maxSilenceHours = DEFAULT_MAX_SILENCE_HOURS;
  let json = false;

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
    // 已退役的选项:旧调度的 hook 可能还带着,接受并忽略,不让它们 fail-closed。
    if (arg === '--no-cadence-throttle') continue;
    if (arg === '--draft-reminder-hours' || arg === '--max-work-pending-passes') {
      i++;
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
    if (arg === '--max-silence-hours') {
      const raw = argv[++i];
      maxSilenceHours = Number(raw);
      if (!Number.isFinite(maxSilenceHours) || maxSilenceHours <= 0) {
        throw new Error(`--max-silence-hours expects a positive number, got: ${raw}`);
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
    retryBackoffMs: Math.round(retryBackoffMinutes * 60_000),
    minPassSpacingMs: Math.round(minPassSpacingMinutes * 60_000),
    maxSilenceMs: Math.round(maxSilenceHours * 3_600_000),
    json,
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

/* ── 事件 ─────────────────────────────────────────────────────────────── */

const isoAt = (ms) => new Date(ms).toISOString();

/** 快照里的检查结果:新快照自带 outcome,旧格式(测试夹具等)按状态推出来。 */
function checkOutcome(check) {
  if (check?.outcome) return check.outcome;
  const status = String(check?.status ?? '').toUpperCase();
  const conclusion = String(check?.conclusion ?? '').toUpperCase();
  if (check?.type === 'StatusContext') {
    if (['PENDING', 'EXPECTED'].includes(status)) return 'pending';
    return ['FAILURE', 'ERROR'].includes(status) ? 'failed' : 'passed';
  }
  if (status && status !== 'COMPLETED') return 'pending';
  if (!conclusion) return 'pending';
  return ['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(conclusion) ? 'passed' : 'failed';
}

/**
 * PR 上的全部留言:顶层评论、有内容或有结论的 review、review thread 里的评论。只有内容的
 * 「COMMENTED」空 review 不单列 —— 它的内容就是 thread 里的那几条评论。
 */
export function remarksOf(snap) {
  const out = [];
  for (const c of snap?.comments ?? []) {
    out.push({ id: c?.id, author: c?.author, at: c?.updatedAt ?? c?.createdAt, body: c?.body ?? '', path: null, url: c?.url ?? null });
  }
  for (const r of snap?.reviews ?? []) {
    const body = String(r?.body ?? '').trim();
    if (!body && ['COMMENTED', 'PENDING'].includes(r?.state)) continue;
    out.push({ id: r?.id, author: r?.author, at: r?.submittedAt, body, state: r?.state ?? null, path: null, url: r?.url ?? null });
  }
  for (const t of snap?.reviewThreads?.nodes ?? []) {
    for (const c of t?.comments ?? []) {
      out.push({ id: c?.id, author: c?.author, at: c?.updatedAt ?? c?.createdAt, body: c?.body ?? '', path: t?.path ?? null, url: c?.url ?? null });
    }
  }
  return out.filter((r) => r.id && Number.isFinite(Date.parse(r.at ?? '')));
}

const queueProblemsOf = (snap) =>
  [...new Set((snap?.mergeQueue?.blockers ?? []).filter((b) => b !== 'merge_queue_pending'))].sort();

/**
 * 新跟进的起点:检查从空白开始(这样失败、全部通过都会报一次),评论从首次检查前一个调度
 * 间隔起算 —— 开始跟进的那一轮 agent 已经处理过更早的评论。
 */
export function freshWatch(snap, now) {
  return {
    headSha: null,
    failedChecks: [],
    passed: false,
    passedChecks: [],
    owedChecks: [],
    remarksThrough: isoAt(now - FIRST_CHECK_LOOKBACK_MS),
    remarkIds: [],
    conflicting: false,
    isDraft: Boolean(snap?.isDraft),
    queueProblems: [],
    wakes: 0,
    checksAwaitedSince: null,
    everHadChecks: false,
  };
}

/**
 * 对比已确认的 watch 与这次快照,算出要告诉 agent 的事件和下一份 watch(纯函数)。规则与 T3 Code
 * 一致:每个 head 上新失败的检查(按名字)、必需检查全部通过(没有必需检查时看全部)、别人的新
 * 留言、开始冲突、新 head 迟迟没有检查;另加草稿转换与合并队列出问题。
 */
export function evaluateWatch(watch, snap, now, lastKnownConflicting = null) {
  const events = [];
  const headSha = snap?.latestCommitOid ?? null;
  const headMoved = headSha !== watch.headSha;

  // 读不到检查时(快照标了 unavailable)保留原状态,不把「没读到」当成「没有检查」。
  let failedChecks = headMoved ? [] : watch.failedChecks ?? [];
  let passed = headMoved ? false : Boolean(watch.passed);
  let passedChecks = headMoved ? [] : watch.passedChecks ?? [];
  let owedChecks = headMoved ? [] : watch.owedChecks ?? [];
  const checksUnavailable = Boolean(snap?.checksSummary?.unavailable);
  const checks = checksUnavailable ? [] : (snap?.checks ?? []).filter((c) => c?.name);
  if (checks.length > 0) {
    const failed = checks.filter((c) => checkOutcome(c) === 'failed');
    const newlyFailed = failed.filter((c) => !failedChecks.includes(c.name));
    if (newlyFailed.length > 0) events.push({ kind: 'checks-failed', failed: newlyFailed });
    failedChecks = failed.map((c) => c.name);

    const required = checks.filter((c) => c.required === true);
    const gate = required.length > 0 ? required : checks;
    const passedNow = gate.every((c) => checkOutcome(c) === 'passed');
    const gateNames = gate.map((c) => c.name);
    const told = passed && passedChecks.length === 0 ? gateNames : passedChecks;
    // 必需检查可能在两次检查之间新增;没有必需检查时不理会非必需检查的增减。
    const gateGrew = required.length > 0 && gateNames.some((name) => !told.includes(name));
    // 必需检查通过时仍在跑的其它检查,全部结束时再报一次;之后它们怎么变都不再唤起。
    const owed = passedNow && passed
      ? checks.filter((c) => c.required !== true && owedChecks.includes(c.name)).map((c) => c.name)
      : [];
    const settled = failed.length === 0 && checks.every((c) => checkOutcome(c) !== 'pending');
    owedChecks = owed;
    if (passedNow && (!passed || gateGrew)) {
      events.push({ kind: 'checks-passed', count: gate.length, required: required.length > 0 });
      owedChecks = required.length > 0
        ? checks.filter((c) => c.required !== true && checkOutcome(c) === 'pending').map((c) => c.name)
        : [];
    } else if (settled && owed.length > 0) {
      events.push({ kind: 'checks-passed', count: checks.length, required: false });
      owedChecks = [];
    }
    passed = passedNow;
    passedChecks = passedNow ? gateNames : [];
  }

  // 这个 PR 以前跑过检查,新 head 却迟迟没有任何检查:可能没触发,也可能被禁用了。
  const everHadChecks = Boolean(watch.everHadChecks) || checks.length > 0;
  let checksAwaitedSince = watch.checksAwaitedSince ?? null;
  if (!checksUnavailable && watch.everHadChecks) {
    const awaitedBefore = headMoved ? isoAt(now) : checksAwaitedSince;
    checksAwaitedSince = checks.length > 0 ? null : awaitedBefore;
    const awaitedMs = checksAwaitedSince === null ? 0 : now - Date.parse(checksAwaitedSince);
    if (awaitedMs >= NO_CHECKS_MS) {
      events.push({ kind: 'no-checks', minutes: Math.round(awaitedMs / 60_000) });
      checksAwaitedSince = null;
    }
  }

  // 别人的新留言;自己账号(agent 就用它回复)的不算。时间戳只到秒,同一秒的按 id 区分。
  const own = String(snap?.viewer ?? '').toLowerCase();
  const through = Date.parse(watch.remarksThrough) || 0;
  const fresh = remarksOf(snap).filter((r) => {
    const at = Date.parse(r.at);
    return (at > through || (at === through && !(watch.remarkIds ?? []).includes(r.id)))
      && !(own && String(r.author ?? '').toLowerCase() === own);
  }).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (fresh.length > 0) events.push({ kind: 'remarks', remarks: fresh });
  const latest = Math.max(through, ...fresh.map((r) => Date.parse(r.at)));
  const atLatest = fresh.filter((r) => Date.parse(r.at) === latest);
  const remarksThrough = latest === through ? watch.remarksThrough : isoAt(latest);
  const remarkIds = [...(latest === through ? watch.remarkIds ?? [] : []), ...atLatest.map((r) => r.id)];

  // 合并态未知(GitHub 还在算)时沿用上次的结论,只有明确的答案才清除冲突。
  const conflicting = normalizeConflicting(snap, lastKnownConflicting ?? Boolean(watch.conflicting));
  if (conflicting && !watch.conflicting) events.push({ kind: 'conflicting' });

  const isDraft = Boolean(snap?.isDraft);
  if (isDraft !== Boolean(watch.isDraft)) events.push({ kind: isDraft ? 'draft-entered' : 'draft-exited' });

  const queueProblems = queueProblemsOf(snap);
  if (queueProblems.some((b) => !(watch.queueProblems ?? []).includes(b))) {
    events.push({ kind: 'merge-queue', blockers: queueProblems, reason: snap?.mergeQueue?.reason ?? null });
  }

  const commentsOnly = events.length > 0 && events.every((e) => e.kind === 'remarks');
  const progress = headMoved || (events.length > 0 && !commentsOnly);
  const wakes = (progress ? 0 : Number(watch.wakes) || 0) + (commentsOnly ? 1 : 0);
  return {
    events,
    exhausted: commentsOnly && wakes >= COMMENT_WAKE_LIMIT,
    next: {
      headSha, failedChecks, passed, passedChecks, owedChecks, remarksThrough, remarkIds,
      conflicting, isDraft, queueProblems, wakes, checksAwaitedSince, everHadChecks,
    },
  };
}

/** 从旧版状态升级时的起点:把这次快照里的一切当作已知,不补报旧事。 */
export function watchFromSnapshot(snap, now, lastKnownConflicting = null) {
  const base = { ...freshWatch(snap, now), remarksThrough: isoAt(0), conflicting: normalizeConflicting(snap, lastKnownConflicting) };
  const { next } = evaluateWatch(base, snap, now, lastKnownConflicting);
  return { ...next, queueProblems: queueProblemsOf(snap), wakes: 0, checksAwaitedSince: null };
}

function snippet(body) {
  const text = String(body ?? '').replace(/<!--[\s\S]*?-->/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length <= SNIPPET_LENGTH ? text : `${text.slice(0, SNIPPET_LENGTH - 3)}...`;
}

function listed(items, line) {
  const lines = items.slice(0, LISTED_ITEMS).map(line);
  if (items.length > LISTED_ITEMS) lines.push(`  - and ${items.length - LISTED_ITEMS} more`);
  return lines;
}

/** 唤起 agent 时附上的「发生了什么」:具体到检查名、留言人和片段、链接,agent 不必再从头翻。 */
export function eventReport(events, snap, exhausted = false) {
  const commit = snap?.latestCommitOid ? ` on ${String(snap.latestCommitOid).slice(0, 7)}` : '';
  const base = snap?.baseRefName || 'the base branch';
  const lines = [];
  for (const e of events) {
    if (e.kind === 'checks-failed') {
      lines.push(`- Checks failed${commit}:`, ...listed(e.failed, (c) => {
        const outcome = String(c.conclusion ?? c.status ?? '').toLowerCase();
        return `  - ${c.name}${outcome && outcome !== 'failure' ? ` (${outcome})` : ''}${c.detailsUrl ? ` ${c.detailsUrl}` : ''}`;
      }));
    } else if (e.kind === 'checks-passed') {
      lines.push(`- All ${e.count} ${e.required ? 'required ' : ''}${e.count === 1 ? 'check' : 'checks'} passed${commit}.`);
    } else if (e.kind === 'remarks') {
      lines.push(`- ${e.remarks.length} new ${e.remarks.length === 1 ? 'comment' : 'comments'}:`, ...listed(e.remarks, (r) => {
        const body = snippet(r.body);
        const said = body ? `"${body}"` : String(r.state ?? 'reviewed').toLowerCase();
        return `  - ${r.author ?? 'someone'}${r.path ? ` on ${r.path}` : ''}: ${said}${r.url ? ` ${r.url}` : ''}`;
      }));
    } else if (e.kind === 'no-checks') {
      lines.push(`- No checks have reported${commit} after ${e.minutes} minutes, although this PR ran checks before. They may not have been triggered.`);
    } else if (e.kind === 'conflicting') {
      lines.push(`- The branch now conflicts with ${base}.`);
    } else if (e.kind === 'draft-entered') {
      lines.push('- The PR was converted to a draft.');
    } else if (e.kind === 'draft-exited') {
      lines.push('- The PR left draft and is ready for review.');
    } else if (e.kind === 'merge-queue') {
      lines.push(`- Merge queue problem: ${e.blockers.join(', ')}${e.reason ? ` (reason: ${e.reason})` : ''}.`);
    }
  }
  if (exhausted) {
    lines.push(`- This is the ${COMMENT_WAKE_LIMIT}th update in a row with only comments. Stop following: delete this schedule and tell the user why.`);
  }
  return lines.join('\n');
}

/** 这次要报的事件的身份:同一批事件重复放行才算重试。 */
function eventKey(events) {
  const parts = events.map((e) => {
    if (e.kind === 'checks-failed') return `${e.kind}:${e.failed.map((c) => c.name).sort().join(',')}`;
    if (e.kind === 'remarks') return `${e.kind}:${e.remarks.map((r) => `${r.id}@${r.at}`).sort().join(',')}`;
    if (e.kind === 'merge-queue') return `${e.kind}:${e.blockers.join(',')}`;
    return e.kind;
  });
  return createHash('sha256').update(parts.sort().join('\n')).digest('hex').slice(0, 16);
}

/**
 * 决策(纯函数,可测)。返回本轮退出码与**下一轮状态**,由 main 原样落库:
 *   { exitCode, reason, detail, report, fingerprint,
 *     nextWatch, nextPendingWatch, nextPendingKey, nextPendingCount, nextRetryBackoffUntil, keepNextAllowAt }
 *
 * 两段式:`watch` 是 agent 已确认处理完的基线(由 --ack / --defer 提升,或在没有新事件时直接
 * 前进),`pendingWatch` 是已放行、未确认的那一份。事件一律拿已确认的 watch 算,所以放行后
 * agent 没跑成时,同一批事件下一轮还在,会被重试。
 *
 * 优先级:
 *   1. merged / closed     → 放行:收口(汇报 + 删调度 + cleanup)必须有 agent 出场
 *   2. 快照被截断          → 放行:数据不全时不得判定「无变化」
 *   3. 只剩人工批准的等待  → 跳过并吸收变化(真实的检查失败、冲突不在此列)
 *   4. 有新事件            → 放行,附上事件清单;同一批事件未确认时按快速重试 + 退避重试
 *   5. 没有新事件          → 基线直接前进;defer 未到点、等人批准或空闲时跳过,
 *                            defer 到点或太久没唤起过(保底巡检)时放行一次
 */
export function decide({
  snap,
  previous,
  now,
  maxPassAttempts = DEFAULT_MAX_PASS_ATTEMPTS,
  retryBackoffMs = DEFAULT_RETRY_BACKOFF_MINUTES * 60_000,
  minPassSpacingMs = DEFAULT_MIN_PASS_SPACING_MINUTES * 60_000,
  maxSilenceMs = DEFAULT_MAX_SILENCE_HOURS * 3_600_000,
}) {
  const lastKnownConflicting =
    typeof previous?.lastKnownConflicting === 'boolean' ? previous.lastKnownConflicting : null;
  const current = fingerprint(snap, lastKnownConflicting);
  const pendingWatch = previous?.pendingWatch ?? null;
  const pendingKey = previous?.pendingKey ?? null;
  const pendingCount = Number(previous?.pendingPassCount) || 0;
  // 距上次放行太近 = 上一次放行没换来一轮真实处理(宿主顺延/spawn 失败/重启),
  // 本轮照常放行但不消耗额度。理由见 DEFAULT_MIN_PASS_SPACING_MINUTES 的注释。
  const lastPassAt = Number(previous?.lastPassAt) || 0;
  const emptyPass = minPassSpacingMs > 0 && lastPassAt > 0 && now - lastPassAt < minPassSpacingMs;
  const emptyPassNote = emptyPass
    ? ` (previous release was only ${formatDuration(now - lastPassAt)} ago and produced no real run; not counted)`
    : '';

  // 基线:新跟进从空白起;旧版 gate 留下的状态(只有指纹)从这次快照起,不补报旧事。
  const legacy = !previous?.watch && Boolean(previous?.fingerprint || previous?.pendingFingerprint);
  const baseline = previous?.watch
    ?? (legacy ? watchFromSnapshot(snap, now, lastKnownConflicting) : freshWatch(snap, now));
  const result = evaluateWatch(baseline, snap, now, lastKnownConflicting);
  const base = { fingerprint: current };

  /**
   * 放行并登记「已放行未确认」。同一批事件每轮快速重试 maxPassAttempts 次后转入退避重试:
   * 既不永久放弃(那会漏事件),也不继续每轮唤起(那会无限烧 token)。
   * pendingWatch 只记**最早一份**:慢 agent 随后的 --ack 只能确认它确实被告知过的状态。
   */
  const passPending = (reason, detail, report, key, nextWatch) => {
    const nextPendingWatch = pendingWatch ?? nextWatch;
    const attempt = pendingKey === key ? Math.max(1, emptyPass ? pendingCount : pendingCount + 1) : 1;
    const pending = { ...base, report, nextWatch: baseline, nextPendingWatch, nextPendingKey: key };
    if (attempt > maxPassAttempts) {
      const backoffUntil = Number(previous?.retryBackoffUntil) || 0;
      if (backoffUntil > now) {
        return {
          ...pending,
          exitCode: EXIT_SKIP,
          reason: 'retry-backoff',
          detail: `${detail}; released ${pendingCount} times without --ack, next try at ${isoAt(backoffUntil)}`,
          nextPendingCount: pendingCount,
          nextRetryBackoffUntil: backoffUntil,
        };
      }
      const stuckCycles = attempt - maxPassAttempts;
      const stuckNote = stuckCycles >= STUCK_NOTIFY_BACKOFF_CYCLES
        ? `; ⚠️ the same update has gone unacknowledged for ${stuckCycles} backoff cycles: notify the user (schedule_notify_current_run) with what is stuck; do not keep retrying silently`
        : '';
      return {
        ...pending,
        exitCode: EXIT_PASS,
        reason: 'retry-backoff-attempt',
        detail: `${detail}; attempt=${attempt} (backoff retry, next in ${Math.round(retryBackoffMs / 60_000)} min)${stuckNote}`,
        nextPendingCount: attempt,
        nextRetryBackoffUntil: now + retryBackoffMs,
      };
    }
    return {
      ...pending,
      exitCode: EXIT_PASS,
      reason: attempt > 1 ? 'retry-unacked' : reason,
      detail: `${detail}; attempt=${attempt}/${maxPassAttempts}${emptyPassNote}`,
      nextPendingCount: attempt,
    };
  };
  const skip = (reason, detail, nextWatch, extra = {}) => ({
    ...base, exitCode: EXIT_SKIP, reason, detail, nextWatch, nextPendingWatch: null, nextPendingKey: null, nextPendingCount: 0, ...extra,
  });

  if (snap.merged || snap.closed) {
    // 收口每轮都必须放行,不受重试上限约束(agent 收口失败就得再来一轮)
    return {
      ...base,
      exitCode: EXIT_PASS,
      reason: 'terminal',
      detail: snap.merged ? 'merged' : 'closed',
      nextWatch: baseline,
      nextPendingWatch: pendingWatch ?? result.next,
      nextPendingKey: 'terminal',
      nextPendingCount: pendingKey === 'terminal' ? pendingCount + 1 : 1,
    };
  }
  if (snap.gate?.truncated) {
    // 数据不全:不推进基线(确认后仍从原基线算,不会越过可能漏掉的留言)
    return passPending('truncated', 'snapshot truncated', '', 'truncated', baseline);
  }
  if (legacy && previous?.pendingFingerprint) {
    return passPending('upgraded', 'the follow-up check was upgraded while an update was still unacknowledged; look at the PR once', '', 'upgraded', result.next);
  }
  // 纯人工批准等待期间,外部变化(评论、检查通过)不再唤起 agent;首次退化成这种状态时
  // 仍按事件放行一次,让 agent 看到并留下必要的收尾说明。
  if (result.events.length > 0 && previous?.humanOnlyPending === true && isHumanOnlyReviewPending(snap)) {
    return skip('blocked-human', `${humanOnlyReviewDetail(snap)}; only external state changed, confirmed without waking the agent`, result.next);
  }
  if (result.events.length > 0) {
    const kinds = [...new Set(result.events.map((e) => e.kind))];
    const reason = result.exhausted ? 'comment-limit' : kinds.length === 1 && kinds[0].startsWith('draft-') ? kinds[0] : 'changed';
    return passPending(
      reason,
      `events=[${kinds.join(',')}]; verdict=${snap.verdict}`,
      eventReport(result.events, snap, result.exhausted),
      eventKey(result.events),
      result.next,
    );
  }

  // 没有新事件:推送、检查在跑、自己的评论这类变化直接并入基线,不唤起 agent。
  const changedKeys = diffFingerprintFields(previous?.fingerprintFields, fingerprintFieldHashes(snap, lastKnownConflicting));
  const quietNote = changedKeys ? `; no news in changedFields=[${changedKeys}]` : '';
  // defer = 「到点叫我,除非先有事」:未到点跳过,到点放行一次(放行即消费掉)。
  const nextAllowAt = Number(previous?.nextAllowAt) || 0;
  if (nextAllowAt > now) {
    return skip('deferred', `nextAllowAt=${isoAt(nextAllowAt)}${quietNote}`, result.next, { keepNextAllowAt: true });
  }
  if (nextAllowAt > 0) {
    return {
      ...base,
      exitCode: EXIT_PASS,
      reason: 'defer-expired',
      detail: `the wait you set with --defer is over and nothing new happened meanwhile (verdict=${snap.verdict})`,
      nextWatch: result.next,
      nextPendingWatch: null,
      nextPendingKey: null,
      nextPendingCount: 0,
    };
  }
  // 保底巡检:太久没有真正放行过 —— 指纹看不到的东西,以及 gate 自身的静默失效,让 AI 看一眼。
  const silenceAnchor = lastPassAt || Number(previous?.lastCheckedAt) || 0;
  if (silenceAnchor > 0 && now - silenceAnchor >= maxSilenceMs) {
    return {
      ...base,
      exitCode: EXIT_PASS,
      reason: 'silence-guard',
      detail: `the agent has not been woken for ${formatDuration(now - silenceAnchor)}; safety check-in (verdict=${snap.verdict})`,
      nextWatch: result.next,
      nextPendingWatch: null,
      nextPendingKey: null,
      nextPendingCount: 0,
    };
  }
  if (isHumanOnlyReviewPending(snap)) return skip('blocked-human', humanOnlyReviewDetail(snap), result.next);
  return skip('idle', `verdict=${snap.verdict}${quietNote}`, result.next);
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

/** --ack / --defer 共用:把已放行的 pendingWatch 提升为已确认。无 pending 时是 no-op。 */
function promotePending(state, now) {
  const next = { ...state, lastAckAt: now };
  if (state.pendingWatch) next.watch = state.pendingWatch;
  // 旧版 gate 留下的未确认指纹:确认后照旧前进,下一轮按新规则从快照建立基线
  if (state.pendingFingerprint) next.fingerprint = state.pendingFingerprint;
  for (const key of ['pendingWatch', 'pendingKey', 'pendingFingerprint', 'pendingPassCount', 'retryBackoffUntil']) delete next[key];
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

/** 低成本探测(pr-snapshot.mjs --probe)。永不 throw;失败时 gate 照常做完整读取。 */
function runProbe(snapshotPath, repo, number) {
  return new Promise((resolve) => {
    execFile(process.execPath, [snapshotPath, String(number), '--repo', repo, '--probe'], { encoding: 'utf8' },
      (err, stdout, stderr) => resolve({ code: err ? 1 : 0, stdout: stdout ?? '', stderr: stderr ?? '' }));
  });
}

function parseProbe(run) {
  if (run?.code !== 0) return null;
  try {
    const value = JSON.parse(run.stdout);
    return typeof value?.status === 'string' && typeof value?.remarks === 'string'
      ? { status: value.status, remarks: value.remarks } : null;
  } catch {
    return null;
  }
}

/**
 * 探测结果与上次完整读取时一致、且没有必须完整读取的理由时,本轮直接跳过。必须完整读取:
 * 还有未确认的放行、上次读到检查在跑或合并态未知、已合并/关闭、超过 30 分钟没完整读过、
 * 新 head 等检查的期限到了、保底巡检到点。
 */
export function probeAllowsSkip(previous, probe, now, maxSilenceMs = DEFAULT_MAX_SILENCE_HOURS * 3_600_000) {
  if (!probe || !previous?.watch || !previous.probe) return false;
  if (probe.status !== previous.probe.status || probe.remarks !== previous.probe.remarks) return false;
  if (previous.pendingWatch || previous.inFlight || previous.merged || previous.closed) return false;
  if ((Number(previous.nextAllowAt) || 0) > 0 && now >= Number(previous.nextAllowAt)) return false;
  if (!(now - (Number(previous.lastFullReadAt) || 0) < FULL_REREAD_MS)) return false;
  const awaited = previous.watch.checksAwaitedSince ? Date.parse(previous.watch.checksAwaitedSince) : NaN;
  if (Number.isFinite(awaited) && now - awaited >= NO_CHECKS_MS) return false;
  const silenceAnchor = Number(previous.lastPassAt) || Number(previous.lastCheckedAt) || 0;
  return !(silenceAnchor > 0 && now - silenceAnchor >= maxSilenceMs);
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
      `reason=${payload.reason}${payload.detail ? ` (${payload.detail})` : ''}\n` +
      (payload.report ? `${payload.report}\n` : ''),
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
  // 被 run 唤起的 AI 再结合这份 reason/detail/report 与 fresh snapshot 自主决定是否通知。
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
      report: lastResult?.report,
      lastResult,
    }, out);
    return EXIT_PASS;
  }

  // --suggest 已退役:检查不再降频(每次先做一个低成本探测),保留只读兼容输出。
  if (args.suggest) {
    emit(args, {
      exitCode: EXIT_PASS,
      repo: args.repo,
      number: args.number,
      reason: 'suggest-fixed',
      detail: 'the check no longer changes its pace; keep the 10-minute schedule',
    }, out);
    return EXIT_PASS;
  }

  // --ack / --defer:纯管理命令,不跑快照、不做门禁判定(供 agent 收尾时调用)
  if (args.ack || args.deferMinutes !== undefined) {
    const previous = readState(file) ?? {};
    let next = promotePending(previous, now);
    let detail = next.watch ? `confirmed head=${String(next.watch.headSha ?? 'none').slice(0, 7)}` : 'confirmed';
    if (args.deferMinutes !== undefined) {
      // defer 隐含 ack,并约定到点再唤起一次;期间新事件照常唤起。
      // deferredHeadOid:当前 head 已用掉一次等待额度(回合制机判依据),head 一变由普通轮清掉。
      const nextAllowAt = now + Math.round(args.deferMinutes * 60_000);
      next = {
        ...next,
        nextAllowAt,
        deferredAt: now,
        ...(next.headOid ? { deferredHeadOid: next.headOid } : {}),
      };
      detail += ` nextAllowAt=${new Date(nextAllowAt).toISOString()}`;
    }
    writeState(file, next);
    emit(args, {
      exitCode: EXIT_PASS,
      repo: args.repo,
      number: args.number,
      reason: args.deferMinutes !== undefined ? 'defer-set' : 'acked',
      detail,
    }, out);
    return EXIT_PASS;
  }

  if (!fs.existsSync(args.snapshot)) {
    // 确定性配置错误:必须暴露,不能当瞬时抖动跳过
    throw new Error(`snapshot script not found: ${args.snapshot}`);
  }

  const previous = readState(file);
  if (Number(previous?.snapshotFailureBackoffUntil) > now) {
    const detail = `nextProbeAt=${new Date(previous.snapshotFailureBackoffUntil).toISOString()}`;
    const lastResult = { decision: 'skip', exitCode: EXIT_SKIP, reason: 'snapshot-failure-backoff', detail, checkedAt: now };
    writeState(file, { ...previous, lastDecision: 'skip', lastDecisionReason: lastResult.reason, lastResult });
    emit(args, { ...lastResult, repo: args.repo, number: args.number }, out);
    return EXIT_SKIP;
  }
  // 先问一句「有没有变」:一个很小的查询,与上次完整读取时一致就不做三四个接口的完整读取。
  const probe = parseProbe(await ctx.runProbe(args.snapshot, args.repo, args.number));
  if (probeAllowsSkip(previous, probe, now, args.maxSilenceMs)) {
    const lastResult = { decision: 'skip', exitCode: EXIT_SKIP, reason: 'unchanged', detail: 'probe matches the last full read', checkedAt: now };
    writeState(file, { ...previous, lastProbeAt: now, lastDecision: 'skip', lastDecisionReason: lastResult.reason, lastResult });
    emit(args, { ...lastResult, repo: args.repo, number: args.number }, out);
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
    retryBackoffMs: args.retryBackoffMs,
    minPassSpacingMs: args.minPassSpacingMs,
    maxSilenceMs: args.maxSilenceMs,
  });
  const passed = decision.exitCode === EXIT_PASS;
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
  const lastKnownConflicting = mergeSignalKnown(snap)
    ? normalizeConflicting(snap, null)
    : typeof previous?.lastKnownConflicting === 'boolean'
      ? previous.lastKnownConflicting
      : null;
  // 上次读到检查在跑或合并态还没算出:下一轮不靠探测跳过,直接完整读取。
  const inFlight = !mergeSignalKnown(snap) || (snap.checks ?? []).some((c) => checkOutcome(c) === 'pending');
  writeState(file, {
    // watch 只由 --ack / --defer 或「没有新事件」推进,放行时不推进
    watch: decision.nextWatch,
    ...(decision.nextPendingWatch
      ? {
          pendingWatch: decision.nextPendingWatch,
          pendingKey: decision.nextPendingKey,
          pendingPassCount: decision.nextPendingCount,
        }
      : {}),
    ...(decision.nextRetryBackoffUntil ? { retryBackoffUntil: decision.nextRetryBackoffUntil } : {}),
    // 旧版状态的未确认指纹:在 agent 确认前保留,让升级那一轮能继续按未确认处理
    ...(previous?.pendingFingerprint && !previous?.watch && decision.nextPendingWatch
      ? { pendingFingerprint: previous.pendingFingerprint } : {}),
    currentFingerprint: decision.fingerprint,
    verdict: snap.verdict ?? null,
    blockers: snap.blockers ?? [],
    // NEEDS_WORK 里若只剩明确的人工批准 thread,下一轮 gate 静默跳过
    humanOnlyPending: isHumanOnlyReviewPending(snap),
    merged: Boolean(snap.merged),
    closed: Boolean(snap.closed),
    url: snap.url ?? null,
    ...(probe ? { probe } : {}),
    inFlight,
    lastFullReadAt: now,
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
      ...(decision.report ? { report: decision.report } : {}),
      verdict: snap.verdict ?? null,
      blockers: snap.blockers ?? [],
      checkedAt: now,
    },
    ...(previous?.lastAckAt ? { lastAckAt: previous.lastAckAt } : {}),
    // 跳过的轮次也要把上次放行时间带下去:「距上次放行多久」是空放行与保底巡检的依据
    ...(passed
      ? { lastPassAt: now }
      : previous?.lastPassAt
        ? { lastPassAt: previous.lastPassAt }
        : {}),
    // 放行即消费掉 defer;跳过时原样保留,否则 defer 永远只生效一轮。
    ...(decision.keepNextAllowAt ? { nextAllowAt: previous.nextAllowAt } : {}),
    // 回合状态(见上方注释):writeState 是整对象替换,必须显式带上才能跨轮存活
    ...(initialAdditions !== undefined ? { initialAdditions } : {}),
    ...(headOid ? { headOid, roundCount } : {}),
    ...(reviewersSeen.length ? { reviewersSeen } : {}),
    ...(deferredHeadOid ? { deferredHeadOid } : {}),
    ...(typeof lastKnownConflicting === 'boolean' ? { lastKnownConflicting } : {}),
    fingerprintFields: fingerprintFieldHashes(
      snap,
      typeof previous?.lastKnownConflicting === 'boolean' ? previous.lastKnownConflicting : null,
    ),
  });

  emit(args, {
    exitCode: decision.exitCode,
    repo: args.repo,
    number: args.number,
    reason: decision.reason,
    detail: decision.detail,
    report: decision.report,
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
  runProbe: probeRunner = runProbe,
  out = (text) => process.stdout.write(text),
  err = (text) => process.stderr.write(text),
} = {}) {
  try {
    return await gateMain(argv, { env, now, runSnapshot: snapshotRunner, runProbe: probeRunner, out, err });
  } catch (error) {
    err(`[pr-heartbeat-gate] ${error.message}\n`);
    return EXIT_BLOCK;
  }
}

const entryPath = process.argv[1] ? realpathOrSelf(process.argv[1]) : null;
if (entryPath && entryPath === realpathOrSelf(fileURLToPath(import.meta.url))) {
  runGate(process.argv.slice(2)).then((code) => process.exit(code));
}
