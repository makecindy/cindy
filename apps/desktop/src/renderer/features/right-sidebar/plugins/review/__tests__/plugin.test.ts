// @vitest-environment jsdom

/**
 * review plugin 注册 + state 序列化 / 反序列化容错单测。
 *
 * 不测 ReviewTabBody 完整渲染(复杂 DOM 树 + 多个被 mock 的依赖),只测 plugin
 * 本身的契约:registry 命中、defaultState 形状、hydrateState 对非法 raw 的容错。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let registry: typeof import('../../../registry');
let pluginMod: typeof import('../index');
let expansionPreference: typeof import('../diffExpansionPreference');

describe('review plugin', () => {
  beforeEach(async () => {
    // 关键:vitest 模块缓存默认共享,直接 import 第二次拿到 cached export 不会再
    // 跑顶层 registerTabKind side-effect。每个测试前先 resetModules + 全新 import
    // registry,registry 也是模块单例,新 import 拿到的是空 registry。然后 import
    // plugin 让它跑一遍 register。
    vi.resetModules();
    registry = await import('../../../registry');
    pluginMod = await import('../index');
    expansionPreference = await import('../diffExpansionPreference');
    expansionPreference.resetReviewDiffExpansionPreferencesForTests();
  });

  afterEach(() => {
    registry._resetTabKindRegistry();
  });

  it('registers under kind="review"', () => {
    const got = registry.getTabKind('review');
    expect(got).not.toBeNull();
    expect(got?.kind).toBe('review');
    expect(got?.menu.singleton).toBe(true);
    expect(got?.menu.enabled).toBe(true);
  });

  it('retains the all-diff preference before the review tab is deleted', async () => {
    const p = registry.getTabKind('review')!;
    await p.onBeforeClose?.(
      { ...(p.defaultState() as object), diffsExpanded: false },
      { tabId: 'review-tab', sessionId: 'session-a' },
    );

    expect(expansionPreference.getReviewDiffsExpanded('session-a', true)).toBe(false);
  });

  it('defaultState expands all diffs and includes the persisted review preferences', () => {
    const p = registry.getTabKind('review')!;
    const a = p.defaultState() as {
      descriptor: { kind: string };
      messageSnapshot: unknown;
      jumpTarget: unknown;
      diffsExpanded: boolean;
      diffViewMode: string;
      fileTreeVisible: boolean;
      wordWrap: boolean;
      wordDiff: boolean;
      hideWhitespace: boolean;
      richMarkdownPreview: boolean;
      branchBaseRef: string | null;
    };
    expect(a.descriptor).toEqual({ kind: 'unstaged' });
    expect(a.messageSnapshot).toBeNull();
    expect(a.jumpTarget).toBeNull();
    expect(a.diffsExpanded).toBe(true);
    expect(a.diffViewMode).toBe('unified');
    expect(a.fileTreeVisible).toBe(false);
    expect(a.wordWrap).toBe(false);
    expect(a.wordDiff).toBe(false);
    expect(a.hideWhitespace).toBe(false);
    expect(a.richMarkdownPreview).toBe(true);
    expect(a.branchBaseRef).toBeNull();
  });

  it('hydrateState recovers the persisted all-diff expansion preference', () => {
    const p = registry.getTabKind('review')!;
    const s = p.hydrateState!({
      diffsExpanded: false,
      diffViewMode: 'split',
      fileTreeVisible: true,
      wordWrap: true,
      wordDiff: false,
      hideWhitespace: true,
      richMarkdownPreview: false,
      descriptor: { kind: 'branch', baseRef: 'main' },
      branchBaseRef: 'origin/release',
      jumpTarget: { diffId: 'branch:main:a.ts', path: 'a.ts', nonce: 3 },
    }) as {
      diffsExpanded: boolean;
      diffViewMode: string;
      fileTreeVisible: boolean;
      wordWrap: boolean;
      wordDiff: boolean;
      hideWhitespace: boolean;
      richMarkdownPreview: boolean;
      descriptor: { kind: string; baseRef?: string | null };
      branchBaseRef: string | null;
      jumpTarget: { diffId: string | null; path: string | null; nonce: number } | null;
    };
    expect(s.diffsExpanded).toBe(false);
    expect(s.diffViewMode).toBe('split');
    expect(s.fileTreeVisible).toBe(true);
    expect(s.wordWrap).toBe(true);
    expect(s.wordDiff).toBe(false);
    expect(s.hideWhitespace).toBe(true);
    expect(s.richMarkdownPreview).toBe(false);
    expect(s.descriptor).toEqual({ kind: 'branch', baseRef: 'main' });
    expect(s.branchBaseRef).toBe('origin/release');
    expect(s.jumpTarget).toEqual({ diffId: 'branch:main:a.ts', path: 'a.ts', nonce: 3 });
  });

  it('hydrateState keeps a safe branch descriptor and fails closed on invalid refs', () => {
    const p = registry.getTabKind('review')!;
    expect(
      (
        p.hydrateState!({ descriptor: { kind: 'branch', baseRef: 'origin/main' } }) as {
          descriptor: unknown;
        }
      ).descriptor,
    ).toEqual({ kind: 'branch', baseRef: 'origin/main' });
    expect(
      (
        p.hydrateState!({ descriptor: { kind: 'branch', baseRef: '-bad' } }) as {
          descriptor: unknown;
        }
      ).descriptor,
    ).toEqual({ kind: 'unstaged' });
    expect(
      (
        p.hydrateState!({ descriptor: { kind: 'branch', baseRef: 'main~1' } }) as {
          descriptor: unknown;
        }
      ).descriptor,
    ).toEqual({ kind: 'unstaged' });
    expect(
      (p.hydrateState!({ descriptor: { kind: 'branch', baseRef: 42 } }) as { descriptor: unknown })
        .descriptor,
    ).toEqual({ kind: 'unstaged' });
  });

  it('derives the remembered branch base from the descriptor and rejects unsafe state', () => {
    const p = registry.getTabKind('review')!;
    expect(
      (
        p.hydrateState!({ descriptor: { kind: 'branch', baseRef: 'origin/main' } }) as {
          branchBaseRef: string | null;
        }
      ).branchBaseRef,
    ).toBe('origin/main');
    expect(
      (
        p.hydrateState!({
          descriptor: { kind: 'unstaged' },
          branchBaseRef: '-unsafe',
        }) as { branchBaseRef: string | null }
      ).branchBaseRef,
    ).toBeNull();
  });

  it('hydrates an exact message snapshot independently from the active git source', () => {
    const p = registry.getTabKind('review')!;
    const state = p.hydrateState!({
      descriptor: { kind: 'unstaged' },
      messageSnapshot: {
        kind: 'turn-set',
        targetSessionId: 'worker-session',
        changeSetIds: ['set-1', 'set-2'],
      },
    }) as { descriptor: unknown; messageSnapshot: unknown };

    expect(state.descriptor).toEqual({ kind: 'unstaged' });
    expect(state.messageSnapshot).toEqual({
      kind: 'turn-set',
      targetSessionId: 'worker-session',
      changeSetIds: ['set-1', 'set-2'],
    });
  });

  it('fails closed when the persisted message snapshot is invalid or not a turn set', () => {
    const p = registry.getTabKind('review')!;
    expect(
      (
        p.hydrateState!({
          descriptor: { kind: 'unstaged' },
          messageSnapshot: { kind: 'turn-set', changeSetIds: [] },
        }) as { messageSnapshot: unknown }
      ).messageSnapshot,
    ).toBeNull();
    expect(
      (
        p.hydrateState!({
          descriptor: { kind: 'staged' },
          messageSnapshot: { kind: 'unstaged' },
        }) as { messageSnapshot: unknown }
      ).messageSnapshot,
    ).toBeNull();
  });

  it('migrates the legacy turnTarget into descriptor and jumpTarget once', () => {
    const p = registry.getTabKind('review')!;
    const state = p.hydrateState!({
      turnTarget: {
        changeSetIds: ['set-1', 'set-2'],
        selectedDiffId: 'unstaged:src/a.ts',
        selectedPath: 'src/a.ts',
        requestNonce: 9,
        targetSessionId: 'worker-session',
      },
    }) as { descriptor: unknown; messageSnapshot: unknown; jumpTarget: unknown };

    expect(state.descriptor).toEqual({
      kind: 'turn-set',
      changeSetIds: ['set-1', 'set-2'],
      targetSessionId: 'worker-session',
    });
    expect(state.messageSnapshot).toEqual(state.descriptor);
    expect(state.jumpTarget).toEqual({
      diffId: 'unstaged:src/a.ts',
      path: 'src/a.ts',
      nonce: 9,
    });
  });

  it('does not mix a stale legacy jump into a persisted descriptor', () => {
    const p = registry.getTabKind('review')!;
    const state = p.hydrateState!({
      descriptor: {
        kind: 'turn-set',
        targetSessionId: 'current-worker',
        changeSetIds: ['current-set'],
      },
      turnTarget: {
        targetSessionId: 'stale-worker',
        changeSetIds: ['stale-set'],
        selectedPath: 'stale.ts',
        requestNonce: 4,
      },
    }) as { descriptor: unknown; jumpTarget: unknown };

    expect(state.descriptor).toEqual({
      kind: 'turn-set',
      targetSessionId: 'current-worker',
      changeSetIds: ['current-set'],
    });
    expect(state.jumpTarget).toBeNull();
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
    expect(
      (p.hydrateState!({ hideWhitespace: true }) as { hideWhitespace: boolean }).hideWhitespace,
    ).toBe(true);
    expect(
      (p.hydrateState!({ hideWhitespace: 'yes' }) as { hideWhitespace: boolean }).hideWhitespace,
    ).toBe(false);
    expect((p.hydrateState!({}) as { hideWhitespace: boolean }).hideWhitespace).toBe(false);
  });

  it('hydrateState defaults rich markdown preview to enabled for invalid values', () => {
    const p = registry.getTabKind('review')!;
    expect(
      (p.hydrateState!({ richMarkdownPreview: false }) as { richMarkdownPreview: boolean })
        .richMarkdownPreview,
    ).toBe(false);
    expect(
      (p.hydrateState!({ richMarkdownPreview: true }) as { richMarkdownPreview: boolean })
        .richMarkdownPreview,
    ).toBe(true);
    expect(
      (p.hydrateState!({ richMarkdownPreview: 'yes' }) as { richMarkdownPreview: boolean })
        .richMarkdownPreview,
    ).toBe(true);
    expect((p.hydrateState!({}) as { richMarkdownPreview: boolean }).richMarkdownPreview).toBe(
      true,
    );
  });

  it('hydrateState defaults to expanded when raw is null or has the wrong shape', () => {
    const p = registry.getTabKind('review')!;
    expect((p.hydrateState!(null) as { diffsExpanded: boolean }).diffsExpanded).toBe(true);
    expect((p.hydrateState!('garbage') as { diffsExpanded: boolean }).diffsExpanded).toBe(true);
    expect((p.hydrateState!({}) as { diffsExpanded: boolean }).diffsExpanded).toBe(true);
    expect(
      (p.hydrateState!({ diffsExpanded: 'yes' }) as { diffsExpanded: boolean }).diffsExpanded,
    ).toBe(true);
    expect(
      (p.hydrateState!({ expandedPaths: ['legacy-expanded.ts'] }) as { diffsExpanded: boolean })
        .diffsExpanded,
    ).toBe(true);
  });

  // 引用 pluginMod 让 lint 满意 + 验证 module load 成功
  it('module imports without throwing', () => {
    expect(pluginMod).toBeTruthy();
  });
});
