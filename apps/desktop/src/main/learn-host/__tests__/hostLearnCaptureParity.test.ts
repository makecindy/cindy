/**
 * Host vs desktop: the /learn capture dependencies (release table row 18).
 *
 *   Both launchers run the same createCindyLearnInvocationCapture; only the dependencies
 *   differ. The desktop ones are written here exactly as maker-ipc/register.ts passes them
 *   (captureCindyLearnInvocation); the Host ones come from apps/host/src/agent/learn-capture.ts.
 *   On the same profile, published built-in Skills, Skill settings, bot-session table and
 *   Skill listing, every scenario gives the same snapshot (or none), and the Skill listing is
 *   asked with the same arguments. os.homedir() and CLAUDE_CONFIG_DIR point into the fixture.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentKind, ListAgentSkillsResult } from '@cindy/maker-core';

const h = vi.hoisted(() => ({ userData: '', appData: '', home: '' }));
// Both sides fall back to os.homedir() for the Claude configuration directory. Assigning
// process.env.HOME does not reach it in a worker thread (vitest threads pool) or on Windows
// (USERPROFILE), so the module is mocked; a read before the fixture home exists fails.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = () => {
    if (!h.home) throw new Error('homedir read before the fixture home was set');
    return h.home;
  };
  return { ...actual, default: { ...actual, homedir }, homedir };
});
vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'appData' ? h.appData : h.userData), getAppPath: () => h.userData, isPackaged: true },
  safeStorage: { isEncryptionAvailable: () => false },
}));

import { configureAppDataDir, configureUserDataDir } from '../../userDataPath.js';
import { createCindyLearnInvocationCapture } from '../captureInvocation.js';
import { canGrantUnqualifiedClaudeLearnInvocation } from '../invocationGrant.js';
import { builtInSkillDescriptors, prepareBuiltInSkills } from '../../maker-host/built-in-skills.js';
import { isCindySkillEnabled, setCindySkillEnabled } from '../../skillhub/activationPreferences.js';
import { clearCurrentDbClient, setCurrentDbClient } from '../../localDb/client/current.js';
import { app } from 'electron';

// Real temporary workspaces and capture files, for both sides.
// An explicit bound instead of the 5 s / 10 s defaults, wide enough for the loaded full desktop pool.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

type Session = { id: string; instanceId: string; agentKind: AgentKind; workDir: string; remoteHostId: string | null; getStatus?(): 'active' | 'closed' };
type Capture = (session: Session, persisted: unknown, dispatched: string) => Promise<unknown>;

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-learn-capture-parity-')));
const home = path.join(root, 'home');
h.home = home;
const project = path.join(root, 'project');
const sqlite = new Database(':memory:');
const db = { drizzle: drizzle(sqlite) };
const sessions = new Map<string, Session>();
const calls: unknown[] = [];
let listing: (session: { agentKind: AgentKind }) => ListAgentSkillsResult = () => ({ skills: [] });
// The same Maker for both: records how the Skill listing is asked, answers from the fixture.
const maker = {
  getSession: (id: string) => sessions.get(id) ?? null,
  listAgentRuntimeSkills: async (agentKind: AgentKind, opts: unknown) => { calls.push(['runtime', agentKind, opts]); return listing({ agentKind }); },
  listAgentSkills: async (agentKind: AgentKind, opts: unknown) => { calls.push(['agent', agentKind, opts]); return listing({ agentKind }); },
};
let desktop: Capture;
let host: Capture;
const saved = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };

beforeAll(async () => {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(project);
  process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
  h.userData = path.join(root, 'user-data');
  h.appData = path.join(root, 'app-data');
  configureUserDataDir(h.userData);
  configureAppDataDir(h.appData);
  sqlite.exec('CREATE TABLE bot_session_links(id TEXT PRIMARY KEY, session_id TEXT NOT NULL)');
  setCurrentDbClient(db as never, 'parity-owner');
  // maker-ipc/register.ts captureCindyLearnInvocation, verbatim apart from `maker`.
  desktop = createCindyLearnInvocationCapture({
    getSession: (sessionId) => maker.getSession(sessionId),
    builtInSkillDescriptors: () => builtInSkillDescriptors(
      app.getPath('userData'),
      app.getPath('appData'),
    ),
    isSkillEnabled: isCindySkillEnabled,
    canGrantUnqualifiedClaudeInvocation: canGrantUnqualifiedClaudeLearnInvocation,
    listSkills: (session) => session.agentKind === 'claude-code'
      ? maker.listAgentRuntimeSkills(session.agentKind, {
        workingDir: session.workDir,
        sessionId: session.id,
        runtimeConfigDir: process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude'),
      })
      : maker.listAgentSkills(session.agentKind, {
        workingDir: session.workDir,
        sessionId: session.id,
      }),
  }) as Capture;
  // A non-literal specifier keeps the Host sources out of the desktop typecheck.
  const hostModule = '../../../../../host/src/agent/learn-capture.ts';
  const { createHostLearnInvocationCapture } = (await import(/* @vite-ignore */ hostModule)) as {
    createHostLearnInvocationCapture(options: { getMaker(): typeof maker }): Capture;
  };
  host = createHostLearnInvocationCapture({ getMaker: () => maker });
}, 120_000);

afterAll(() => {
  clearCurrentDbClient(db as never);
  for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(root, { recursive: true, force: true });
});

