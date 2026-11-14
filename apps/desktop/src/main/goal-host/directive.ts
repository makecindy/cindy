/**
 * Goal 每轮指令构造 —— 纯函数。
 *
 * 把"目标 + 裁决约定"拼成一段文本,**追加到 user message 末尾**发给 agent
 * (与 scheduler 的 buildSilentRunInstruction 同款:per-call user 后缀,**不进
 * system prompt**,不污染 prompt cache 前缀,不触发规则 11 的系统提示词审批)。
 *
 * 这是方案里"交给模型自由发挥"的唯一部分:模型读目标、自己决定下一步动作、
 * 并在末尾按约定吐裁决块。是否续跑、预算、空轮、终态等确定性逻辑全在
 * controller / verdict 的代码里(规则 9)。
 */

import type { GoalVerdictStatus } from './verdict.js';

/**
 * 裁决块约定 —— 同时被 verdict.ts 的解析逻辑认。两边改要一起改。
 *
 * includeRefinedObjective(仅首轮 true):把可选的 refined_objective 字段**放进裁决块
 * 模板本身**。关键 —— 模型可靠遵守"end with EXACTLY this block"的模板复制行为(它每轮
 * 都吐 goal_status),所以"改写目标"这个字段必须长在模板里;若只在别处用一段话嘱咐它
 * "记得加 refined_objective",模型照模板吐块时就会漏掉(实测如此)。措辞=语言活归模型,
 * 解析+落库=确定性归 controller/verdict(规则 9)。
 */
function buildVerdictContract(includeRefinedObjective: boolean): string {
  const blockLine = includeRefinedObjective
    ? '{"goal_status":"complete|continue|blocked|waiting","reason":"<one short sentence>","refined_objective":"<OPTIONAL — see rule below; omit unless you clarified a vague goal this turn>"}'
    : '{"goal_status":"complete|continue|blocked|waiting","reason":"<one short sentence>"}';
  const lines = [
    'When you finish working this turn, end your reply with EXACTLY this fenced block (and nothing after it):',
    '',
    '```json',
    blockLine,
    '```',
    '',
    'Rules for the verdict:',
    '- "complete": the goal is verifiably done. Before claiming this, actually run the check (tests/build/etc.) and show its output this turn.',
    '- "continue": real work remains; you made progress and want another turn.',
    '- "blocked": you cannot proceed without human input (a decision, a credential, or an action you are not permitted to take). Put what you need in "reason".',
    '- "waiting": nothing actionable THIS turn because progress depends on events outside this session (another agent must deliver work, a long-running external process, or the user). Auto-continuation pauses and the system wakes you when new input arrives. NEVER use waiting to dodge work: if you could do anything useful this turn, do it and use "continue". Do not re-check unchanged state turn after turn — emit waiting instead.',
  ];
  if (includeRefinedObjective) {
    lines.push(
      '- "refined_objective": OPTIONAL. Include this field ONLY if you used AskUserQuestion this turn to clarify a vague goal and now have a concrete one. Set it to the sharpened goal in the user\'s own language (one clear sentence based on their answer) — the system will replace the stored goal with it. If you did not clarify the goal, or the user chose to keep it as-is, OMIT this field entirely.',
    );
  }
  lines.push('Do real work with tools each turn — do not just chat. When you truly have nothing to do, end the turn with "waiting" instead of a no-progress "continue". Emit the verdict block every turn.');
  return lines.join('\n');
}

const SEPARATOR = '\n\n---\n';

/**
 * 首轮质量自检约定 —— 用模型**自带的 AskUserQuestion 工具**与用户确认,
 * 复用 app 原生的交互问答 UI(不再自绘 chip、不再吐自定义块)。
 *
 * 设计意图:只在 agent **真有具体顾虑**时才打断;没顾虑就零摩擦直接开干。措辞反复
 * 强调"没顾虑就别问",避免模型动不动弹问答卡(那会退化回旧 intake 的摩擦)。
 * 这是"交给模型自由发挥"的部分:是否问、问什么由模型判断;用户的回答经原生交互
 * 链路回到模型,模型据此继续推进(本轮不暂停,见三种交互均不暂停的约定)。
 *
 * ⚠️ 与 controller 耦合:下面要求澄清问题**必含一个 label = 用户原目标 verbatim 的选项**。
 * 这个选项除了"让用户可保持原目标",还被 controller.questionsLookLikeGoalClarification 当作
 * 确定性标记——据此把"答案即时改写目标"(Option B)严格限定在真正的目标澄清问题上,不被普通
 * 工作型提问误触。删/改这个选项约定时必须同步改 controller(否则目标改写会失效或被误触)。
 */
