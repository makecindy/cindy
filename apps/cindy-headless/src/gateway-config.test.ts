import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildCodexGatewayArgs, gatewayConfigCandidates, loadGatewayConfig } from './gateway-config.js';

describe('gateway config', () => {
  it('searches the documented repository-local config path', () => {
    expect(gatewayConfigCandidates()).toContain(path.join(process.cwd(), 'apps', 'cindy-headless', 'config.local.json'));
  });
  it('builds an API-key Codex Responses provider without placing the secret in argv', () => {
    const args = buildCodexGatewayArgs({ baseUrl: 'https://gateway.example.com', apiKey: 'secret' });
    expect(args).toContain('model_provider="cindy_gateway"');
    expect(args).toContain('model_providers.cindy_gateway.base_url="https://gateway.example.com/v1"');
    expect(args).toContain('model_providers.cindy_gateway.env_key="CINDY_CODEX_API_KEY"');
    expect(args.join(' ')).not.toContain('secret');
  });

  it('loads the shared gateway config from an explicit local file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cindy-headless-config-'));
    const file = path.join(dir, 'config.json');
    await writeFile(file, JSON.stringify({ gateway: { baseUrl: 'https://gateway.example.com', apiKey: 'file-secret' } }), 'utf8');
    const previous = {
      config: process.env.CINDY_HEADLESS_CONFIG_FILE,
      key: process.env.CINDY_HEADLESS_API_KEY,
      anthropicKey: process.env.ANTHROPIC_API_KEY,
      codexKey: process.env.CINDY_CODEX_API_KEY,
      baseUrl: process.env.CINDY_HEADLESS_BASE_URL,
      anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
    };
    process.env.CINDY_HEADLESS_CONFIG_FILE = file;
    delete process.env.CINDY_HEADLESS_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CINDY_CODEX_API_KEY;
    delete process.env.CINDY_HEADLESS_BASE_URL;
    delete process.env.ANTHROPIC_BASE_URL;
    try {
      await expect(loadGatewayConfig()).resolves.toMatchObject({ baseUrl: 'https://gateway.example.com', apiKey: 'file-secret' });
    } finally {
      const restore = (name: string, value: string | undefined) => value === undefined ? delete process.env[name] : process.env[name] = value;
      restore('CINDY_HEADLESS_CONFIG_FILE', previous.config);
      restore('CINDY_HEADLESS_API_KEY', previous.key);
      restore('ANTHROPIC_API_KEY', previous.anthropicKey);
      restore('CINDY_CODEX_API_KEY', previous.codexKey);
      restore('CINDY_HEADLESS_BASE_URL', previous.baseUrl);
      restore('ANTHROPIC_BASE_URL', previous.anthropicBaseUrl);
    }
  });
});
