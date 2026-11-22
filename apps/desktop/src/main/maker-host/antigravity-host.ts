import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { hasProxyEnvConfig } from '@cindy/anthropic-compat-proxy';
import { activeOwnerScopeKey, getActiveAppSession, isAppSessionBoundaryPending, onAppSessionInvalidated } from '../appSessionState.js';
import { AntigravityAgent, antigravityNativeResumeId, isAntigravitySubscriptionModel, probeAntigravityRuntime } from '@cindy/maker-core/agents/antigravity';
import { spawnAcp } from '@cindy/maker-core/agents/antigravity-transport';
import type { AgentDeps } from '@cindy/maker-core';
import { antigravitySubscriptionArgs, assertAntigravityGenerationAllowed, assertAntigravitySubscriptionSettings } from './antigravity-policy.js';
import { ANTIGRAVITY_ACCOUNT_BUSY, type AntigravityAccountsView } from '../../shared/antigravityAccounts.js';
import type { SubscriptionCodexUsageBucket } from '../../shared/subscriptionAccounts.js';
import { readAntigravityToken, createAntigravityUsageReader } from './antigravity-usage.js';
import { outboundFetch } from './outbound-fetch.desktop.js';
import { resolveDesktopOutboundProxy } from './outbound-proxy-resolver.js';
import { ensureCliProxyBridge } from './cli-proxy-bridge.js';
import { antigravityConnected, setAntigravityState } from './antigravity-state.js';

import { assertVerifiedAntigravityBinary, supportsAntigravityRuntime } from './antigravity-runtime.js';
import { watchAntigravityCommandExits } from './antigravity-command-exits.js';
import { clearAntigravityProcessActivity } from './claude-session-background-activity.js';

import { downloadAntigravityRelease, fetchAntigravityRelease, managedAntigravityPlatform } from './antigravity-download.js';

const LEGACY_PROFILE = 'default';
const PROFILE_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const MAX_PROFILES = 32;
type Connection = Record<string, unknown>;

async function resolveAntigravityHttpsProxy(): Promise<string | undefined> {
  if (hasProxyEnvConfig()) return undefined;
  // The CLI uses HTTPS for Google OAuth and generation. Resolve the system
  // route for each CONNECT destination so PAC can route those hosts separately.
  return ensureCliProxyBridge(resolveDesktopOutboundProxy).catch(() => undefined);
}

interface AntigravityAccounts {
  assertOwner(): void;
  assertActiveAccount(id: string): void;
  read(): AntigravityAccountsView;
  configure(binaryPath: string): Promise<AntigravityAccountsView>;
  install(): Promise<AntigravityAccountsView>;
  add(): Promise<AntigravityAccountsView>;
  select(id: string): Promise<AntigravityAccountsView>;
  remove(id: string): Promise<AntigravityAccountsView>;
  usage(): Promise<AntigravityAccountsView>;
}
let currentAccounts: AntigravityAccounts | null = null;
const quotaChangeListeners = new Set<() => void>();
export function onAntigravityQuotaChanged(listener: () => void): () => void {
  quotaChangeListeners.add(listener);
  return () => { quotaChangeListeners.delete(listener); };
}
function notifyAntigravityQuotaChanged(): void {
  for (const listener of [...quotaChangeListeners]) {
    try { listener(); } catch { /* ignore listener failure */ }
  }
}
export function getAntigravityAccounts(): AntigravityAccounts | null {
  return currentAccounts;
}

interface Binding {
  binary: string;
  id: string;
  version: number;
  config: Connection;
}

