import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseProjectEnv } from '@expo/env';
import { metroEnvironmentFingerprint } from '../sim-metro.mjs';

/** Read the same inputs for start, diagnostics and rebuild, without repairing files. */
export function readSimEnvironment(mobileDir, buildEnv, systemEnv = process.env) {
  const projectEnv = parseProjectEnv(mobileDir, {
    mode: systemEnv.NODE_ENV ?? 'development', silent: true, systemEnv: { ...systemEnv },
  });
  const loginScenario = systemEnv.EXPO_PUBLIC_LOGIN_SCENARIO?.trim()
    ?? projectEnv.env.EXPO_PUBLIC_LOGIN_SCENARIO?.trim() ?? '';
  const files = {};
  for (const name of ['.env', 'scripts/self-host-regions.json']) {
    const file = join(mobileDir, name);
    files[name] = existsSync(file) ? readFileSync(file, 'utf8') : null;
  }
  return { loginScenario, envFingerprint: metroEnvironmentFingerprint({
    env: { ...buildEnv, EXPO_PUBLIC_LOGIN_SCENARIO: loginScenario }, files,
  }) };
}
