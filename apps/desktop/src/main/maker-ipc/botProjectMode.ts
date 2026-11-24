/**
 * 伙伴 V2(项目模式)。伙伴 = 一个包装过的项目 + 一堆任务。
 *
 * 开启后伙伴的 `workspace/` 就是一个普通 Cindy 项目：
 *   - 登记进项目列表(侧栏可见，名字是伙伴名)；
 *   - 根部的 AGENTS.md 是这个伙伴的项目规则(CLAUDE.md 用 `@AGENTS.md` 指过去)；
 *   - 记忆就是这个项目的记忆，放在项目里的 `.cindy/memory/`(随项目 Git 记版本)；技能就是项目里
 *     `.agents/skills` 下的技能；
 *   - 用 Git 记版本，沿用 Cindy 的快照与回退。
 *
 * 只有身份(名字头像、SOUL、IM 等对外身份)留在伙伴外壳上。
 * 开启时把原来的记忆和技能**复制**进项目(不搬走、不覆盖)，关掉开关就回到原来的伙伴。
 */
import { createHash } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';

import { BrowserWindow } from 'electron';

import { getActiveDataOwnerPushStamp } from '../appSessionState.js';
import { getDbPathForUser } from '../localDb/index.js';
import { getCurrentDbClientUserId } from '../localDb/client/current.js';
import { MEMORY_STORAGE_MIGRATION_RECEIPT, parseFilename } from '@cindy/maker-core';
import { createSnapshotDetailed } from '../git-snapshot/gitSnapshotService.js';
import { listProjectAliases, upsertProjectAlias } from '../localDb/ipc/projectAliases.js';
import { normalizeRecentWorkdirPath, upsertRecentWorkdir } from '../localDb/ipc/recentWorkdirs.js';
import { createLogger } from '../logger.js';
import { isTrustedAppRendererWindow } from '../security/trustedAppRenderer.js';
import { restoreLocalProjectVisibility } from '../sidebarSettingsStore.js';
import { gitExec, GitExecError } from '../worktree/gitExec.js';
import { detectCwd } from '../worktree/WorktreeManager.js';
import { botProfileDir, botProfileMemoryDir, ensureBotWorkspaceDir } from './botProfileFolder.js';
import {
  hasTeammateUpgraded,
  TEAMMATE_GITIGNORE_RECEIPT_FILE,
  TEAMMATE_MEMORY_MOVE_RECEIPT_FILE,
  TEAMMATE_PROJECT_MEMORY_SEGMENTS,
  isTeammateProjectIgnoreReady,
  legacyTeammateProjectMemoryDir,
  teammateProjectMemoryDir,
  unlinkedTeammateProjectMemoryDir,
} from './botProjectMemory.js';
import { setBotProjectSkillsDir } from './botSkillStore.js';
import { TEAMMATE_TEMPLATE_VERSION, applyTeammateTemplate, type ReadPreviousTemplate } from './botProjectTemplate.js';
import { ensureMemoryReviewHook, MEMORY_REVIEW_HOOK_COMMAND, LEGACY_MEMORY_REVIEW_HOOK_COMMAND } from './botProjectMemoryReview.js';
import type { ProjectScheduleConfig } from '../scheduler-host/project-automation-loader.js';
import type { BotModelRoute } from '../../shared/botModelChain.js';
import type { BotProjectRepositoryStatus } from '../../shared/botProjectMode.js';

const log = createLogger('maker-ipc:bot-project-mode');

