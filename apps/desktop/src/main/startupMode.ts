import { app } from 'electron';

/** Shared by the early OS registration entries and the later smoke runner. */
export function parseSmokeArgs(): {
  enabled: boolean;
  userId: string;
  pluginStorage: boolean;
  resultFile: string | null;
} {
  const resultFile = !app.isPackaged
    ? process.env.XDT_PLUGIN_STORAGE_SMOKE_RESULT_FILE?.trim() || null
    : null;
  const enabled = process.argv.includes('--smoke-test') || resultFile !== null;
  const userFlag = process.argv.find((a) => a.startsWith('--smoke-user='));
  const userId = userFlag ? userFlag.slice('--smoke-user='.length) : '__smoke_test__';
  return {
    enabled,
    userId,
    pluginStorage: process.argv.includes('--smoke-plugin-storage') || resultFile !== null,
    resultFile,
  };
}

/** userData isolation alone does not isolate OS associations or shortcuts. */
export function shouldSkipSystemIntegration(): boolean {
  return process.argv.includes('--no-system-integration') || parseSmokeArgs().enabled;
}
