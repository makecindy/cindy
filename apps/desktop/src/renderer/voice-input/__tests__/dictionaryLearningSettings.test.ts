import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DictationDictionaryLearningAction } from '@cindy/voice-input-core';

import {
  applyVoiceInputDictionaryLearningActions,
  deleteVoiceInputDictionaryEntriesFromSettings,
  getDefaultVoiceInputSettings,
  getNewAutomaticDictionaryEntries,
  normalizeVoiceInputSettings,
  type VoiceInputHistoryEntry,
  type VoiceInputSettings,
} from '../../../shared/voiceInputData';

let settings: VoiceInputSettings;
let history: VoiceInputHistoryEntry[];
let recordDictionaryLearningActions: ReturnType<typeof vi.fn>;

beforeEach(() => {
  settings = getDefaultVoiceInputSettings('darwin');
  history = [];
  recordDictionaryLearningActions = vi.fn(async (actions: DictationDictionaryLearningAction[]) => {
    const nextSettings = normalizeVoiceInputSettings(
      applyVoiceInputDictionaryLearningActions(settings, actions),
      'darwin',
    );
    const newAutomaticEntries = getNewAutomaticDictionaryEntries(
      settings.dictionaryEntries,
      nextSettings.dictionaryEntries,
    );
    settings = nextSettings;
    return { settings, newAutomaticEntries };
  });
  vi.stubGlobal('window', {
    electronAPI: {
      platform: 'darwin',
      voiceInput: {
        getDataSnapshot: () => ({ settings, history }),
        updateSettings: vi.fn(async (patch: Partial<VoiceInputSettings>) => {
          settings = normalizeVoiceInputSettings({ ...settings, ...patch }, 'darwin');
          return settings;
        }),
        deleteDictionaryEntries: vi.fn(async (entryIds: string[]) => {
          settings = deleteVoiceInputDictionaryEntriesFromSettings(settings, entryIds);
          return settings;
        }),
        recordDictionaryLearningActions,
        adviseDictionaryLearning: vi.fn(),
        setGlobalShortcut: vi.fn().mockResolvedValue({ ok: true }),
        onDataChanged: vi.fn(() => () => {}),
      },
    },
  });
  vi.resetModules();
});

async function loadSettingsModule() {
  return await import('@/hooks/useVoiceInputSettings');
}