async function writeIfMissing(filePath: string, content: string): Promise<boolean> {
  try {
    await fs.writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/** A folder's entries; a missing folder has none. Any other read failure is thrown, so the upgrade retries. */
async function readEntries(dir: string) {
  return fs.readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
}

async function sameContent(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([fs.readFile(a), fs.readFile(b)]);
  return left.equals(right);
}

/** The free name beside `file` for an older copy: `name-from-v1.ext`, then `-2`, … */
async function besideName(file: string): Promise<string> {
  const ext = path.extname(file);
  const stem = file.slice(0, file.length - ext.length);
  for (let index = 1; ; index++) {
    const candidate = `${stem}-from-v1${index === 1 ? '' : `-${index}`}${ext}`;
    if (!await fs.lstat(candidate).then(() => true, () => false)) return candidate;
  }
}

/**
 * The folder beside `dir` for an older copy: an earlier run's `-from-v1` folder is reused (merged
 * into), so a retried upgrade does not copy everything again.
 */
async function besideDir(dir: string): Promise<string> {
  for (let index = 1; ; index++) {
    const candidate = `${dir}-from-v1${index === 1 ? '' : `-${index}`}`;
    const kind = await kindAt(candidate);
    if (kind === null || kind === 'dir') return candidate;
  }
}

/**
 * Copy durable memory records into the project's memory. A record of the same name already there is
 * a later version of the same memory (the project's copy is the newer one) and wins; the older one
 * stays where it was.
 */
async function copyMemoryRecords(sourceDir: string, targetDir: string): Promise<number> {
  const entries = await readEntries(sourceDir);
  let copied = 0;
  for (const entry of entries) {
    // Only curated records; MEMORY.md, fts.db and meta.json are rebuilt by the store.
    if (!entry.isFile() || !parseFilename(entry.name)) continue;
    await fs.mkdir(targetDir, { recursive: true });
    try {
      await fs.copyFile(path.join(sourceDir, entry.name), path.join(targetDir, entry.name), fsConstants.COPYFILE_EXCL);
      copied++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  return copied;
}

/** Whether `target` lies inside `root` (both real paths). */
function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** What is at `file` without following a link: null when nothing is there. */
async function kindAt(file: string): Promise<'file' | 'dir' | 'other' | null> {
  const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return null;
  return stat.isSymbolicLink() ? 'other' : stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'other';
}

/**
 * Merge one Skill folder into the project's copy, file by file: a missing file is copied, a file the
 * project has with other content keeps the project's and gets the old one beside it (`-from-v1`).
 * A link to something inside the Skill folder is copied as what it points to (each folder once, so
 * a link loop ends); a link leading outside it is not followed (it could expose anything on the
 * computer) and is reported. Nothing is written through a link in the project, or over a file of
 * the other kind: the old copy then goes beside. Returns the files written.
 */
async function mergeSkillTree(sourceRoot: string, source: string, target: string, skipped: string[],
  ancestors: Set<string>): Promise<number> {
  const realSource = await fs.realpath(source);
  // Only a folder already being copied above this one is a loop; another link to a folder inside
  // the Skill is a second name for it and is copied there too.
  if (ancestors.has(realSource)) return 0;
  ancestors.add(realSource);
  try {
    return await mergeSkillEntries(sourceRoot, source, target, skipped, ancestors);
  } finally {
    ancestors.delete(realSource);
  }
}

async function mergeSkillEntries(sourceRoot: string, source: string, target: string, skipped: string[],
  ancestors: Set<string>): Promise<number> {
  let written = 0;
  for (const entry of await readEntries(source)) {
    const from = path.join(source, entry.name);
    let to = path.join(target, entry.name);
    let real = from;
    let stat = await fs.lstat(from);
    if (stat.isSymbolicLink()) {
      const resolved = await fs.realpath(from).catch(() => null);
      if (!resolved || !inside(sourceRoot, resolved)) {
        skipped.push(path.relative(path.dirname(sourceRoot), from));
        continue;
      }
      real = resolved;
      stat = await fs.stat(resolved);
    }
    if (!stat.isDirectory() && !stat.isFile()) continue;
    const kind = stat.isDirectory() ? 'dir' : 'file';
    const existing = await kindAt(to);
    // A link the project made, or a file where a folder was (or the reverse): keep it, put the old beside.
    if (existing !== null && existing !== kind) to = kind === 'dir' ? await besideDir(to) : await besideName(to);
    if (kind === 'dir') {
      if (ancestors.has(real)) continue;
      await fs.mkdir(to, { recursive: true });
      written += await mergeSkillTree(sourceRoot, real, to, skipped, ancestors);
      continue;
    }
    try {
      await fs.copyFile(real, to, fsConstants.COPYFILE_EXCL);
      written++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await sameContent(real, to)) continue;
      const siblings = (await readEntries(target)).filter((item) => item.isFile()).map((item) => path.join(target, item.name))
        .filter((file) => file !== to && path.basename(file).startsWith(`${path.basename(to, path.extname(to))}-from-v1`));
      let present = false;
      for (const sibling of siblings) if (await sameContent(real, sibling)) present = true;
      if (present) continue;
      await fs.copyFile(real, await besideName(to), fsConstants.COPYFILE_EXCL);
      written++;
    }
  }
  return written;
}

/** Merge each Skill folder into the project's Skills; the project's own files are never overwritten. */
async function copySkillFolders(sourceDir: string, workspace: string): Promise<{ copied: number; skippedLinks: string[]; targetDir: string }> {
  let copied = 0;
  const skippedLinks: string[] = [];
  let targetDir = path.join(workspace, '.agents', 'skills');
  // The project's Skills folder (or `.agents`) is a link the project set up: never write through it.
  for (const dir of [path.join(workspace, '.agents'), targetDir]) {
    const kind = await kindAt(dir);
    if (kind !== null && kind !== 'dir') { targetDir = await besideDir(path.join(workspace, 'skills')); break; }
  }
  const root = await fs.realpath(sourceDir).catch(() => sourceDir);
  for (const entry of await readEntries(sourceDir)) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (await kindAt(path.join(path.dirname(sourceDir), 'disabled-skills', entry.name)) !== null) continue;
    const skillRoot = path.join(root, entry.name);
    let target = path.join(targetDir, entry.name);
    const existing = await kindAt(target);
    if (existing !== null && existing !== 'dir') target = await besideDir(target);
    await fs.mkdir(target, { recursive: true });
    if (await mergeSkillTree(skillRoot, skillRoot, target, skippedLinks, new Set()) > 0) copied++;
  }
  return { copied, skippedLinks, targetDir };
}

/**
 * The memory records are the teammate's own work and are versioned; what the memory store derives
 * beside them (the rebuilt MEMORY.md index, search database, folder metadata, temp files) is not.
 * The store's copy receipt is versioned too: a `git clean` must not make it copy the old records
 * again over later deletions.
 */
const MEMORY_DIR = TEAMMATE_PROJECT_MEMORY_SEGMENTS.join('/');
export const BOT_PROJECT_MEMORY_GITIGNORE = [
  `${MEMORY_DIR}/*`,
  `!${MEMORY_DIR}/*.md`,
  `!${MEMORY_DIR}/${MEMORY_STORAGE_MIGRATION_RECEIPT}`,
  `${MEMORY_DIR}/MEMORY.md`,
];

/**
 * A teammate puts whatever its work needs in its project: a skill's `.env` or token file, Python
 * environments, worktrees of the repositories it works on. Versions are for its own work, so these
 * stay out of Git (and out of every automatic snapshot's file count). Env templates stay versioned;
 * their exceptions follow `.env.*`, which they must, also when appended to an existing file.
 */
export const BOT_PROJECT_LOCAL_GITIGNORE = [
  '.env', '.env.*', '!.env.example', '!.env.sample', '!.env.template',
  'token.json', 'credentials.json', 'client_secret*.json', '*.pem', '*.p12', '*.pfx',
  '.venv/', 'venv/', '__pycache__/', '.cindy-worktrees/', '.xdt-worktrees/',
];
const ENV_TEMPLATE_EXCEPTIONS = BOT_PROJECT_LOCAL_GITIGNORE.filter((line) => line.startsWith('!'));

const BOT_PROJECT_GITIGNORE = [
  'node_modules/', 'tmp/', '.DS_Store', '*.log',
  '*.zip', '*.tar', '*.tar.gz', '*.tgz', '*.dmg', '*.iso',
  '*.db', '*.sqlite', '*.sqlite3', '*-wal', '*-shm', 'pg_wal/',
  ...BOT_PROJECT_LOCAL_GITIGNORE,
  ...BOT_PROJECT_MEMORY_GITIGNORE,
  '',
].join('\n');

/**
 * Appends the entries a project's `.gitignore` lacks, keeping its own lines as they are. A missing
 * file gets the whole default list; a `.gitignore` the project made a link is left alone. True when
 * it changed.
 */
async function ensureIgnored(workspace: string, entries: readonly string[]): Promise<boolean> {
  const file = path.join(workspace, '.gitignore');
  const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (stat === null) return writeIfMissing(file, BOT_PROJECT_GITIGNORE);
  if (!stat.isFile()) return false;
  const current = await fs.readFile(file, 'utf8');
  const lines = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const missing = entries.filter((line) => !lines.has(line));
  // An exception only applies below its pattern: a newly added `.env.*` is followed by them again.
  if (missing.includes('.env.*')) missing.push(...ENV_TEMPLATE_EXCEPTIONS.filter((line) => !missing.includes(line)));
  if (!missing.length) return false;
  const newline = current.includes('\r\n') ? '\r\n' : '\n';
  const separator = current === '' || current.endsWith('\n') ? '' : newline;
  await fs.writeFile(file, `${current}${separator}${missing.join(newline)}${newline}`, 'utf8');
  return true;
}

/**
 * A project set up before {@link BOT_PROJECT_LOCAL_GITIGNORE} gets the entries it lacks, once.
 * Only `.gitignore` changes: files already in the history stay versioned and nothing on disk is
 * removed. No version is recorded here: the teammate's next version includes the change, and a
 * startup snapshot has no size bound. Never throws. `failed` (say, a read-only `.gitignore`) keeps
 * the teammate usable but defers its versions, and is retried on the next start or repository retry.
 */
export async function ensureTeammateProjectIgnored(input: { workspace: string; botId?: string }): Promise<'ready' | 'failed'> {
  try {
    if (await isTeammateProjectIgnoreReady(input.workspace)) return 'ready';
    const changed = await ensureIgnored(input.workspace, BOT_PROJECT_LOCAL_GITIGNORE);
    await fs.writeFile(path.join(path.dirname(input.workspace), TEAMMATE_GITIGNORE_RECEIPT_FILE), `${JSON.stringify({ version: 1, at: new Date().toISOString(), changed }, null, 2)}\n`, 'utf8');
    if (changed) log.info('teammate project .gitignore completed', { botId: input.botId });
    return 'ready';
  } catch (error) {
    log.warn('teammate project .gitignore update failed; its versions wait until it is completed', { botId: input.botId, error: String(error) });
    return 'failed';
  }
}

async function isOwnRepository(workspace: string): Promise<boolean> {
  return fs.lstat(path.join(workspace, '.git')).then(() => true, () => false);
}

async function snapshotTeammateProject(botId: string, workspace: string, label: string): Promise<void> {
  if (!await isOwnRepository(workspace)) return;
  // The change stays in the project and goes into the first version after the entries are in place.
  if (!await isTeammateProjectIgnoreReady(workspace).catch(() => false)) {
    log.info('teammate project version deferred until its .gitignore is completed', { botId, label });
    return;
  }
  try {
    await createSnapshotDetailed(workspace, { label, meta: { sessionId: 'bot-project', kind: 'manual' } });
  } catch (error) {
    // Versions are an addition: a Git failure must not keep the memories from being used.
    log.warn('teammate project snapshot failed', { botId, error: String(error) });
  }
}

/**
 * Once per teammate: its project's memory was kept outside the project, like any project's
 * (`<owner>/maker-memory/<scope>`); now it lives in the project. Copies those records in — a record
 * the project already has wins — leaves the old folder untouched as a fallback, tells the memory
 * store the copy is done (so it never copies again over later deletions), makes sure the derived
 * files stay out of Git and keeps a version. Returns the records copied; null when already done.
 */
export async function moveTeammateMemoryIntoProject(input: {
  botId: string;
  ownerRoot: string;
  workspace: string;
}): Promise<number | null> {
  const receipt = path.join(botProfileDir(input.ownerRoot, input.botId), TEAMMATE_MEMORY_MOVE_RECEIPT_FILE);
  if (await fs.lstat(receipt).then(() => true, () => false)) return null;
  const target = unlinkedTeammateProjectMemoryDir(input.workspace);
  const copied = await copyMemoryRecords(await legacyTeammateProjectMemoryDir(input.ownerRoot, input.workspace), target);
  await fs.mkdir(target, { recursive: true });
  await writeIfMissing(path.join(target, MEMORY_STORAGE_MIGRATION_RECEIPT),
    `${JSON.stringify({ schemaVersion: 1, migratedAt: new Date().toISOString() })}\n`);
  const ignoreChanged = await ensureIgnored(input.workspace, BOT_PROJECT_MEMORY_GITIGNORE);
  if (copied > 0 || ignoreChanged) await snapshotTeammateProject(input.botId, input.workspace, 'Move teammate memory into the project');
  await fs.writeFile(receipt, `${JSON.stringify({ version: 1, movedAt: new Date().toISOString(), copied }, null, 2)}\n`, 'utf8');
  if (copied > 0) log.info('teammate memory moved into its project', { botId: input.botId, copied });
  return copied;
}

/**
 * An earlier template file, found in the project's own Git history by the hash the template record
 * kept: what a teammate's changed copy started from. Looks back a bounded number of versions.
 */
export function templateFromProjectHistory(workspace: string): ReadPreviousTemplate {
  return async (relative, sha256) => {
    if (!await isOwnRepository(workspace)) return null;
    const file = relative.split(path.sep).join('/');
    const { stdout } = await gitExec(['log', '--format=%H', '--diff-filter=AM', '-n', sha256 ? '50' : '1', '--', file], workspace, { timeoutMs: 10_000 });
    for (const commit of stdout.split('\n').map(line => line.trim()).filter(Boolean)) {
      const shown = await gitExec(['show', `${commit}:${file}`], workspace, { timeoutMs: 10_000 }).catch(() => null);
      if (shown && (!sha256 || createHash('sha256').update(shown.stdout).digest('hex') === sha256)) return shown.stdout;
    }
    return null;
  };
}

/** An upgraded teammate gets the starter template's missing files (or a newer version) once, as a version. */
export async function ensureTeammateTemplate(input: { botId: string; displayName: string; workspace: string }): Promise<boolean> {
  const applied = await applyTeammateTemplate(input.workspace, input.displayName, undefined, undefined,
    templateFromProjectHistory(input.workspace));
  if (applied) await snapshotTeammateProject(input.botId, input.workspace, `Apply teammate template v${TEAMMATE_TEMPLATE_VERSION}`);
  return applied;
}

/** A repository whose root is the workspace itself; an enclosing repo does not count. */
async function inspectWorkspaceRepository(workspace: string, repairSafeDirectory = true): Promise<'ready' | 'unborn' | 'missing' | 'unavailable'> {
  const before = await detectCwd(workspace, { repairSafeDirectory });
  const probeOptions = { timeoutMs: 10_000, repairSafeDirectory };
  if (!before.gitInstalled) return 'unavailable';
  const [ownRoot, repoRoot] = await Promise.all([
    fs.realpath(workspace),
    before.repoRoot ? fs.realpath(before.repoRoot).catch(() => before.repoRoot) : Promise.resolve(null),
  ]);
  if (before.isGitRepo && repoRoot === ownRoot) {
    try {
      await gitExec(['rev-parse', '--verify', 'HEAD^{commit}'], workspace, probeOptions);
      return 'ready';
    } catch (error) {
      if (!(error instanceof GitExecError) || error.exitCode !== 128
        || error.timedOut || error.aborted || error.cleanupUnconfirmed) throw error;
      // A failed HEAD lookup alone does not mean an unborn branch: a detached HEAD,
      // unreadable ref or missing commit object must not be repaired by a new commit.
      const { stdout } = await gitExec(['symbolic-ref', '--quiet', 'HEAD'], workspace, probeOptions);
      const branch = stdout.trim();
      if (!branch.startsWith('refs/heads/')) throw error;
      try {
        await gitExec(['show-ref', '--verify', '--quiet', branch], workspace, probeOptions);
      } catch (refError) {
        if (!(refError instanceof GitExecError) || refError.exitCode !== 1
          || refError.stderr.trim() || refError.timedOut || refError.aborted || refError.cleanupUnconfirmed) throw refError;
        return 'unborn';
      }
      throw error;
    }
  }
  // Discovery can report non-Git for damaged metadata. Never re-init over an existing
  // .git entry (including a dangling link), or mistake an access failure for absence.
  const gitEntry = await fs.lstat(path.join(workspace, '.git')).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (gitEntry) throw new Error('Existing buddy repository could not be read');
  return 'missing';
}

/** Read-only: opening settings must never create a commit or change Git configuration. */
export async function readWorkspaceRepositoryStatus(workspace: string): Promise<BotProjectRepositoryStatus> {
  try {
    const state = await inspectWorkspaceRepository(workspace, false);
    if (state === 'ready' || state === 'unavailable') return state;
    if (state === 'missing') return 'not-ready';
    for (const identity of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
      await gitExec(['var', identity], workspace, { timeoutMs: 10_000, repairSafeDirectory: false, extraEnv: { LC_ALL: 'C' } });
    }
    return 'not-ready';
  } catch (error) {
    if (error instanceof GitExecError && error.exitCode === 128
      && /identity unknown|unable to auto-detect|empty ident|no (?:name|email) was given/i.test(error.stderr)) return 'needs-identity';
    return 'failed';
  }
}

const repositoryPreparations = new Map<string, Promise<'initialized' | 'already-git' | 'unavailable'>>();

/** Startup and explicit retries share one in-flight attempt for this workspace. */
export function ensureWorkspaceRepository(workspace: string): Promise<'initialized' | 'already-git' | 'unavailable'> {
  const key = path.resolve(workspace);
  const pending = repositoryPreparations.get(key);
  if (pending) return pending;
  const attempt = initializeWorkspaceRepository(workspace).finally(() => {
    if (repositoryPreparations.get(key) === attempt) repositoryPreparations.delete(key);
  });
  repositoryPreparations.set(key, attempt);
  return attempt;
}

async function initializeWorkspaceRepository(workspace: string): Promise<'initialized' | 'already-git' | 'unavailable'> {
  const state = await inspectWorkspaceRepository(workspace);
  if (state === 'unavailable') return state;
  if (state === 'ready') return 'already-git';
  // The first version takes every file in the folder: only once the local entries keep credentials out.
  if (await ensureTeammateProjectIgnored({ workspace }) === 'failed') throw new Error('Buddy project .gitignore could not be completed');
  // A long-lived teammate folder collects archives, databases and logs; versions are for its
  // own work, so those stay out of the history from the first snapshot on.
  if (state === 'missing') {
    await writeIfMissing(path.join(workspace, '.gitignore'), BOT_PROJECT_GITIGNORE);
    await gitExec(['init'], workspace, { timeoutMs: 10_000 });
  }
  await createInitialWorkspaceSnapshot(workspace);
  return 'initialized';
}

async function createInitialWorkspaceSnapshot(workspace: string): Promise<void> {
  const snapshot = await createSnapshotDetailed(workspace, {
    label: 'Start teammate project',
    meta: { sessionId: 'bot-project', kind: 'manual' },
    allowEmpty: true,
  });
  if (!snapshot.commit) throw new Error('Buddy initial version was not created');
}

function broadcastProjectRegistered(workingDir: string): void {
  const owner = getActiveDataOwnerPushStamp();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!isTrustedAppRendererWindow(window)) continue;
    try {
      window.webContents.send('local-db:recent-workdirs:changed', { path: workingDir }, owner);
    } catch (error) {
      log.warn('teammate project registered but window refresh failed', { error: String(error) });
    }
  }
}

