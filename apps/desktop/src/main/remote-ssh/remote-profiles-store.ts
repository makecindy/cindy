/**
 * Cindy-local remote hosts.
 *
 * These profiles are deliberately independent from OpenSSH configuration:
 * adding/editing/removing one never writes ~/.ssh/config or an Include file.
 * Connection fields and Cindy-only preferences share one versioned, atomic,
 * mode-0600 document under Electron userData.
 */

import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AuthMethod, HostConfig } from '@cindy/maker-remote-ssh';
import { cindyHostRef } from '@cindy/maker-remote-ssh';
import {
  LEGACY_AGENT_PROXY_REMOTE_PORT,
  normalizeAgentProxyUrl,
  type SshHostAgentProxyPref,
} from '../../shared/agentProxyConfig.js';

import { createLogger } from '../logger.js';

const log = createLogger('remote-profiles-store');
const SCHEMA_VERSION = 1 as const;

export interface RemoteProfile {
  profileId: string;
  displayName: string;
  hostname: string;
  port: number;
  user: string;
  authMethod: AuthMethod;
  identityFile?: string;
  autoConnect: boolean;
  agentProxy?: SshHostAgentProxyPref;
}

interface RemoteProfilesFile {
  schemaVersion: typeof SCHEMA_VERSION;
  profiles: RemoteProfile[];
}

export interface RemoteProfileDiagnostic {
  path: string;
  kind: 'io' | 'syntax' | 'schema';
  message: string;
  recoveryHint: string;
}

export interface RemoteProfilesReadResult {
  profiles: RemoteProfile[];
  error: RemoteProfileDiagnostic | null;
}

let cached: RemoteProfile[] | null = null;
let lastError: RemoteProfileDiagnostic | null = null;

function storePath(): string {
  return path.join(app.getPath('userData'), 'remote-profiles.json');
}

function validPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function normalizeProfileAgentProxy(
  value: unknown,
): SshHostAgentProxyPref | undefined | null {
  if (value == null) return undefined;
  if (typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.enabled !== true) return undefined;
  if (v.mode === 'env') {
    const proxyUrl = normalizeAgentProxyUrl(v.proxyUrl);
    return proxyUrl ? { enabled: true, mode: 'env', proxyUrl } : null;
  }
  if (v.mode !== undefined && v.mode !== 'tunnel') return null;
  const localHost = typeof v.localHost === 'string' ? v.localHost.trim() : '';
  const localPort = v.localPort;
  const remotePort = v.remotePort ?? LEGACY_AGENT_PROXY_REMOTE_PORT;
  if (
    !localHost
    || /\s/.test(localHost)
    || localHost.includes("'")
    || localHost.includes('"')
    || !validPort(localPort)
    || !validPort(remotePort)
    || remotePort < 1024
  ) return null;
  return { enabled: true, mode: 'tunnel', localHost, localPort, remotePort };
}

function normalizeProfile(value: unknown): RemoteProfile | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.profileId !== 'string' || !v.profileId.trim()
    || typeof v.displayName !== 'string' || !v.displayName.trim()
    || typeof v.hostname !== 'string' || !v.hostname.trim()
    || typeof v.user !== 'string' || !v.user.trim()
    || !validPort(v.port)
    || (v.authMethod !== 'agent' && v.authMethod !== 'key')
  ) return null;
  if (v.authMethod === 'key' && (typeof v.identityFile !== 'string' || !v.identityFile.trim())) {
    return null;
  }
  const agentProxy = normalizeProfileAgentProxy(v.agentProxy);
  if (agentProxy === null) return null;
  return {
    profileId: v.profileId,
    displayName: v.displayName,
    hostname: v.hostname,
    port: v.port,
    user: v.user,
    authMethod: v.authMethod,
    ...(typeof v.identityFile === 'string' && v.identityFile.trim()
      ? { identityFile: v.identityFile }
      : {}),
    autoConnect: v.autoConnect === true,
    ...(agentProxy ? { agentProxy } : {}),
  };
}

