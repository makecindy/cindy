/**
 * 测试价值
 * - 生产入口与可观察结果：botProjectMemory 的 teammateMemoryDirs + readTeammateMemories，即云端伙伴上传
 *   （companion-cloud/host.ts）读到的记忆集合。V2 伙伴上传项目里 `.cindy/memory/` 的记忆；搬进项目没走完时
 *   项目外旧位置里还没复制的记忆、升级没走完时旧文件夹里还没复制的记忆照样上传（不被误写墓碑）；
 *   两步都完成后只读项目里的记忆（项目里删掉的才会被墓碑）。
 * - 规则依据：cloud-companions.md §2.1 记忆一行；修复「V2 记忆从不离开这台电脑、V1 上传可能删掉项目里同名记忆」；
 *   伙伴记忆搬进伙伴项目（2026-11-09）。
 * - 现有覆盖缺口：上传此前只读旧 `memories/`，没有任何用例覆盖项目记忆及其项目外旧位置。
 * - 最小失败输入：项目、项目外旧位置与旧文件夹各有同名记忆 + 后两处各有独有一条；有 / 没有搬迁与升级回执。
 * - tier：unit（临时目录真实文件 I/O，无 Electron、无 Git）。
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { botProfileDir, botProfileMemoryDir } from '../botProfileFolder.js';
import {
  TEAMMATE_MEMORY_MOVE_RECEIPT_FILE,
  TEAMMATE_V2_RECEIPT_FILE,
  legacyTeammateProjectMemoryDir,
  readTeammateMemories,
  teammateMemoryDirs,
  teammateProjectMemoryDir,
  teammateWorkspaceDir,
} from '../botProjectMemory.js';

let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ''; });

async function put(dir: string, name: string, content: string) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), content, 'utf8');
}

it('uploads a V2 teammate\'s project memories, with not-yet-copied earlier ones only until the move and upgrade finished', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'teammate-memory-'));
  const workspace = teammateWorkspaceDir(root, 'bot_mia');
  await mkdir(workspace, { recursive: true });
  const project = teammateProjectMemoryDir(workspace);
  expect(project).toBe(path.join(workspace, '.cindy', 'memory'));
  await put(project, 'user_tea.md', 'project version');
  await put(project, 'MEMORY.md', 'index');
  await put(project, 'README.md', 'portable memory format guide');
  const outside = await legacyTeammateProjectMemoryDir(root, workspace);
  await put(outside, 'user_tea.md', 'outside version');
  await put(outside, 'feedback_tone.md', 'not moved yet');
  await put(botProfileMemoryDir(root, 'bot_mia'), 'user_tea.md', 'old version');
  await put(botProfileMemoryDir(root, 'bot_mia'), 'project_launch.md', 'not copied yet');
  await put(botProfileMemoryDir(root, 'bot_mia'), 'USER.md', 'profile');
  const read = async (projectMode: boolean) =>
    Object.fromEntries((await readTeammateMemories(await teammateMemoryDirs(root, 'bot_mia', projectMode))).map(m => [m.filename, m.content]));

  expect(await read(false)).toEqual({ 'user_tea.md': 'old version', 'project_launch.md': 'not copied yet' });
  expect(await read(true)).toEqual({
    'user_tea.md': 'project version', 'feedback_tone.md': 'not moved yet', 'project_launch.md': 'not copied yet',
  });
  await writeFile(path.join(botProfileDir(root, 'bot_mia'), TEAMMATE_V2_RECEIPT_FILE), '{}');
  expect(await read(true)).toEqual({ 'user_tea.md': 'project version', 'feedback_tone.md': 'not moved yet' });
  await writeFile(path.join(botProfileDir(root, 'bot_mia'), TEAMMATE_MEMORY_MOVE_RECEIPT_FILE), '{}');
  expect(await read(true)).toEqual({ 'user_tea.md': 'project version' });
});

// PR #9314 review: the cloud upload followed a project memory folder (or `.cindy`) that is a link
// and uploaded whatever .md files it points to. It now refuses, keeping the uploaded memories.
it('refuses to read a project memory folder that is a link', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'teammate-memory-link-'));
  const workspace = teammateWorkspaceDir(root, 'bot_mia');
  const outside = path.join(root, 'outside');
  await put(outside, 'user_notes.md', 'private');
  await mkdir(path.join(workspace, '.cindy'), { recursive: true });
  await symlink(outside, teammateProjectMemoryDir(workspace), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(teammateMemoryDirs(root, 'bot_mia', true)).rejects.toThrow('link');
});
