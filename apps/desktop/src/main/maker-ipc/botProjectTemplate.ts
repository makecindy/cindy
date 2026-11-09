/**
 * The starter template of a teammate project: a clean copy every teammate starts from, like a
 * template repository. From then on the project is the teammate's own; the owner and the teammate
 * change its rules and skills by using it, and Git keeps every version.
 *
 * Kept small on purpose: how a teammate works comes from what the owner shapes, not from built-in
 * orchestration. A later template version never overwrites a file the project changed: an untouched
 * file is updated, a changed one gets the new version beside it (`.cindy/template/`) to merge.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const TEAMMATE_TEMPLATE_VERSION = 1;
/** What the project started from and which template files it still has untouched. */
export const TEAMMATE_TEMPLATE_RECORD = path.join('.cindy', 'template.json');
const PENDING_DIR = path.join('.cindy', 'template');

export interface TeammateTemplateRecord {
  version: number;
  /** Template path → hash of the template content last written there. */
  files: Record<string, string>;
  /** Template files the project had changed when a newer version arrived; the new copy waits in `.cindy/template/`. */
  pending?: string[];
}

export function teammateTemplateFiles(displayName: string): Record<string, string> {
  const name = displayName.trim() || 'This teammate';
  return {
    'AGENTS.md': [
      `# ${name} · project rules`,
      '',
      `This folder is ${name}'s project. Everything in this file is loaded at the start of every task ${name} runs here, on every engine.`,
      '',
      `- Write down how ${name} should work: steps, conventions, checklists, things to avoid.`,
      `- ${name} may edit this file and the skills in \`.agents/skills/\` to improve its own way of working. Changes apply to the next task; versions are kept, so any edit can be reviewed and undone.`,
      '- Who the teammate is (name, personality, relationship) stays in its profile, not here.',
      '',
    ].join('\n'),
    '.agents/skills/hand-off/SKILL.md': [
      '---',
      'name: hand-off',
      'description: Handing work to another task or teammate with send_to_session, getting the result back, and answering how handed-off work is going.',
      '---',
      '',
      '# Hand-off',
      '',
      '- Say what is wanted and how to tell it is done. The other side can read this conversation with `get_chat_history` (its session id comes with your message); point to it for background instead of copying everything.',
      '- When the owner is waiting on one piece of work, ask the other side to send its result back to this conversation with `send_to_session` when done, and give it this conversation\'s session id (`get_current_session_id`). For a batch the owner will check on later, do not ask for replies.',
      '- When asked how things are going, read `get_task_digest` for each task; open the full history only when needed. Do not wait in a loop.',
      '- Before telling the owner a result, check it against what was asked.',
      '',
    ].join('\n'),
  };
}

const hash = (content: string) => createHash('sha256').update(content).digest('hex');

async function readText(file: string): Promise<string | null> {
  return fs.readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function write(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, file);
}

/**
 * Brings the project up to the current template. Never overwrites a file the project changed or
 * a file it had before the template (an upgraded teammate's own rules). Returns true when it wrote.
 */
export async function applyTeammateTemplate(workspace: string, displayName: string,
  version = TEAMMATE_TEMPLATE_VERSION, files = teammateTemplateFiles(displayName)): Promise<boolean> {
  const recordPath = path.join(workspace, TEAMMATE_TEMPLATE_RECORD);
  const recordText = await readText(recordPath);
  let record: TeammateTemplateRecord | null = null;
  try { record = recordText ? JSON.parse(recordText) as TeammateTemplateRecord : null; } catch { record = null; }
  if (record && record.version >= version) return false;
  const next: TeammateTemplateRecord = { version, files: {}, pending: [] };
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(workspace, relative);
    const current = await readText(target);
    const base = record?.files[relative];
    if (current === null || current === content || (base !== undefined && hash(current) === base)) {
      // Missing, already this version, or still exactly what an earlier template wrote.
      if (current !== content) await write(target, content);
      next.files[relative] = hash(content);
    } else if (base !== undefined) {
      // Changed by the owner or the teammate: the new version waits beside it to be merged.
      await write(path.join(workspace, PENDING_DIR, relative), content);
      next.pending!.push(relative);
    }
    // A file the project had before any template stays its own and is not tracked.
  }
  if (!next.pending!.length) delete next.pending;
  await write(recordPath, `${JSON.stringify(next, null, 2)}\n`);
  return true;
}
