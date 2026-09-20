import { expect, it } from 'vitest';
import { appendPluginAuthorizationPrompt, PLUGIN_AUTHORIZATION_PROMPT } from '../prompt.js';
it('preserves the existing prefix and appends one stable device-neutral instruction', () => {
  const original = 'existing Host and harness instructions';
  expect(appendPluginAuthorizationPrompt(original)).toBe(
    `${original}\n\n${PLUGIN_AUTHORIZATION_PROMPT}`,
  );
  expect(appendPluginAuthorizationPrompt(original)).toBe(appendPluginAuthorizationPrompt(original));
  expect(PLUGIN_AUTHORIZATION_PROMPT).not.toMatch(/CIS|cloud instance|instance-runtime|CINDY_POD/);
});
it('guides discovery, exact reinstall-free reauthorization and private input without claiming provider success', () => {
  expect(PLUGIN_AUTHORIZATION_PROMPT).toContain('ghost_info');
  expect(PLUGIN_AUTHORIZATION_PROMPT).toContain('ghost_market_install');
  expect(PLUGIN_AUTHORIZATION_PROMPT).toContain('reauthorize=true');
  expect(PLUGIN_AUTHORIZATION_PROMPT).toContain('without first deleting');
  expect(PLUGIN_AUTHORIZATION_PROMPT).toContain('Never request');
  expect(PLUGIN_AUTHORIZATION_PROMPT).toContain('read-only check');
});