const learnFile = () => {
  const descriptor = builtInSkillDescriptors(h.userData, h.appData).find(d => d.name === 'learn');
  return descriptor ? path.join(descriptor.absolutePath, 'SKILL.md') : null;
};
/** What the Host agents list for the published learn (learn-capture.test.mjs measures it). */
const fixtureListing = (extraUserLearn: boolean) => ({ agentKind }: { agentKind: AgentKind }): ListAgentSkillsResult => {
  const file = learnFile();
  const builtIn = file && agentKind === 'claude-code'
    ? [{ kind: 'agent-skill', name: 'cindy:learn', runtimeCommandName: 'cindy:learn', description: 'learn', source: 'skill', path: file, scope: 'global', enabled: true }]
    : file && agentKind === 'pi'
      ? [{ kind: 'agent-skill', name: 'learn', runtimeCommandName: 'skill:learn', description: 'learn', source: 'skill', path: file, scope: 'global', enabled: true }]
      : [];
  const user = extraUserLearn
    ? [{ kind: 'agent-skill', name: 'learn', description: 'user', source: 'user', path: path.join(home, '.claude', 'skills', 'learn', 'SKILL.md'), scope: 'global', enabled: true }]
    : [];
  return { skills: [...builtIn, ...user] as ListAgentSkillsResult['skills'] };
};

async function both(name: string, session: Session, persisted: string, dispatched = persisted) {
  calls.length = 0;
  const d = await desktop(session, persisted, dispatched);
  const desktopCalls = [...calls];
  calls.length = 0;
  const hst = await host(session, persisted, dispatched);
  expect(hst, name).toEqual(d);
  expect(calls, `${name}: Skill listing arguments`).toEqual(desktopCalls);
  // Every Claude configuration directory either side asked about is inside the fixture.
  for (const [, , opts] of calls as Array<[string, AgentKind, { runtimeConfigDir?: string }]>) {
    if (opts.runtimeConfigDir !== undefined) expect(opts.runtimeConfigDir.startsWith(`${root}${path.sep}`),
      `${name}: root=${root}; file=${opts.runtimeConfigDir}`).toBe(true);
  }
  return d;
}

const s = (id: string, agentKind: AgentKind, extra: Partial<Session> = {}): Session => {
  const value: Session = { id, instanceId: `instance-${id}`, agentKind, workDir: project, remoteHostId: null, getStatus: () => 'active', ...extra };
  sessions.set(id, value);
  return value;
};

describe('the Host /learn capture decides as the desktop one', () => {
  it('before the built-in Skills are published', async () => {
    listing = fixtureListing(false);
    for (const kind of ['claude-code', 'pi', 'codex'] as const) expect(await both(`unpublished ${kind}`, s(`u-${kind}`, kind), '/cindy:learn x')).toBeNull();
  });

  it('for every engine, invocation and condition once they are', async () => {
    await prepareBuiltInSkills({ bundledRoot: path.resolve(__dirname, '../../../../resources/system-skills'), userDataDir: h.userData, appDataDir: h.appData, homeDir: home });
    expect(learnFile()).toBeTruthy();
    listing = fixtureListing(false);
    const granted: unknown[] = [];
    for (const kind of ['claude-code', 'pi', 'codex'] as const) {
      for (const text of ['/cindy:learn how we deploy', '/learn how we deploy', '/skill:learn how we deploy', 'learn how we deploy']) {
        granted.push(await both(`${kind} ${text}`, s(`${kind}-${text}`, kind), text));
      }
      expect(await both(`${kind} mismatch`, s(`${kind}-mismatch`, kind), '/cindy:learn a', '/cindy:learn b')).toBeNull();
      expect(await both(`${kind} remote`, s(`${kind}-remote`, kind, { remoteHostId: 'ssh-fixture' }), '/cindy:learn x')).toBeNull();
      expect(await both(`${kind} closed`, s(`${kind}-closed`, kind, { getStatus: () => 'closed' }), '/cindy:learn x')).toBeNull();
      const replaced = s(`${kind}-replaced`, kind);
      s(`${kind}-replaced`, kind);
      expect(await both(`${kind} replaced`, replaced, '/cindy:learn x')).toBeNull();
    }
    expect(granted.filter(Boolean).length).toBeGreaterThan(0);
    // A bot session.
    sqlite.prepare('INSERT INTO bot_session_links(id, session_id) VALUES (?, ?)').run('link', 'bot-task');
    await both('bot /learn', s('bot-task', 'claude-code'), '/learn x');
    await both('bot /cindy:learn', s('bot-task', 'claude-code'), '/cindy:learn x');
    // Two candidates named learn.
    listing = fixtureListing(true);
    await both('two candidates /learn', s('two', 'claude-code'), '/learn x');
    await both('two candidates /cindy:learn', s('two', 'claude-code'), '/cindy:learn x');
    listing = fixtureListing(false);
    // Disabled in Cindy's Skill settings.
    const descriptor = builtInSkillDescriptors(h.userData, h.appData).find(d => d.name === 'learn')!;
    await setCindySkillEnabled(descriptor.absolutePath, false);
    for (const kind of ['claude-code', 'pi'] as const) expect(await both(`disabled ${kind}`, s(`d-${kind}`, kind), '/cindy:learn x')).toBeNull();
    await setCindySkillEnabled(descriptor.absolutePath, true);
  }, 60_000);

  it('without CLAUDE_CONFIG_DIR, both fall back to the home os.homedir() reports, here the fixture one', async () => {
    const configDir = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    try {
      listing = fixtureListing(false);
      await both('no CLAUDE_CONFIG_DIR', s('no-config-dir', 'claude-code'), '/cindy:learn x');
      expect(calls).toEqual([['runtime', 'claude-code', expect.objectContaining({ runtimeConfigDir: path.join(home, '.claude') })]]);
    } finally {
      process.env.CLAUDE_CONFIG_DIR = configDir;
    }
  });

});