describe('voice input dictionary learning settings', () => {
  it('legacy path admits on third observation and coalesces aliases within one result', () => {
    const base = { action: 'add_candidate' as const, term: 'Slack', type: 'product_name' as const, confidence: 'medium' as const };
    let next = applyVoiceInputDictionaryLearningActions(settings, [
      { ...base, aliases: ['Slate'] }, { ...base, aliases: ['Slak'] },
    ]);
    expect(next.dictionaryCandidates[0].evidenceCount).toBe(1);
    next = applyVoiceInputDictionaryLearningActions(next, [{ ...base, aliases: ['Slate'] }]);
    next = applyVoiceInputDictionaryLearningActions(next, [{ ...base, aliases: [] }]);
    expect(next.dictionaryCandidates).toEqual([]);
    expect(next.dictionaryEntries[0]).toMatchObject({ frequency: 3, aliases: [
      { text: 'Slate', count: 2 }, { text: 'Slak', count: 1 },
    ] });
  });

  it('无别名词汇进入润色词表,但不生成纠错提示', async () => {
    const { recordVoiceInputDictionaryLearningActions, getVoiceInputSettings,
      formatVoiceInputDictionary, buildVoiceInputDictionaryAliasHints } = await loadSettingsModule();
    await recordVoiceInputDictionaryLearningActions([
      { action: 'add_entry', term: 'Slack', aliases: [], type: 'product_name', confidence: 'high' },
    ]);
    const entries = getVoiceInputSettings().dictionaryEntries;
    expect(entries).toEqual([expect.objectContaining({ text: 'Slack', aliases: [], frequency: 1 })]);
    expect(formatVoiceInputDictionary(entries)).toContain('- Slack');
    expect(buildVoiceInputDictionaryAliasHints(entries)).toBeUndefined();
  });

  it('does not learn while refinement or automatic dictionary learning is disabled', async () => {
    const {
      getVoiceInputSettings,
      recordVoiceInputDictionaryLearningActions,
    } = await loadSettingsModule();
    const action = {
      action: 'add_entry' as const,
      term: 'Codex',
      aliases: ['扣德克斯'],
      type: 'technical_term' as const,
      confidence: 'high' as const,
    };

    settings = {
      ...getVoiceInputSettings(),
      refinementEnabled: false,
    };
    await recordVoiceInputDictionaryLearningActions([action]);
    expect(getVoiceInputSettings().dictionaryCandidates).toEqual([]);
    expect(getVoiceInputSettings().dictionaryEntries).toEqual([]);

    settings = {
      ...getVoiceInputSettings(),
      refinementEnabled: true,
      autoDictionaryEnabled: false,
    };
    await recordVoiceInputDictionaryLearningActions([action]);
    expect(getVoiceInputSettings().dictionaryCandidates).toEqual([]);
    expect(getVoiceInputSettings().dictionaryEntries).toEqual([]);
  });

  it('applies model-advised candidate and entry actions', async () => {
    const {
      buildVoiceInputDictionaryAliasHints,
      formatVoiceInputDictionary,
      getVoiceInputSettings,
      getNewAutomaticDictionaryEntryTexts,
      recordVoiceInputDictionaryLearningActions,
    } = await loadSettingsModule();

    const before = getVoiceInputSettings().dictionaryEntries;
    await recordVoiceInputDictionaryLearningActions([
      {
        action: 'add_candidate',
        term: 'Vibe Coding',
        aliases: ['web coding'],
        type: 'technical_term',
        confidence: 'medium',
      },
    ]);
    let current = getVoiceInputSettings();
    expect(current.dictionaryCandidates).toHaveLength(1);
    expect(current.dictionaryCandidates[0]).toMatchObject({
      text: 'Vibe Coding',
      evidenceCount: 1,
      aliases: [{ text: 'web coding', count: 1 }],
    });
    expect(getNewAutomaticDictionaryEntryTexts(before, current.dictionaryEntries)).toEqual([]);

    await recordVoiceInputDictionaryLearningActions([
      {
        action: 'add_entry',
        term: 'Vibe Coding',
        aliases: ['web coding'],
        type: 'technical_term',
        confidence: 'high',
      },
    ]);
    current = getVoiceInputSettings();
    expect(current.dictionaryCandidates).toEqual([]);
    expect(current.dictionaryEntries).toHaveLength(1);
    expect(current.dictionaryEntries[0]).toMatchObject({
      text: 'Vibe Coding',
      source: 'automatic',
      frequency: 2,
      aliases: [{ text: 'web coding', count: 2 }],
    });
    expect(getNewAutomaticDictionaryEntryTexts(before, current.dictionaryEntries)).toEqual(['Vibe Coding']);
    expect(formatVoiceInputDictionary(current.dictionaryEntries)).toContain('- Vibe Coding');
    expect(formatVoiceInputDictionary(current.dictionaryEntries)).not.toContain('web coding');
    expect(buildVoiceInputDictionaryAliasHints(current.dictionaryEntries)).toEqual([
      {
        term: 'Vibe Coding',
        frequency: 2,
        aliases: [{ text: 'web coding', count: 2 }],
      },
    ]);
  });

  it('does not report manual or updated automatic entries as newly auto-added', async () => {
    const {
      createManualVoiceInputDictionaryEntry,
      getNewAutomaticDictionaryEntryTexts,
      getVoiceInputSettings,
      recordVoiceInputDictionaryLearningActions,
    } = await loadSettingsModule();

    const manual = createManualVoiceInputDictionaryEntry('Codex');
    expect(manual).not.toBeNull();
    settings = {
      ...getVoiceInputSettings(),
      dictionaryEntries: [manual!],
    };
    const before = getVoiceInputSettings().dictionaryEntries;
    expect(getNewAutomaticDictionaryEntryTexts([], before)).toEqual([]);

    await recordVoiceInputDictionaryLearningActions([
      {
        action: 'add_entry',
        term: 'Vibe Coding',
        aliases: ['web coding'],
        type: 'technical_term',
        confidence: 'high',
      },
    ]);
    const afterAdd = getVoiceInputSettings().dictionaryEntries;
    expect(getNewAutomaticDictionaryEntryTexts(before, afterAdd)).toEqual(['Vibe Coding']);

    await recordVoiceInputDictionaryLearningActions([
      {
        action: 'update_entry',
        term: 'Vibe Coding',
        aliases: ['vibe coding'],
        type: 'technical_term',
        confidence: 'high',
      },
    ]);
    const afterUpdate = getVoiceInputSettings().dictionaryEntries;
    expect(getNewAutomaticDictionaryEntryTexts(afterAdd, afterUpdate)).toEqual([]);
  });

  it('forwards dictionary learning actions to the main-owned store', async () => {
    const {
      getVoiceInputSettings,
      recordVoiceInputDictionaryLearningActions,
    } = await loadSettingsModule();

    await recordVoiceInputDictionaryLearningActions([
      {
        action: 'add_entry',
        term: 'Vibe Coding',
        aliases: ['web coding'],
        type: 'technical_term',
        confidence: 'high',
      },
      {
        action: 'add_entry',
        term: '3D Printing',
        aliases: ['three dee printing'],
        type: 'technical_term',
        confidence: 'high',
      },
    ]);

    expect(getVoiceInputSettings().dictionaryEntries.map((entry) => entry.text)).toEqual([
      'Vibe Coding',
      '3D Printing',
    ]);
    expect(recordDictionaryLearningActions).toHaveBeenCalledTimes(1);
  });

  it('defaults Linux voice input shortcut to null', () => {
    expect(getDefaultVoiceInputSettings('linux').shortcut).toBeNull();
  });
});
