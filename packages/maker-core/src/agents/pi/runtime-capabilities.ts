import type { PiRpcResponse } from './rpc-client.js';
import path from 'node:path';
import type {
  PiRuntimeCapabilityError,
  PiRuntimeCapabilityErrorStage,
  PiRuntimeCapabilityManifest,
  PiRuntimeCommand,
  PiRuntimeCommandSourceInfo,
  PiManagedPackageSkillRuntimeSnapshot,
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

type RuntimeCommandParseResult =
  | { ok: true; commands: PiRuntimeCommand[] }
  | { ok: false };

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) return undefined;
  return value;
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
    if (!name || !source || !sourceInfo) return { ok: false };
    const description = raw.description === undefined
      ? undefined
      : boundedString(raw.description, MAX_DESCRIPTION_LENGTH);
    if (raw.description !== undefined && !description) return { ok: false };
    parsed.push({
      name,
      ...(description ? { description } : {}),
      source,
      sourceInfo,
    });
  }
  return { ok: true, commands: parsed };
}

function isPathWithin(root: string, candidate: string): boolean {
  if (!path.isAbsolute(root) || !path.isAbsolute(candidate)) return false;
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function commandSourcePaths(sourceInfo: PiRuntimeCommandSourceInfo): string[] {
  const values = [sourceInfo.path, sourceInfo.source, sourceInfo.origin]
    .filter((value): value is string => typeof value === 'string' && path.isAbsolute(value));
  if (sourceInfo.baseDir && path.isAbsolute(sourceInfo.baseDir)) {
    values.push(sourceInfo.baseDir);
    if (sourceInfo.path && !path.isAbsolute(sourceInfo.path)) {
      values.push(path.resolve(sourceInfo.baseDir, sourceInfo.path));
    }
  }
  return values;
}

/**
 * Mark only commands whose Pi-owned provenance points inside an enabled
 * Cindy-managed package root. The result is later used both by the palette and
 * by the prompt escape boundary; static filenames alone never authorize an
 * extension command.
 */
export function identifyManagedPiPackageCommandNames(
  commands: readonly PiRuntimeCommand[],
  packageRoots: readonly string[],
): string[] {
  const roots = packageRoots.filter(path.isAbsolute).map((root) => path.resolve(root));
  if (roots.length === 0) return [];
  const provenanceByName = new Map<string, boolean[]>();
  for (const command of commands) {
    const managed = commandSourcePaths(command.sourceInfo)
      .some((candidate) => roots.some((root) => isPathWithin(root, candidate)));
    const provenance = provenanceByName.get(command.name) ?? [];
    provenance.push(managed);
    provenanceByName.set(command.name, provenance);
  }
  // Pi may legitimately expose an Extension command and a Prompt with the
  // same name. Authorize that name only when every colliding catalog entry is
  // from a managed package; mixed provenance could dispatch a Cindy internal
  // or user command instead of the package command shown in the menu.
  return [...provenanceByName.entries()].flatMap(([name, provenance]) => (
    provenance.length > 0 && provenance.every(Boolean) ? [name] : []
  ));
}

function canonicalRuntimePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function managedSkillCommandMatchesSource(command: PiRuntimeCommand, sourcePath: string): boolean {
  if (command.source !== 'skill' || !command.name.startsWith('skill:') || !path.isAbsolute(sourcePath)) return false;
  const expectedFile = canonicalRuntimePath(sourcePath);
  const commandFile = command.sourceInfo.path;
  if (commandFile && path.isAbsolute(commandFile) && canonicalRuntimePath(commandFile) === expectedFile) return true;
  const commandBaseDir = command.sourceInfo.baseDir;
  return path.basename(sourcePath).toLowerCase() === 'skill.md'
    && typeof commandBaseDir === 'string'
    && path.isAbsolute(commandBaseDir)
    && canonicalRuntimePath(commandBaseDir) === canonicalRuntimePath(path.dirname(sourcePath));
}

/**
 * Freeze the managed-skill roster passed to one runtime and attach a command
 * name only when that runtime's own catalog proves an unambiguous loaded match.
 */
export function snapshotManagedPiPackageSkills(
  skills: readonly { path: string; name: string; description?: string }[],
  commands: readonly PiRuntimeCommand[],
  managedPackageCommandNames: readonly string[],
): PiManagedPackageSkillRuntimeSnapshot[] {
  const managedNames = new Set(managedPackageCommandNames);
  return skills.map((skill) => {
    const matches = [...new Set(commands.flatMap((command) => (
      managedNames.has(command.name) && managedSkillCommandMatchesSource(command, skill.path)
        ? [command.name]
        : []
    )))];
    return {
      sourcePath: skill.path,
      name: skill.name,
      ...(skill.description ? { description: skill.description } : {}),
      ...(matches.length === 1 ? { runtimeCommandName: matches[0] } : {}),
    };
  });
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
): Promise<PiRuntimeCapabilityManifest> {
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
