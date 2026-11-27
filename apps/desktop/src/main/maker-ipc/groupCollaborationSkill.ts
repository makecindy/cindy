import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';

import { GROUP_COLLABORATION_SKILL_NAME, GROUP_COLLABORATION_SKILL_DESCRIPTION, GROUP_COLLABORATION_SKILL_BODY } from './groupCollaborationSkillContent.js';

/** Managed, versioned source; immutable generations avoid rewriting a Skill under a running harness. */
export async function collectGroupCollaborationSkillMount(userDataDir: string) {
  const source = `---\nname: ${GROUP_COLLABORATION_SKILL_NAME}\ndescription: ${JSON.stringify(GROUP_COLLABORATION_SKILL_DESCRIPTION)}\n---\n\n${GROUP_COLLABORATION_SKILL_BODY}\n`;
  const version = createHash('sha256').update(source).digest('hex');
  const pluginRoot = path.join(userDataDir, 'managed-group-skills', version);
  const skillPath = path.join(pluginRoot, 'skills', GROUP_COLLABORATION_SKILL_NAME);
  const filePath = path.join(skillPath, 'SKILL.md');
  const manifestPath = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
  for (const [target, content] of [
    [filePath, source],
    [manifestPath, JSON.stringify({ name: 'cindy-group', version: '1.0.0', description: GROUP_COLLABORATION_SKILL_DESCRIPTION })],
  ] as const) {
    if (await fs.readFile(target, 'utf8').catch(() => null) === content) continue;
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, content, 'utf8');
      await fs.rename(temporary, target);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  return { name: GROUP_COLLABORATION_SKILL_NAME, description: GROUP_COLLABORATION_SKILL_DESCRIPTION, path: skillPath, filePath, pluginRoot };
}

/** Tasks of a group's Cindy on this computer, newest last; bounded, local only, no content. */
const GROUP_CINDY_TASKS_KEPT = 500;
const file = () => ownerScopedUserDataPath('group-cindy-tasks.json');
function readTasks(): string[] {
  try {
    const raw = readAtomicFileSync(file());
    const parsed = raw ? z.array(z.string().min(1)).safeParse(JSON.parse(raw)) : null;
    return parsed?.success ? parsed.data : [];
  } catch { return []; }
}
/** Marks a task as a group's Cindy task, so it starts with the 群协作 Skill; a failed write only loses the Skill. */
export function markGroupCindyTask(sessionId: string): boolean {
  try {
    const tasks = readTasks();
    if (tasks.includes(sessionId)) return true;
    const target = file();
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    atomicWriteFileSync(target, JSON.stringify([...tasks, sessionId].slice(-GROUP_CINDY_TASKS_KEPT)));
    return true;
  } catch { return false; }
}
export function isGroupCindyTask(sessionId: string): boolean {
  return readTasks().includes(sessionId);
}
