import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Theme } from '../types';

const localThemesMock = vi.hoisted(() => ({ themes: [] as Theme[] }));

vi.mock('../local-themes', () => ({
  getLocalThemes: () => localThemesMock.themes,
  onLocalThemesChange: () => () => undefined,
}));

import { getThemeFamilies, resolveFamilyVariant } from '../families';

/**
 * 本地主题的家族分组。
 *
 * 引入可选 `family` 字段的兼容性要求：**没有该字段的老本地主题，家族 id 与行为
 * 必须逐字不变**（家族 id 就是 `<id>-local`），否则用户已持久化的
 * lightThemeId / darkThemeId 会失效、主题选择被重置。
 */

function makeTheme(id: string, type: 'light' | 'dark', family?: string): Theme {
  return {
    id: `${id}-local`,
    name: id,
    type,
    ...(family ? { family } : {}),
    colors: {},
  };
}

describe('本地主题家族 · 无 family 字段时保持旧行为', () => {
  beforeEach(() => {
    localThemesMock.themes = [
      makeTheme('solo-dark', 'dark'),
      makeTheme('solo-light', 'light'),
    ];
  });

  it('每个文件各自成家族，家族 id 就是主题 id', () => {
    const local = getThemeFamilies().filter((f) => f.id.endsWith('-local'));
    expect(local.map((f) => f.id)).toEqual(['solo-dark-local', 'solo-light-local']);
  });

  it('单变体家族只填对应 type', () => {
    const family = getThemeFamilies().find((f) => f.id === 'solo-dark-local')!;
    expect(family.dark?.id).toBe('solo-dark-local');
    expect(family.light).toBeNull();
  });

  it('请求缺失的 type 时 fallback 并标记（沿用既有提示逻辑）', () => {
    const resolved = resolveFamilyVariant('solo-dark-local', 'light');
    expect(resolved.fallback).toBe(true);
    expect(resolved.theme.type).toBe('dark');
    expect(resolved.requestedType).toBe('light');
  });
});

describe('本地主题家族 · 同 family 的 light + dark 合并', () => {
  beforeEach(() => {
    localThemesMock.themes = [
      makeTheme('minimal-dark', 'dark', 'minimal'),
      makeTheme('minimal-light', 'light', 'minimal'),
    ];
  });

  it('合并成一个双变体家族', () => {
    const local = getThemeFamilies().filter((f) => f.id.endsWith('-local'));
    expect(local).toHaveLength(1);
    expect(local[0].id).toBe('minimal-local');
    expect(local[0].dark?.id).toBe('minimal-dark-local');
    expect(local[0].light?.id).toBe('minimal-light-local');
  });

  it('家族 id 带 -local 后缀（设置页据此显示本地 badge、避免撞内置家族 id）', () => {
    expect(getThemeFamilies().find((f) => f.id === 'minimal-local')).toBeTruthy();
  });

  it('两个模式都能解析到自己的变体，不再 fallback', () => {
    expect(resolveFamilyVariant('minimal-local', 'light').fallback).toBe(false);
    expect(resolveFamilyVariant('minimal-local', 'dark').fallback).toBe(false);
  });
});

describe('本地主题家族 · 边界情况', () => {
  it('family 名撞内置家族 id 时不遮蔽内置主题', () => {
    localThemesMock.themes = [makeTheme('fake-github', 'dark', 'github')];
    const families = getThemeFamilies();
    const github = families.filter((f) => f.id === 'github');
    // 内置 github 家族仍是唯一持有该 id 的；本地主题落到 github-local。
    expect(github).toHaveLength(1);
    expect(github[0].dark?.id).toBe('github-dark');
    expect(families.find((f) => f.id === 'github-local')?.dark?.id).toBe('fake-github-local');
  });

  it('同 family 同 type 撞车时保留先出现的（loader 已按文件名排序）', () => {
    localThemesMock.themes = [
      makeTheme('first', 'dark', 'dup'),
      makeTheme('second', 'dark', 'dup'),
    ];
    const family = getThemeFamilies().find((f) => f.id === 'dup-local')!;
    expect(family.dark?.id).toBe('first-local');
  });

  it('混合有/无 family 的本地主题各走各的分组', () => {
    localThemesMock.themes = [
      makeTheme('paired-dark', 'dark', 'paired'),
      makeTheme('paired-light', 'light', 'paired'),
      makeTheme('lonely', 'dark'),
    ];
    const local = getThemeFamilies().filter((f) => f.id.endsWith('-local'));
    expect(local.map((f) => f.id)).toEqual(['paired-local', 'lonely-local']);
  });

  it('没有本地主题时只剩内置家族', () => {
    localThemesMock.themes = [];
    expect(getThemeFamilies().every((f) => !f.id.endsWith('-local'))).toBe(true);
  });
});