/** The project's own nightly review: an ordinary project automation, not a host job. */
export const BOT_PROJECT_MEMORY_REVIEW_ID = 'teammate-memory-review';

const MEMORY_REVIEW_INSTRUCTIONS = `. Keep only durable, useful knowledge in this project's memory and reusable, proven procedures in its skills. Search existing files first: update a related record or skill instead of adding a duplicate. Review related existing material for duplication, contradictions, obsolete status and unnecessary detail; keep concise facts and actionable steps, not conversation logs or one-off task progress. Preserve the owner's rules and intent. Before merging or removing content, verify the evidence and keep a recoverable copy or a targeted Git commit; leave uncertain items intact. Read .cindy/memory/README.md before memory maintenance. Skills live in .agents/skills; keep SKILL.md focused and move detailed examples to on-demand references when useful. Do not invent a skill just because a review ran. If no meaningful improvement is justified, finish quietly.`;
/** Exactly the supplied prompt from before its check counted since the last review. Any edit,
 * including the review's scope or a name from before a rename, keeps the owner's text. */
function isLastDayReviewPrompt(prompt: string | undefined, input: { botId: string; displayName: string }): boolean {
  const name = input.displayName.trim() || input.botId;
  return prompt === `Review ${name}'s conversations from the last day (teammate id ${input.botId})${MEMORY_REVIEW_INSTRUCTIONS}`;
}

