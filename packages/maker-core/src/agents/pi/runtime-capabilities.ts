import fsp from 'node:fs/promises';
import path from 'node:path';

import { scanPiRuntimeUserSkillSources } from './customization-scanner.js';
import type { PiRpcResponse } from './rpc-client.js';
import type {
  PiRuntimeCapabilityError,
  PiRuntimeCapabilityErrorStage,
  PiRuntimeCapabilityManifest,
  PiRuntimeCommand,
  PiRuntimeCommandSourceInfo,
} from '../../types/pi-runtime-capabilities.js';

const MAX_RESPONSE_BYTES = 256_000;
const MAX_COMMANDS = 4_096;
const MAX_NAME_LENGTH = 256;
const MAX_DESCRIPTION_LENGTH = 4_096;
const MAX_SOURCE_LENGTH = 128;
const MAX_SOURCE_INFO_VALUE_LENGTH = 4_096;
const MAX_ERROR_MESSAGE_LENGTH = 160;
export const PI_RUNTIME_CAPABILITY_TIMEOUT_MS = 5_000;
const PI_RPC_RESPONSE_KEYS = new Set(['type', 'id', 'command', 'success', 'data', 'error']);
const PI_RUNTIME_USER_SKILL_CANONICAL_SOURCE = Symbol.for(
  'cindy.pi.runtime-user-skill-canonical-source',
);

interface PiRuntimeCapabilityCaptureOptions {
  /** Local roots Cindy permits Pi to report as auto-loaded user Skill homes. */
  readonly userSkillBaseDirs?: readonly string[];
}

type RuntimeCommandParseResult =
  | { ok: true; commands: PiRuntimeCommand[] }
  | { ok: false };

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) return undefined;
  return value;
}

async function awaitRuntimeCapabilityStep<T>(
  operation: () => Promise<T>,
  deadlineAtMs: number,
): Promise<T> {
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) throw new Error('Pi runtime capability provenance capture timed out');
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Pi runtime capability provenance capture timed out')),
          remainingMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function stableCanonicalUserSkillSource(
  entryPath: string,
  deadlineAtMs: number,
): Promise<string | null> {
  try {
    const [entryBefore, canonicalBefore] = await Promise.all([
      awaitRuntimeCapabilityStep(() => fsp.lstat(entryPath, { bigint: true }), deadlineAtMs),
      awaitRuntimeCapabilityStep(() => fsp.realpath(entryPath), deadlineAtMs),
    ]);
    const [entryAfter, canonicalAfter, targetAfter] = await Promise.all([
      awaitRuntimeCapabilityStep(() => fsp.lstat(entryPath, { bigint: true }), deadlineAtMs),
      awaitRuntimeCapabilityStep(() => fsp.realpath(entryPath), deadlineAtMs),
      awaitRuntimeCapabilityStep(() => fsp.stat(entryPath, { bigint: true }), deadlineAtMs),
    ]);
    if (
      (!entryBefore.isDirectory() && !entryBefore.isSymbolicLink())
      || !targetAfter.isDirectory()
      || entryBefore.dev === 0n
      || entryBefore.ino === 0n
      || entryBefore.dev !== entryAfter.dev
      || entryBefore.ino !== entryAfter.ino
      || entryBefore.mode !== entryAfter.mode
      || canonicalBefore !== canonicalAfter
      || !path.isAbsolute(canonicalBefore)
      || canonicalBefore.includes('\0')
    ) return null;
    return canonicalBefore;
  } catch {
    return null;
  }
}

