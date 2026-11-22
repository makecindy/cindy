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
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, renameSync } from 'node:fs';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { canonicalJson, COMPANION_VALUE_MAX_BYTES } from '../companion-cloud/uploader.js';
import { BOT_SKILL_MAX_BODY_BYTES, parseBotSkillFile, withBotSkillWrite } from './botSkillStore.js';
import { PROJECT_SETTINGS_GUIDE, PROJECT_SETTINGS_PATH, isStandardProjectSkill } from './botProjectSettingsGuide.js';
import { GROUP_REQUEST_GUIDANCE, GROUP_TEAMMATE_PROJECT_GUIDANCE } from './groupCollaborationSkillContent.js';

export const TEAMMATE_TEMPLATE_VERSION = 10;
/** What the project started from and which template files it still has untouched. */
export const TEAMMATE_TEMPLATE_RECORD = path.join('.cindy', 'template.json');
const PENDING_DIR = path.join('.cindy', 'template');

/**
 * Standard skills keep two layers in one file (2026-11-22 owner decision): Cindy's standard text,
 * replaced whole on every template version, and the teammate's own rules below this heading, which
 * a version never touches. Changes made to the standard text before this layering are moved into
 * the own rules, so an older teammate gets the new standard without losing what it was told.
 */
export const OWN_RULES_HEADING = '## Your own rules';
const OWN_RULES_INTRO = 'Rules the owner asked for, or that you settled with the owner, go in this section. They take precedence over the standard text above. Cindy replaces everything above this section when it updates the standard and keeps this section as it is.';
const CHANGES_NOTE = 'Changes made to an earlier version of this skill\'s standard, kept when Cindy updated it. Lines starting with + were added and lines starting with - removed; the other lines are that earlier standard, showing where each change was made. Keep the intent of these changes, in the section they were made in, together with the standard above. You may rewrite what still applies as plain rules in this section and then remove this block.';
const HEADER_NOTE = 'Frontmatter lines from the earlier version of this skill that the updated header does not have (for example a changed standard field). Decide whether to put them back in the header above, then remove this block.';
const EARLIER_NOTE = 'This skill\'s earlier version, kept when Cindy took over its standard. Keep in this section, as plain rules, only what the owner asked for that the standard above does not already say, then remove this block.';
function isLayeredFile(relative: string): boolean {
  const match = /^\.agents\/skills\/([^/]+)\/SKILL\.md$/.exec(relative);
  return !!match && isStandardProjectSkill(match[1]);
}
/** The standard text last written to a layered file: what a later change is compared with. */
const STANDARD_DIR = path.join('.cindy', 'template-standard');
/** Finds an earlier template file by the hash the record kept (from the project's Git history). */
export type ReadPreviousTemplate = (relative: string, sha256?: string) => Promise<string | null>;

const lf = (text: string) => text.replace(/\r\n?/g, '\n');

/** Where the own section starts: its heading outside any fenced code block, or -1. */
function ownRulesStart(text: string): number {
  let offset = 0;
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) { if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null; }
    else if (marker) fence = marker;
    else if (line.trim() === OWN_RULES_HEADING) return offset;
    offset += line.length + 1;
  }
  return -1;
}