/** Default Bot tasks inherit at creation; their definitions never contain a model snapshot. */
export type BotDefaultProjectSchedule = Omit<ProjectScheduleConfig,
  'followTeammateModel' | 'model' | 'agentKind' | 'modelAgentKind' | 'modelAgentDeviceId'
  | 'providerId' | 'agentDeviceId' | 'effort' | 'fastMode'>;

/** Shared creation policy for every supplied task; existing choices have no inferred provenance. */
export function createBotDefaultProjectSchedule(
  defaults: BotDefaultProjectSchedule,
  current?: ProjectScheduleConfig,
): ProjectScheduleConfig {
  return { ...defaults, ...current,
    followTeammateModel: current ? current.followTeammateModel : true };
}

export function botProjectMemoryReview(input: {
  botId: string;
  displayName: string;
  route?: BotModelRoute | null;
  timezone: string;
  /** Localized "{{name}} · …" title template. */
  title: string;
}): BotDefaultProjectSchedule {
  const name = input.displayName.trim() || input.botId;
  return {
    id: BOT_PROJECT_MEMORY_REVIEW_ID,
    name: input.title.replace('{{name}}', name),
    prompt: `Review ${name}'s conversations since the last completed review (teammate id ${input.botId})${MEMORY_REVIEW_INSTRUCTIONS}`,
    cronExpr: '30 3 * * *',
    timezone: input.timezone,
    recurring: true,
    persistentSession: true,
    silentWhenIdle: true,
  };
}

