/**
 * DS-2b 用户本地主题不变量（loader → mapWireTheme → 归一化的生产组合边界）。
 *
 * 红灯不是禁令。有意改值的合法路径 = 同一 PR 更新本快照 + 按治理合同 §6 交证据 +
 * 设计师批准；禁止为绿灯加豁免或绕加载路径。
 *
 * 保护值（CINDY 皮肤族 DESIGN.md §15、U2 二级信息色、annotation-accent）另有比
 * 「改快照 + 设计师批准」更严的门槛，见治理合同 §1.1。
 *
 * 本文件补齐 sibling 测试各自覆盖一半、拼不到一起的那条链路：
 * localThemesDiskInvariants 只跑 main loader，localThemesUserThemeInvariants 直接调
 * normalizeLocalThemeColors——两者之间「loader 输出的 wire 主题经 renderer
 * bootstrapLocalThemesSync / mapWireTheme 装载后才归一化」的生产接线没有守卫。
 * 这里用真实 loadLocalThemesSync 读盘产出 wire payload，再喂给 renderer 侧
 * bootstrapLocalThemesSync，对 getLocalThemes() 出来的 Theme 断言归一化结果：
 * loader 输出形状或 renderer 映射任一侧回归（wire colors 丢 key / mapWireTheme
 * 漏调 normalize），本文件都会红灯，而 sibling 两个文件仍绿。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const osMock = vi.hoisted(() => ({ homedir: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    default: { ...actual, homedir: () => osMock.homedir },
    homedir: () => osMock.homedir,
  };
});

vi.mock('../../../main/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadLocalThemesSync, resetLocalThemesMigrationForTest } from '../../../main/local-themes/loader';
import '../colors';
import { bootstrapLocalThemesSync, getLocalThemes } from '../local-themes';
import type { Theme } from '../types';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/local-themes/', import.meta.url));

const FIXTURE_FILES = [
  'legacy-placeholder.json',
  'unknown-colors.json',
  'unknown-toplevel.json',
  'external-import-missing-switch.json',
] as const;

/** 用真实 loader 读盘并走 renderer 生产装载路径，返回按 id 索引的 Theme。 */
function loadViaProductionPipeline(): Map<string, Theme> {
  const payload = loadLocalThemesSync();
  // bootstrapLocalThemesSync 失败只 warn 不抛；success 断言放在装载前，
  // 让「loader 整体失败」在本测试里显式红灯而不是静默空列表。
  expect(payload.success).toBe(true);
  vi.stubGlobal('window', {
    electronAPI: {
      localThemes: {
        listSync: () => payload,
      },
    },
  });
  bootstrapLocalThemesSync();
  return new Map(getLocalThemes().map((theme) => [theme.id, theme]));
}

describe('DS-2b · 用户主题生产组合不变量（loader → mapWireTheme → normalize）', () => {
  beforeEach(() => {
    osMock.homedir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ds2b-pipeline-home-')));
    resetLocalThemesMigrationForTest();
    const dir = path.join(osMock.homedir, '.cindy', 'themes');
    fs.mkdirSync(dir, { recursive: true });
    for (const name of FIXTURE_FILES) {
      fs.copyFileSync(path.join(FIXTURE_DIR, name), path.join(dir, name));
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(osMock.homedir, { recursive: true, force: true });
  });

  it('真实加载 + renderer 装载后，4 个 fixture 全部到位且 id 已带 -local 后缀', () => {
    const themes = loadViaProductionPipeline();
    expect([...themes.keys()].sort()).toEqual([
      'ds2b-external-import-local',
      'ds2b-legacy-placeholder-local',
      'ds2b-unknown-colors-local',
      'ds2b-unknown-toplevel-local',
    ]);
  });

  it('loader 输出的 wire colors 仍带旧 per-surface key；归一化只发生在 renderer 装载后', () => {
    // 先证明 loader 侧没归一化：wire payload 里的旧 key 原样存在。
    const payload = loadLocalThemesSync();
    expect(payload.success).toBe(true);
    if (!payload.success) return;
    const wire = payload.themes.find((entry) => entry.id === 'ds2b-legacy-placeholder-local');
    expect(wire?.colors['settings-input-placeholder']).toBe('#c4c4c4');
    expect(wire?.colors['chat-input-placeholder']).toBe('var(--text-tertiary)');

    // 再证明 renderer 装载后才收口——两侧断言合起来钉死「归一化必须发生在
    // mapWireTheme 这一步」的生产契约；任何一侧挪动位置都会红灯。
    const themes = loadViaProductionPipeline();
    const loaded = themes.get('ds2b-legacy-placeholder-local');
    expect(loaded?.colors['text-placeholder']).toBe('#c4c4c4');
    expect(loaded?.colors['settings-input-placeholder']).toBeUndefined();
    expect(loaded?.colors['chat-input-placeholder']).toBeUndefined();
    expect(loaded?.colors['ask-input-placeholder']).toBeUndefined();
    expect(loaded?.colors['plan-action-fb-placeholder']).toBeUndefined();
  });

  it('colors 内未知键与 family 沿生产链路透传到 Theme', () => {
    const themes = loadViaProductionPipeline();
    const loaded = themes.get('ds2b-unknown-colors-local');
    expect(loaded?.colors['my-plugin-accent']).toBe('#112233');
    expect(loaded?.colors['future-slot-xyz']).toBe('var(--text-secondary)');
    expect(loaded?.family).toBe('ds2b-fake-family');
  });

  it('外部导入缺 Switch token 的主题经生产链路装载后补齐为可解析 hex', () => {
    const themes = loadViaProductionPipeline();
    const loaded = themes.get('ds2b-external-import-local');
    expect(loaded?.colors['switch-track-off']).toMatch(/^#[0-9a-f]{6}$/);
    expect(loaded?.colors['switch-thumb-off']).toMatch(/^#[0-9a-f]{6}$/);
    expect(loaded?.family).toBe('ds2b-import-family');
  });

  it('顶层未知字段在生产链路中仍按当前行为丢弃（已登记缺口）', () => {
    const themes = loadViaProductionPipeline();
    const loaded = themes.get('ds2b-unknown-toplevel-local');
    expect(loaded).toBeDefined();
    expect(loaded).not.toHaveProperty('author');
    expect(loaded?.colors.surface).toBe('#ffffff');
  });

  it('缺 family 的老文件走完生产链路后仍是可用的单家族主题', () => {
    const themes = loadViaProductionPipeline();
    const loaded = themes.get('ds2b-legacy-placeholder-local');
    expect(loaded?.family).toBeUndefined();
    expect(loaded?.name).toBe('DS2b Legacy Placeholder');
    expect(loaded?.type).toBe('light');
  });
});