async function capturePathlessUserSkillSources(
  commands: readonly PiRuntimeCommand[],
  options: PiRuntimeCapabilityCaptureOptions,
  deadlineAtMs: number,
): Promise<void> {
  if (!options.userSkillBaseDirs?.length) return;
  const pathlessCommands = commands.filter((command) => (
    command.source === 'skill'
    && command.sourceInfo.scope === 'user'
    && command.sourceInfo.source === 'auto'
    && command.sourceInfo.path === undefined
  ));
  if (pathlessCommands.length === 0) return;
  const allowedBaseDirs = new Set<string>();
  for (const rawBaseDir of options.userSkillBaseDirs) {
    if (!path.isAbsolute(rawBaseDir) || rawBaseDir.includes('\0')) continue;
    try {
      allowedBaseDirs.add(await awaitRuntimeCapabilityStep(
        () => fsp.realpath(path.resolve(rawBaseDir)),
        deadlineAtMs,
      ));
    } catch {
      // A missing or blocked host-owned root cannot prove runtime provenance.
    }
  }

  const candidatesByCommand = new Map<string, Awaited<
    ReturnType<typeof scanPiRuntimeUserSkillSources>
  >>();
  const candidates = await scanPiRuntimeUserSkillSources(
    [...allowedBaseDirs],
    deadlineAtMs,
  );
  for (const candidate of candidates) {
    const key = [candidate.baseDir, candidate.runtimeCommandName].join('\0');
    const matches = candidatesByCommand.get(key);
    if (matches) matches.push(candidate);
    else candidatesByCommand.set(key, [candidate]);
  }

  for (const command of pathlessCommands) {
    const rawBaseDir = command.sourceInfo.baseDir;
    if (
      !/^skill:[^\s/\\\0]+$/.test(command.name)
      || typeof rawBaseDir !== 'string'
      || !path.isAbsolute(rawBaseDir)
      || rawBaseDir.includes('\0')
    ) continue;
    try {
      const canonicalBaseDir = await awaitRuntimeCapabilityStep(
        () => fsp.realpath(path.resolve(rawBaseDir)),
        deadlineAtMs,
      );
      if (!allowedBaseDirs.has(canonicalBaseDir)) continue;
      const matches = candidatesByCommand.get(
        [canonicalBaseDir, command.name].join('\0'),
      );
      if (matches?.length !== 1) continue;
      const candidate = matches[0]!;
      const canonicalSource = await stableCanonicalUserSkillSource(
        candidate.sourcePath,
        deadlineAtMs,
      );
      if (!canonicalSource || canonicalSource !== candidate.canonicalSourcePath) continue;
      Object.defineProperty(command, PI_RUNTIME_USER_SKILL_CANONICAL_SOURCE, {
        value: canonicalSource,
        enumerable: false,
        configurable: false,
        writable: false,
      });
    } catch {
      // Keep the command visible for diagnostics; final invocation fails closed.
    }
  }
}

function parseSourceInfo(value: unknown): PiRuntimeCommandSourceInfo | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !['path', 'scope', 'baseDir', 'source', 'origin'].includes(key))) return undefined;
  for (const key of ['path', 'scope', 'baseDir', 'source', 'origin'] as const) {
    if (Object.hasOwn(raw, key) && !boundedString(raw[key], MAX_SOURCE_INFO_VALUE_LENGTH)) {
      return undefined;
    }
  }
  const path = boundedString(raw.path, MAX_SOURCE_INFO_VALUE_LENGTH);
  const scope = boundedString(raw.scope, MAX_SOURCE_INFO_VALUE_LENGTH);
  const baseDir = boundedString(raw.baseDir, MAX_SOURCE_INFO_VALUE_LENGTH);
  const source = boundedString(raw.source, MAX_SOURCE_INFO_VALUE_LENGTH);
  const origin = boundedString(raw.origin, MAX_SOURCE_INFO_VALUE_LENGTH);
  // A sourceInfo object with no recognized provenance is not trustworthy enough
  // to mark the command catalog loaded.
  if (!path && !scope && !baseDir && !source) return undefined;
  return {
    ...(path ? { path } : {}),
    ...(scope ? { scope } : {}),
    ...(baseDir ? { baseDir } : {}),
    ...(source ? { source } : {}),
    ...(origin ? { origin } : {}),
  };
}

/** Conservative parser for Pi's get_commands `data.commands` payload. */
export function parsePiRuntimeCommands(data: unknown): RuntimeCommandParseResult {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return { ok: false };
  const rawData = data as Record<string, unknown>;
  if (Object.keys(rawData).some((key) => key !== 'commands')) return { ok: false };
  const commands = rawData.commands;
  if (!Array.isArray(commands) || commands.length > MAX_COMMANDS) return { ok: false };

  let serializedLength = 0;
  try {
    const serialized = JSON.stringify(data);
    if (typeof serialized !== 'string') return { ok: false };
    serializedLength = Buffer.byteLength(serialized, 'utf8');
  } catch {
    return { ok: false };
  }
  if (serializedLength > MAX_RESPONSE_BYTES) return { ok: false };

  const seen = new Set<string>();
  const parsed: PiRuntimeCommand[] = [];
  for (const value of commands) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false };
    const raw = value as Record<string, unknown>;
    if (Object.keys(raw).some((key) => !['name', 'description', 'source', 'sourceInfo'].includes(key))) {
      return { ok: false };
    }
    const name = boundedString(raw.name, MAX_NAME_LENGTH);
    const source = boundedString(raw.source, MAX_SOURCE_LENGTH);
    const sourceInfo = parseSourceInfo(raw.sourceInfo);
    if (!name || !source || !sourceInfo || seen.has(name)) return { ok: false };
    const description = raw.description === undefined
      ? undefined
      : boundedString(raw.description, MAX_DESCRIPTION_LENGTH);
    if (raw.description !== undefined && !description) return { ok: false };
    seen.add(name);
    parsed.push({
      name,
      ...(description ? { description } : {}),
      source,
      sourceInfo,
    });
  }
  return { ok: true, commands: parsed };
}

