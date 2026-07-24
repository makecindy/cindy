/**
 * 灵动岛单行工具状态文案:复用面板同一套共享产线
 * (describeToolUse → formatToolRowText,措辞经 ToolRowWording 注入本地化),
 * 在其上做岛特有的单行拼接决策。
 *
 * 纯模块(无 electron / i18n import),可直接单测;措辞由调用方注入
 * (state 持有,默认共享包中文表,service 换成本地化实现)。
 */
import { formatToolRowText, type ToolRowWording } from '@cindy/maker-shared/message-presentation';
import { describeToolUse, truncateToolText, type ToolUseDescriptor } from '@cindy/maker-shared/tool-use-descriptor';

/** task 描述与 generic 兜底沿用旧岛的 80 字上限,防长 prompt 撑爆 pill。 */
const ISLAND_DETAIL_MAX_CHARS = 80;

export interface IslandToolDetailOptions {
  wording: ToolRowWording;
  /**
   * 权限确认场景:真实命令必须保持可见(用户批准的是命令本身,不是意图摘要),
   * 人话 label 只作语境补充(`运行测试 · $ pnpm test`)。
   */
  requireCommandVisible?: boolean;
}

export function formatIslandToolDetail(
  toolName: string,
  input: unknown,
  options: IslandToolDetailOptions,
  fallback?: Record<string, unknown>,
): string | null {
  const toolInput = asRecord(input);
  if (!toolInput) {
    return firstNonEmptyString(fallback?.description, fallback?.toolDescription, fallback?.displayName);
  }

  // codex 工具侧问题(input.questions)优先于工具形态展示。
  const question = permissionQuestionDetail(toolInput);
  if (question) return question;

  const descriptor = describeToolUse(toolName, toolInput);
  if (descriptor.kind === 'command') {
    return formatCommandDetail(descriptor, options);
  }
  const label = formatToolRowText(descriptor, options.wording).label;
  if (!label) return null;
  if (descriptor.kind === 'generic') {
    // 描述符解析不出形态的工具(codex MCP elicitation 的 `mcp:server`、
    // permissions 等):input 里的人话字段与请求级 description 比「调用 X」
    // 更有信息量,优先展示(旧岛行为);都没有时才落 label(+detail)。
    const informative = firstNonEmptyString(
      toolInput.message,
      toolInput.toolTitle,
      toolInput.toolDescription,
      fallback?.description,
    );
    if (informative) return truncateToolText(informative, ISLAND_DETAIL_MAX_CHARS);
    return truncateToolText(
      descriptor.detail ? `${label} · ${descriptor.detail}` : label,
      ISLAND_DETAIL_MAX_CHARS,
    );
  }
  if (descriptor.kind === 'task') {
    return truncateToolText(label, ISLAND_DETAIL_MAX_CHARS);
  }
  return label;
}

/**
 * 命令类单行拼接:
 * - 模型 description → `描述 · $ 命令`(描述已含命令时不重复);
 * - 命令意图 → 人话 label(权限场景强制补 `· $ 命令`);
 * - 无法分类 → 保持 `$ 命令` 原样(rm 等破坏性命令刻意不进意图规则表,
 *   「运行命令」label 无信息量,原文即最诚实的展示)。
 */
function formatCommandDetail(
  descriptor: Extract<ToolUseDescriptor, { kind: 'command' }>,
  options: IslandToolDetailOptions,
): string | null {
  const command = descriptor.command.trim();
  const description = descriptor.description?.trim() ?? '';
  if (description) {
    if (!command || description === command || description.includes(command)) return description;
    return `${description} · $ ${command}`;
  }
  if (descriptor.intent) {
    const label = formatToolRowText(descriptor, options.wording).label;
    if (options.requireCommandVisible && command) return `${label} · $ ${command}`;
    return label;
  }
  if (command) return `$ ${command}`;
  return null;
}

function permissionQuestionDetail(input: Record<string, unknown>): string | null {
  const questions = input.questions;
  if (!Array.isArray(questions)) return null;
  const firstQuestion = questions.find((question): question is Record<string, unknown> => (
    Boolean(question) && typeof question === 'object' && !Array.isArray(question)
  ));
  if (!firstQuestion) return null;
  const text = firstNonEmptyString(firstQuestion.question, firstQuestion.header);
  if (!text) return null;
  const extraCount = questions.length - 1;
  return extraCount > 0 ? `${text} (+${extraCount})` : text;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}
