// @vitest-environment jsdom

/**
 * review plugin 注册 + state 序列化 / 反序列化容错单测。
 *
 * 不测 ReviewTabBody 完整渲染(复杂 DOM 树 + 多个被 mock 的依赖),只测 plugin
 * 本身的契约:registry 命中、defaultState 形状、hydrateState 对非法 raw 的容错。
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// ReviewTabBody has its own renderer tests. This suite only exercises the
// registration/state contract, so keep the full review UI graph outside this fixture.
vi.mock('../ReviewTabBody', () => ({ ReviewTabBody: () => null }));

let registry: typeof import('../../../registry');
let pluginMod: typeof import('../index');
let fixtureInitializationCount = 0;

describe('review plugin', () => {
  beforeAll(async () => {
    fixtureInitializationCount += 1;
    // registry 与 plugin 共享同一个文件级 fixture：注册 side-effect 只需执行一次。
    // 每个用例都重置模块会在满载 worker 中重复拉起依赖图并撞上 hook timeout。
    vi.resetModules();
    registry = await import('../../../registry');
    pluginMod = await import('../index');
  });

  afterAll(() => {
    registry._resetTabKindRegistry();
  });

  it('registers under kind="review"', () => {
    const got = registry.getTabKind('review');
    expect(got).not.toBeNull();
    expect(got?.kind).toBe('review');
    expect(got?.menu.singleton).toBe(true);
    expect(got?.menu.enabled).toBe(true);
  });

  it('defaultState returns fresh collapsedPaths array per call', () => {
    const p = registry.getTabKind('review')!;
    const a = p.defaultState() as { collapsedPaths: string[]; diffViewMode: string; fileTreeVisible: boolean; wordWrap: boolean; wordDiff: boolean; hideWhitespace: boolean; richMarkdownPreview: boolean; branchBaseRef: string | null };
    const b = p.defaultState() as { collapsedPaths: string[]; diffViewMode: string; fileTreeVisible: boolean; wordWrap: boolean; wordDiff: boolean; hideWhitespace: boolean; richMarkdownPreview: boolean; branchBaseRef: string | null };
    expect(a.collapsedPaths).toEqual([]);
    expect(b.collapsedPaths).toEqual([]);
    expect(a.diffViewMode).toBe('unified');
    expect(a.fileTreeVisible).toBe(false);
    expect(a.wordWrap).toBe(false);
    expect(a.wordDiff).toBe(false);
    expect(a.hideWhitespace).toBe(false);
    expect(a.richMarkdownPreview).toBe(true);
    expect(a.branchBaseRef).toBeNull();
    // 不要让多个 tab 共享同一个数组引用 → mutate a 不影响 b
    a.collapsedPaths.push('whatever');
    expect(b.collapsedPaths).toEqual([]);
  });

  it('hydrateState recovers valid collapsedPaths and drops legacy expandedPaths', () => {
    const p = registry.getTabKind('review')!;
    const s = p.hydrateState!({
      expandedPaths: ['legacy.ts'],
      collapsedPaths: ['a.ts', 'b/c.tsx'],
      diffViewMode: 'split',
      fileTreeVisible: true,
      wordWrap: true,
      wordDiff: false,
      hideWhitespace: true,
      richMarkdownPreview: false,
      branchBaseRef: 'main',
    }) as {
      collapsedPaths: string[];
      diffViewMode: string;
      fileTreeVisible: boolean;
      wordWrap: boolean;
      wordDiff: boolean;
      hideWhitespace: boolean;
      richMarkdownPreview: boolean;
      branchBaseRef: string | null;
    };
    expect(s.collapsedPaths).toEqual(['a.ts', 'b/c.tsx']);
    expect(s.diffViewMode).toBe('split');
    expect(s.fileTreeVisible).toBe(true);
    expect(s.wordWrap).toBe(true);
    expect(s.wordDiff).toBe(false);
    expect(s.hideWhitespace).toBe(true);
    expect(s.richMarkdownPreview).toBe(false);
    expect(s.branchBaseRef).toBe('main');
  });

  it('hydrateState keeps a valid session-level branch base ref and drops invalid values', () => {
    const p = registry.getTabKind('review')!;
    expect((p.hydrateState!({ branchBaseRef: 'origin/main' }) as { branchBaseRef: string | null }).branchBaseRef).toBe('origin/main');
    expect((p.hydrateState!({ branchBaseRef: '' }) as { branchBaseRef: string | null }).branchBaseRef).toBeNull();
    expect((p.hydrateState!({ branchBaseRef: '-bad' }) as { branchBaseRef: string | null }).branchBaseRef).toBeNull();
    expect((p.hydrateState!({ branchBaseRef: 'main~1' }) as { branchBaseRef: string | null }).branchBaseRef).toBeNull();
    expect((p.hydrateState!({ branchBaseRef: 42 }) as { branchBaseRef: string | null }).branchBaseRef).toBeNull();
  });

  it('hydrateState falls back to disabled word wrap for invalid values', () => {
    const p = registry.getTabKind('review')!;
    expect((p.hydrateState!({ wordWrap: true }) as { wordWrap: boolean }).wordWrap).toBe(true);
    expect((p.hydrateState!({ wordWrap: 'yes' }) as { wordWrap: boolean }).wordWrap).toBe(false);
    expect((p.hydrateState!({}) as { wordWrap: boolean }).wordWrap).toBe(false);
  });

  it('hydrateState defaults word diff to disabled for invalid values', () => {
    const p = registry.getTabKind('review')!;
    expect((p.hydrateState!({ wordDiff: false }) as { wordDiff: boolean }).wordDiff).toBe(false);
    expect((p.hydrateState!({ wordDiff: true }) as { wordDiff: boolean }).wordDiff).toBe(true);
    expect((p.hydrateState!({ wordDiff: 'no' }) as { wordDiff: boolean }).wordDiff).toBe(false);
    expect((p.hydrateState!({}) as { wordDiff: boolean }).wordDiff).toBe(false);
  });

  it('hydrateState falls back to visible whitespace changes for invalid values', () => {
    const p = registry.getTabKind('review')!;
    expect((p.hydrateState!({ hideWhitespace: true }) as { hideWhitespace: boolean }).hideWhitespace).toBe(true);
    expect((p.hydrateState!({ hideWhitespace: 'yes' }) as { hideWhitespace: boolean }).hideWhitespace).toBe(false);
    expect((p.hydrateState!({}) as { hideWhitespace: boolean }).hideWhitespace).toBe(false);
  });

  it('hydrateState defaults rich markdown preview to enabled for invalid values', () => {
    const p = registry.getTabKind('review')!;
    expect((p.hydrateState!({ richMarkdownPreview: false }) as { richMarkdownPreview: boolean }).richMarkdownPreview).toBe(false);
    expect((p.hydrateState!({ richMarkdownPreview: true }) as { richMarkdownPreview: boolean }).richMarkdownPreview).toBe(true);
    expect((p.hydrateState!({ richMarkdownPreview: 'yes' }) as { richMarkdownPreview: boolean }).richMarkdownPreview).toBe(true);
    expect((p.hydrateState!({}) as { richMarkdownPreview: boolean }).richMarkdownPreview).toBe(true);
  });

  it('hydrateState falls back to empty when raw is null / wrong shape', () => {
    const p = registry.getTabKind('review')!;
    expect(
      (p.hydrateState!(null) as { collapsedPaths: string[] }).collapsedPaths,
    ).toEqual([]);
    expect(
      (p.hydrateState!('garbage') as { collapsedPaths: string[] }).collapsedPaths,
    ).toEqual([]);
    expect(
      (p.hydrateState!({}) as { collapsedPaths: string[] }).collapsedPaths,
    ).toEqual([]);
    expect(
      (p.hydrateState!({ collapsedPaths: 'not-an-array' }) as { collapsedPaths: string[] })
        .collapsedPaths,
    ).toEqual([]);
    expect(
      (p.hydrateState!({ expandedPaths: ['legacy-expanded.ts'] }) as { collapsedPaths: string[] })
        .collapsedPaths,
    ).toEqual([]);
  });

  it('hydrateState filters out non-string entries', () => {
    const p = registry.getTabKind('review')!;
    const s = p.hydrateState!({
      collapsedPaths: ['ok.ts', 123, null, undefined, 'also.tsx'],
    }) as { collapsedPaths: string[] };
    expect(s.collapsedPaths).toEqual(['ok.ts', 'also.tsx']);
  });

  // 引用 pluginMod 让 lint 满意 + 验证 module load 成功
  it('loads the registration fixture once without throwing', () => {
    expect(pluginMod).toBeTruthy();
    expect(fixtureInitializationCount).toBe(1);
  });
});
