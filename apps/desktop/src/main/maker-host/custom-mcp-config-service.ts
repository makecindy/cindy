import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { eq, asc } from 'drizzle-orm';
import { customMcpServers } from '../localDb/schema.js';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import {
  activeOwnerScopeKey,
  getActiveAppSession,
  isAppSessionBoundaryPending,
} from '../appSessionState.js';
import {
  hasLegacyMcpToken,
  readLegacyMcpToken,
  readMcpCredentials,
  writeMcpCredentials,
} from '../secrets/customMcpCredentials.js';
import { validateCustomMcpConfig } from './custom-mcp-store.js';
import { validateMcpEndpoint } from '../mcp-integrations/custom-mcp-fetch.js';
import type { CustomMcpMutation, CustomMcpSummary } from '../../shared/mcpSetup.js';
import type { CustomMcpConfig } from '../../shared/customMcp.js';

export function captureMcpOwner() {
  const snapshot = getCurrentDbClientSnapshot();
  const scope = activeOwnerScopeKey();
  if (
    !snapshot ||
    snapshot.userId !== getActiveAppSession().dataOwnerId ||
    isAppSessionBoundaryPending()
  )
    throw new Error('OWNER_CHANGED');
  const assertOwner = () => {
    if (
      scope !== activeOwnerScopeKey() ||
      isAppSessionBoundaryPending() ||
      getCurrentDbClientSnapshot() !== snapshot
    )
      throw new Error('OWNER_CHANGED');
  };
  return { client: snapshot.client, scope, assertOwner };
}
export type McpOwner = ReturnType<typeof captureMcpOwner>;
export type McpRecord = typeof customMcpServers.$inferSelect;
const mutationSchema = z
  .object({
    id: z.string().min(1).max(40),
    name: z.string().min(1).max(60),
    url: z.string().max(8192),
    transport: z.enum(['http', 'sse']),
    headers: z.record(z.string().max(100), z.string().max(8192)),
    token: z.string().max(8192).optional(),
    tokenAction: z.enum(['keep', 'replace', 'clear']).optional(),
    keepHeaderNames: z.array(z.string().max(100)).max(32).optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
    keepUrl: z.boolean().optional(),
  })
  .strict();
export async function listMcpRecords(owner = captureMcpOwner()): Promise<McpRecord[]> {
  const rows = await owner.client.drizzle
    .select()
    .from(customMcpServers)
    .orderBy(asc(customMcpServers.sortOrder));
  owner.assertOwner();
  return rows;
}
function headerMap(raw: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        )
      : {};
  } catch {
    return {};
  }
}
export function resolveMcpCredentials(row: McpRecord) {
  if (row.credentialFormat === 0)
    return { token: readLegacyMcpToken(row.id) ?? '', headers: headerMap(row.headers) };
  if (row.credentialFormat === 1 || row.credentialFormat === 2)
    return readMcpCredentials(row, row.credentialRef);
  throw new Error('SECRET_UNREADABLE');
}
export async function listMcpSummaries(): Promise<CustomMcpSummary[]> {
  const owner = captureMcpOwner();
  const rows = await listMcpRecords(owner);
  owner.assertOwner();
  return rows.map((row) => {
    let url = row.url;
    let urlRedacted = false;
    try {
      const u = new URL(url);
      urlRedacted = Boolean(u.username || u.password || u.search || u.hash);
      u.username = '';
      u.password = '';
      u.search = '';
      u.hash = '';
      url = u.href;
    } catch {
      url = '';
      urlRedacted = true;
    }
    const hasToken =
      row.credentialFormat !== 0
        ? Boolean(row.credentialRef?.startsWith('mcp_bundle_t_'))
        : hasLegacyMcpToken(row.id);
    const saved =
      row.credentialFormat !== 0
        ? Boolean(row.credentialRef)
        : hasToken || Object.keys(headerMap(row.headers)).length > 0;
    // Presence is metadata. Listing never decrypts credentials or probes Keychain.
    return {
      id: row.id,
      name: row.name,
      transport: row.transport as CustomMcpConfig['transport'],
      url,
      headers: Object.fromEntries(Object.keys(headerMap(row.headers)).map((name) => [name, ''])),
      revision: row.updatedAt,
      hasToken,
      credentialState: saved ? 'saved' : 'absent',
      urlRedacted,
    };
  });
}
export function newMcpId(): string {
  return 'custom_' + randomBytes(12).toString('hex');
}