function buildClarifyContract(maxTurns: number | null): string {
  const lines = [
    'Before doing substantial work, do a quick one-time sanity check of this goal:',
    '- Is the goal clear and specific enough to pursue autonomously and to define what "complete" means?',
  ];
  if (maxTurns != null) {
    lines.push(`- The current turn budget is ${maxTurns} turns — is that plausibly enough for this goal's scope?`);
  }
  lines.push(
    '',
    'If the goal is already clear and specific, do NOT ask anything — just start working toward it. Asking when there is no genuine problem wastes the user\'s time.',
    '',
    'BUT if the goal is too vague or open-ended to know when it would be "complete" — for example a single word or a bare one-liner like "think about it", "take a look", or "improve things" — then you DO have a real concern, so call the AskUserQuestion tool ONCE before working. Frame the options as concrete candidate goals: each option label should itself BE a specific, self-contained goal you could actually pursue and verify (not "what do you want me to do?") — the option label IS the goal. Also include one option whose label is the user\'s original goal verbatim (so picking it keeps the goal unchanged). The system uses the option the user picks as the goal directly, so write each label as the exact goal statement. When the goal is genuinely underspecified, prefer asking via AskUserQuestion over either guessing what the user meant or stalling.' +
      (maxTurns != null
        ? ' Use AskUserQuestion the same way if the turn budget looks clearly too small for the goal.'
        : ''),
    '',
    'After the user answers, pursue the concrete goal their answer points to. If that goal is sharper than what they originally typed, report it via the "refined_objective" field of your verdict block (described below) so the system updates the stored goal to match.',
    '',
    'Reserve "goal_status":"blocked" for a different situation: only end the turn as blocked (instead of asking) if making progress would require a dangerous or irreversible action, a credential, or a permission you do not have — NOT merely because the goal is vague. A vague goal is a reason to ask via AskUserQuestion, never a reason to block.',
  );
  return lines.join('\n');
}

/**
 * 首轮指令:用户的目标条件 + 首轮质量自检约定 + 裁决约定。
 * objective 原样透传(用户写什么就是什么),约定附在后面。
 * opts.maxTurns 让模型据当前轮次预算判断上限是否合理(null = 未设上限,不提预算)。
 */
export function buildFirstTurnDirective(
  objective: string,
  opts?: { maxTurns?: number | null },
): string {
  return [
    `[Goal] Work autonomously toward this goal across multiple turns until it is met:`,
    '',
    objective.trim(),
    SEPARATOR.trimStart(),
    buildClarifyContract(opts?.maxTurns ?? null),
    SEPARATOR.trimStart(),
    // 首轮带 refined_objective 字段(澄清含糊目标后回报具体目标)。
    buildVerdictContract(true),
  ].join('\n');
}

/**
 * 续轮指令:提醒目标 + 上一轮裁决理由(若有)+ 裁决约定。
 * 每个续轮都是一条新的 user message(controller 通过 session.send 发起)。
 */
export function buildContinuationDirective(objective: string, lastReason?: string | null): string {
  const reasonLine = lastReason && lastReason.trim()
    ? `\nLast status note: ${lastReason.trim()}`
    : '';
  return [
    `[Goal] Continue working toward this goal:`,
    '',
    objective.trim(),
    reasonLine ? reasonLine.trimStart() : '',
    SEPARATOR.trimStart(),
    // 续轮不带 refined_objective(目标改写只发生在首轮澄清)。
    buildVerdictContract(false),
  ].filter((line) => line !== '').join('\n');
}

/** 续轮发送的状态机内部 reason 标签(非用户可见)→ 是否属于"模型给出的"理由。 */
export type GoalDirectiveKind = Extract<GoalVerdictStatus, 'continue'> | 'first';
