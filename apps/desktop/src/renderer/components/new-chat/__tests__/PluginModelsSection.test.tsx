// @vitest-environment jsdom
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { usePluginModels } from '@/features/cc-agent/pluginModelRoute';
import { PluginModelsSection } from '../PluginModelsSection';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' } }) }));

const auto = { pluginId: 'gate', pluginName: 'Decision Gate', id: 'auto', name: 'Auto', description: 'Picks by your rules' };
const cheap = { ...auto, id: 'cheap', name: 'Cheap', description: undefined };
const other = { pluginId: 'other', pluginName: 'Other', id: 'x', name: 'X' };

afterEach(() => {
  cleanup();
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
