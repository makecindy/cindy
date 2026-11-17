/**
 * 本机会话实际加载的 Claude Code 设置来源 —— SDK `settingSources` 与 subagent 定义扫描
 * 共用这一个判定。
 *
 * 为什么必须共用:会话的 `settingSources` 既决定 CLI 子进程读哪些文件层设置,也决定它
 * 加载哪些目录里的 subagent 定义(`.claude/agents` 随 `project` 来源、`~/.claude/agents`
 * 随 `user` 来源)。扫描若比实际加载更宽,一份 CLI 根本不加载的定义就会被算进
 * 「有人声明了 model」,从而静默停用「Subagent 模型」默认值 —— 真正会加载的内置 / 项目
 * agent 反而拿不到用户配置的默认值(判定见 subagent-model-default.ts)。
 *
 * 真实事故(PR #8605 P1):本机订阅会话排除了用户级设置,CLI 不再加载
 * `~/.claude/agents`;但启动期扫描仍扫用户作用域,一份旧的全局 agent 里的 `model:` 就把
 * `CLAUDE_CODE_SUBAGENT_MODEL` 压掉了。
 *
 * 两处各写一份条件迟早会漂移,所以来源判定收在这里;扫描只按这里的返回值选目录。
 */

/** cc 的设置来源字面值(与 SDK `SettingSource` 同值;不直接依赖 SDK 类型)。 */
export type ClaudeSettingSource = 'user' | 'project' | 'local';

/** 全部文件层来源,与 SDK 缺省行为一致。 */
export const ALL_CLAUDE_SETTING_SOURCES: readonly ClaudeSettingSource[] = Object.freeze([
  'user',
  'project',
  'local',
]);

export interface ClaudeSettingSourcesInput {
  /** 自动审阅任务:只跑给定工作目录,不读用户 / 项目设置。 */
  reviewMode: boolean;
  /** 伙伴(独立 profile)会话:同上。 */
  isolatedBotProfile: boolean;
  /** host 自管工具的本地 agent client:自带工具全关,设置也不读。 */
  hostToolsOnly: boolean;
  /** 设备托管:个人配置属于任务所在电脑,本机用户级设置不属于该任务。 */
  hosted: boolean;
  /** 本机订阅会话:用户级设置里的 apiKeyHelper / 网关会盖过订阅登录(见 subscription-settings-isolation.ts)。 */
  nativeCliAuth: boolean;
}

/**
 * 本次会话的 `settingSources`。
 *
 * - 审阅 / 伙伴 / hostToolsOnly:完全不读文件层设置(`[]`);
 * - 设备托管、本机订阅:只读项目级(含 cwd-local),不读本机 `~/.claude`;
 * - 其余(API / 网关路由、SSH 远端之外的普通本机会话):三层全读。
 *
 * 远端(SSH)会话不适用:那边读的是远端机器上的用户设置,由远端分支自己决定。
 */
export function resolveClaudeSettingSources(
  input: ClaudeSettingSourcesInput,
): ClaudeSettingSource[] {
  if (input.reviewMode || input.isolatedBotProfile || input.hostToolsOnly) return [];
  return input.hosted || input.nativeCliAuth ? ['project', 'local'] : [...ALL_CLAUDE_SETTING_SOURCES];
}
