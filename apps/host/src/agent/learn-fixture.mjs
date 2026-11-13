// Test fixture for the /learn capture: a temporary profile with the bundled built-in Skills
// published, Cindy's Skill settings, the Host agents for Skill listing (never spawned), and
// session objects. HOME and CLAUDE_CONFIG_DIR point into the fixture.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import { configureHostOwner } from './claude-auth.mjs';
import { createHostAgentGraph } from './runtime.ts';
import { createHostMcpRuntime } from './mcp-runtime.ts';
import { createHostLearnInvocationCapture } from './learn-capture.ts';
import { configureAppDataDir } from '../../../desktop/src/main/userDataPath.ts';
import { prepareBuiltInSkills, builtInSkillDescriptors } from '../../../desktop/src/main/maker-host/built-in-skills.ts';
import { createManagedSkills } from '../../../desktop/src/main/maker-host/managedSkillsCore.ts';
import { setCurrentDbClient, clearCurrentDbClient } from '../../../desktop/src/main/localDb/client/current.ts';

export const BUNDLED = fileURLToPath(new URL('../../../desktop/resources/system-skills', import.meta.url));

export async function learnFixture(t, { publish = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-learn-capture-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  t.after(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  process.env.HOME = process.env.USERPROFILE = home;
  process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
  const profile = path.join(root, 'profile');
  const appData = path.join(root, 'app-data');
  const project = path.join(root, 'project');
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(project);
  configureHostOwner({ userDataDir: profile, ownerId: 'learn-capture-owner' });
  t.after(() => configureHostOwner({ userDataDir: profile, ownerId: null }));
  configureAppDataDir(appData);
  if (publish) await prepareBuiltInSkills({ bundledRoot: BUNDLED, userDataDir: profile, appDataDir: appData, homeDir: home });
  // Only the table the bot-session check reads.
  const sqlite = new Database(':memory:');
  sqlite.exec('CREATE TABLE bot_session_links(id TEXT PRIMARY KEY, session_id TEXT NOT NULL)');
  const db = { drizzle: drizzle(sqlite) };
  setCurrentDbClient(db, 'learn-capture-owner');
  t.after(() => clearCurrentDbClient(db));
  const catalog = createManagedSkills({ listAvailableGhosts: async () => [],
    getGhostManager: () => ({ verifyApprovedSkillSnapshot: async () => false }),
    loadGhostFirstPartyFactsForGhost: () => ({ kind: 'missing' }) });
  const harnessRoot = path.join(profile, 'harnesses');
  const rgDir = path.join(harnessRoot, 'ripgrep-bin', `${process.platform}-${process.arch}`);
  fs.mkdirSync(rgDir, { recursive: true });
  fs.writeFileSync(path.join(rgDir, process.platform === 'win32' ? 'rg.exe' : 'rg'), '');
  const sessions = new Map();
  const mcp = createHostMcpRuntime({ appServerIds: () => [], getRemoteMcpBridgeToken: () => null });
  t.after(() => mcp.close());
  // Never spawned: only the agents' Skill listing is used.
  const graph = createHostAgentGraph({ userDataDir: profile, harnessRoot, gateway: null,
    getManagedSkills: () => catalog.listCindyManagedSkills(),
    binaryPath: path.join(root, 'claude'), codexBinaryPath: path.join(root, 'codex'), piBinaryPath: path.join(root, 'pi'),
    mcpRuntime: mcp, mcpProviders: [],
    // The task rows the Skill listing reads (maker.listAgentSkills): kind, not review, local.
    storage: { get: async id => (sessions.has(id) ? { id, agentKind: sessions.get(id).agentKind, reviewMode: false, remoteHostId: null } : null) },
    providerConfig: {
      grok: { hasGrokOAuthLogin: () => false, grokAccountIdentity: () => null },
      list: async () => [], readKey: () => null,
      oauth: { readCachedGenericOAuthAccessToken: () => null },
      codexAccounts: { setCodexAccountRetirement: () => {}, isCodexAccountProvider: () => false, codexAccountState: () => ({ authenticated: false }) },
    } });
  t.after(() => graph.maker.shutdown?.());
  const maker = {
    getSession: id => sessions.get(id) ?? null,
    listAgentRuntimeSkills: (...args) => graph.maker.listAgentRuntimeSkills(...args),
    listAgentSkills: (...args) => graph.maker.listAgentSkills(...args),
  };
  const session = (id, agentKind, extra = {}) => {
    const value = { id, instanceId: `instance-${id}`, agentKind, workDir: project, remoteHostId: null, getStatus: () => 'active', ...extra };
    sessions.set(id, value);
    return value;
  };
  return { root, home, profile, appData, project, sqlite, sessions, maker, session, graph,
    capture: createHostLearnInvocationCapture({ getMaker: () => maker }) };
}

export const learnDescriptor = (f) => builtInSkillDescriptors(f.profile, f.appData).find(d => d.name === 'learn');
export const inside = (root, file) => fs.realpathSync(file).startsWith(`${root}${path.sep}`);

