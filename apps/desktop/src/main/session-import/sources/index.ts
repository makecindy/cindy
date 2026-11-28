/** 来源适配器注册表：顺序即界面「全部来源」菜单与空状态里的顺序。 */

import type { ImportSourceId, SourceAdapter } from '../types.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { cursorAdapter } from './cursor.js';
import { deepseekAdapter } from './deepseek.js';
import { factoryAdapter } from './factory.js';
import { geminiAdapter } from './gemini.js';
import { kimiAdapter } from './kimi.js';
import { opencodeAdapter } from './opencode.js';
import { piAdapter } from './pi.js';
import { qwenAdapter } from './qwen.js';
import { traeAdapter } from './trae.js';
import { workbuddyAdapter } from './workbuddy.js';

export const SOURCE_ADAPTERS: SourceAdapter[] = [
  claudeAdapter,
  codexAdapter,
  piAdapter,
  opencodeAdapter,
  geminiAdapter,
  cursorAdapter,
  qwenAdapter,
  kimiAdapter,
  factoryAdapter,
  workbuddyAdapter,
  deepseekAdapter,
  traeAdapter,
];

export function adapterFor(id: ImportSourceId): SourceAdapter | undefined {
  return SOURCE_ADAPTERS.find((a) => a.id === id);
}
