import { describe, it, expect } from 'vitest';
import { appendCloudPluginOauthPrompt, CLOUD_PLUGIN_OAUTH_PROMPT } from '../prompt.js';

describe('cloud plugin OAuth guidance', () => {
  it('leaves local/SSH host text byte-identical and preserves the stable prefix', () => {
    const prefix = 'Identity\n\nSkill precedence\n\nHarness behavior';
    expect(appendCloudPluginOauthPrompt(prefix, false)).toBe(prefix);
    expect(appendCloudPluginOauthPrompt(prefix, true)).toBe(
      `${prefix}\n\n${CLOUD_PLUGIN_OAUTH_PROMPT}`,
    );
    expect(appendCloudPluginOauthPrompt(prefix, true)).toBe(
      appendCloudPluginOauthPrompt(prefix, true),
    );
  });
  it('describes real cards and desktop callback support, not prompt-based grants', () => {
    expect(CLOUD_PLUGIN_OAUTH_PROMPT).toContain('Only the Host');
    expect(CLOUD_PLUGIN_OAUTH_PROMPT).toContain('connect_account');
    expect(CLOUD_PLUGIN_OAUTH_PROMPT).toContain(
      'Phone clients currently support viewing and cancelling',
    );
    expect(CLOUD_PLUGIN_OAUTH_PROMPT).toContain('do not initiate another Cindy SSO');
    expect(CLOUD_PLUGIN_OAUTH_PROMPT).not.toMatch(/https?:\/\//);
  });
});
