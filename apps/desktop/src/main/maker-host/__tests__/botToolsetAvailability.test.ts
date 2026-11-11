import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createLiziMcpProviders } from '@cindy/mcps';
import { isBotToolsetProviderAvailable } from '../botToolsetAvailability';

const root = mkdtempSync(join(tmpdir(), 'cindy-bot-toolsets-'));
const tsDir = join(root, 'typescript');
const plainDir = join(root, 'plain');
mkdirSync(tsDir);
mkdirSync(plainDir);
writeFileSync(join(tsDir, 'tsconfig.json'), '{}');
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

describe('Bot toolset provider availability', () => {
  it('follows the real LSP gate rather than registry enablement', () => {
    let lspEnabled = false;
    const providers = createLiziMcpProviders({
      enabled: ['cindy_lsp', 'cindy_memory'],
      lsp: { pool: {} as never, isUserEnabled: () => lspEnabled },
      memory: { getManager: () => ({ isEnabled: () => false }) as never },
    });
    const available = (toolsetId: string, workingDir = tsDir) =>
      isBotToolsetProviderAvailable(providers, { botId: 'bot-1', agentKind: 'claude-code', workingDir, toolsetId });
    expect(available('lsp')).toBe(false);
    lspEnabled = true;
    expect(available('lsp', plainDir)).toBe(false);
    expect(available('lsp')).toBe(true);
    for (const agentKind of ['codex', 'pi'] as const) {
      expect(isBotToolsetProviderAvailable(providers, {
        botId: 'bot-1', agentKind, workingDir: tsDir, toolsetId: 'lsp',
      })).toBe(false); // The real provider rejects the shared bridge's empty workdir.
      expect(isBotToolsetProviderAvailable(providers, {
        botId: 'bot-1', agentKind, workingDir: tsDir, toolsetId: 'memory',
      })).toBe(true);
    }
    vi.stubEnv('LIZI_LSP_DISABLED', '1');
    expect(available('lsp')).toBe(false);
    expect(available('memory')).toBe(true); // Bot Memory is independent of global Memory.
    expect(available('missing')).toBe(false);
  });

  it('keeps target restrictions and never uses custom MCP collisions to bypass a builtin gate', () => {
    const providers = [
      { name: 'cindy_scheduler', isEnabled: () => false },
      { name: 'cindy_scheduler', isEnabled: () => true },
      { name: 'cindy_docs', isEnabled: () => true },
    ];
    const input = { botId: 'bot-1', agentKind: 'claude-code' as const, workingDir: plainDir };
    expect(isBotToolsetProviderAvailable(providers, { ...input, toolsetId: 'scheduler' })).toBe(false);
    expect(isBotToolsetProviderAvailable(providers, { ...input, toolsetId: 'docs' })).toBe(true);
    expect(isBotToolsetProviderAvailable(providers, { ...input, toolsetId: 'docs', remoteHostId: 'ssh' })).toBe(false);
    expect(isBotToolsetProviderAvailable(providers, { ...input, agentKind: 'pi', toolsetId: 'docs', remoteHostId: 'ssh' })).toBe(true);
  });
});
