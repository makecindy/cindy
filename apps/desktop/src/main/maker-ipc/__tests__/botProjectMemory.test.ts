/**
 * 测试价值
 * - 生产入口与可观察结果：botProjectMemory 的 teammateMemoryDirs + readTeammateMemories，即云端伙伴上传
 *   （companion-cloud/host.ts）读到的记忆集合。V2 伙伴上传项目记忆；升级没走完时旧文件夹里还没复制的
 *   记忆照样上传（不被误写墓碑）；升级完成后只读项目记忆（项目里删掉的才会被墓碑）。
 * - 规则依据：cloud-companions.md §2.1 记忆一行；修复「V2 记忆从不离开这台电脑、V1 上传可能删掉项目里同名记忆」。
 * - 现有覆盖缺口：上传此前只读旧 `memories/`，没有任何用例覆盖项目记忆。
 * - 最小失败输入：项目与旧文件夹各有同名记忆 + 旧文件夹独有一条；有 / 没有升级回执。
 * - tier：unit（临时目录真实文件 I/O，无 Electron、无 Git）。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { botProfileDir, botProfileMemoryDir } from '../botProfileFolder.js';
import {
  TEAMMATE_V2_RECEIPT_FILE,
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

it('uploads a V2 teammate\'s project memories, with not-yet-copied old ones only until its upgrade finished', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'teammate-memory-'));
  const workspace = teammateWorkspaceDir(root, 'bot_mia');
  await mkdir(workspace, { recursive: true });
  const project = await teammateProjectMemoryDir(root, workspace);
  await put(project, 'user_tea.md', 'project version');
  await put(project, 'MEMORY.md', 'index');
  await put(botProfileMemoryDir(root, 'bot_mia'), 'user_tea.md', 'old version');
  await put(botProfileMemoryDir(root, 'bot_mia'), 'project_launch.md', 'not copied yet');
  await put(botProfileMemoryDir(root, 'bot_mia'), 'USER.md', 'profile');
  const read = async (projectMode: boolean) =>
    Object.fromEntries((await readTeammateMemories(await teammateMemoryDirs(root, 'bot_mia', projectMode))).map(m => [m.filename, m.content]));

  expect(await read(false)).toEqual({ 'user_tea.md': 'old version', 'project_launch.md': 'not copied yet' });
  expect(await read(true)).toEqual({ 'user_tea.md': 'project version', 'project_launch.md': 'not copied yet' });
  await writeFile(path.join(botProfileDir(root, 'bot_mia'), TEAMMATE_V2_RECEIPT_FILE), '{}');
  expect(await read(true)).toEqual({ 'user_tea.md': 'project version' });
});
