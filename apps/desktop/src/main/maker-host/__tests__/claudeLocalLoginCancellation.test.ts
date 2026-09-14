import { readFileSync } from 'node:fs';
import { ScriptTarget, transpileModule } from 'typescript';
import { expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() }, app: { getPath: () => '/unused-test-path' } }));
import { beginClaudeLocalLogin, cancelClaudeOAuthLogin } from '../claude-oauth-login.js';

const source = readFileSync(new URL('../../bootstrap-electron.ts', import.meta.url), 'utf8');
const start = source.indexOf('  ipcMain.handle(MAKER_IPC_INVOKE.CLAUDE_OAUTH_LOGIN,');
const end = source.indexOf('  ipcMain.handle(MAKER_IPC_INVOKE.CLAUDE_OAUTH_LOGOUT,', start);
const compiled = transpileModule(source.slice(start, end), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;

it.each(['scan', 'proxy'] as const)('does not bind a cancelled local login while waiting for %s', async (stage) => {
  let resume!: () => void;
  const pending = new Promise<void>(resolve => { resume = resolve; });
  let handler!: () => Promise<{ ok: boolean; reason?: string }>;
  const bind = vi.fn(() => true);
  const proxy = vi.fn(() => stage === 'proxy' ? pending : Promise.resolve());
  const deps = {
    ipcMain: { handle: (_channel: string, callback: typeof handler) => { handler = callback; } },
    MAKER_IPC_INVOKE: { CLAUDE_OAUTH_LOGIN: 'login' },
    assertTrustedAppRendererEvent: vi.fn(),
    activeOwnerScopeKey: () => 'owner',
    isAppSessionBoundaryPending: () => false,
    getActiveAppSession: () => ({ dataOwnerId: 'owner' }),
    beginClaudeLocalLogin,
    resetProviderModelAutoRefreshCooldowns: vi.fn(),
    clearAnthropicDiscoveredModels: () => stage === 'scan' ? pending : Promise.resolve(),
    ensureAnthropicCompatProxyReady: proxy,
    reconnectClaudeAiOAuth: bind,
    broadcastClaudeAuthStateChanged: vi.fn(),
    syncClaudeSubscriptionUsageForAuthChange: vi.fn(),
    refreshAnthropicModelsFromHttp: vi.fn(),
    hasClaudeAiOAuth: () => true,
  };
  new Function(...Object.keys(deps), compiled)(...Object.values(deps));
  const run = handler();
  if (stage === 'proxy') await vi.waitFor(() => expect(proxy).toHaveBeenCalled());
  cancelClaudeOAuthLogin();
  resume();
  await expect(run).resolves.toMatchObject({ ok: false, reason: 'login_cancelled' });
  expect(bind).not.toHaveBeenCalled();
});

it('reuses cancellation for a replacement local login without aborting the replacement', () => {
  const first = beginClaudeLocalLogin('old');
  const second = beginClaudeLocalLogin('new');
  expect(first.aborted).toBe(true);
  expect(second.aborted).toBe(false);
  cancelClaudeOAuthLogin('old');
  expect(second.aborted).toBe(false);
  cancelClaudeOAuthLogin('new');
  expect(second.aborted).toBe(true);
});
