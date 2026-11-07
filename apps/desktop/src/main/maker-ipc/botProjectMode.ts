/**
 * 伙伴 V2(项目模式)。伙伴 = 一个包装过的项目 + 一堆任务。
 *
 * 开启后伙伴的 `workspace/` 就是一个普通 Cindy 项目：
 *   - 登记进项目列表(侧栏可见，名字是伙伴名)；
 *   - 根部的 AGENTS.md 是这个伙伴的项目规则(CLAUDE.md 用 `@AGENTS.md` 指过去)；
 *   - 记忆就是这个项目的记忆，技能就是项目里 `.agents/skills` 下的技能；
 *   - 用 Git 记版本，沿用 Cindy 的快照与回退。
 *
 * 只有身份(名字头像、SOUL、IM 等对外身份)留在伙伴外壳上。
 * 开启时把原来的记忆和技能**复制**进项目(不搬走、不覆盖)，关掉开关就回到原来的伙伴。
 */
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';

import { BrowserWindow } from 'electron';

import { getActiveDataOwnerPushStamp } from '../appSessionState.js';
import { memoryScopeDirName, parseFilename, resolveMemoryScopeKey } from '@cindy/maker-core';
import { createSnapshotDetailed } from '../git-snapshot/gitSnapshotService.js';
import { listProjectAliases, upsertProjectAlias } from '../localDb/ipc/projectAliases.js';
import { normalizeRecentWorkdirPath, upsertRecentWorkdir } from '../localDb/ipc/recentWorkdirs.js';
import { createLogger } from '../logger.js';
import { isTrustedAppRendererWindow } from '../security/trustedAppRenderer.js';
import { restoreLocalProjectVisibility } from '../sidebarSettingsStore.js';
import { gitExec } from '../worktree/gitExec.js';
import { detectCwd } from '../worktree/WorktreeManager.js';
import { botProfileDir, botProfileMemoryDir, ensureBotWorkspaceDir } from './botProfileFolder.js';
import { setBotProjectSkillsDir } from './botSkillStore.js';
import type { ProjectScheduleConfig } from '../scheduler-host/project-automation-loader.js';
import type { BotModelRoute } from '../../shared/botModelChain.js';

const log = createLogger('maker-ipc:bot-project-mode');

export function botProjectAgentsTemplate(displayName: string): string {
  const name = displayName.trim() || 'This teammate';
  return [
    `# ${name} · project rules`,
    '',
    `This folder is ${name}'s project. Everything in this file is loaded at the start of every task ${name} runs here, on every engine.`,
    '',
    `- Write down how ${name} should work: steps, conventions, checklists, things to avoid.`,
    `- ${name} may edit this file to improve its own way of working. Changes apply to the next task; versions are kept, so any edit can be reviewed and undone.`,
    '- Who the teammate is (name, personality, relationship) stays in its profile, not here.',
    '- Project skills go in `.agents/skills/<name>/SKILL.md`.',
    '',
  ].join('\n');
}

/** Copy durable memory records into the project's memory; existing project records win. */
async function copyMemoryRecords(sourceDir: string, targetDir: string): Promise<number> {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true }).catch(() => []);
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

/** Copy each Skill folder that the project does not have yet; never follows symlinks. */
async function copySkillFolders(sourceDir: string, targetDir: string): Promise<number> {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true }).catch(() => []);
  let copied = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const target = path.join(targetDir, entry.name);
    if (await fs.lstat(target).then(() => true, () => false)) continue;
    await fs.mkdir(targetDir, { recursive: true });
    await fs.cp(path.join(sourceDir, entry.name), target, {
      recursive: true, errorOnExist: false, force: false,
      filter: async (source) => !(await fs.lstat(source)).isSymbolicLink(),
    });
    copied++;
  }
  return copied;
}

