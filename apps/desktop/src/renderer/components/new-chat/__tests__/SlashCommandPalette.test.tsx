// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import zhCNCommon from '@/i18n/locales/zh-CN/common.json';
import type { UnifiedCommand } from '@/lib/slashCommands';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { SlashCommandPalette } from '../SlashCommandPalette';

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(cleanup);

const discoveredProjectSkill: UnifiedCommand = {
  kind: 'agent-skill',
  name: 'demo',
  source: 'skill',
  scope: 'repo',
  runtimeStatus: 'discovered',
};

describe('SlashCommandPalette project Skill rows', () => {
  it('keeps a discovered Skill disabled and non-actionable', () => {
    const onSelect = vi.fn();

    render(
      <SlashCommandPalette
        query=""
        commands={[discoveredProjectSkill]}
        focusedIndex={0}
        onFocusedIndexChange={vi.fn()}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );

    const row = screen.getByRole('button', {
      name: 'demo: commandPalette.projectSkillNotLoaded',
    });
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.className).toContain('opacity-50');
    expect(row.className).toContain('cursor-not-allowed');

    fireEvent.mouseDown(row);
    fireEvent.click(row);

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('uses the automatic loading copy without a trust or admission action', () => {
    expect(zhCNCommon.commandPalette.projectSkillNotLoaded).toBe(
      '当前 Pi 任务尚未加载此项目 Skill，新任务会自动尝试加载',
    );
    expect(zhCNCommon.commandPalette).not.toHaveProperty('projectTrustRequired');
    expect(zhCNCommon.commandPalette).not.toHaveProperty('projectSkillConfirmAction');
  });

  it('continues to select a loaded Skill normally', () => {
    const loaded: UnifiedCommand = {
      ...discoveredProjectSkill,
      runtimeStatus: 'loaded',
    };
    const onSelect = vi.fn();

    render(
      <SlashCommandPalette
        query=""
        commands={[loaded]}
        focusedIndex={0}
        onFocusedIndexChange={vi.fn()}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );

    fireEvent.mouseDown(screen.getByRole('button', { name: 'demo' }));

    expect(onSelect).toHaveBeenCalledWith(loaded);
  });
});
