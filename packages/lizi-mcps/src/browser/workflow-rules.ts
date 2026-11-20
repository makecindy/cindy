import type { BrowserBackendKind } from '../types.js';
import browserWorkflowRules from './prompts/rules/browser-workflow.md?raw';

// `<!-- backend: external, rsb-webview -->` … `<!-- /backend -->`, each marker on its own line.
const BACKEND_BLOCK = /^[ \t]*<!-- backend: ([a-z, -]+) -->[ \t]*\r?\n([\s\S]*?)^[ \t]*<!-- \/backend -->[ \t]*\r?\n?/gm;

/**
 * The browser workflow rules for one automation target. Parts that only apply to other targets are
 * left out, so the agent reads (and keeps in context) what it can act on. Without a known target
 * every part is kept, which is what hosts that do not report one get.
 */
export function renderBrowserWorkflowRules(backend?: BrowserBackendKind): string {
  const body = browserWorkflowRules.replace(BACKEND_BLOCK, (_match, kinds: string, block: string) =>
    !backend || kinds.split(',').some((kind) => kind.trim() === backend) ? block : '');
  if (!backend) return body;
  return `${body.trimEnd()}\n\n> 以上规则按当前浏览器模式 \`${backend}\` 给出。\`status.data.backend\` 变成别的模式后,重新 \`list_tools({category:"browser"})\` 读取那个模式的规则,不要沿用这一份里与模式有关的部分。\n`;
}