function classifyExplicitRpcFailure(raw: string): Pick<PiRuntimeCapabilityError, 'code' | 'message'> {
  const text = raw.toLowerCase();
  if (text.includes('unknown command') || text.includes('unsupported') || text.includes('not supported')) {
    return { code: 'unsupported', message: 'Pi does not support runtime command discovery' };
  }
  return { code: 'rpc_failed', message: 'Pi runtime command discovery was rejected' };
}

function classifyTransportFailure(raw: string): Pick<PiRuntimeCapabilityError, 'code' | 'message'> {
  const text = raw.toLowerCase();
  if (text.startsWith('pi rpc timeout after ')) {
    return { code: 'timeout', message: 'Pi runtime command discovery timed out' };
  }
  if (
    text.startsWith('pi process already exited')
    || text.startsWith('pi process exited (')
    || text.startsWith('pi process error:')
    || text.startsWith('pi rpc write failed:')
  ) {
    return { code: 'process_unavailable', message: 'Pi process was unavailable for runtime command discovery' };
  }
  return { code: 'rpc_failed', message: 'Pi runtime command discovery was rejected' };
}

function statusForFailureCode(code: PiRuntimeCapabilityError['code']): 'unknown' | 'failed' {
  return code === 'unsupported' || code === 'timeout' || code === 'process_unavailable'
    ? 'unknown'
    : 'failed';
}

function errorManifest(
  identity: { sessionId?: string; sdkSessionId?: string },
  generation: number,
  stage: PiRuntimeCapabilityErrorStage,
  failure: Pick<PiRuntimeCapabilityError, 'code' | 'message'>,
  status: 'unknown' | 'failed',
): PiRuntimeCapabilityManifest {
  return {
    ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
    ...(identity.sdkSessionId ? { sdkSessionId: identity.sdkSessionId } : {}),
    capturedAt: new Date().toISOString(),
    generation,
    status,
    source: 'pi:get_commands',
    commands: [],
    error: { stage, ...failure, message: failure.message.slice(0, MAX_ERROR_MESSAGE_LENGTH) },
  };
}

export async function capturePiRuntimeCapabilityManifest(
  requester: {
    request(
      command: Record<string, unknown>,
      options?: { timeoutMs?: number },
    ): Promise<PiRpcResponse>;
  },
  identity: { sessionId?: string; sdkSessionId?: string },
  generation: number,
  stage: PiRuntimeCapabilityErrorStage,
  options: PiRuntimeCapabilityCaptureOptions = {},
): Promise<PiRuntimeCapabilityManifest> {
  const deadlineAtMs = Date.now() + PI_RUNTIME_CAPABILITY_TIMEOUT_MS;
  try {
    const response = await requester.request(
      { type: 'get_commands' },
      { timeoutMs: PI_RUNTIME_CAPABILITY_TIMEOUT_MS },
    );
    const rawResponse = response as unknown;
    if (
      typeof rawResponse !== 'object'
      || rawResponse === null
      || Array.isArray(rawResponse)
    ) {
      return errorManifest(identity, generation, stage, {
        code: 'malformed_response',
        message: 'Pi returned an invalid runtime command response',
      }, 'failed');
    }
    const responseRecord = rawResponse as Record<string, unknown>;
    if (
      Object.keys(responseRecord).some((key) => !PI_RPC_RESPONSE_KEYS.has(key))
      || responseRecord.type !== 'response'
      || responseRecord.command !== 'get_commands'
      || typeof responseRecord.success !== 'boolean'
      || (responseRecord.id !== undefined && typeof responseRecord.id !== 'string')
      || (responseRecord.error !== undefined && typeof responseRecord.error !== 'string')
    ) {
      return errorManifest(identity, generation, stage, {
        code: 'malformed_response',
        message: 'Pi returned an invalid runtime command response',
      }, 'failed');
    }
    const typedResponse = responseRecord as unknown as PiRpcResponse;
    if (!typedResponse.success) {
      const failure = classifyExplicitRpcFailure(typeof typedResponse.error === 'string' ? typedResponse.error : 'rpc rejected');
      return errorManifest(identity, generation, stage, failure, statusForFailureCode(failure.code));
    }
    const parsed = parsePiRuntimeCommands(typedResponse.data);
    if (!parsed.ok) {
      return errorManifest(identity, generation, stage, {
        code: 'malformed_response',
        message: 'Pi returned an invalid runtime command catalog',
      }, 'failed');
    }
    await capturePathlessUserSkillSources(parsed.commands, options, deadlineAtMs);
    return {
      ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
      ...(identity.sdkSessionId ? { sdkSessionId: identity.sdkSessionId } : {}),
      capturedAt: new Date().toISOString(),
      generation,
      status: 'loaded',
      source: 'pi:get_commands',
      commands: parsed.commands,
    };
  } catch (error) {
    const failure = classifyTransportFailure(error instanceof Error ? error.message : 'rpc failed');
    return errorManifest(identity, generation, stage, failure, statusForFailureCode(failure.code));
  }
}