export async function saveMcpConfig(
  input: CustomMcpMutation,
  create: boolean,
  options: {
    owner?: McpOwner;
    receipt?: { operationId: string; sessionId: string };
    reservedIds?: string[];
    secureNetwork?: boolean;
  } = {},
) {
  const parsed = mutationSchema.safeParse(input);
  if (!parsed.success) throw new Error('INVALID_CONFIG');
  input = parsed.data;
  const owner = options.owner ?? captureMcpOwner();
  owner.assertOwner();
  const rows = await owner.client.drizzle
    .select()
    .from(customMcpServers)
    .where(eq(customMcpServers.id, input.id));
  owner.assertOwner();
  const previous = rows[0];
  if (create && previous) throw new Error('CONFIG_CONFLICT');
  if (!create && !previous) throw new Error('CONFIG_CONFLICT');
  if (
    previous &&
    input.expectedRevision !== undefined &&
    input.expectedRevision !== previous.updatedAt
  )
    throw new Error('CONFIG_CONFLICT');
  const needsPrevious =
    previous &&
    (input.tokenAction === 'keep' ||
      input.tokenAction === undefined ||
      Boolean(input.keepHeaderNames?.length));
  const old = needsPrevious ? resolveMcpCredentials(previous) : { token: '', headers: {} };
  const token =
    input.tokenAction === 'clear'
      ? ''
      : input.tokenAction === 'replace'
        ? (input.token ?? '').trim()
        : old.token;
  const headers = { ...input.headers };
  for (const name of input.keepHeaderNames ?? []) {
    if (!(name in old.headers)) throw new Error('CONFIG_CONFLICT');
    headers[name] = old.headers[name];
  }
  const config = {
    ...input,
    url: input.keepUrl && previous ? previous.url : input.url.trim(),
    name: input.name.trim(),
    headers,
  };
  if (
    !validateCustomMcpConfig(config, options.reservedIds).ok ||
    token.length > 8192 ||
    /[^\x20-\x7e]/.test(token) ||
    Object.keys(headers).length > 32 ||
    JSON.stringify(headers).length > 32768
  )
    throw new Error('INVALID_CONFIG');
  owner.assertOwner();
  if (options.secureNetwork || previous?.credentialFormat === 1) validateMcpEndpoint(config.url);
  const credentialRef = writeMcpCredentials(config, { token, headers });
  // This immutable file is intentionally retained on ambiguous worker failures.
  // Deleting it could destroy credentials of a transaction that actually committed.
  const result = await owner.client.tx('customMcp.commit', {
    id: config.id,
    name: config.name,
    transport: config.transport,
    url: config.url,
    headers: JSON.stringify(Object.fromEntries(Object.keys(headers).map((name) => [name, '']))),
    credentialRef,
    expectedRevision: previous?.updatedAt ?? null,
    now: Date.now(),
    receipt: options.receipt,
    // 1: encrypted + controlled network (conversation); 2: encrypted + legacy
    // Settings transport semantics. Editing a secure entry never weakens it.
    credentialFormat: options.secureNetwork || previous?.credentialFormat === 1 ? 1 : 2,
  });
  owner.assertOwner();
  return result;
}

export async function deleteMcpConfig(id: string): Promise<void> {
  const owner = captureMcpOwner();
  await owner.client.drizzle.delete(customMcpServers).where(eq(customMcpServers.id, id));
  owner.assertOwner();
  // Unreferenced encrypted blobs are not readable by a renderer or runtime.
}
