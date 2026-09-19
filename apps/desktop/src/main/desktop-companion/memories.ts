import fs from 'node:fs';
import path from 'node:path';

import { sanitizeSceneText } from './context.js';

function titleFromMarkdown(content: string): string | null {
  const title = content.match(/^title:\s*(.+)$/m)?.[1]?.trim();
  return title ? sanitizeSceneText(title, 32) : null;
}

export function listMemoryTopics(memoryRoot: string, limit = 8): string[] {
  if (!fs.existsSync(memoryRoot)) return [];
  const topics: string[] = [];
  const dirs = fs.readdirSync(memoryRoot, { withFileTypes: true });
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const fullDir = path.join(memoryRoot, dir.name);
    let files: string[] = [];
    try {
      files = fs.readdirSync(fullDir).filter((name) => name.endsWith('.md') && name !== 'MEMORY.md');
    } catch {
      continue;
    }
    for (const file of files) {
      try {
        const title = titleFromMarkdown(fs.readFileSync(path.join(fullDir, file), 'utf8'));
        if (title) topics.push(title);
        if (topics.length >= limit) return topics;
      } catch {
        // skip unreadable shards
      }
    }
  }
  return topics;
}
