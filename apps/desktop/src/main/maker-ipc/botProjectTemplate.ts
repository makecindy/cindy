/**
 * The starter template of a teammate project: a clean copy every teammate starts from, like a
 * template repository. From then on the project is the teammate's own; the owner and the teammate
 * change its rules and skills by using it, and Git keeps every version.
 *
 * Small, but it sets how a teammate works from the first conversation: talk with the owner here,
 * do longer work in a task started in the project it belongs to, so that task carries that project's
 * rules and skills (2026-11-10). A later template version never overwrites a file the project
 * changed: an untouched file is updated, a changed one gets the new version beside it
 * (`.cindy/template/`) to merge.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const TEAMMATE_TEMPLATE_VERSION = 3;
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
      '## Talk here, work in tasks',
      '',
      `When you talk with the owner as ${name} (in your conversation with them, in a group, or over a message channel), that conversation is where they talk with you, decide, and hear back. Keep it that way:`,
      '',
      '- Quick things stay here: answering, looking something up, reading a few files, adjusting this project\'s own rules and skills.',
      '- Longer work goes to a task: changing a repository, building or testing, research across many sources, anything that takes more than a few minutes. Start that task with the hand-off skill before you begin, also when a discussion turns into "go ahead" or "fix it". Do the work here only when the owner asks for it here.',
      '- Start the task in the project the work belongs to, not here, so it carries that project\'s rules and skills (how to build, test, open and follow up a pull request).',
      '- A task started for a piece of work does that work itself; it does not hand it on again.',
      '',
      '## Improving how you work',
      '',
      `- Write down how ${name} should work: steps, conventions, checklists, things to avoid.`,
      `- ${name} may edit this file and the skills in \`.agents/skills/\` to improve its own way of working. Changes apply to the next task; versions are kept, so any edit can be reviewed and undone.`,
      '- Who the teammate is (name, personality, relationship) stays in its profile, not here.',
      '',
    ].join('\n'),
    '.agents/skills/hand-off/SKILL.md': [
      '---',
      'name: hand-off',
      'description: Use before starting any work longer than a quick answer (changing a repository, building or testing, research, anything that takes more than a few minutes) to start a task for it in the right project. Also for sending work to an existing task or teammate and for answering how that work is going.',
      '---',
      '',
      '# Hand-off',
      '',
      '## Start a task',
      '',
      '1. Choose the project. Work on a repository or folder belongs to that project: find it with `list_projects` (in `cindy_helper`) and pass its path as `project_path`. Without it the task stays in this teammate\'s own project, which is right only for work about this teammate or work with no project. If the work belongs to no registered project, ask the owner rather than guessing.',
      '2. Reuse before creating. If the work continues an existing task (the same pull request, issue or feature), find it with `list_sessions` and send to it with `target_session_id`.',
      '3. Otherwise create one with `send_to_session` and no `target_session_id`: a short `title`, the `project_path`, and the brief as the message. Keep the engine and model unless the owner asked for others.',
      '4. Write the brief so the task can work alone: what is wanted, the decisions and constraints the owner gave so far, and how to tell it is done. The task can read this conversation with `get_chat_history` (your session id comes with the message); point to it for background instead of copying everything.',
      '5. Tell the owner in a line or two which task you started, in which project, and what it will do. Then stop: do not do the same work here as well.',
      '',
      '## While it runs',
      '',
      '- Do not ask a task to send its result back: the owner is notified when it finishes and reads it there. Ask for a send-back (with this conversation\'s session id from `get_current_session_id`) only when the owner wants you to take the result further, such as combining it or continuing from it.',
      '- When asked how things are going, read `get_task_digest` for each task; open the full history only when needed. Do not wait in a loop.',
      '- When a result does come back, read it against what was asked. If something is missing or wrong, ask that task to fix it; do not redo the work yourself.',
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

/** Whether writing `relative` in the project would go through a link (it could lead anywhere). */
async function throughLink(workspace: string, relative: string): Promise<boolean> {
  let current = workspace;
  for (const part of relative.split(/[\\/]/)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch(() => null);
    if (!stat) return false;
    if (stat.isSymbolicLink()) return true;
  }
  return false;
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
    // The project linked this place elsewhere (its Skills folder, say): never write through it.
    if (await throughLink(workspace, relative) || await throughLink(workspace, path.join(PENDING_DIR, relative))) continue;
    const current = await readText(target);
    const base = record?.files[relative];
    if (current === null || current === content || (base !== undefined && hash(current) === base)) {
      // Missing, already this version, or still exactly what an earlier template wrote.
      if (current !== content) await write(target, content);
      next.files[relative] = hash(content);
    } else if (base !== undefined) {
      // Changed by the owner or the teammate: the new version waits beside it to be merged. The
      // file stays tracked against the version it was changed from, so later versions wait there too.
      await write(path.join(workspace, PENDING_DIR, relative), content);
      next.files[relative] = base;
      next.pending!.push(relative);
    }
    // A file the project had before any template stays its own and is not tracked.
  }
  if (!next.pending!.length) delete next.pending;
  await write(recordPath, `${JSON.stringify(next, null, 2)}\n`);
  return true;
}
