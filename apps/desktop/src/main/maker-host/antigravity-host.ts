import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { activeOwnerScopeKey, getActiveAppSession } from '../appSessionState.js';
import { AntigravityAgent, isAntigravitySubscriptionModel } from '@cindy/maker-core/agents/antigravity';
import { spawnAcp } from '@cindy/maker-core/agents/antigravity-transport';
import type { AgentDeps } from '@cindy/maker-core';
import { antigravitySubscriptionArgs, assertAntigravityGenerationAllowed, assertAntigravitySubscriptionSettings } from './antigravity-policy.js';
import { setAntigravityState } from './antigravity-state.js';

/** Local opt-in only. Never alters defaults, another engine or a companion profile. */
function createAntigravityAgent(userData: string, logger: AgentDeps['logger'], prepareTools?: (opts: import('@cindy/maker-core').StartSessionOptions) => Promise<{ mcpServers: Array<Record<string, unknown>>; dispose(): void }>): AntigravityAgent | null {
  const owner = getActiveAppSession().dataOwnerId;
  const fence = activeOwnerScopeKey();
  const assertOwner = () => { if (activeOwnerScopeKey() !== fence) throw new Error('ANTIGRAVITY_OWNER_CHANGED'); };
  const ownerKey = createHash('sha256').update(owner ?? 'local').digest('hex').slice(0, 24);
  const configPath = path.join(userData, 'google-subscription', ownerKey, 'connection.json');
  setAntigravityState(null);
  if (!fs.existsSync(configPath)) return null;
  const config: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!config || typeof config !== 'object') throw new Error('ANTIGRAVITY_CONFIG_INVALID');
  const cfg = config as Record<string, unknown>;
  if (cfg.enabled !== true) return null;
  if (typeof cfg.binaryPath !== 'string' || !path.isAbsolute(cfg.binaryPath) || !fs.existsSync(cfg.binaryPath)) throw new Error('ANTIGRAVITY_BINARY_UNAVAILABLE');
  const updateLocalConnection = (patch: Record<string, unknown>) => {
    assertOwner();
    const current = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const temporary = `${configPath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ ...current, ...patch }, null, 2), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, configPath);
    } finally { fs.rmSync(temporary, { force: true }); }
  };
  const binary = cfg.binaryPath;
  // Official manifest-verified 1.5.9 darwin-arm64 payload; defaults below are version-bound.
  const pinnedSha256 = 'fad3628ad91fe8613a72f074a1c5fde7cd816517788a5b9be96703f7d256741a';
  const assertBinary = () => {
    if (createHash('sha256').update(fs.readFileSync(binary)).digest('hex') !== pinnedSha256) throw new Error('ANTIGRAVITY_UNVERIFIED_RUNTIME');
  };
  assertBinary();
  const root = path.join(userData, 'google-subscription', ownerKey);
  const geminiDir = path.join(root, '.gemini');
  const settingsPath = path.join(geminiDir, 'antigravity-cli', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(settingsPath)) fs.writeFileSync(settingsPath, JSON.stringify({ useG1Credits: false, modelProvider: '', agentMode: '', toolPermission: 'strict' }), { mode: 0o600, flag: 'wx' });
  const checkPolicy = async (): Promise<void> => {
    assertOwner();
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    const sharedPath = path.join(geminiDir, 'config', 'config.json');
    let user: Record<string, unknown> = {};
    if (fs.existsSync(sharedPath)) {
      const shared = JSON.parse(fs.readFileSync(sharedPath, 'utf8')) as { userSettings?: Record<string, unknown> };
      user = shared.userSettings ?? {};
    }
    assertAntigravitySubscriptionSettings(settings, user);
  };
  setAntigravityState({ isCurrent: () => activeOwnerScopeKey() === fence, connected: false, models: [] });
  return new AntigravityAgent({
    binaryPath: binary, logger, runtimeConfig: {},
    auth: { getState: async () => ({ authenticated: false }), triggerLogin: async () => ({ authenticated: false }), logout: async () => {}, getAuthEnv: async () => ({}) },
  }, {
    async connect(cwd, opts) {
      assertBinary();
      await checkPolicy();
      const tools = opts && prepareTools ? await prepareTools(opts) : undefined;
      // The pinned ACP runtime requires its official worker mode for HTTP MCP.
      // Native settings and the isolated on-disk settings both keep credits off;
      // environment filtering prevents API/ADC credentials from reaching either process.
      return { mcpServers: tools?.mcpServers, dispose: tools?.dispose, transport: spawnAcp(binary, antigravitySubscriptionArgs(geminiDir, opts?.permissionMode, !!tools?.mcpServers.length), cwd), assertSubscriptionOnly: checkPolicy };
    },
    async assertSessionAllowed() {
      await checkPolicy();
      const current = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      if (current.enabled !== true || current.binaryPath !== binary || current.authDisconnected === true) throw new Error('Google 订阅连接已断开或设置已更改，请重新连接。');
    },
    async authenticated() { updateLocalConnection({ authDisconnected: false }); },
    async assertGenerationAllowed() {
      await checkPolicy();
      // Re-read disconnection state before every attempted turn. Connecting and
      // discovering models never grants permission to start generation.
      const current = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      if (current.enabled !== true || current.binaryPath !== binary) throw new Error('ANTIGRAVITY_CONNECTION_CHANGED');
      assertAntigravityGenerationAllowed(current);
    },
    disconnected() {
      assertOwner();
      updateLocalConnection({ authDisconnected: true });
      setAntigravityState({ isCurrent: () => activeOwnerScopeKey() === fence, connected: false, models: [] });
    },
    modelsChanged(models, tier) {
      assertOwner();
      const admitted = models.filter(m => isAntigravitySubscriptionModel(m.id));
      setAntigravityState({ isCurrent: () => activeOwnerScopeKey() === fence, connected: true, models: admitted, tier: tier && { ...tier } });
    },
  });
}

/** An optional native engine must never prevent existing engines from starting. */
export function buildAntigravityAgent(...args: Parameters<typeof createAntigravityAgent>): AntigravityAgent | null {
  try { return createAntigravityAgent(...args); }
  catch { setAntigravityState(null); args[1].warn('Antigravity optional engine configuration unavailable', { code: 'ANTIGRAVITY_CONFIG_UNAVAILABLE' }); return null; }
}