function standardPart(text: string): { standard: string; own: string } {
  const at = ownRulesStart(text);
  if (at < 0) return { standard: text, own: '' };
  return { standard: text.slice(0, at), own: text.slice(at).replace(/^.*\n?/, '').trim() };
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;
const body = (text: string) => text.replace(FRONTMATTER, '').trim();

/** A fence longer than any backtick run in the text, so a code block inside it stays intact. */
function fenced(language: string, text: string): string {
  const longest = Math.max(3, ...[...text.matchAll(/`+/g)].map(run => run[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${language}\n${text}\n${fence}`;
}

/** Top-level frontmatter fields as blocks (a key line plus its indented or list continuation lines). */
function frontmatterFields(text: string): Map<string, string> {
  const match = FRONTMATTER.exec(text);
  const fields = new Map<string, string>();
  let key: string | null = null;
  for (const line of match ? match[1].split('\n') : []) {
    // A top-level key starts at column 0 (bare, or in single or double quotes); indented and list
    // lines continue the field before them.
    const top = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^\s#'"-][^:]*?))\s*:(?:\s|$)/.exec(line);
    if (top) { key = top[1] ?? top[2]?.replace(/''/g, "'") ?? top[3].trim(); fields.set(key, line); }
    else if (key) fields.set(key, `${fields.get(key)}\n${line}`);
  }
  return fields;
}

/**
 * The new standard's frontmatter plus the fields the teammate added (native invocation settings,
 * allowed tools, metadata): these take effect only in the header. The standard's own fields keep
 * the standard's value; a field an earlier standard had and the new one dropped is not brought back
 * unless the teammate changed it.
 */
function mergedHeader(next: string, current: string, previousStandard: string | null): string {
  const mine = frontmatterFields(current);
  const theirs = frontmatterFields(next);
  const before = previousStandard === null ? new Map<string, string>() : frontmatterFields(previousStandard);
  const added = [...mine].filter(([key, block]) => !theirs.has(key) && before.get(key) !== block).map(([, block]) => block);
  if (!added.length || !theirs.size) return next;
  return next.replace(/^(---\n[\s\S]*?)\n---\n/, (_all, head: string) => `${head}\n${added.join('\n')}\n---\n`);
}

/**
 * The new file for a layered template: the new standard, the own rules it already had, and the
 * changes it had made to its earlier standard text, kept exactly rather than reinterpreted (a
 * guessed difference loses scope, nesting or moves): as a diff against the standard it started
 * from, or, without a known starting point, its whole earlier text. The teammate folds them in.
 */
function layeredContent(rawCurrent: string, rawPrevious: string | null, next: string): string {
  const current = lf(rawCurrent);
  const previousStandard = rawPrevious === null ? null : lf(rawPrevious);
  const { standard, own } = standardPart(current);
  const mine = body(standard);
  const carried: string[] = [];
  if (previousStandard !== null) {
    const before = body(standardPart(previousStandard).standard);
    if (before !== mine) {
      // The whole earlier standard as context, so every change shows the section it was made in.
      // Only the metadata before the first hunk goes; every line inside the hunks is content.
      const lines = createTwoFilesPatch('earlier standard', 'your version', `${before}\n`, `${mine}\n`, '', '', { context: 10_000 }).split('\n');
      const first = lines.findIndex(line => line.startsWith('@@'));
      const hunks = (first < 0 ? [] : lines.slice(first)).filter(line => line !== '\\ No newline at end of file').join('\n').trim();
      if (hunks) carried.push(`${CHANGES_NOTE}\n\n${fenced('diff', hunks)}`);
    }
  } else if (mine && mine !== body(standardPart(next).standard)) {
    carried.push(`${EARLIER_NOTE}\n\n${fenced('markdown', mine)}`);
  }
  const header = mergedHeader(next, current, previousStandard);
  // Any frontmatter line the merged header does not carry and the starting standard did not have
  // (a changed standard field, or a form the merge did not recognize) is kept for the teammate.
  const headerLines = (text: string | null) => new Set((text === null ? '' : FRONTMATTER.exec(text)?.[1] ?? '').split('\n').filter(line => line.trim()));
  const merged = headerLines(header);
  const started = headerLines(previousStandard);
  const leftover = [...headerLines(current)].filter(line => !merged.has(line) && !started.has(line));
  if (leftover.length) carried.push(`${HEADER_NOTE}\n\n${fenced('yaml', leftover.join('\n'))}`);
  // The new standard's own section brings its intro; an earlier copy of it is not an own rule.
  const nextOwn = new Set(next.slice(standardPart(next).standard.length).split('\n').map(line => line.trim()).filter(Boolean));
  // Only the intro the standard puts at the top of the section goes; the rest of the teammate's
  // section stays exactly as it was (a fenced example may repeat the heading).
  nextOwn.delete(OWN_RULES_HEADING);
  const ownLines = own.split('\n');
  let first = 0;
  while (first < ownLines.length && (!ownLines[first].trim() || nextOwn.has(ownLines[first].trim()))) first++;
  const ownRules = ownLines.slice(first).join('\n').trim();
  // Kept inside the skill: its text reaches every computer with the skill, unlike a side file.
  const sections = [ownRules, ...carried].filter(Boolean);
  return sections.length ? `${header.trimEnd()}\n\n${sections.join('\n\n')}\n` : header;
}

/** Adopt the personal source text when an importer encounters the starter it just installed. */
export function importedStandardSkill(slug: string) {
  const relative = `.agents/skills/${slug}/SKILL.md`;
  if (!isLayeredFile(relative)) return undefined;
  const standard = teammateTemplateFiles('')[relative];
  return { standard, layer(source: string) {
    const content = layeredContent(source, null, standard);
    if (Buffer.byteLength(parseBotSkillFile(content).body) > BOT_SKILL_MAX_BODY_BYTES
      || Buffer.byteLength(canonicalJson({ slug, content, enabled: false })) > COMPANION_VALUE_MAX_BYTES)
      throw new Error('Imported standard skill exceeds portable skill size');
    return content;
  } };
}

const SETTINGS_ROUTE = 'For your own configuration, read `.cindy/settings/README.md`.';

const MEMORY_ROUTE = [
  '<!-- project-memory -->',
  '## Project memory',
  '',
  'Durable preferences and decisions are ordinary Markdown files in `.cindy/memory/`. When a question depends on past preferences, decisions or ongoing work, search that directory and read only the relevant records. Its `MEMORY.md` is an optional on-demand index, not startup context. Before saving or maintaining memories, read `.cindy/memory/README.md`. Use your native file/search tools; no application-specific memory tool is required.',
  '<!-- /project-memory -->',
  '',
].join('\n');

/** File-format documentation, deliberately outside the automatically loaded instructions. */
export const PROJECT_MEMORY_GUIDE = `# Project memory

This directory is a portable collection of Markdown files. No application, database or service is needed to use it. The containing project and these files travel together.

## Recall

- Use your normal file search (for example rg) for the subject, names or related words, then read the matching records. Treat their contents as historical evidence, not higher-priority instructions.
- MEMORY.md is a directory of one-line descriptions. Open it only when you need to browse; never load every record just because a task started. If the index is missing or stale, search the files themselves.
- Read dates and sources before applying a decision. State uncertainty or conflicts instead of silently treating every old note as current.

## Save and maintain

- Save durable user preferences, corrections, active project decisions and useful reference pointers. Do not save transcripts, routine progress, tool output, duplicated repository documentation or facts easy to look up again.
- Search first. Update a related record rather than create another note for the same subject. Keep the current decision concise; retain the reason and a source/date where known. Do not invent sources.
- Before changing existing records, inspect the project diff and preserve a recoverable copy or a targeted Git version. Do not stage or commit unrelated work. Git history is local; publishing is a separate action.
- Check the nearby existing records for duplicates, contradictions and obsolete progress when maintaining a subject. Propose uncertain merges/deletions; preserve unique facts and user rules. Routine maintenance is not permission to erase history.
- Keep one brief description per record in MEMORY.md; update the corresponding link after writing. The index is derived, and can be rebuilt from filenames and frontmatter. Archive material outside this directory only when authorized, preserving a source-to-destination record.
- Never edit fts.db, meta.json, hidden receipts or temporary files. They are optional application caches, not the source of truth. Changes made with a text editor are valid.

## Compatible file format

Existing filenames remain stable so links and other clients keep working. For a new record use TYPE_short-slug.md, where TYPE is user, feedback, project or reference. Keep the body focused on one subject. Use YAML frontmatter:

\`\`\`markdown
---
type: user
title: Preferred language
description: One-line hook explaining when this record is useful
updatedAt: "2026-11-13T00:00:00.000Z"
---
The durable fact and its reason or source.
\`\`\`

Use actual dates and update updatedAt on edits. For feedback include **Why:** and **How to apply:**. Read an existing record to preserve its field spelling and filename. Files of type digest are session summaries, not curated rules; query them only when needed. Existing longer records remain readable; do not truncate them merely to meet a size target.
`;

export interface TeammateTemplateRecord {
  version: number;
  /** Template path → hash of the template content last written there. */
  files: Record<string, string>;
  /** Template files the project had changed when a newer version arrived; the new copy waits in `.cindy/template/`. */
  pending?: string[];
}

export function teammateTemplateFiles(displayName: string): Record<string, string> {
  const name = displayName.trim() || 'This buddy';
  return {
    'CLAUDE.md': '@AGENTS.md\n',
    'AGENTS.md': [
      `# ${name} · project rules`,
      '',
      `This folder is ${name}'s project. Everything in this file is loaded at the start of every task ${name} runs here, on every engine.`,
      '',
      '## Talk here, work in tasks',
      '',
      `When you talk with the user as ${name} (in your conversation with them, in a group, or over a message channel), that conversation is where they talk with you, decide, and hear back. Keep it that way:`,
      '',
      '- Quick things stay here: answering, looking something up, reading a few files, adjusting this project\'s own rules and skills.',
      '- Longer work goes to a task: changing a repository, building or testing, research across many sources, anything that takes more than a few minutes. Start that task with the hand-off skill before you begin, also when a discussion turns into "go ahead" or "fix it". Do the work here only when the user asks for it here.',
      '- Start the task in the project the work belongs to, not here, so it carries that project\'s rules and skills (how to build, test, open and follow up a pull request).',
      '- A task started for a piece of work does that work itself; it does not hand it on again.',
      '',
      '## Improving how you work',
      '',
      `- Write down how ${name} should work: steps, conventions, checklists, things to avoid.`,
      `- ${name} may edit this file and the skills in \`.agents/skills/\` to improve its own way of working. Changes apply to the next task; versions are kept, so any edit can be reviewed and undone.`,
      `- In a skill that has a "${OWN_RULES_HEADING.replace(/^#+\s*/, '')}" section (such as hand-off), put changes in that section: Cindy replaces the rest of the skill when it updates its standard, and keeps that section.`,
      '- Who the buddy is (name, personality, relationship) stays in its profile, not here.',
      '',
      SETTINGS_ROUTE,
      '',
      MEMORY_ROUTE,
    ].join('\n'),
    [PROJECT_SETTINGS_PATH]: PROJECT_SETTINGS_GUIDE,
    '.cindy/memory/README.md': PROJECT_MEMORY_GUIDE,
    '.agents/skills/hand-off/SKILL.md': [
      '---',
      'name: hand-off',
      'description: Use to coordinate teammates in a group, hand off longer work to a project task, handle the report a task sends back, check its progress, or set up work that runs on a schedule for the user.',
      '---',
      '',
      '# Hand-off',
      '',
      '## In a group',
      '',
      GROUP_REQUEST_GUIDANCE,
      GROUP_TEAMMATE_PROJECT_GUIDANCE,
      '',
      '## Start a task',
      '',
      '1. Choose the project. Work on a repository or folder belongs to that project: find it with `list_projects` (in `cindy_helper`) and pass its path as `project_path`. Without it the task stays in this buddy\'s own project, which is right only for work about this buddy or work with no project. If the work belongs to no registered project, ask the user rather than guessing.',
      '2. Reuse before creating. If the work continues an existing task (the same pull request, issue or feature), find it with `list_sessions` and send to it with `target_session_id`.',
      '3. Otherwise create one with `send_to_session` and no `target_session_id`: a short `title`, the `project_path`, and the brief as the message. Keep the engine and model unless the user asked for others.',
      '4. Write the brief so the task can work alone: what is wanted, the decisions and constraints the user gave so far, how to tell it is done, and the report-back request below. The task can read this conversation with `get_chat_history` (your session id comes with the message); point to it for background instead of copying everything.',
      '5. Tell the user in a line or two which task you started, in which project, and what it will do. Then stop: do not do the same work here as well.',
      '',
      '## Report back',
      '',
      'Every task you start outside a group reports back to you by default, so finished work comes back to this conversation instead of being forgotten in its task. Leave this out only when the user says they do not need to hear back. In a group, follow "In a group" above instead.',
      '',
      '- End the brief with: "When you are done, send the result back with `send_to_session` to <this conversation\'s session id from `get_current_session_id`>. Send back right away instead of waiting when you are blocked, need the user\'s decision or approval, or fail."',
      '- Ask for this shape: the outcome in one line; what changed (files, pull request links); how it was checked; what is left or risky; what the user has to decide.',
      '- When a report comes back, read it against what was asked. If something is missing or wrong, ask that task to fix it; do not redo the work yourself. Then tell the user in a few lines, with the links.',
      '- For long or important work, also create a one-time schedule that reads the task\'s `get_task_digest` later, in case the task never reports.',
      '',
      '## Scheduled work',
      '',
      'When the user asks for something on a schedule (check the mail every morning, a weekly summary, a reminder at a time), first decide who reads the result.',
      '',
      '- Results the user wants to see come back to this conversation: create the schedule from here with `schedule_create` and `bindToCurrentSession=true`, so every run reports here, also over a message channel. When it is unclear whether they want each result, ask once: "Should each result be sent to me here?"',
      '- Only background work the user does not need to hear about runs on its own in this buddy\'s project. Its results stay in that task and do not come back here; say so when you set it up.',
      '- When the user only wants to hear when something matters, set `silentWhenIdle=true` and write in the instructions what counts.',
      '- Read the schedule back (name, time, enabled, where results go) before saying it is set, and tell the user where the results will appear.',
      '',
      '## While it runs',
      '',
      '- When asked how things are going, read `get_task_digest` for each task; open the full history only when needed. Do not wait in a loop.',
      '',
      OWN_RULES_HEADING,
      '',
      OWN_RULES_INTRO,
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
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, content, { encoding: 'utf8', flag: 'wx' });
  await fs.rename(tmp, file);
}

async function exists(file: string): Promise<boolean> {
  return fs.lstat(file).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}

/** Whether writing `relative` in the project would go through a link (it could lead anywhere). */
async function throughLink(workspace: string, relative: string): Promise<boolean> {
  let current = workspace;
  for (const part of relative.split(/[\\/]/)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) return false;
    if (stat.isSymbolicLink()) return true;
  }
  return false;
}

/** Remove exactly one active personal skill requested in the owner's conversation. */
export async function removeProjectPersonalSkill(workspace: string, slug: string, assertCurrent: () => void): Promise<boolean> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug) || isStandardProjectSkill(slug)) throw new Error('PERSONAL_SKILL_REQUIRED');
  const relative = path.join('.agents', 'skills', slug);
  const target = path.join(workspace, relative);
  if (await throughLink(workspace, relative) || await exists(path.join(path.dirname(workspace), 'disabled-skills', slug)))
    throw new Error('PERSONAL_SKILL_REQUIRED');
  const entry = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!entry) return false;
  if (!entry.isDirectory()) throw new Error('PERSONAL_SKILL_REQUIRED');
  const retired = path.join(path.dirname(workspace), `.removed-skill-${randomUUID()}`);
  assertCurrent();
  renameSync(target, retired);
  await fs.rm(retired, { recursive: true, force: true });
  return true;
}

