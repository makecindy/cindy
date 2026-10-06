import { app } from 'electron';
import path from 'node:path';
import { createOverrideSettingsFile } from './override-settings-file.js';
import { desktopMakerLogger } from './logger-adapter.js';
import { isCodexFollowUpMode, type CodexFollowUpMode } from '../../shared/codexFollowUp.js';
const store = createOverrideSettingsFile<{ mode: CodexFollowUpMode }>({
  filePath: () => path.join(app.getPath('userData'), 'codex-follow-up-settings.json'),
  defaults: { mode: 'queue' },
  normalize: (raw) => ({
    mode:
      raw && typeof raw === 'object' && isCodexFollowUpMode((raw as { mode?: unknown }).mode)
        ? (raw as { mode: CodexFollowUpMode }).mode
        : 'queue',
  }),
  log: desktopMakerLogger.child('codex-follow-up-settings'),
  label: 'codex-follow-up',
});
export function readCodexFollowUpSettings() {
  store.invalidateIfChanged();
  return store.readState();
}
export async function writeCodexFollowUpSettings(mode: CodexFollowUpMode | null) {
  if (mode === null) await store.resetAtomic();
  else await store.writePatchAtomic({ mode }, { preserveDefaults: true });
  return readCodexFollowUpSettings();
}