/** Local opt-in only. Never alters defaults, another engine or a companion profile. */
function createAntigravityAgent(
  userData: string,
  logger: AgentDeps['logger'],
  prepareTools?: (opts: import('@cindy/maker-core').StartSessionOptions) => Promise<{ mcpServers: Array<Record<string, unknown>>; dispose(): void }>,
  closeTaskSessions?: () => Promise<void>,
): AntigravityAgent | null {
  currentAccounts = null;
  setAntigravityState(null);
  if (!supportsAntigravityRuntime()) return null;

  const owner = getActiveAppSession().dataOwnerId;
  const fence = activeOwnerScopeKey();
  const isOwner = () => owner !== null && !isAppSessionBoundaryPending() && activeOwnerScopeKey() === fence;
  const assertOwner = () => { if (!isOwner()) throw new Error('ANTIGRAVITY_OWNER_CHANGED'); };
  const ownerKey = createHash('sha256').update(owner ?? 'local').digest('hex').slice(0, 24);
  const root = path.join(userData, 'google-subscription', ownerKey);
  const configPath = path.join(root, 'connection.json');
  const ownerDirectory = (directory: string, create = false): void => {
    let current = fs.realpathSync(userData);
    for (const component of path.relative(userData, directory).split(path.sep)) {
      current = path.join(current, component);
      try {
        if (!fs.lstatSync(current).isDirectory()) throw new Error('ANTIGRAVITY_PROFILE_PATH_INVALID');
      } catch (error) {
        if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        fs.mkdirSync(current, { mode: 0o700 });
      }
    }
  };
  const readConnection = (): Connection => {
    assertOwner();
    try {
      ownerDirectory(root);
      const fd = fs.openSync(configPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      let value: unknown;
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024) throw new Error('ANTIGRAVITY_CONFIG_INVALID');
        value = JSON.parse(fs.readFileSync(fd, 'utf8'));
      } finally { fs.closeSync(fd); }
      if (typeof value === 'object' && value && !Array.isArray(value)) return value as Connection;
      throw new Error('ANTIGRAVITY_CONFIG_INVALID');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  };
  const writeConnection = (next: Connection): void => {
    assertOwner();
    ownerDirectory(root, true);
    const temporary = `${configPath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, configPath);
    } finally { fs.rmSync(temporary, { force: true }); }
  };

  const profileIds = (config: Connection): string[] => {
    if (config.profiles === undefined) return typeof config.binaryPath === 'string' ? [LEGACY_PROFILE] : [];
    if (!Array.isArray(config.profiles) || config.profiles.length > MAX_PROFILES
      || !config.profiles.every(id => typeof id === 'string' && (id === LEGACY_PROFILE || PROFILE_ID.test(id)))
      || new Set(config.profiles).size !== config.profiles.length) throw new Error('ANTIGRAVITY_CONFIG_INVALID');
    return config.profiles;
  };
  const activeId = (config: Connection): string | null => {
    const ids = profileIds(config);
    if (config.activeProfile === undefined) return ids.includes(LEGACY_PROFILE) ? LEGACY_PROFILE : null;
    if (config.activeProfile === null && ids.length === 0) return null;
    if (typeof config.activeProfile !== 'string' || !ids.includes(config.activeProfile)) throw new Error('ANTIGRAVITY_CONFIG_INVALID');
    return config.activeProfile;
  };
  const disconnected = (config: Connection, id: string): boolean => id === LEGACY_PROFILE
    ? config.authDisconnected === true
    : Array.isArray(config.disconnectedProfiles) && config.disconnectedProfiles.includes(id);
  const setDisconnected = (config: Connection, id: string, value: boolean): Connection => {
    if (id === LEGACY_PROFILE) return { ...config, authDisconnected: value };
    const ids = Array.isArray(config.disconnectedProfiles) ? config.disconnectedProfiles.filter(profile => profile !== id) : [];
    if (value) ids.push(id);
    return { ...config, disconnectedProfiles: ids };
  };
  const profileDirectory = (id: string) => path.join(root, 'profiles', id);
  const geminiHome = (id: string) => path.join(id === LEGACY_PROFILE ? root : profileDirectory(id), '.gemini');
  const tokenPath = (id: string) => path.join(geminiHome(id), 'antigravity-cli', 'antigravity-oauth-token');
  const privateTokenPath = (id: string): string | null => {
    const file = tokenPath(id);
    try {
      ownerDirectory(path.dirname(file));
      return file;
    } catch { return null; }
  };
  const getToken = (id: string) => {
    const file = privateTokenPath(id);
    return file ? readAntigravityToken(file) : null;
  };

  const profileIdentity = (config: Connection, id: string): string | undefined => {
    const identities = config.profileIdentities;
    if (!identities || typeof identities !== 'object' || Array.isArray(identities)) return undefined;
    const saved = (identities as Record<string, unknown>)[id];
    return typeof saved === 'string' ? saved : undefined;
  };
  const identityDigest = (identity: string | undefined) =>
    identity ? createHash('sha256').update(identity.trim().toLowerCase()).digest('hex') : undefined;
  const assertProfileIdentity = (config: Connection, id: string) => {
    const expected = profileIdentity(config, id);
    if (expected && identityDigest(getToken(id)?.identity) !== expected) {
      throw new Error('ANTIGRAVITY_ACCOUNT_IDENTITY_CHANGED');
    }
  };

  let version = 0;
  let changingAccount = false;
  let lastUsage: { id: string; version: number; buckets: SubscriptionCodexUsageBucket[] } | null = null;
  const assertAccountIdle = () => {
    if (changingAccount) throw new Error(ANTIGRAVITY_ACCOUNT_BUSY);
  };
  const transports = new Map<ReturnType<typeof spawnAcp>, string>();
  const getBinding = (): Binding => {
    const config = readConnection();
    const id = activeId(config);
    if (config.enabled !== true || !id || typeof config.binaryPath !== 'string' || !path.isAbsolute(config.binaryPath)) {
      throw new Error('ANTIGRAVITY_BINARY_UNAVAILABLE');
    }
    return { binary: config.binaryPath, id, version, config };
  };
  const isCurrentBinding = (binding: Binding): boolean => {
    if (!isOwner() || binding.version !== version) return false;
    try {
      const current = getBinding();
      return current.binary === binding.binary && current.id === binding.id;
    } catch { return false; }
  };
  const assertCurrentBinding = (binding: Binding): void => {
    if (!isCurrentBinding(binding)) throw new Error('ANTIGRAVITY_CONNECTION_CHANGED');
  };
  const checkPolicy = (binding: Binding): void => {
    assertCurrentBinding(binding);
    const geminiDir = geminiHome(binding.id);
    const settingsPath = path.join(geminiDir, 'antigravity-cli', 'settings.json');
    ownerDirectory(path.dirname(settingsPath), true);
    if (!fs.existsSync(settingsPath)) {
      fs.writeFileSync(settingsPath, JSON.stringify({ useG1Credits: false, modelProvider: '', agentMode: '', toolPermission: 'strict' }), { mode: 0o600, flag: 'wx' });
    }
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    const sharedPath = path.join(geminiDir, 'config', 'config.json');
    let user: Record<string, unknown> = {};
    if (fs.existsSync(sharedPath)) {
      const shared = JSON.parse(fs.readFileSync(sharedPath, 'utf8')) as { userSettings?: Record<string, unknown> };
      user = shared.userSettings ?? {};
    }
    assertAntigravitySubscriptionSettings(settings, user);
  };
  const clearState = () => setAntigravityState({ isCurrent: isOwner, connected: false, models: [] });
  clearState();

  const agent = new AntigravityAgent({
    get binaryPath() {
      const { binary } = getBinding();
      assertVerifiedAntigravityBinary(binary);
      return binary;
    },
    logger, runtimeConfig: {},
    auth: { getState: async () => ({ authenticated: false }), triggerLogin: async () => ({ authenticated: false }), logout: async () => {}, getAuthEnv: async () => ({}) },
  }, {
    async connect(cwd, opts) {
      assertAccountIdle();
      const binding = getBinding();
      const stableSession = opts !== undefined;
      const sessionScope = binding.id === LEGACY_PROFILE ? '' : `antigravity-profile:${binding.id}:`;
      assertVerifiedAntigravityBinary(binding.binary);
      if (stableSession) assertProfileIdentity(binding.config, binding.id);
      checkPolicy(binding);
      const tools = opts && prepareTools ? await prepareTools(opts) : undefined;
      try {
        const httpsProxy = await resolveAntigravityHttpsProxy();
        // MCP and proxy preparation yield. Recheck the owner and profile before spawning.
        assertAccountIdle();
        checkPolicy(binding);
        if (stableSession) assertProfileIdentity(readConnection(), binding.id);
        assertVerifiedAntigravityBinary(binding.binary);
        const transport = spawnAcp(binding.binary, antigravitySubscriptionArgs(geminiHome(binding.id), opts?.permissionMode, !!tools?.mcpServers.length),
          cwd, { profileStorage: binding.id !== LEGACY_PROFILE, httpsProxy });
        let observingLateExit = false;
        const tracked = { ...transport, async close() {
          try {
            await transport.close();
            transports.delete(tracked);
          } catch (error) {
            const { sessionId, sessionInstanceId } = opts ?? {};
            if (!observingLateExit && sessionId && sessionInstanceId && transport.whenExited) {
              observingLateExit = true;
              // Explicit session close can fence the event stream before a late exit.
              void transport.whenExited.then(() => clearAntigravityProcessActivity(sessionId, sessionInstanceId));
            }
            throw error;
          }
        } };
        transports.set(tracked, binding.id);
        void transport.whenExited?.then(() => transports.delete(tracked));
        return {
          sessionScope, isCurrent: () => isCurrentBinding(binding),
          useCachedAuthentication: stableSession && !antigravityNativeResumeId(opts.resumeSessionId, sessionScope) && binding.id !== LEGACY_PROFILE,
          mcpServers: tools?.mcpServers, dispose: tools?.dispose,
          transport: tracked,
          watchCommandExits: (sessionId, onExit) => watchAntigravityCommandExits(geminiHome(binding.id), sessionId, onExit),
          assertSubscriptionOnly: async () => checkPolicy(binding),
          assertGenerationAllowed: async () => {
            assertCurrentBinding(binding);
            const current = readConnection();
            assertProfileIdentity(current, binding.id);
            assertAntigravityGenerationAllowed({ ...current, authDisconnected: disconnected(current, binding.id) });
          },
        };
      } catch (error) { tools?.dispose(); throw error; }
    },
    async assertSessionAllowed() {
      assertAccountIdle();
      const binding = getBinding();
      if (disconnected(binding.config, binding.id)) throw new Error('Google 订阅连接已断开，请先重新连接。');
      assertProfileIdentity(binding.config, binding.id);
    },
    async authenticated() {
      assertAccountIdle();
      const { config, id } = getBinding();
      const token = id === LEGACY_PROFILE ? null : getToken(id);
      if (id !== LEGACY_PROFILE && !token?.accessToken) throw new Error('ANTIGRAVITY_PROFILE_TOKEN_UNAVAILABLE');
      const expected = profileIdentity(config, id);
      const actual = identityDigest(token?.identity);
      if (expected && expected !== actual) throw new Error('ANTIGRAVITY_ACCOUNT_IDENTITY_CHANGED');
      if (actual && !expected) {
        const identities = config.profileIdentities && typeof config.profileIdentities === 'object'
          ? config.profileIdentities
          : {};
        writeConnection(setDisconnected({ ...config, profileIdentities: { ...identities, [id]: actual } }, id, false));
      } else if (disconnected(config, id)) {
        writeConnection(setDisconnected(config, id, false));
      }
    },
    disconnected() {
      assertAccountIdle();
      const { config, id } = getBinding();
      writeConnection(setDisconnected(config, id, true));
      clearState();
    },
    modelsChanged(models, tier, capabilities) {
      assertOwner();
      const admitted = models.filter(m => isAntigravitySubscriptionModel(m.id));
      setAntigravityState({
        isCurrent: isOwner,
        connected: true,
        models: admitted,
        tier: tier && { ...tier },
        ...(capabilities?.supportsImageInput !== undefined ? { supportsImageInput: capabilities.supportsImageInput } : {}),
      });
      notifyAntigravityQuotaChanged();
      void currentAccounts?.usage().catch(() => undefined);
    },
  });

  const read = (): AntigravityAccountsView => {
    const config = readConnection();
    const active = activeId(config);
    let configured = false;
    if (config.enabled === true && typeof config.binaryPath === 'string' && path.isAbsolute(config.binaryPath)) {
      try { assertVerifiedAntigravityBinary(config.binaryPath); configured = true; } catch { /* Offer manual configuration. */ }
    }
    const connected = configured && active !== null && !disconnected(config, active) && antigravityConnected();
    const cachedUsage = connected && active !== null && lastUsage && lastUsage.id === active && lastUsage.version === version
      ? lastUsage.buckets
      : undefined;
    return {
      configured,
      connected,
      activeId: active,
      accounts: profileIds(config).map(id => {
        const identity = id === LEGACY_PROFILE ? undefined : getToken(id)?.identity?.trim();
        const expected = profileIdentity(config, id);
        return { id, identity: !expected || identityDigest(identity) === expected ? identity : undefined };
      }),
      ...(cachedUsage !== undefined ? { usage: cachedUsage } : {}),
    };
  };
  const quotaReads = new Set<AbortController>();
  const changeBinding = (next: Connection) => {
    writeConnection(next);
    for (const request of quotaReads) request.abort();
    lastUsage = null;
    version += 1;
    agent.resetConnection();
    clearState();
    notifyAntigravityQuotaChanged();
  };
  const mutate = async (run: () => Promise<void>) => {
    assertOwner();
    assertAccountIdle();
    changingAccount = true;
    try { await run(); } finally { changingAccount = false; }
  };
  const quiesce = async (id: string | null, active: boolean) => {
    if (!id) return;
    // Maker retires task handles with its normal lifecycle so queued messages
    // and project resources stay attached to the Cindy task.
    if (active) await closeTaskSessions?.();
    assertOwner();
    await Promise.all([...transports].filter(([, profile]) => profile === id).map(([transport]) => transport.close()));
    assertOwner();
  };
  const refreshSelection = async () => {
    const view = read();
    if (!view.configured || !view.activeId) return view;
    const selected = getBinding();
    await agent.getAuthState();
    assertCurrentBinding(selected);
    return read();
  };
  const emptyProfile = (config: Connection, id: string): boolean => {
    if (id === LEGACY_PROFILE || !disconnected(config, id) || profileIdentity(config, id)) return false;
    try {
      ownerDirectory(path.dirname(tokenPath(id)));
      fs.lstatSync(tokenPath(id));
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
  };
  const removeProfileDirectory = async (id: string, config: Connection, commit: () => void) => {
    if (id === LEGACY_PROFILE) { commit(); return; }
    const directory = profileDirectory(id);
    try { ownerDirectory(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      commit();
      return;
    }
    if (typeof config.binaryPath === 'string') {
      let binary = config.binaryPath;
      try { binary = fs.realpathSync(binary); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const relative = path.relative(fs.realpathSync(directory), binary);
      if (relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))) {
        throw new Error('ANTIGRAVITY_RUNTIME_INSIDE_PROFILE');
      }
    }
    const temporary = `${directory}.removing-${randomUUID()}`;
    fs.renameSync(directory, temporary);
    try { commit(); }
    catch (error) { fs.renameSync(temporary, directory); throw error; }
    await fs.promises.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  const configureRuntime = async (binaryPath: string, managedRelease?: string): Promise<void> => {
    const binary = fs.realpathSync(binaryPath);
    const fingerprint = assertVerifiedAntigravityBinary(binary);
    const assertSameBinary = () => {
      if (assertVerifiedAntigravityBinary(binary) !== fingerprint) throw new Error('ANTIGRAVITY_RUNTIME_CHANGED');
    };
    const probeDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-agy-probe-'));
    try {
      const httpsProxy = await resolveAntigravityHttpsProxy();
      assertOwner();
      assertSameBinary();
      await probeAntigravityRuntime(spawnAcp(binary, antigravitySubscriptionArgs(probeDir), probeDir, {
        isolatedHome: probeDir,
        profileStorage: true,
        httpsProxy,
      }), probeDir);
    } finally {
      await fs.promises.rm(probeDir, { recursive: true, force: true });
    }
    assertSameBinary();
    const config = readConnection();
    const previous = activeId(config);
    await quiesce(previous, true);
    assertSameBinary();
    const id = previous ?? randomUUID();
    const profiles = profileIds(config);
    changeBinding({
      ...config, binaryPath: binary, enabled: true, activeProfile: id, managedRelease,
      managedFingerprint: managedRelease ? fingerprint : undefined,
      // Legacy configurations retain their explicit generation choice.
      generationMode: config.generationMode ?? (profiles.length === 0 ? 'subscription-only' : undefined),
      profiles: profiles.includes(id) ? profiles : [...profiles, id],
      ...(profiles.length === 0 ? { disconnectedProfiles: [id] } : {}),
    });
  };
  const readUsage = createAntigravityUsageReader(outboundFetch);
  currentAccounts = {
    read, assertOwner,
    assertActiveAccount(id) {
      if (getBinding().id !== id) throw new Error('ANTIGRAVITY_CONNECTION_CHANGED');
    },
    async configure(binaryPath) {
      await mutate(() => configureRuntime(binaryPath));
      return refreshSelection();
    },
    async install() {
      await mutate(async () => {
        const controller = new AbortController();
        const unsubscribe = onAppSessionInvalidated(() => controller.abort());
        let stage: string | undefined;
        let activated = false;
        try {
          const platform = managedAntigravityPlatform();
          const release = await fetchAntigravityRelease(outboundFetch, platform, controller.signal);
          assertOwner();
          const config = readConnection();
          const managedRoot = path.join(root, 'managed-runtimes', 'antigravity');
          let verifiedExisting: string | undefined;
          if (config.enabled === true && config.managedRelease === release.sha512 && typeof config.binaryPath === 'string') {
            try {
              ownerDirectory(managedRoot);
              const managedPath = fs.realpathSync(managedRoot);
              if (path.dirname(path.dirname(config.binaryPath)) === managedPath) {
                ownerDirectory(path.dirname(config.binaryPath));
                if (assertVerifiedAntigravityBinary(config.binaryPath) === config.managedFingerprint) verifiedExisting = config.binaryPath;
              }
            } catch { /* Repair a missing or changed managed executable. */ }
          }
          if (verifiedExisting) {
            if (!activeId(config)) await configureRuntime(verifiedExisting, release.sha512);
            return;
          }
          ownerDirectory(managedRoot, true);
          stage = await fs.promises.mkdtemp(path.join(managedRoot, release.version + '-' + platform + '-'));
          const binary = await downloadAntigravityRelease(outboundFetch, release, platform, stage, controller.signal);
          assertOwner();
          ownerDirectory(stage);
          await configureRuntime(binary, release.sha512);
          activated = true;
        } finally {
          unsubscribe();
          if (stage && !activated) await fs.promises.rm(stage, { recursive: true, force: true });
        }
      });
      return refreshSelection();
    },
    async add() {
      await mutate(async () => {
        const config = readConnection();
        if (config.enabled !== true || typeof config.binaryPath !== 'string' || !path.isAbsolute(config.binaryPath)) {
          throw new Error('ANTIGRAVITY_BINARY_UNAVAILABLE');
        }
        const current = activeId(config);
        const profiles = profileIds(config);
        if (current && emptyProfile(config, current)) return;
        const available = profiles.find(id => emptyProfile(config, id));
        if (!available && profiles.length >= MAX_PROFILES) throw new Error('ANTIGRAVITY_ACCOUNT_LIMIT');
        const id = available ?? randomUUID();
        if (current) await quiesce(current, true);
        changeBinding(setDisconnected({ ...config, profiles: available ? profiles : [...profiles, id], activeProfile: id }, id, true));
      });
      return read();
    },
    async select(id) {
      await mutate(async () => {
        const { config, id: current } = getBinding();
        if (!profileIds(config).includes(id)) throw new Error('ANTIGRAVITY_ACCOUNT_UNKNOWN');
        if (current === id) return;
        await quiesce(current, true);
        changeBinding({ ...config, activeProfile: id });
      });
      return refreshSelection();
    },
    async remove(id) {
      let wasActive = false;
      await mutate(async () => {
        const config = readConnection();
        const current = activeId(config);
        const profiles = profileIds(config);
        if (!profiles.includes(id)) throw new Error('ANTIGRAVITY_ACCOUNT_UNKNOWN');
        wasActive = id === current;
        await quiesce(id, wasActive);
        const remaining = profiles.filter(profile => profile !== id);
        const fallback = remaining.find(profile => !disconnected(config, profile) &&
          (profile === LEGACY_PROFILE || !!getToken(profile)?.accessToken)) ?? remaining[0] ?? null;
        const next = setDisconnected({
          ...config, profiles: remaining, activeProfile: (wasActive ? fallback : current) ?? null,
        }, id, id === LEGACY_PROFILE);
        if (next.profileIdentities && typeof next.profileIdentities === 'object' && !Array.isArray(next.profileIdentities)) {
          const identities = { ...next.profileIdentities } as Record<string, unknown>;
          delete identities[id];
          next.profileIdentities = identities;
        }
        await removeProfileDirectory(id, config, () => {
          if (wasActive) changeBinding(next);
          else {
            writeConnection(next);
            notifyAntigravityQuotaChanged();
          }
        });
      });
      return wasActive ? refreshSelection() : read();
    },
    async usage() {
      if (!activeId(readConnection())) return { ...read(), usage: [] };
      const binding = getBinding();
      const { id, config } = binding;
      // The legacy CLI reads its own OS Keychain entry. Quota requests use only
      // the CLI-owned file belonging to the selected owner-local profile.
      const token = privateTokenPath(id);
      if (!token || id === LEGACY_PROFILE || disconnected(config, id)) {
        lastUsage = null;
        return { ...read(), usage: [] };
      }
      const request = new AbortController();
      quotaReads.add(request);
      const release = onAppSessionInvalidated(() => request.abort());
      try {
        const usage = await readUsage(token, binding.version, request.signal, () => {
          assertCurrentBinding(binding);
          const current = readConnection();
          if (disconnected(current, id)) throw new Error('ANTIGRAVITY_CONNECTION_CHANGED');
          assertProfileIdentity(current, id);
        });
        const previous = lastUsage && lastUsage.id === id && lastUsage.version === binding.version ? lastUsage.buckets : null;
        lastUsage = { id, version: binding.version, buckets: usage };
        if (JSON.stringify(previous) !== JSON.stringify(usage)) notifyAntigravityQuotaChanged();
        return { ...read(), usage };
      } finally {
        release();
        quotaReads.delete(request);
      }
    },
  };
  return agent;
}

/** An optional native engine must never prevent existing engines from starting. */
export function buildAntigravityAgent(...args: Parameters<typeof createAntigravityAgent>): AntigravityAgent | null {
  try { return createAntigravityAgent(...args); }
  catch { setAntigravityState(null); args[1].warn('Antigravity optional engine configuration unavailable', { code: 'ANTIGRAVITY_CONFIG_UNAVAILABLE' }); return null; }
}