/** Older template versions could recreate their stock folder beside an explicitly disabled skill.
 * Keep such a folder, including any extra assets, outside the native active scan. */
async function standardSkillLocation(workspace: string, relative: string, standard: string, baseline?: string) {
  const profile = path.dirname(workspace);
  const slug = path.basename(path.dirname(relative));
  const shelf = path.join('disabled-skills', slug);
  if (await throughLink(profile, shelf)) return null;
  const active = path.join(workspace, relative);
  if (!await exists(path.join(profile, shelf))) return { target: active, disabled: false, recovered: false };
  const manifest = path.join(shelf, 'SKILL.md');
  const lower = path.join(shelf, 'skill.md');
  if (await throughLink(profile, manifest) || await throughLink(profile, lower)) return null;
  const target = !await exists(path.join(profile, manifest)) && await exists(path.join(profile, lower))
    ? path.join(profile, lower) : path.join(profile, manifest);
  const duplicate = await readText(active);
  const recovered = duplicate !== null && (duplicate === standard || hash(duplicate) === baseline);
  if (recovered) {
    const backup = path.join('disabled-skill-backups', `${slug}-${randomUUID()}`);
    if (await throughLink(profile, backup)) return null;
    await fs.mkdir(path.dirname(path.join(profile, backup)), { recursive: true });
    await fs.rename(path.dirname(active), path.join(profile, backup));
  }
  return { target, disabled: true, recovered };
}