export function readRemoteProfiles(): RemoteProfilesReadResult {
  const file = storePath();
  try {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        cached = [];
        lastError = null;
        return { profiles: [], error: null };
      }
      throw err;
    }
    const parsed = JSON.parse(raw) as Partial<RemoteProfilesFile>;
    if (parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.profiles)) {
      throw Object.assign(new Error('unsupported remote-profiles.json schema'), { code: 'SCHEMA' });
    }
    const normalized = parsed.profiles.map(normalizeProfile);
    if (normalized.some((profile) => profile === null)) {
      throw Object.assign(new Error('remote-profiles.json contains an invalid profile'), { code: 'SCHEMA' });
    }
    const profiles = normalized as RemoteProfile[];
    const ids = new Set<string>();
    for (const profile of profiles) {
      if (ids.has(profile.profileId)) {
        throw Object.assign(new Error(`duplicate profileId: ${profile.profileId}`), { code: 'SCHEMA' });
      }
      ids.add(profile.profileId);
    }
    cached = profiles;
    lastError = null;
    return { profiles: [...profiles], error: null };
  } catch (err) {
    const code = (err as { code?: string }).code;
    lastError = {
      path: file,
      kind: code === 'SCHEMA' ? 'schema' : err instanceof SyntaxError ? 'syntax' : 'io',
      message: err instanceof Error ? err.message : String(err),
      recoveryHint: 'Fix or restore remote-profiles.json, then refresh. Cindy kept the last valid local host list.',
    };
    log.warn('remote profiles read failed; keeping last valid snapshot', {
      path: file,
      error: lastError.message,
    });
    return { profiles: [...(cached ?? [])], error: lastError };
  }
}

function writeProfiles(profiles: RemoteProfile[]): void {
  const file = storePath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const payload: RemoteProfilesFile = { schemaVersion: SCHEMA_VERSION, profiles };
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* best effort on Windows */ }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* rename succeeded or cleanup best effort */ }
  }
  cached = profiles;
  lastError = null;
}

function readProfilesForMutation(): RemoteProfile[] {
  const result = readRemoteProfiles();
  if (result.error) {
    const error = new Error(
      `remote profiles are unreadable; refusing to overwrite user data: ${result.error.message}`,
    );
    (error as { code?: string }).code = 'REMOTE_PROFILES_UNREADABLE';
    throw error;
  }
  return result.profiles;
}

export function addRemoteProfile(
  input: Omit<RemoteProfile, 'profileId'> & { profileId?: string },
): RemoteProfile {
  const current = readProfilesForMutation();
  const profile: RemoteProfile = { ...input, profileId: input.profileId ?? randomUUID() };
  if (current.some((item) => item.profileId === profile.profileId)) {
    throw new Error(`profile already exists: ${profile.profileId}`);
  }
  writeProfiles([...current, profile]);
  return profile;
}

export function updateRemoteProfile(profile: RemoteProfile): RemoteProfile {
  const current = readProfilesForMutation();
  const index = current.findIndex((item) => item.profileId === profile.profileId);
  if (index < 0) throw new Error(`profile not found: ${profile.profileId}`);
  const next = [...current];
  next[index] = profile;
  writeProfiles(next);
  return profile;
}

export function removeRemoteProfile(profileId: string): void {
  const current = readProfilesForMutation();
  const next = current.filter((item) => item.profileId !== profileId);
  if (next.length === current.length) throw new Error(`profile not found: ${profileId}`);
  writeProfiles(next);
}

export function remoteProfileToHostConfig(profile: RemoteProfile): HostConfig {
  const identityFile = profile.identityFile
    ? (() => {
        const expanded = profile.identityFile === '~'
          ? os.homedir()
          : profile.identityFile.startsWith('~/') || profile.identityFile.startsWith('~\\')
            ? path.join(os.homedir(), profile.identityFile.slice(2))
            : profile.identityFile;
        return path.isAbsolute(expanded)
          ? expanded
          : path.resolve(os.homedir(), '.ssh', expanded);
      })()
    : undefined;
  return {
    id: cindyHostRef(profile.profileId),
    displayName: profile.displayName,
    hostname: profile.hostname,
    port: profile.port,
    user: profile.user,
    authMethod: profile.authMethod,
    identityFile,
    source: 'manual',
    editable: true,
    deletable: true,
  };
}

export function getRemoteProfilesError(): RemoteProfileDiagnostic | null {
  return lastError;
}

export function __resetRemoteProfilesForTests(): void {
  cached = null;
  lastError = null;
}
