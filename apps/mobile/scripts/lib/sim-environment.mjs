import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseProjectEnv } from '@expo/env';
import { metroEnvironmentFingerprint } from '../sim-metro.mjs';

export const UI_MOCK_ENV = 'EXPO_PUBLIC_CINDY_MOBILE_VISUAL_MOCK';

/**
 * `--mock` selects the login-free UI mock data (docs/dev-rules/ui-mock-data.md).
 * It only sets the bundle env, so start, whoami and rebuild must all pass it.
 */
export function applySimMockArg(args, env = process.env) {
  const passthrough = args.filter((arg) => arg !== '--mock');
  if (passthrough.length !== args.length) env[UI_MOCK_ENV] = '1';
  return passthrough;
}

/** Read the same inputs for start, diagnostics and rebuild, without repairing files. */
export function readSimEnvironment(mobileDir, buildEnv, systemEnv = process.env) {
  const projectEnv = parseProjectEnv(mobileDir, {
    mode: systemEnv.NODE_ENV ?? 'development', silent: true, systemEnv: { ...systemEnv },
  });
  const loginScenario = systemEnv.EXPO_PUBLIC_LOGIN_SCENARIO?.trim()
    ?? projectEnv.env.EXPO_PUBLIC_LOGIN_SCENARIO?.trim() ?? '';
  const uiMock = ['1', 'true', 'yes'].includes(
    (systemEnv[UI_MOCK_ENV] ?? projectEnv.env[UI_MOCK_ENV] ?? '').trim().toLowerCase());
  const files = {};
  for (const name of ['.env', 'scripts/self-host-regions.json']) {
    const file = join(mobileDir, name);
    files[name] = existsSync(file) ? readFileSync(file, 'utf8') : null;
  }
  return { loginScenario, uiMock, envFingerprint: metroEnvironmentFingerprint({
    // Only a mock Metro adds the key, so existing real-data fingerprints stay valid.
    env: { ...buildEnv, EXPO_PUBLIC_LOGIN_SCENARIO: loginScenario, ...(uiMock ? { [UI_MOCK_ENV]: '1' } : {}) },
    files,
  }) };
}
