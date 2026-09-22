// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import zhCNCommon from '@/i18n/locales/zh-CN/common.json';
import { mergeCommands, type UnifiedCommand } from '@/lib/slashCommands';
import { CINDY_LEARN_SOURCE_DESCRIPTION } from '../../../../shared/cindyBuiltInSkills';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, number>) => {
      if (key === 'commandPalette.moreResults' && options) {
        return `${key}:${options.count}:${options.visible}:${options.total}`;
      }
      if (key === 'commandPalette.resultCount' && options) {
        return `${key}:${options.visible}:${options.total}`;
      }
      return options?.count === undefined ? key : `${key}:${options.count}`;
    },
  }),
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

const issue4788Target = 'run-cindy-e2e-pr-testcase';
const issue4788Commands = mergeCommands([], [], [
  ...Array.from({ length: 32 }, (_, index) => ({
    kind: 'agent-skill' as const,
    name: `cindy-e2e-${String(index + 1).padStart(2, '0')}`,
    source: 'skill' as const,
    description: 'Cindy E2E fixture Skill',
  })),
  {
    kind: 'agent-skill' as const,
    name: issue4788Target,
    source: 'skill' as const,
    description: 'Run the Cindy E2E PR testcase',
  },
  ...Array.from({ length: 4 }, (_, index) => ({
    kind: 'agent-skill' as const,
    name: `z-skill-${String(index + 1).padStart(2, '0')}`,
    source: 'skill' as const,
    description: 'Trailing fixture Skill',
  })),
]);

describe('SlashCommandPalette project Skill rows', () => {
  it('shows the issue #4788 hint for broad queries and reveals the target after narrowing', () => {
    const { rerender } = render(<SlashCommandPalette query="" commands={issue4788Commands} focusedIndex={0}
      onFocusedIndexChange={vi.fn()} onSelect={vi.fn()} onClose={vi.fn()} />);

    expect(screen.getAllByRole('button')).toHaveLength(25);
    expect(screen.queryByRole('button', { name: issue4788Target })).toBeNull();
    const hint = screen.getByText('commandPalette.moreResults:12:25:37');
    const liveRegion = hint.closest('[aria-live="polite"]');
    expect(liveRegion?.tagName).toBe('DIV');
    expect(liveRegion?.getAttribute('aria-live')).toBe('polite');

    rerender(<SlashCommandPalette query="cindy" commands={issue4788Commands} focusedIndex={0}
      onFocusedIndexChange={vi.fn()} onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getAllByRole('button')).toHaveLength(25);
    expect(screen.queryByRole('button', { name: issue4788Target })).toBeNull();
    expect(screen.getByText('commandPalette.moreResults:8:25:33')).not.toBeNull();

    rerender(<SlashCommandPalette query="run" commands={issue4788Commands} focusedIndex={0}
      onFocusedIndexChange={vi.fn()} onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: issue4788Target })).not.toBeNull();
    expect(screen.queryByText(/commandPalette\.moreResults/)).toBeNull();
  });

  it('does not show the truncation hint when all matching commands are visible', () => {
    const commands: UnifiedCommand[] = Array.from({ length: 25 }, (_, index) => ({
      kind: 'desktop',
      name: `command-${index}`,
      description: '',
    }));

    render(<SlashCommandPalette query="" commands={commands} focusedIndex={0}
      onFocusedIndexChange={vi.fn()} onSelect={vi.fn()} onClose={vi.fn()} />);

    expect(screen.queryByText('commandPalette.moreResults:0')).toBeNull();
  });

  it('reveals the next page only after the explicit show-more action', () => {
    const onShowMore = vi.fn();
    const onFocusedIndexChange = vi.fn();
    const { rerender } = render(
      <SlashCommandPalette
        query=""
        commands={issue4788Commands}
        focusedIndex={0}
        onFocusedIndexChange={onFocusedIndexChange}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        visibleLimit={25}
        onShowMore={onShowMore}
      />,
    );

    expect(screen.queryByRole('button', { name: issue4788Target })).toBeNull();
    expect(screen.queryByText('commandPalette.moreResults:12:25:37')).toBeNull();
    const showMore = screen.getByRole('button', {
      name: 'commandPalette.showMore: commandPalette.resultCount:25:37',
    });
    fireEvent.mouseDown(showMore);
    fireEvent.click(showMore);
    expect(onShowMore).toHaveBeenCalledOnce();
    expect(onFocusedIndexChange).not.toHaveBeenCalled();

    rerender(
      <SlashCommandPalette
        query=""
        commands={issue4788Commands}
        focusedIndex={0}
        onFocusedIndexChange={vi.fn()}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        visibleLimit={50}
        onShowMore={onShowMore}
      />,
    );
    expect(screen.getByRole('button', { name: issue4788Target })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'commandPalette.showMore:0' })).toBeNull();
  });

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
