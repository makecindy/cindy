import { USER_INDEX_HEADING, type MakerMemoryManager } from './manager.js';
import { MAKER_MEMORY_RULES } from './system-prompt.js';

/**
 * 项目记忆放在项目文件夹里的任务 (伙伴的项目) 另有账号级记忆时, 接在定位说明后面的一段:
 * 那一份不在项目文件夹里, 要经 cindy_memory 读写。
 */
const ACCOUNT_MEMORY_IN_PROJECT_FOLDER_RULES = [
  '',
  '',
  'Separately, the user has an account-level memory (scope `user`): what holds for them in every project — preferences, working habits, facts about their accounts and devices. Its index is under the `# Memory Index — user` heading later in this prompt, a snapshot taken when this conversation started. It is not in the project folder: read and write it through the `cindy_memory` MCP server (`call_tool` with `memory_read` / `memory_search` / `memory_write`), always passing `scope: "user"`. Save there only what holds in every project, and check the index for an existing entry first; everything about this project stays in the project memory files.',
].join('\n');

/** The same contract for all engines, including a provider running on another computer. */
export async function loadMemoryContext(input: {
  manager?: MakerMemoryManager;
  scopeKey: string;
  hosted?: boolean;
  snapshot?: string;
  projectDirectory?: string;
}): Promise<{ rules: string; index: string; projectDirectory?: string }> {
  const projectDirectory = input.projectDirectory
    ?? (input.hosted ? undefined : input.manager?.getProjectMemoryDirectory?.(input.scopeKey));
  if (projectDirectory) {
    // 伙伴的项目: 项目那一份在项目文件夹里, 按需用文件工具读; 账号级那一份 (「关于你」) 与普通
    // 项目一样把索引带进提示词 (cindy-memory.md §9)。取不到账号级索引不能连累项目记忆的定位。
    // 随启动带来的快照只认账号级索引: 这类项目自己的索引不进提示词, 别的来源给的整份索引照旧丢弃。
    const index = input.snapshot !== undefined
      ? (input.snapshot.startsWith(USER_INDEX_HEADING) ? input.snapshot : '')
      : (input.hosted ? '' : await input.manager?.getPromptIndex(input.scopeKey).catch(() => '') ?? '');
    return {
      // Also works in an IM/group lane whose cwd is outside the owner's project. This is a
      // locator, not the growing index. All reads and writes use the ordinary file tools.
      rules: `Project memory is stored as ordinary Markdown files in ${JSON.stringify(projectDirectory)}. When past preferences or decisions matter, search that directory and read matching records. Before maintaining it, read its README.md. Use native file tools; no dedicated memory service is required. Do not load the whole directory or index into every conversation.${index ? ACCOUNT_MEMORY_IN_PROJECT_FOLDER_RULES : ''}`,
      index,
      projectDirectory,
    };
  }
  return {
    rules: input.scopeKey.startsWith('bot:') ? '' : MAKER_MEMORY_RULES,
    // 账号级在前、项目在后的两份索引 (伙伴等只有一份的作用域照旧是那一份), 见 getPromptIndex。
    index: input.snapshot ?? (input.hosted ? '' : await input.manager?.getPromptIndex(input.scopeKey) ?? ''),
  };
}
