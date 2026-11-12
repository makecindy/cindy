import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedCommand } from '@cindy/maker-core';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { NEW_MAKER_DRAFT_KEY } from '@/features/cc-agent/newMakerDraftKeys';
import { clearDraft, getDraft, plainTextToTiptapDoc, saveDraft } from '../composerDraftStore';
import { prefillThemeCreatorDraft } from '../themeCreatorDraft';

const host = vi.hoisted(() => ({ commands: vi.fn(), resetTargets: vi.fn(), vendor: 'cc' }));
vi.mock('../slashCommands', () => ({
  loadAllCommands: (...args: unknown[]) => host.commands(...args),
  isSlashCommandUnavailable: (command: { runtimeStatus?: string }) => command.runtimeStatus === 'failed',
}));
vi.mock('@/state/newMakerDraft', () => ({
  getDraft: () => ({ vendor: host.vendor }),
  resetDraftWorkspaceTargets: () => host.resetTargets(),
}));

const command = (patch: Record<string, unknown> = {}): UnifiedCommand => ({
  kind: 'agent-skill', name: 'cindy-theme-creator', description: 'Create a theme',
  source: 'skill', scope: 'user', path: '/managed/theme/SKILL.md', builtIn: true, enabled: true,
  ...patch,
} as UnifiedCommand);

// Unit: exercise the production entry and real draft store. A plain prompt would
// lose official identity, overwrite user work or inherit an unrelated workspace.
// Existing issue/diagnosis tests do not route an authenticated built-in Skill.
describe('theme creator draft', () => {
  beforeEach(() => {
    clearDraft(NEW_MAKER_DRAFT_KEY);
    setDataOwnerGeneration('theme-owner');
    host.vendor = 'cc';
    host.resetTargets.mockClear();
    host.commands.mockReset().mockResolvedValue([command()]);
  });
  afterEach(() => {
    clearDraft(NEW_MAKER_DRAFT_KEY);
    setDataOwnerGeneration(null);
  });

  it.each(['cindy-theme-creator', 'cindy:cindy-theme-creator'])('pins the official %s command and preserves the existing body and media', async (name) => {
    host.commands.mockResolvedValue([command({ builtIn: false }), command({ name })]);
    const attachment = { id: 'reference', name: 'reference.png', path: '/tmp/reference.png', ext: '.png', size: 1, category: 'image' as const, mimeType: 'image/png' };
    const previousText = plainTextToTiptapDoc('Keep this reference and my notes');
    saveDraft(NEW_MAKER_DRAFT_KEY, { text: previousText, attachments: [attachment] });

    expect(await prefillThemeCreatorDraft('The style I want:')).toBe('prepared');
    const draft = getDraft(NEW_MAKER_DRAFT_KEY)!;
    expect(draft.text?.content?.[0].content?.[0].text).toBe(`/${name} The style I want:`);
    expect(draft.text?.content?.slice(1)).toEqual(previousText.content);
    expect(draft.attachments).toEqual([attachment]);
    expect(draft.builtInSkillIntent).toEqual({ name: 'cindy-theme-creator', commandName: name });
    expect(draft.focusAtEnd).toBe(true);
    expect(host.commands).toHaveBeenCalledWith('claude-code', null, { forceReload: true });
    expect(host.resetTargets).toHaveBeenCalledTimes(1);
  });

  it.each([
    { builtIn: false }, { enabled: false }, { runtimeStatus: 'failed' },
  ])('keeps the draft unchanged when the creator is unavailable: %j', async (patch) => {
    host.commands.mockResolvedValue([command(patch)]);
    saveDraft(NEW_MAKER_DRAFT_KEY, { text: plainTextToTiptapDoc('My unfinished task'), attachments: [] });
    const previous = getDraft(NEW_MAKER_DRAFT_KEY);
    expect(await prefillThemeCreatorDraft('Create a theme')).toBe('unavailable');
    expect(getDraft(NEW_MAKER_DRAFT_KEY)).toBe(previous);
    expect(host.resetTargets).not.toHaveBeenCalled();
  });

  it('reopens an edited theme draft without inserting the preset again', async () => {
    host.vendor = 'pi';
    await prefillThemeCreatorDraft('Create a theme');
    const original = getDraft(NEW_MAKER_DRAFT_KEY)!;
    saveDraft(NEW_MAKER_DRAFT_KEY, {
      ...original, text: plainTextToTiptapDoc('/cindy-theme-creator Use my sea-green reference'),
    });
    const edited = getDraft(NEW_MAKER_DRAFT_KEY)!;
    expect(await prefillThemeCreatorDraft('A new preset')).toBe('prepared');
    expect(getDraft(NEW_MAKER_DRAFT_KEY)?.text).toEqual(edited.text);
    expect(host.commands).toHaveBeenLastCalledWith('pi', null, { forceReload: true });
  });

  it('does not write a late command-discovery result into another account', async () => {
    let finish!: (commands: UnifiedCommand[]) => void;
    host.commands.mockReturnValue(new Promise<UnifiedCommand[]>((resolve) => { finish = resolve; }));
    const pending = prefillThemeCreatorDraft('Create a theme');
    setDataOwnerGeneration('different-owner');
    finish([command()]);
    expect(await pending).toBe('context-changed');
    expect(getDraft(NEW_MAKER_DRAFT_KEY)).toBeUndefined();
    expect(host.resetTargets).not.toHaveBeenCalled();
  });

  it('preserves the draft when host command discovery fails', async () => {
    host.commands.mockRejectedValue(new Error('Host unavailable'));
    saveDraft(NEW_MAKER_DRAFT_KEY, { text: plainTextToTiptapDoc('Keep my task'), attachments: [] });
    const previous = getDraft(NEW_MAKER_DRAFT_KEY);
    await expect(prefillThemeCreatorDraft('Create a theme')).rejects.toThrow('Host unavailable');
    expect(getDraft(NEW_MAKER_DRAFT_KEY)).toBe(previous);
    expect(host.resetTargets).not.toHaveBeenCalled();
  });
});