/** Upgrade only the supplied old prompt; preserve edits, schedule/model choices and removal. */
export async function ensureBotProjectAutomations(input: {
  botId: string;
  displayName: string;
  workingDir: string;
  route?: BotModelRoute | null;
  /** Receipt path: do not resurrect a review removed after the initial V2 upgrade. */
  addMissing?: boolean;
}): Promise<boolean> {
  // Loaded on use: the scheduler host is not part of the teammate profile store's import graph.
  const [{ getProjectAutomationLoader }, { t }] = await Promise.all([
    import('../scheduler-host/index.desktop.js'), import('../i18n.desktop.js'),
  ]);
  const loader = getProjectAutomationLoader();
  const existing = await loader.loadProjectSchedules(input.workingDir);
  const current = existing?.find((config) => config.id === BOT_PROJECT_MEMORY_REVIEW_ID);
  if (!current && input.addMissing === false) return false;
  const suppliedHook = current?.preRunHook?.command === MEMORY_REVIEW_HOOK_COMMAND;
  const legacyHook = current?.preRunHook?.command === LEGACY_MEMORY_REVIEW_HOOK_COMMAND;
  if (current && !suppliedHook && !legacyHook && (current.preRunHook || !current.prompt?.startsWith('Look back at ')
    || !current.prompt.endsWith(`'s conversations from the last day (teammate id ${input.botId}) and keep what is worth remembering in this project's memory and skills. If nothing new is worth keeping, finish quietly.`))) return false;
  const userId = getCurrentDbClientUserId();
  if (!userId) throw new Error('Memory review requires the active account database');
  const databasePath = getDbPathForUser(userId);
  const { bundledCheck, ...preRunHook } = await ensureMemoryReviewHook({ ...input, databasePath, previousCommand: current?.preRunHook?.command });
  // The supplied check now counts since the last review; its untouched last-day prompt follows.
  const upgradePrompt = bundledCheck && isLastDayReviewPrompt(current?.prompt, input);
  if ((suppliedHook || (legacyHook && preRunHook.command === current?.preRunHook?.command)) && !upgradePrompt) return false;
  // An existing file that cannot be read whole is kept: the upgrade fails and retries next start.
  const defaults = botProjectMemoryReview({
    ...input,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    title: t('bots.homeFolder.projectMode.memoryReviewName'),
  });
  await loader.upsertSchedule(input.workingDir, {
    ...createBotDefaultProjectSchedule(defaults, current),
    prompt: legacyHook && !upgradePrompt ? current!.prompt : defaults.prompt,
    preRunHook: { ...preRunHook, ...current?.preRunHook, command: preRunHook.command },
  }, { keepUnreadable: true });
  return true;
}

