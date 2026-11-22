import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  TEAMMATE_GUIDE_DESCRIPTION,
  TEAMMATE_GUIDE_NAME,
  buildTeammateGuide,
} from './teammateGuide.js';

/** Managed, versioned source shared by every local Bot; never lives on a Bot's learned shelf. */
export async function collectTeammateGuideMount(userDataDir: string) {
  const source = `---\nname: ${TEAMMATE_GUIDE_NAME}\ndescription: ${JSON.stringify(TEAMMATE_GUIDE_DESCRIPTION)}\n---\n\n${buildTeammateGuide()}\n`;
  const version = createHash('sha256').update(source).digest('hex');
  const pluginRoot = path.join(userDataDir, 'managed-teammate-skills', version);
  const skillPath = path.join(pluginRoot, 'skills', TEAMMATE_GUIDE_NAME);
  const filePath = path.join(skillPath, 'SKILL.md');
  const manifestPath = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
  // Immutable generations avoid rewriting a Skill underneath an active harness.
  for (const [target, content] of [
    [filePath, source],
    [manifestPath, JSON.stringify({ name: 'teammate-guide', version: '1.0.0', description: TEAMMATE_GUIDE_DESCRIPTION })],
  ]) {
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
  return { pluginRoot, skill: { name: TEAMMATE_GUIDE_NAME,
    description: TEAMMATE_GUIDE_DESCRIPTION, path: skillPath, filePath } };
}