async function writeIfMissing(filePath: string, content: string): Promise<boolean> {
  try {
    await fs.writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/** A repository whose root is the workspace itself; an enclosing repo does not count. */
async function ensureWorkspaceRepository(workspace: string): Promise<'initialized' | 'already-git' | 'unavailable'> {
  const before = await detectCwd(workspace);
  if (!before.gitInstalled) return 'unavailable';
  const [ownRoot, repoRoot] = await Promise.all([
    fs.realpath(workspace),
    before.repoRoot ? fs.realpath(before.repoRoot).catch(() => before.repoRoot) : Promise.resolve(null),
  ]);
  if (before.isGitRepo && repoRoot === ownRoot) return 'already-git';
  await gitExec(['init'], workspace);
  await createSnapshotDetailed(workspace, {
    label: 'Start teammate project',
    meta: { sessionId: 'bot-project', kind: 'manual' },
    allowEmpty: true,
  });
  return 'initialized';
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

export function botProjectMemoryReview(input: {
  botId: string;
  displayName: string;
  route?: BotModelRoute | null;
  timezone: string;
  /** Localized "{{name}} · …" title template. */
  title: string;
}): ProjectScheduleConfig {
  const name = input.displayName.trim() || input.botId;
  const route = input.route && !input.route.agentDeviceId ? input.route : null;
  return {
    id: BOT_PROJECT_MEMORY_REVIEW_ID,
    name: input.title.replace('{{name}}', name),
    // A goal, not a procedure: the task picks its own tools and material.
    prompt: `Look back at ${name}'s conversations from the last day (teammate id ${input.botId}) and keep what is worth remembering in this project's memory and skills. If nothing new is worth keeping, finish quietly.`,
    cronExpr: '30 3 * * *',
    timezone: input.timezone,
    recurring: true,
    persistentSession: true,
    silentWhenIdle: true,
    ...(route ? {
      agentKind: route.harness === 'claude' ? 'claude-code' as const : route.harness,
      model: route.model,
      ...(route.providerId ? { providerId: route.providerId } : {}),
      ...(route.effort ? { effort: route.effort } : {}),
    } : {}),
  };
}

/** Adds the review once; an owner's later edit or removal of it in the project is kept. */
export async function ensureBotProjectAutomations(input: {
  botId: string;
  displayName: string;
  workingDir: string;
  route?: BotModelRoute | null;
}): Promise<boolean> {
  // Loaded on use: the scheduler host is not part of the teammate profile store's import graph.
  const [{ getProjectAutomationLoader }, { t }] = await Promise.all([
    import('../scheduler-host/index.js'), import('../i18n.js'),
  ]);
  const loader = getProjectAutomationLoader();
  const existing = await loader.loadProjectSchedules(input.workingDir);
  if (existing?.some((config) => config.id === BOT_PROJECT_MEMORY_REVIEW_ID)) return false;
  await loader.upsertSchedule(input.workingDir, botProjectMemoryReview({
    ...input,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    title: t('bots.homeFolder.projectMode.memoryReviewName'),
  }));
  return true;
}

/** Turning project mode off hands the nightly review back to the host. */
export async function removeBotProjectAutomations(workingDir: string): Promise<void> {
  const { getProjectAutomationLoader } = await import('../scheduler-host/index.js');
  await getProjectAutomationLoader().removeSchedule(workingDir, BOT_PROJECT_MEMORY_REVIEW_ID);
}

export interface BotProjectPreparation {
  workingDir: string;
  repository: 'initialized' | 'already-git' | 'unavailable' | 'failed';
  registered: boolean;
  memoriesCopied: number;
  skillsCopied: number;
}

/** Idempotent. Never overwrites existing files, history or a user-chosen project name. */
export async function prepareBotProjectWorkspace(input: {
  botId: string;
  displayName: string;
  ownerRoot: string;
  legacyUserDataDir?: string;
}): Promise<BotProjectPreparation> {
  const workspace = await ensureBotWorkspaceDir(input.ownerRoot, input.botId, input.legacyUserDataDir);
  await writeIfMissing(path.join(workspace, 'AGENTS.md'), botProjectAgentsTemplate(input.displayName));
  await writeIfMissing(path.join(workspace, 'CLAUDE.md'), '@AGENTS.md\n');
  // Memory and Skills become the project's own, before the first V2 turn reads them.
  const projectMemoryDir = path.join(
    input.ownerRoot, 'maker-memory', memoryScopeDirName(await resolveMemoryScopeKey(workspace)),
  );
  const memoriesCopied = await copyMemoryRecords(botProfileMemoryDir(input.ownerRoot, input.botId), projectMemoryDir);
  const skillsCopied = await copySkillFolders(
    path.join(botProfileDir(input.ownerRoot, input.botId), 'skills'),
    path.join(workspace, '.agents', 'skills'),
  );
  setBotProjectSkillsDir(input.ownerRoot, input.botId, true);
  let repository: BotProjectPreparation['repository'];
  try {
    repository = await ensureWorkspaceRepository(workspace);
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
  return { workingDir: workspace, repository, registered, memoriesCopied, skillsCopied };
}

/** One recognisable name for every teammate project, so it never reads like a same-named repo. */
export function botProjectName(displayName: string): string {
  return `Teammate ${displayName.trim()}`;
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
  const replaceable = new Set(['', name, ...(previousName?.trim() ? [previousName.trim(), botProjectName(previousName)] : [])]);
  if (!replaceable.has(current) || current === botProjectName(name)) return;
  await upsertProjectAlias(projectKey, botProjectName(name)).catch((error) => {
    log.warn('teammate project name failed', { botId, error: String(error) });
  });
}
