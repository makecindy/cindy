// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import zhCNCommon from '@/i18n/locales/zh-CN/common.json';
import type { UnifiedCommand } from '@/lib/slashCommands';
import { CINDY_LEARN_SOURCE_DESCRIPTION } from '../../../../shared/cindyBuiltInSkills';

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
  it('opens details from the portaled information panel without inserting the Skill', () => {
    const command: UnifiedCommand = { ...discoveredProjectSkill, path: '/repo/.pi/skills/demo/SKILL.md' };
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const onOpenSkillDetails = vi.fn();
    const { container } = render(<SlashCommandPalette query="" commands={[command]} focusedIndex={0}
      onFocusedIndexChange={vi.fn()} onSelect={onSelect} onClose={onClose} onOpenSkillDetails={onOpenSkillDetails} />);
    const details = screen.getByRole('button', { name: 'commandPalette.viewSkillDetails' });
    expect(container.contains(details)).toBe(false);
    fireEvent.mouseDown(details);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(details);
    expect(onOpenSkillDetails).toHaveBeenCalledWith(command);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each([
    { kind: 'agent-builtin', name: 'compact', description: '' },
    { ...discoveredProjectSkill, source: 'user', path: '/repo/.claude/commands/demo.md' },
    discoveredProjectSkill,
  ] as UnifiedCommand[])('does not offer Skill details for commands without a backing Skill: $name', (command) => {
    render(<SlashCommandPalette query="" commands={[command]} focusedIndex={0}
      onFocusedIndexChange={vi.fn()} onSelect={vi.fn()} onClose={vi.fn()} onOpenSkillDetails={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'commandPalette.viewSkillDetails' })).toBeNull();
  });

  it('does not expose a local destination when the host omits navigation for remote Skills', () => {
    render(<SlashCommandPalette query="" commands={[{ ...discoveredProjectSkill, path: '/remote/demo/SKILL.md' }]}
      focusedIndex={0} onFocusedIndexChange={vi.fn()} onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'commandPalette.viewSkillDetails' })).toBeNull();
  });

  it('keeps a package Skill usable without offering an unresolvable local detail page', () => {
    const command: UnifiedCommand = { ...discoveredProjectSkill, path: '/packages/demo/SKILL.md',
      origin: 'package', runtimeStatus: 'approved' };
    const onSelect = vi.fn();
    render(<SlashCommandPalette query="" commands={[command]} focusedIndex={0}
      onFocusedIndexChange={vi.fn()} onSelect={onSelect} onClose={vi.fn()} onOpenSkillDetails={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'commandPalette.viewSkillDetails' })).toBeNull();
    fireEvent.mouseDown(screen.getByRole('button', { name: 'demo' }));
    expect(onSelect).toHaveBeenCalledWith(command);
  });

  it.each(['repo', 'project', 'global', 'user'] as const)('offers only resolvable %s details in a new-task draft', (scope) => {
    const command: UnifiedCommand = { ...discoveredProjectSkill, scope, path: '/draft/demo/SKILL.md', runtimeStatus: 'approved' };
    const onSelect = vi.fn();
    render(<SlashCommandPalette query="" commands={[command]} focusedIndex={0} allowProjectSkillDetails={false}
      onFocusedIndexChange={vi.fn()} onSelect={onSelect} onClose={vi.fn()} onOpenSkillDetails={vi.fn()} />);
    const details = screen.queryByRole('button', { name: 'commandPalette.viewSkillDetails' });
    if (scope === 'global' || scope === 'user') expect(details).not.toBeNull();
    else expect(details).toBeNull();
    fireEvent.mouseDown(screen.getByRole('button', { name: 'demo' }));
    expect(onSelect).toHaveBeenCalledWith(command);
  });

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

  it('localizes the built-in Skill Creator description in the input palette', () => {
    const skillCreator: UnifiedCommand = {
      kind: 'agent-skill',
      name: 'cindy-skill-creator',
      description: 'Create or update a Cindy Skill',
      builtIn: true,
      source: 'skill',
      scope: 'user',
    };

    render(
      <SlashCommandPalette
        query=""
        commands={[skillCreator]}
        focusedIndex={0}
        onFocusedIndexChange={vi.fn()}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('skillhub.builtIn.skillCreator.description')).toBeTruthy();
    expect(screen.getByText('skillhub.builtIn.official')).toBeTruthy();
    expect(screen.queryByText(skillCreator.description!)).toBeNull();
  });

  it('keeps a user-owned Skill Creator description unchanged', () => {
    const userSkillCreator: UnifiedCommand = {
      kind: 'agent-skill',
      name: 'cindy-skill-creator',
      description: 'Create Skills for my private workflow',
      source: 'skill',
      scope: 'user',
    };

    render(
      <SlashCommandPalette
        query=""
        commands={[userSkillCreator]}
        focusedIndex={0}
        onFocusedIndexChange={vi.fn()}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText(userSkillCreator.description!)).toBeTruthy();
    expect(screen.queryByText('skillhub.builtIn.skillCreator.description')).toBeNull();
    expect(screen.queryByText('skillhub.builtIn.official')).toBeNull();
  });

  it('localizes and marks the built-in Learn Skill as official', () => {
    render(
      <SlashCommandPalette
        query=""
        commands={[{
          kind: 'agent-skill',
          name: 'learn',
          description: CINDY_LEARN_SOURCE_DESCRIPTION,
          builtIn: true,
          source: 'skill',
          scope: 'user',
        }]}
        focusedIndex={0}
        onFocusedIndexChange={vi.fn()}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('skillhub.builtIn.official')).toBeTruthy();
    expect(screen.getByText('skillhub.builtIn.learn.description')).toBeTruthy();
  });

  it('does not mark a user Skill named learn as official', () => {
    render(
      <SlashCommandPalette
        query=""
        commands={[{
          kind: 'agent-skill',
          name: 'learn',
          description: 'My Learn workflow',
          source: 'skill',
        }]}
        focusedIndex={0}
        onFocusedIndexChange={vi.fn()}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByText('skillhub.builtIn.official')).toBeNull();
  });
});
