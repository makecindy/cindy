// @vitest-environment jsdom
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { usePluginModels } from '@/features/cc-agent/pluginModelRoute';
import { PluginModelsSection } from '../PluginModelsSection';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' }, t: (key: string) => key }) }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({ getDataOwnerGeneration: () => ({ dataOwnerId: 'owner-a' }) }));

const auto = { pluginId: 'gate', pluginName: 'Decision Gate', id: 'auto', name: 'Auto', description: 'Picks by your rules' };
const cheap = { ...auto, id: 'cheap', name: 'Cheap', description: undefined };
const other = { pluginId: 'other', pluginName: 'Other', id: 'x', name: 'X' };

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

// Rule: the picker shows only what plugins published and must keep working when plugins misbehave.
describe('PluginModelsSection', () => {
  it('lists what plugins published, marks the active one, and selects a model', () => {
    const onSelect = vi.fn();
    const onPicked = vi.fn();
    render(<PluginModelsSection picker={{ models: [auto, cheap, other], active: cheap, onSelect }} query="" onPicked={onPicked} />);
    expect(screen.getByRole('group', { name: 'Decision Gate' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Other' })).toBeTruthy();
    expect(screen.getByText('Picks by your rules')).toBeTruthy();
    expect(screen.getByRole('option', { name: /Cheap/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('option', { name: /Auto/ }).getAttribute('aria-selected')).toBe('false');
    fireEvent.click(screen.getByRole('option', { name: /Auto/ }));
    expect(onSelect).toHaveBeenCalledWith(auto);
    expect(onPicked).toHaveBeenCalled();
  });

  it('follows the search box and renders nothing when no model matches', () => {
    const picker = { models: [auto, other], active: null, onSelect: vi.fn() };
    const { container, rerender } = render(<PluginModelsSection picker={picker} query="decision" onPicked={vi.fn()} />);
    expect(screen.getByRole('option', { name: /Auto/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /^X/ })).toBeNull();
    rerender(<PluginModelsSection picker={picker} query="nothing" onPicked={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  // 生产入口与可观察结果：PluginModelsSection + pluginModelFavorites(localStorage)；点行尾 ☆ 收藏不选中模型、
  // 在 variant="favorites" 下仅展示已收藏模型、allowFavorites=false 隐藏星标且受账号分区隔离。
  // 规则依据：与 ModelGroupsPickerSection 收藏行为保持一致。
  // 覆盖缺口：此前插件路由模型没有收藏能力。最小失败输入与 tier：unit(jsdom)，点击 ☆ 触发 onSelect 或收藏视图为空。
  it('stars and unstars plugin models without selecting them, and lists only starred ones in favorites view', () => {
    const onSelect = vi.fn();
    const picker = { models: [auto, cheap, other], active: null, onSelect };
    const all = render(<PluginModelsSection picker={picker} query="" onPicked={vi.fn()} />);
    const starBtn = all.container.querySelector('[data-plugin-model-favorite="gate:auto"]')!;
    expect(starBtn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(starBtn);
    expect(onSelect).not.toHaveBeenCalled();
    expect(starBtn.getAttribute('aria-pressed')).toBe('true');
    all.unmount();

    const favView = render(<PluginModelsSection picker={picker} query="" onPicked={vi.fn()} variant="favorites" />);
    expect(screen.getByRole('option', { name: /Auto/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Cheap/ })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: /Auto/ }));
    expect(onSelect).toHaveBeenCalledWith(auto);
    favView.unmount();

    const official = render(<PluginModelsSection picker={picker} query="" onPicked={vi.fn()} allowFavorites={false} />);
    expect(official.container.querySelector('[data-plugin-model-favorite]')).toBeNull();
    official.unmount();
  });

  // 生产入口与可观察结果：PluginModelsSection + pluginModelFavorites 在 localStorage.setItem 抛错（如配额满）后，
  // 连续收藏 A、收藏 B、取消 A 与重开面板均基于内存副本演进，不回退覆盖；写入恢复后能正常落盘。
  // 最小失败输入与 tier：unit(jsdom)，setItem 抛错时第二次收藏导致第一次收藏丢失。
  it('preserves sequential in-memory favorite toggles when localStorage writes fail and recovers once writable', () => {
    const picker = { models: [auto, cheap, other], active: null, onSelect: vi.fn() };
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    });

    const first = render(<PluginModelsSection picker={picker} query="" onPicked={vi.fn()} />);
    fireEvent.click(first.container.querySelector('[data-plugin-model-favorite="gate:auto"]')!);
    fireEvent.click(first.container.querySelector('[data-plugin-model-favorite="gate:cheap"]')!);
    expect(first.container.querySelector('[data-plugin-model-favorite="gate:auto"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(first.container.querySelector('[data-plugin-model-favorite="gate:cheap"]')?.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(first.container.querySelector('[data-plugin-model-favorite="gate:auto"]')!);
    expect(first.container.querySelector('[data-plugin-model-favorite="gate:auto"]')?.getAttribute('aria-pressed')).toBe('false');
    expect(first.container.querySelector('[data-plugin-model-favorite="gate:cheap"]')?.getAttribute('aria-pressed')).toBe('true');
    first.unmount();

    const reopened = render(<PluginModelsSection picker={picker} query="" onPicked={vi.fn()} variant="favorites" />);
    expect(screen.getByRole('option', { name: /Cheap/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Auto/ })).toBeNull();

    setItemSpy.mockRestore();
    fireEvent.click(reopened.container.querySelector('[data-plugin-model-favorite="gate:cheap"]')!);
    expect(screen.queryByRole('option', { name: /Cheap/ })).toBeNull();
    expect(localStorage.getItem('cindy:pluginModelFavorites:v1:owner-a')).toBe('[]');
    reopened.unmount();
  });
});

describe('usePluginModels', () => {
  const stubGhosts = (listPickerModels: () => Promise<unknown>) => {
    const off = vi.fn();
    let changed = () => {};
    vi.stubGlobal('electronAPI', { ghosts: { listPickerModels, onChanged: (fn: () => void) => { changed = fn; return off; } } });
    Object.assign(window, { electronAPI: { ghosts: { listPickerModels, onChanged: (fn: () => void) => { changed = fn; return off; } } } });
    return { off, change: () => changed() };
  };

  it('treats a failed read as no plugin models, and refreshes when plugins change', async () => {
    const list = vi.fn<() => Promise<unknown>>().mockRejectedValueOnce(new Error('ipc')).mockResolvedValue([auto]);
    const { change, off } = stubGhosts(list);
    const { result, unmount } = renderHook(() => usePluginModels(true));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    expect(result.current).toEqual([]);
    change();
    await waitFor(() => expect(result.current).toEqual([auto]));
    unmount();
    expect(off).toHaveBeenCalled();
  });

  it('does not touch plugins where plugin models are not offered', () => {
    const list = vi.fn(async () => [auto]);
    stubGhosts(list);
    const { result } = renderHook(() => usePluginModels(false));
    expect(list).not.toHaveBeenCalled();
    expect(result.current).toEqual([]);
  });
});
