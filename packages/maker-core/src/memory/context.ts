import type { MakerMemoryManager } from './manager.js';
import { MAKER_MEMORY_RULES } from './system-prompt.js';

/**
 * The locator for project-local Markdown memory. Reads always use the ordinary file tools.
 * `saveWithTool`: the host routed this conversation's saves through the `cindy_memory` server (a
 * teammate's conversation with its owner) and the engine confirmed this session mounted it, so
 * the rule never names a tool the session lacks. It writes the same files and keeps the index.
 */
export function projectMemoryRules(projectDirectory: string, saveWithTool = false): string {
  const location = `Project memory is stored as ordinary Markdown files in ${JSON.stringify(projectDirectory)}.`;
  if (!saveWithTool)
    return `${location} When past preferences or decisions matter, search that directory and read matching records. Before maintaining it, read its README.md. Use native file tools; no dedicated memory service is required. Do not load the whole directory or index into every conversation.`;
  return `${location} When past preferences or decisions matter, search that directory with your file tools and read matching records. Do not load the whole directory or index into every conversation. Read its README.md before maintaining it. In this conversation, save, update and delete records through the \`cindy_memory\` MCP server instead of editing the files: \`call_tool({"name": "memory_write", "args": {type, name, title, description, body, mode}})\`, and \`memory_delete\` / \`memory_consolidate\` for removals and merges (\`list_tools()\` lists them; \`list_tools({category})\` shows their arguments). It writes the same files in that directory and keeps MEMORY.md current. Edit the files with your file tools only when that tool returns an error. This replaces the file-tool route for saving in the project instructions.`;
}

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
    return {
      // Also works in an IM/group lane whose cwd is outside the owner's project. This is a
      // locator, not the growing index. Engines may switch saving to the memory tool afterwards
      // (projectMemoryRules), once they know the session mounted it.
      rules: projectMemoryRules(projectDirectory),
      index: '',
      projectDirectory,
    };
  }
  const store = input.hosted ? undefined : await input.manager?.getStore(input.scopeKey);
  return {
    rules: input.scopeKey.startsWith('bot:') ? '' : MAKER_MEMORY_RULES,
    index: input.snapshot ?? (store ? await store.getIndex() : ''),
  };
}
