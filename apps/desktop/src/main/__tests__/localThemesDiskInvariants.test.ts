/**
 * DS-2b 用户本地主题不变量（main loader 磁盘 + 解析）。
 *
 * 红灯不是禁令。有意改值的合法路径 = 同一 PR 更新本快照 + 按治理合同 §6 交证据 +
 * 设计师批准；禁止为绿灯加豁免或绕加载路径。
 *
 * 保护值（CINDY 皮肤族 DESIGN.md §15、U2 二级信息色、annotation-accent）另有比
 * 「改快照 + 设计师批准」更严的门槛，见治理合同 §1.1。
 *
 * 缺口登记（治理合同 §7）：parseLocalThemeJson 会丢掉顶层未知字段的内存投影，
 * 这是当前实际行为，不是「未知字段不丢」的已完成能力。colors 内未知键仍保留。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const osMock = vi.hoisted(() => ({ homedir: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    default: { ...actual, homedir: () => osMock.homedir },
    homedir: () => osMock.homedir,
  };
});

vi.mock('../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  getLocalThemesDir,
  loadLocalThemesSync,
  resetLocalThemesMigrationForTest,
} from '../local-themes/loader';

const FIXTURE_DIR = fileURLToPath(
  new URL('../../renderer/themes/__tests__/fixtures/local-themes/', import.meta.url),
);

const FIXTURE_FILES = [
  'legacy-placeholder.json',
  'unknown-colors.json',
  'unknown-toplevel.json',
  'external-import-missing-switch.json',
] as const;

function readExact(filePath: string): Buffer {
  return fs.readFileSync(filePath);
}

describe('DS-2b · 用户主题磁盘与加载不变量', () => {
  let home: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(path.join(tmpdir(), 'ds2b-themes-home-')));
    osMock.homedir = home;
    resetLocalThemesMigrationForTest();

    const dir = path.join(home, '.cindy', 'themes');
    fs.mkdirSync(dir, { recursive: true });
    for (const name of FIXTURE_FILES) {
      fs.copyFileSync(path.join(FIXTURE_DIR, name), path.join(dir, name));
    }
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('真实加载 + 归一化后磁盘字节不变', () => {
    const dir = getLocalThemesDir();
    const before = new Map<string, Buffer>();
    for (const name of FIXTURE_FILES) {
      before.set(name, readExact(path.join(dir, name)));
    }

    const result = loadLocalThemesSync();
    expect(result.success).toBe(true);
    expect(result.themes.length).toBe(FIXTURE_FILES.length);

    for (const name of FIXTURE_FILES) {
      const after = readExact(path.join(dir, name));
      expect(after.equals(before.get(name)!), `${name} 磁盘字节被改写`).toBe(true);
    }
  });

  it('colors 内未知键经真实加载后仍在内存里', () => {
    const result = loadLocalThemesSync();
    expect(result.success).toBe(true);
    const theme = result.themes.find((entry) => entry.id === 'ds2b-unknown-colors-local');
    expect(theme).toBeDefined();
    expect(theme?.colors['my-plugin-accent']).toBe('#112233');
    expect(theme?.colors['future-slot-xyz']).toBe('var(--text-secondary)');
    expect(theme?.family).toBe('ds2b-fake-family');
  });

  it('顶层未知字段当前从内存投影丢弃（已登记缺口，不是已完成能力）', () => {
    const result = loadLocalThemesSync();
    expect(result.success).toBe(true);
    const theme = result.themes.find((entry) => entry.id === 'ds2b-unknown-toplevel-local');
    expect(theme).toBeDefined();
    expect(theme).not.toHaveProperty('author');
    expect(theme).not.toHaveProperty('comment');
    expect(theme).not.toHaveProperty('version');
    expect(theme?.colors.surface).toBe('#ffffff');

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(getLocalThemesDir(), 'unknown-toplevel.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(onDisk.author).toBe('not-a-real-user');
    expect(onDisk.comment).toBe('fake extra field for DS-2b gap freeze');
    expect(onDisk.version).toBe(2);
  });

  it('缺 family 的老文件仍能加载', () => {
    const result = loadLocalThemesSync();
    expect(result.success).toBe(true);
    const theme = result.themes.find((entry) => entry.id === 'ds2b-legacy-placeholder-local');
    expect(theme).toBeDefined();
    expect(theme?.family).toBeUndefined();
    expect(theme?.name).toBe('DS2b Legacy Placeholder');
  });
});
