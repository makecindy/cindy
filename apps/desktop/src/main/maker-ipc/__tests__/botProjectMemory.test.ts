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
  classifyMemoryFilename,
  isSafeTeammateMemoryFilename,
  isStoreCompatibleMemoryFilename,
  legacyTeammateProjectMemoryDir,
  readTeammateMemories,
  removeRawTeammateMemoryFile,
  teammateMemoryDirs,
  teammateProjectMemoryDir,
  teammateWorkspaceDir,
  writeRawTeammateMemoryFile,
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

// #12621, unit: V2 teammates create ordinary Markdown files in `.cindy/memory/` outside MakerMemoryStore's
// `<type>_<slug>.md` naming rule. Safe portable filenames must write/remove atomically without following symlinks,
// while traversal, control chars, derived indexes and Windows reserved names remain rejected.
it('writes and removes safe portable markdown memories while rejecting unsafe filenames and symlinks', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'teammate-raw-memory-'));
  const dir = path.join(root, 'memory');
  expect(isStoreCompatibleMemoryFilename('user_tea.md')).toBe(true);
  expect(isStoreCompatibleMemoryFilename('digest_pi-1.md')).toBe(true);
  expect(isStoreCompatibleMemoryFilename('notes.md')).toBe(false);
  expect(classifyMemoryFilename('user_tea.md')).toBe('store');
  expect(classifyMemoryFilename('daily_2026-11-24.md')).toBe('portable');
  expect(classifyMemoryFilename('project_MyNotes.md')).toBe('portable');
  for (const bad of [
    '../escape.md', 'sub/a.md', 'sub\\a.md', '.hidden.md', 'MEMORY.md', 'memory.md', 'USER.md', 'README.md',
    'CON.md', 'bad\n.md', 'notes.txt',
    'notes?.md', 'a*b.md', 'a:b.md', 'a<b.md', 'a>b.md', 'a"b.md', 'a|b.md',
  ]) {
    expect(isSafeTeammateMemoryFilename(bad)).toBe(false);
    expect(classifyMemoryFilename(bad)).toBe('invalid');
    await expect(writeRawTeammateMemoryFile(dir, bad, 'x')).rejects.toThrow('[INVALID_PARAMS] Invalid memory');
    await expect(removeRawTeammateMemoryFile(dir, bad)).rejects.toThrow('[INVALID_PARAMS] Invalid memory');
  }
  await writeRawTeammateMemoryFile(dir, 'daily_2026-11-24.md', '# Daily\nkept');
  await writeRawTeammateMemoryFile(dir, 'project_MyNotes.md', 'upper case ok');
  // On POSIX hosts a file with Windows-forbidden characters can exist on disk; upload must skip it.
  if (process.platform !== 'win32') {
    await writeFile(path.join(dir, 'notes?.md'), 'non-portable');
    await writeFile(path.join(dir, 'a:b.md'), 'ads-like');
  }
  expect(await readTeammateMemories([dir])).toEqual([
    { filename: 'daily_2026-11-24.md', content: '# Daily\nkept' },
    { filename: 'project_MyNotes.md', content: 'upper case ok' },
  ]);
  await removeRawTeammateMemoryFile(dir, 'daily_2026-11-24.md');
  await removeRawTeammateMemoryFile(dir, 'daily_2026-11-24.md');
  expect(await readTeammateMemories([dir])).toEqual([{ filename: 'project_MyNotes.md', content: 'upper case ok' }]);

  // #12621 review P1: long UTF-8 filenames (80 Han chars + `.md` = 83 chars / 243 bytes <= 255)
  // must write via a short temp name without hitting ENAMETOOLONG; >255 UTF-8 bytes are rejected.
  const longValid = `${'记'.repeat(80)}.md`;
  const tooManyBytes = `${'记'.repeat(85)}.md`;
  expect(Buffer.byteLength(longValid, 'utf8')).toBe(243);
  expect(Buffer.byteLength(tooManyBytes, 'utf8')).toBe(258);
  expect(isSafeTeammateMemoryFilename(longValid)).toBe(true);
  expect(isSafeTeammateMemoryFilename(tooManyBytes)).toBe(false);
  await expect(writeRawTeammateMemoryFile(dir, tooManyBytes, 'too long')).rejects.toThrow('[INVALID_PARAMS] Invalid memory');
  await writeRawTeammateMemoryFile(dir, longValid, 'long utf-8 ok');
  expect(await readTeammateMemories([dir])).toEqual([
    { filename: 'project_MyNotes.md', content: 'upper case ok' },
    { filename: longValid, content: 'long utf-8 ok' },
  ]);
  await removeRawTeammateMemoryFile(dir, longValid);
  expect(await readTeammateMemories([dir])).toEqual([{ filename: 'project_MyNotes.md', content: 'upper case ok' }]);
});