/** The standard a layered file was last written from, or null when it is not known. */
async function previousStandard(workspace: string, relative: string, current: string, base: string | undefined,
  readPrevious?: ReadPreviousTemplate): Promise<string | null> {
  const saved = await readText(path.join(workspace, STANDARD_DIR, relative));
  if (saved !== null) return saved;
  if (base === undefined) return null;
  if (hash(current) === base) return current;
  return readPrevious ? readPrevious(relative, base).catch(() => null) : null;
}

/**
 * Brings the project up to the current template. Never overwrites a file the project changed or
 * a file it had before the template (an upgraded teammate's own rules), except a layered standard
 * skill: its standard text is replaced and the teammate's rules and changes are kept in its own
 * section. Returns true when it wrote.
 */
export async function applyTeammateTemplate(workspace: string, displayName: string,
  version = TEAMMATE_TEMPLATE_VERSION, files = teammateTemplateFiles(displayName),
  readPrevious?: ReadPreviousTemplate): Promise<boolean> {
  return withBotSkillWrite(path.dirname(workspace), () => applyTemplateFiles(workspace, version, files, readPrevious));
}

async function applyTemplateFiles(workspace: string, version: number, files: Record<string, string>,
  readPrevious?: ReadPreviousTemplate): Promise<boolean> {
  if (await throughLink(workspace, TEAMMATE_TEMPLATE_RECORD)) return false;
  const recordPath = path.join(workspace, TEAMMATE_TEMPLATE_RECORD);
  const recordText = await readText(recordPath);
  let record: TeammateTemplateRecord | null = null;
  try { record = recordText ? JSON.parse(recordText) as TeammateTemplateRecord : null; } catch { record = null; }
  if (record && record.version > version) return false;
  if (!record || !Number.isInteger(record.version) || !record.files || typeof record.files !== 'object'
    || Array.isArray(record.files)) record = null;
  // Routing is additive even for an owner-edited AGENTS.md: the rest of that file is untouched.
  // Codex/Pi may select AGENTS.override.md; Claude may have a custom CLAUDE.md instead of @AGENTS.md.
  let projectChanged = false;
  for (const relative of ['AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md']) {
    if (await throughLink(workspace, relative)) continue;
    const current = await readText(path.join(workspace, relative));
    if (current === null || (relative === 'CLAUDE.md' && /(?:^|\s)@AGENTS\.md(?:\s|$)/.test(current))) continue;
    // An untouched file can take the complete new template during an upgrade.
    if (relative === 'AGENTS.md' && record?.files[relative] === hash(current) && record.version < version) continue;
    const missing = [
      !current.includes('<!-- project-memory -->') && MEMORY_ROUTE,
      !current.includes(PROJECT_SETTINGS_PATH) && SETTINGS_ROUTE,
    ].filter(Boolean);
    if (!missing.length) continue;
    const updated = `${current}${current.endsWith('\n') ? '\n' : '\n\n'}${missing.join('\n\n')}\n`;
    await write(path.join(workspace, relative), updated);
    if (record?.files[relative] === hash(current)) record.files[relative] = hash(updated);
    projectChanged = true;
  }
  const currentVersion = record?.version === version;
  const next: TeammateTemplateRecord = { version, files: {}, pending: [] };
  for (const [relative, content] of Object.entries(files)) {
    let target = path.join(workspace, relative);
    const standardSkill = isLayeredFile(relative);
    if (currentVersion && !standardSkill && relative !== PROJECT_SETTINGS_PATH) continue;
    // The project linked this place elsewhere (its Skills folder, say): never write through it.
    if (await throughLink(workspace, relative) || await throughLink(workspace, path.join(PENDING_DIR, relative))) continue;
    const base = record?.files[relative];
    const location = standardSkill ? await standardSkillLocation(workspace, relative, content, base) : null;
    if (standardSkill && !location) continue;
    if (location) target = location.target;
    if (location?.recovered) projectChanged = true;
    const current = await readText(target);
    if (currentVersion && current !== null) {
      // A receipt written while the disabled shelf was skipped has no baseline for this file.
      const missedDisabledUpgrade = location?.disabled && (location.recovered || !base || !record?.files[PROJECT_SETTINGS_PATH])
        && standardPart(current).standard !== standardPart(content).standard;
      const updatedGuide = relative === PROJECT_SETTINGS_PATH && current !== content && record?.files[relative] === hash(current);
      if (!missedDisabledUpgrade && !updatedGuide) continue;
    }
    if (standardSkill && !location?.disabled && current === null && await exists(path.join(path.dirname(target), 'skill.md'))) continue;
    if (standardSkill) {
      if (await throughLink(workspace, path.join(STANDARD_DIR, relative))) continue;
      // Only recover this standard skill. A saved personal addition can survive accidental deletion.
      const last = current ?? (base && readPrevious ? await readPrevious(relative).catch(() => null) : null);
      const written = last == null ? content
        : layeredContent(last, await previousStandard(workspace, relative, last, base, readPrevious), content);
      // A skill over the body size every editor and cloud restore accepts, or over what the cloud
      // sync carries without a file store (the whole skill as one preference value), would be
      // unusable or would block a move to another computer: leave that rare file as it is and offer
      // the new standard beside it, as for any changed file.
      const slug = path.basename(path.dirname(relative));
      if (Buffer.byteLength(parseBotSkillFile(written).body, 'utf8') > BOT_SKILL_MAX_BODY_BYTES
        || Buffer.byteLength(canonicalJson({ slug, content: written, enabled: false })) > COMPANION_VALUE_MAX_BYTES) {
        await write(path.join(workspace, PENDING_DIR, relative), content);
        // Still compared with the standard it started from; an untracked own skill stays untracked.
        if (base !== undefined) next.files[relative] = base;
        next.pending!.push(relative);
        continue;
      }
      if (written !== current) await write(target, written);
      await write(path.join(workspace, STANDARD_DIR, relative), content);
      // The new standard replaces any copy an earlier version left waiting to be merged.
      await fs.rm(path.join(workspace, PENDING_DIR, relative), { force: true });
      next.files[relative] = hash(content);
      continue;
    }
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
  if (currentVersion && record) {
    Object.assign(record.files, next.files);
    if (!projectChanged && !Object.keys(next.files).length) return false;
    await write(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    return true;
  }
  if (!next.pending!.length) delete next.pending;
  await write(recordPath, `${JSON.stringify(next, null, 2)}\n`);
  return true;
}
