import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('VoiceInputSection shortcut recording gate', () => {
  it('disables app shortcuts while recording voice input shortcuts', () => {
    const source = readFileSync(
      new URL('../../components/settings/VoiceInputSection.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain("document.body.dataset.appShortcutRecording = '1'");
    expect(source).toContain('window.electronAPI.appShortcuts.setRecording(true)');
    expect(source).toContain('delete document.body.dataset.appShortcutRecording');
    expect(source).toContain('window.electronAPI.appShortcuts.setRecording(false)');
  });

  it('waits for shortcut suspension before committing and restores the latest persisted shortcut', () => {
    const source = readFileSync(
      new URL('../../components/settings/VoiceInputSection.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain('await shortcutSuspendPromiseRef.current');
    expect(source).toContain('shortcutSuspendPromiseRef.current = suspendPromise');
    expect(source).toContain('syncVoiceInputGlobalShortcut(getVoiceInputSettings().shortcut)');
    expect(source).toContain('}, [recordingShortcut]);');
  });

  it('clears stale custom ASR form fields when the saved config is removed', () => {
    const source = readFileSync(
      new URL('../../components/settings/VoiceInputSection.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain('if (!selection?.customAsr) {');
    expect(source).toContain("setCustomAsrProtocol('openai-realtime')");
    expect(source).toContain("setCustomAsrWebsocketUrl('')");
    expect(source).toContain("setCustomAsrModel('')");
    expect(source).toContain("setCustomAsrApiKey('')");
  });

  it('preserves a dirty custom ASR endpoint and key across unrelated selection refreshes', () => {
    const source = readFileSync(
      new URL('../../components/settings/VoiceInputSection.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain('if (customAsrSelected && customAsrFormDirtyRef.current) return;');
    expect(source).toContain('}, [customAsrSelected, selection?.customAsr]);');
    expect(source).toContain('customAsrFormDirtyRef.current = true;');
  });

  it('invalidates a previous connection result when any local custom ASR field changes', () => {
    const source = readFileSync(
      new URL('../../components/settings/VoiceInputSection.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toMatch(
      /setConnectionTest\(\{ status: 'idle' \}\);[\s\S]*customAsrProtocol,[\s\S]*customAsrWebsocketUrl,[\s\S]*customAsrModel,[\s\S]*customAsrApiKey,/,
    );
  });
});
