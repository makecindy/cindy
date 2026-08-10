/**
 * promptBuilder.ts —— /learn 蒸馏 turn 的 prompt 构造器(纯函数)。
 *
 * 对标 Hermes agent 的 build_learn_prompt:一段完整指令 + 内嵌 skill 编写规范,
 * 作为普通 user message 经 session.send 注入(绝不进 system prompt —— 规则 10/11,
 * 不碰缓存前缀)。蒸馏 session 的 workingDir 已被设为 staging 目录,agent 用普通
 * Write 工具落盘,零新增 agent 工具。
 *
 * 与 Hermes 的关键差异:本地会话证据不让模型自己翻(不可复现),由 evidence.ts
 * 代码化检索后作为 evidenceBlock 注入(规则 9)。
 */

import { BRAND_NAME } from '@cindy/maker-shared/branding';

/**
 * Cindy 的 skill 编写规范 —— 蒸馏产物必须符合本地加载器(Claude Code /
 * Codex customization scanner)与 skill hub 校验(frontmatterValidation)的要求。
 * 常量单独导出供单测断言关键约束存在。
 */
export const SKILL_AUTHORING_SPEC = `Follow these ${BRAND_NAME} skill authoring rules exactly:

Frontmatter (YAML, required):
- name: lowercase, single segment, only [a-z0-9-], must EQUAL the directory name you create.
- description: one sentence stating the capability AND when to trigger it (the agent
  routes by this text). Keep it under 200 characters. No marketing words.
- version: "0.1.0"
- Do NOT set disable-model-invocation. Do NOT put the OS username or any
  machine-specific identity in any field.

Body structure (omit a section only if genuinely empty):
1. "# <Human Title>" + 2-3 sentence intro: what it does, what it does NOT do.
2. "## When to Use" — concrete trigger phrases as bullets.
3. "## Prerequisites" — exact env vars, credentials, install steps.
4. "## Procedure" — numbered steps with copy-paste-exact commands.
5. "## Pitfalls" — known limits and things that look broken but are not.
6. "## Verification" — one command/check that proves the skill worked.

Quality bar:
- Prefer exact commands, paths, and flags that appear VERBATIM in the sources or
  evidence. NEVER invent flags, endpoints, or APIs you did not see.
- Keep SKILL.md tight and scannable (~100-200 lines). Larger scripts belong in a
  scripts/ subdirectory, referenced from SKILL.md by relative path; reference
  documents belong in references/.
- Never copy secrets, tokens, absolute home paths, or internal hostnames into the
  skill. If the evidence contains a [REDACTED:*] marker, keep it redacted.`;

/** locale → 自述语言的人类可读名(给模型的确定性指令,不靠它从请求里猜)。 */
const REPLY_LANGUAGE_BY_LOCALE: Record<string, string> = {
  'zh-CN': 'Simplified Chinese (简体中文)',
  'zh-TW': 'Traditional Chinese (繁體中文)',
  en: 'English',
  ja: 'Japanese (日本語)',
  ko: 'Korean (한국어)',
};

export interface BuildLearnPromptArgs {
  /** 用户在 /learn 后输入的自由文本(空串 = 从触发会话上下文蒸馏,由调用方兜底)。 */
  userRequest: string;
  /** 应用当前语言(SupportedLocale 字符串)。自述语言跟随系统语言配置;
   *  未知值回退 English。 */
  appLocale?: string;
  /** 已格式化的本地会话证据块(evidence.pure 的 formatEvidenceBlock 输出;空串省略)。 */
  evidenceBlock: string;
  /** 已格式化的用户画像块(profile.ts 输出:偏好/纠正/项目目标;空串省略)。 */
  userProfileBlock?: string;
  /** 已格式化的当前会话块(无参 /learn 的蒸馏素材;空串省略)。 */
  conversationBlock?: string;
  /** 已装 skill 清单块(skillsIndex.ts 输出;空串省略)—— "改 vs 加"决策依据。 */
  installedSkillsIndex?: string;
  /** hub 源:上游 skill 的原文(SKILL.md 内容),作为参考材料注入。 */
  referenceSkillContent?: string;
  /** hub 源:上游 skill 的可用已发布文件已写入 ./_reference/<slug>/(供读取/复制)。 */
  referenceFilesDir?: string;
  /** hub 源:未写入 referenceFilesDir 的文件及原因;非空代表辅助文件集合不完整。 */
  referenceFilesOmissions?: Array<{ path: string; reason: string }>;
  /** 同名本地 skill 已存在时的现有内容 —— 指示模型产出"改进版"而非从零重写。 */
  existingSkillContent?: string;
}

