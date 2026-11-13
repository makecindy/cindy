import type { MakerMemoryManager } from './manager.js';
import { MAKER_MEMORY_RULES } from './system-prompt.js';

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
      // locator, not the growing index. All reads and writes use the ordinary file tools.
      rules: `Project memory is stored as ordinary Markdown files in ${JSON.stringify(projectDirectory)}. When past preferences or decisions matter, search that directory and read matching records. Before maintaining it, read its README.md. Use native file tools; no dedicated memory service is required. Do not load the whole directory or index into every conversation.`,
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