/** Turning project mode off removes the project's memory review. */
export async function removeBotProjectAutomations(workingDir: string): Promise<void> {
  const { getProjectAutomationLoader } = await import('../scheduler-host/index.desktop.js');
  await getProjectAutomationLoader().removeSchedule(workingDir, BOT_PROJECT_MEMORY_REVIEW_ID);
}

export interface BotProjectPreparation {
  workingDir: string;
  repository: 'initialized' | 'already-git' | 'unavailable' | 'failed';
  registered: boolean;
  memoriesCopied: number;
  skillsCopied: number;
  /** Links in the teammate's Skills that lead outside their Skill folder: not copied. */
  skippedSkillLinks: string[];
}

/** Idempotent. Never overwrites existing files, history or a user-chosen project name. */
export async function prepareBotProjectWorkspace(input: {
  botId: string;
  displayName: string;
  ownerRoot: string;
  legacyUserDataDir?: string;
}): Promise<BotProjectPreparation> {
  const workspace = await ensureBotWorkspaceDir(input.ownerRoot, input.botId, input.legacyUserDataDir);
  // An existing project's `.gitignore` gets the local entries before anything below records a version.
  // When it cannot, the teammate is still prepared; its versions (and a first commit) wait for the next start.
  const ignore = await ensureTeammateProjectIgnored({ botId: input.botId, workspace });
  // Memory and Skills become the project's own, before the first V2 turn reads them. A project
  // memory kept outside the folder (earlier versions) comes first: it is newer than the V1 copy.
  const moved = await moveTeammateMemoryIntoProject({ botId: input.botId, ownerRoot: input.ownerRoot, workspace });
  const alreadyUpgraded = await hasTeammateUpgraded(input.ownerRoot, input.botId);
  const v1Copied = alreadyUpgraded ? 0 : await copyMemoryRecords(botProfileMemoryDir(input.ownerRoot, input.botId), teammateProjectMemoryDir(workspace));
  const memoriesCopied = (moved ?? 0) + v1Copied;
  const skills = alreadyUpgraded
    ? { copied: 0, targetDir: path.join(workspace, '.agents', 'skills'), skippedLinks: [] }
    : await copySkillFolders(path.join(botProfileDir(input.ownerRoot, input.botId), 'skills'), workspace);
  if (skills.copied > 0 && skills.targetDir !== path.join(workspace, '.agents', 'skills')) {
    skills.skippedLinks.push(`.agents/skills is a link, so the skills were put in ${path.relative(workspace, skills.targetDir)}/`);
  }
  // The starter template only fills what the teammate does not have yet: its own skills and
  // rules (copied just above) win over a template file of the same name. Before the first version.
  const templated = await applyTeammateTemplate(workspace, input.displayName, undefined, undefined, templateFromProjectHistory(workspace));
  await writeIfMissing(path.join(workspace, 'CLAUDE.md'), '@AGENTS.md\n');
  setBotProjectSkillsDir(input.ownerRoot, input.botId, true);
  let repository: BotProjectPreparation['repository'];
  try {
    repository = ignore === 'ready' ? await ensureWorkspaceRepository(workspace) : 'failed';
    if (repository === 'already-git' && v1Copied > 0) {
      await snapshotTeammateProject(input.botId, workspace, 'Copy teammate memories into the project');
    }
    if (repository === 'already-git' && templated) {
      await snapshotTeammateProject(input.botId, workspace, `Apply teammate template v${TEAMMATE_TEMPLATE_VERSION}`);
    }
  } catch (error) {
    // Versions are an addition: a Git failure must not keep the project from opening.
    log.warn('teammate project repository setup failed', { botId: input.botId, error: String(error) });
    repository = 'failed';
  }
  const projectDir = normalizeRecentWorkdirPath(workspace);
  const registered = projectDir ? await upsertRecentWorkdir(projectDir) : false;
  if (projectDir && registered) {
    const owner = getActiveDataOwnerPushStamp();
    await restoreLocalProjectVisibility(projectDir, owner).catch((error) => {
      log.warn('teammate project visibility restore failed', { botId: input.botId, error: String(error) });
    });
    await nameBotProject(input.botId, projectDir, input.displayName);
    broadcastProjectRegistered(projectDir);
  }
  return { workingDir: workspace, repository, registered, memoriesCopied, skillsCopied: skills.copied, skippedSkillLinks: skills.skippedLinks };
}

/** One recognisable name for every teammate project, so it never reads like a same-named repo. */
export function botProjectName(displayName: string): string {
  return `Buddy ${displayName.trim()}`;
}

/**
 * Names the project after the teammate. A name the user gave the project is kept; only no name,
 * the bare teammate name (earlier default) or the standard name for `previousName` is replaced.
 */
export async function nameBotProject(
  botId: string,
  projectDir: string,
  displayName: string,
  previousName?: string,
): Promise<void> {
  const name = displayName.trim();
  if (!name) return;
  const projectKey = `local:${projectDir}`;
  const current = (await listProjectAliases().catch(() => []))
    .find((row) => row.projectKey === projectKey)?.alias?.trim() ?? '';
  const replaceable = new Set(['', name, `Teammate ${name}`,
    ...(previousName?.trim() ? [previousName.trim(), botProjectName(previousName), `Teammate ${previousName.trim()}`] : [])]);
  if (!replaceable.has(current) || current === botProjectName(name)) return;
  await upsertProjectAlias(projectKey, botProjectName(name)).catch((error) => {
    log.warn('teammate project name failed', { botId, error: String(error) });
  });
}