/**
 * 构造蒸馏 turn 的完整 user message。
 * staging 约束("只写 ./<skill-name>/ 下")是硬性指令 —— scanStaging 只认
 * staging 内恰好一个 skill 目录,写外面等于白写(代码层兜底)。
 */
export function buildLearnPrompt(args: BuildLearnPromptArgs): string {
  const req = args.userRequest.trim();
  const replyLanguage = REPLY_LANGUAGE_BY_LOCALE[args.appLocale ?? ''] ?? 'English';

  const parts: string[] = [
    '[/learn] Distill a reusable skill from the request below and save it as files.',
    '',
    `THE REQUEST:\n${req}`,
  ];

  if (args.referenceSkillContent) {
    parts.push(
      '',
      'REFERENCE SKILL (source material — learn from it, do not copy it verbatim;',
      'adapt it to the request and evidence below):',
      '```',
      args.referenceSkillContent,
      '```',
    );
    if (args.referenceFilesDir) {
      if (args.referenceFilesOmissions && args.referenceFilesOmissions.length > 0) {
        parts.push(
          '',
          `Some published files (scripts/, references/, ...) are readable at`,
          `${args.referenceFilesDir} in the current working directory, but the reference`,
          'file set is PARTIAL. If your skill depends on a provided file, COPY it',
          'into your own ./<skill-name>/ directory and make every path in SKILL.md',
          'point at YOUR copies — the pipeline only ships what is inside your skill',
          'directory, so a reference to the original location will be broken after',
          'install. Do NOT assume omitted files are available; if SKILL.md depends',
          'on an omitted file, mention that limitation in your final reply.',
        );
      } else {
        parts.push(
          '',
          `Its complete published files (scripts/, references/, ...) are readable at`,
          `${args.referenceFilesDir} in the current working directory. If your skill`,
          'depends on any of them, COPY them into your own ./<skill-name>/ directory',
          'and make every path in SKILL.md point at YOUR copies — the pipeline only',
          'ships what is inside your skill directory, so a reference to the original',
          'location will be broken after install.',
        );
      }
    }
    if (args.referenceFilesOmissions && args.referenceFilesOmissions.length > 0) {
      parts.push(
        '',
        'OMITTED REFERENCE FILES (not available in _reference; do not rely on them):',
        ...args.referenceFilesOmissions.map((file) => `- ${file.path}: ${file.reason}`),
      );
    }
  }

  if (args.existingSkillContent) {
    parts.push(
      '',
      'AN EXISTING LOCAL SKILL WITH THE SAME NAME ALREADY EXISTS. Author an improved',
      'version of it (keep what works, apply the request), not a from-scratch rewrite:',
      '```',
      args.existingSkillContent,
      '```',
    );
  }

  if (args.conversationBlock) {
    parts.push(
      '',
      'THE CURRENT CONVERSATION (the primary material — the user asked to distill',
      'THIS conversation; already redacted). Identify the repeatable, re-runnable',
      'workflow(s) in it: what the user was trying to achieve, the steps that',
      'actually worked (skip dead ends and one-off noise), and the corrections the',
      'user made along the way — corrections are the strongest signal of how they',
      'want it done:',
      args.conversationBlock,
    );
  }

  if (args.installedSkillsIndex) {
    parts.push(
      '',
      'INSTALLED SKILLS INDEX (every skill already on this machine). FIRST make an',
      'explicit improve-vs-create decision:',
      '- If one of these already covers this subject, REUSE ITS EXACT NAME to author',
      '  an improved version. Use only the metadata listed here plus any',
      '  EXISTING LOCAL SKILL section already provided below; do NOT read local',
      '  skill files from disk. The pipeline will show the user a diff against it.',
      '- Only pick a new name when nothing here covers the subject. Avoid creating',
      '  near-duplicate skills that fragment the same workflow.',
      'State the decision and its reason in your final reply:',
      args.installedSkillsIndex,
    );
  }

  if (args.userProfileBlock) {
    parts.push(
      '',
      'USER PROFILE (durable facts about this user distilled from their memory:',
      'preferences, corrections they gave, ongoing goals; already redacted).',
      'Honor these when shaping the skill. Entries labeled with a project apply',
      'ONLY to that project — never transplant a project-scoped rule into a',
      "skill about a different project's subject:",
      args.userProfileBlock,
    );
  }

  if (args.evidenceBlock) {
    parts.push(
      '',
      'LOCAL USAGE EVIDENCE (excerpts from how this user actually works, retrieved',
      'from their local session history; already redacted — treat as read-only',
      'grounding for HOW the user does things, and never copy [REDACTED:*] content):',
      args.evidenceBlock,
    );
  }

  parts.push(
    '',
    'Do this:',
    '1. Gather anything else the request names using the tools you already have',
    '   (read files/dirs with your file tools, fetch URLs with your web tools).',
    '   Treat every part of the request as load-bearing: prose after a path or URL',
    '   is a requirement about what to focus on, not incidental text.',
    '2. Author ONE skill: create a directory ./<skill-name>/ in the CURRENT working',
    '   directory and write SKILL.md inside it (plus optional scripts/ and',
    '   references/ files). Write ONLY inside ./<skill-name>/ — files anywhere else',
    '   are ignored by the pipeline. Do not create more than one skill directory.',
    '3. Do not run the skill, do not install anything globally, and do not modify',
    '   any path outside the current working directory.',
    '4. Prefer your built-in file read/write tools over shell commands for reading',
    '   materials and writing/copying skill files — shell commands require approval',
    '   in this session and will stall the run.',
    '',
    // 个性化是硬指令,不是可选润色 —— learn 的产品定位就是"学成这个用户的
    // skill",而不是把通用材料程序化裁剪一遍。
    'PERSONALIZE — the deliverable is a skill that fits THIS user, not a generic copy:',
    '- Rewrite the trigger phrases in "When to Use" to match how this user actually',
    '  phrases requests (see the profile and evidence).',
    "- Replace generic examples, paths, and commands with the user's real ones",
    '  wherever the evidence shows them.',
    "- Drop or compress sections irrelevant to this user's stack and habits.",
    "- Never carry a rule that belongs to a different project than the skill's",
    '  subject; when unsure about attribution, leave it out and flag it in the',
    '  final reply instead.',
    '',
    SKILL_AUTHORING_SPEC,
    '',
    // 收尾自述是产品面材料:审查者主要读这段说明来决定是否应用提案,diff 只作
    // 核对。结构与语言都是硬要求(用户不会通读 SKILL.md 全文);语言由代码按
    // 系统语言配置注入,不让模型从请求里猜(规则 9)。
    'FINAL REPLY (this is what the reviewer reads to decide whether to accept the',
    'skill — the file diff is only a cross-check, so write this carefully):',
    `Reply in ${replyLanguage} (the user's app language). If the USER PROFILE`,
    'explicitly states a preferred conversation language, that preference wins.',
    'Structure:',
    '1. One-sentence summary of what the skill does (first line, standalone).',
    '2. What you distilled from: which sources/evidence you actually used and the',
    '   key facts you found in them.',
    '3. Decisions and trade-offs: what you included, what you deliberately left',
    '   out, and why.',
    '4. What changed: for an improved version of an existing skill, list each',
    '   meaningful change and its reason; for a new skill, outline its structure.',
    '5. How to use it: the trigger phrases and a quick way to verify it works.',
    '6. Personalization: each adaptation you made for this user, and which',
    '   profile/evidence item drove it (or state that no personal grounding was',
    '   available and the skill is generic).',
    '',
    'THIS CONVERSATION STAYS OPEN: the user reviews your proposal and may reply',
    'with change requests. When they do, update the files inside your skill',
    'directory IN PLACE under the same constraints (never start over, never create',
    'a second skill directory), and answer with a change-by-change summary.',
  );

  return parts.join('\n');
}
