import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createDefaultLayout,
  insertRootSplitPane,
  validateLayout,
  type Layout,
  type SplitNode,
} from '../../../shared/layoutTree';
import { LAYOUT_FILE_NAME, LayoutStore } from '../LayoutStore';

/** 每个用例独立临时目录(规则 23:测试路径一律 os.tmpdir,收尾清理)。 */
let tmpDir: string;
let filePath: string;

function makeStore(onChanged?: (layout: Layout) => void): LayoutStore {
  return new LayoutStore({
    getFilePath: () => filePath,
    onChanged,
    log: { info: vi.fn(), warn: vi.fn() },
  });
}

function readFileJson(): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-store-test-'));
  filePath = path.join(tmpDir, LAYOUT_FILE_NAME);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('LayoutStore · 读路径(宽容 + 自愈)', () => {
  it('文件缺失 → 返回默认树,并自愈写盘', () => {
    const store = makeStore();
    const layout = store.getLayout();
    expect(validateLayout(layout)).toEqual({ ok: true });
    expect(layout).toEqual(createDefaultLayout());
    // 自愈:读到缺失即重写默认存档。
    expect(fs.existsSync(filePath)).toBe(true);
    expect(readFileJson()).toEqual(createDefaultLayout());
  });

  it('文件损坏(非 JSON)→ 返回默认树,文件被重写为合法默认', () => {
    fs.writeFileSync(filePath, '{{{ not json', 'utf-8');
    const store = makeStore();
    expect(store.getLayout()).toEqual(createDefaultLayout());
    expect(readFileJson()).toEqual(createDefaultLayout());
  });

  it('文件是合法 JSON 但非法树(缺 chat-main)→ 回退默认并自愈', () => {
    const bad = createDefaultLayout() as unknown as {
      content: { children: { node: { panelKind: string } }[] };
    };
    bad.content.children[0].node.panelKind = 'right-tabs';
    fs.writeFileSync(filePath, JSON.stringify(bad), 'utf-8');
    const store = makeStore();
    expect(store.getLayout()).toEqual(createDefaultLayout());
    expect(readFileJson()).toEqual(createDefaultLayout());
  });

  it('合法存档原样读回(含未安装意识面板的 kind)', () => {
    const saved = createDefaultLayout();
    (saved.content as { children: { node: { panelKind: string } }[] }).children[1].node.panelKind =
      'ghost:weekly-report';
    fs.writeFileSync(filePath, JSON.stringify(saved), 'utf-8');
    const store = makeStore();
    expect(store.getLayout()).toEqual(saved);
    // 合法存档不应被"自愈"覆盖。
    expect(readFileJson()).toEqual(saved);
  });
});

describe('LayoutStore · 写路径(严格)', () => {
  it('setLayout 合法树:持久化 + 缓存 + onChanged', () => {
    const onChanged = vi.fn();
    const store = makeStore(onChanged);
    const next = createDefaultLayout();
    (next.content as { children: { fraction: number }[] }).children[0].fraction = 0.5;
    (next.content as { children: { fraction: number }[] }).children[1].fraction = 0.5;

    const result = store.setLayout(next);
    expect('layout' in result && result.layout).toEqual(next);
    expect('persisted' in result && result.persisted).toBe(true);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(readFileJson()).toEqual(next);
    // 新实例读回同一棵树(round-trip)。
    expect(makeStore().getLayout()).toEqual(next);
  });

  it('setLayout 非法树:拒绝,文件与缓存不变,onChanged 不触发', () => {
    const onChanged = vi.fn();
    const store = makeStore(onChanged);
    const before = store.getLayout();

    const bad = createDefaultLayout() as unknown as Record<string, unknown>;
    delete bad.sidebar;
    const result = store.setLayout(bad);

    expect('rejection' in result).toBe(true);
    expect(onChanged).not.toHaveBeenCalled();
    expect(store.getLayout()).toEqual(before);
    expect(readFileJson()).toEqual(before);
  });

  it('setLayout 垃圾输入(null / 字符串)拒绝且不抛', () => {
    const store = makeStore();
    expect(() => store.setLayout(null)).not.toThrow();
    expect('rejection' in store.setLayout(null)).toBe(true);
    expect('rejection' in store.setLayout('garbage')).toBe(true);
  });

  it('setLayout 写盘失败时保留内存布局并返回 persisted=false', () => {
    const onChanged = vi.fn();
    const store = makeStore(onChanged);
    const before = createDefaultLayout();
    expect(store.setLayout(before)).toMatchObject({ persisted: true });

    const next = structuredClone(before);
    (next.content as { children: { fraction: number }[] }).children[0].fraction = 0.55;
    (next.content as { children: { fraction: number }[] }).children[1].fraction = 0.45;
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    expect(store.setLayout(next)).toEqual({ layout: next, persisted: false });
    expect(store.getLayout()).toEqual(next);
    expect(readFileJson()).toEqual(before);
    expect(onChanged).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(`${filePath}.tmp`)).toBe(false);
  });
});

describe('LayoutStore · reset 与 ensurePersisted', () => {
  it('reset 覆盖自定义布局回默认,并触发 onChanged', () => {
    const onChanged = vi.fn();
    const store = makeStore(onChanged);
    const custom = createDefaultLayout();
    (custom.content as { children: { fraction: number }[] }).children[0].fraction = 0.8;
    (custom.content as { children: { fraction: number }[] }).children[1].fraction = 0.2;
    store.setLayout(custom);

    const result = store.reset();
    expect(result).toEqual({ layout: createDefaultLayout(), persisted: true });
    expect(readFileJson()).toEqual(createDefaultLayout());
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it('reset 恢复内置默认排列但保留已停靠的意识面板', () => {
    const store = makeStore();
    const withGhost = insertRootSplitPane(
      createDefaultLayout(),
      { id: 'custom-ghost', panelKind: 'ghost:calendar', minWidth: 260 },
      { index: 2, fraction: 0.3 },
    );
    expect(withGhost.applied).toBe(true);
    store.setLayout(withGhost.layout);

    const result = store.reset();
    expect(result.persisted).toBe(true);
    const children = (result.layout.content as SplitNode).children;
    expect(children.map((child) => child.node.type === 'pane' && child.node.panelKind)).toEqual([
      'ghost:calendar',
      'chat-main',
      'right-tabs',
    ]);
    expect(children[0].node).toMatchObject({
      id: 'ghost-calendar',
      panelKind: 'ghost:calendar',
      minWidth: 260,
    });
    expect(readFileJson()).toEqual(result.layout);
  });

  it('ensurePersisted:缺失时落默认存档;已有合法存档不覆盖', () => {
    const store = makeStore();
    store.ensurePersisted();
    expect(readFileJson()).toEqual(createDefaultLayout());

    const custom = createDefaultLayout();
    (custom.content as { children: { fraction: number }[] }).children[0].fraction = 0.6;
    (custom.content as { children: { fraction: number }[] }).children[1].fraction = 0.4;
    fs.writeFileSync(filePath, JSON.stringify(custom), 'utf-8');
    const store2 = makeStore();
    store2.ensurePersisted();
    expect(readFileJson()).toEqual(custom);
  });

  it('ensurePersisted:损坏存档在启动时即自愈', () => {
    fs.writeFileSync(filePath, 'broken!!!', 'utf-8');
    makeStore().ensurePersisted();
    expect(readFileJson()).toEqual(createDefaultLayout());
  });

  it('写盘不留 .tmp 残留', () => {
    const store = makeStore();
    store.reset();
    expect(fs.existsSync(`${filePath}.tmp`)).toBe(false);
  });
});
