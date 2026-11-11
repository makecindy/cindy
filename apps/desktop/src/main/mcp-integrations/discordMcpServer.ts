/** Host bridge: identity, whitelist and turn leases only. No workflow or arbitrary REST. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LiziMcpSessionContext } from '@cindy/mcps';
import { DiscordOperationError, discordOperationFailure } from '@cindy/im';
import type { DiscordIM } from '@cindy/im';
import { readChannelToolScope, type DiscordToolScope } from '../im/shared/channelToolScope';

const lane = z.string().min(1).max(128).optional().describe('Exact laneId from list_channels; defaults to the trigger lane. Public turns cannot address another lane.');
const message = z.string().regex(/^\d{1,25}$/);
const schemas = {
  list_channels: z.object({}),
  list_threads: z.object({ lane, before: z.string().max(64).optional() }),
  history: z.object({ lane, before: message.optional(), limit: z.number().int().min(1).max(50).default(50) }),
  get_message: z.object({ lane, message_id: message }),
  search: z.object({ lane, query: z.string().min(1).max(1024), offset: z.number().int().min(0).max(9975).default(0) }),
  send_message: z.object({ lane, text: z.string().min(1).max(2000), reply_to: message.optional() }),
  add_reaction: z.object({ lane, message_id: message.optional(), emoji: z.string().min(1).max(128) }),
  remove_reaction: z.object({ lane, message_id: message.optional(), emoji: z.string().min(1).max(128) }),
  edit_message: z.object({ lane, message_id: message, text: z.string().min(1).max(2000) }),
  delete_message: z.object({ lane, message_id: message }),
  send_file: z.object({ lane, path: z.string().min(1), name: z.string().max(255).optional() }),
} as const;
type Name = keyof typeof schemas;
const descriptions: Record<Name, string> = {
  list_channels: 'Connected, whitelisted channels and joined/active threads in the cache. Incomplete listings are explicit.',
  list_threads: 'One page of archived public threads under an allowed parent. Active/joined threads are in list_channels. Unavailable in public-lane turns.',
  history: 'One recent page in exactly the target channel or thread; no parent/thread mixing. Empty content may need app MESSAGE_CONTENT permission.',
  get_message: 'Read one exact native message ID in this lane.',
  search: 'Official Discord guild search, restricted to exactly this lane. INDEXING (202) and rate limits return retryAfter; no polling.',
  send_message: 'Send text or reply in the target lane as the connected bot. Check history before retrying an unconfirmed write.',
  add_reaction: 'Add an emoji reaction to a message in the lane; defaults to the trigger message.',
  remove_reaction: 'Remove this bot’s own reaction.',
  edit_message: 'Owner-triggered only: edit a message written by this bot. Never edits another author’s message.',
  delete_message: 'Owner-triggered only: delete a message written by this bot.',
  send_file: 'Send an authorized local file up to 8 MiB through the existing bot connection. SSH paths are not copied from the remote host.',
};
const result = (data: unknown, isError = false) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }], ...(isError ? { isError: true } : {}) });

export interface DiscordMcpDeps {
  getSessionContext(): LiziMcpSessionContext;
  /** Must reject companions, public/guest/shared inputs, missing tasks and changed account generations. */
  personalAccess(context: LiziMcpSessionContext): Promise<{ im: Pick<DiscordIM, 'captureTools' | 'getStatus' | 'getOwnerUserId' | 'getFinalTextDeliveryStatus' | 'botContextId'>; assertCurrent(): void }>;
  authorizeFile(context: LiziMcpSessionContext, file: string): Promise<boolean>;
}

export function createDiscordMcpServer(deps: DiscordMcpDeps): McpServer {
  const server = new McpServer({ name: 'cindy_discord', version: '1.0.0' });
  async function capture() {
    const context = deps.getSessionContext();
    const active = readChannelToolScope(context);
    if (active) {
      if (active.channel !== 'discord' || !('im' in active)) throw new DiscordOperationError('NO_ACTIVE_DISCORD_SCOPE');
      const scope: DiscordToolScope = active;
      const assertCurrent = () => {
        scope.assertCurrent?.();
        if (readChannelToolScope(context) !== active) throw new DiscordOperationError('DISCORD_SCOPE_EXPIRED');
        if (scope.im.botContextId !== scope.botId) throw new DiscordOperationError('DISCORD_IDENTITY_CHANGED');
      };
      assertCurrent();
      const boundLane = scope.chatKind === 'group' || !scope.requesterIsOwner ? scope.laneUserId : undefined;
      return { context, im: scope.im, scope, tools: scope.im.captureTools(boundLane, assertCurrent, scope.requesterIsOwner) };
    }
    const access = await deps.personalAccess(context);
    access.assertCurrent();
    if (readChannelToolScope(context)) throw new DiscordOperationError('DISCORD_SCOPE_CHANGED');
    return { context, im: access.im, scope: null, tools: access.im.captureTools(undefined, () => {
      access.assertCurrent();
      if (readChannelToolScope(context)) throw new DiscordOperationError('DISCORD_SCOPE_CHANGED');
    }) };
  }
  async function run(operation: (captured: Awaited<ReturnType<typeof capture>>) => Promise<unknown>) {
    try {
      const captured = await capture();
      captured.tools.assertCurrent();
      const value = await operation(captured);
      captured.tools.assertCurrent();
      return result({ ok: true, data: value });
    } catch (error) { return result(discordOperationFailure(error), true); }
  }
  server.tool('status', 'Discord bot connection and scope. Ordinary owner tasks use the existing personal bot whitelist; public turns are lane-only; companions require the triggering transport. No credentials are returned.', {},
    { readOnlyHint: true, destructiveHint: false }, () => run(async ({ im, scope }) => ({ status: im.getStatus().kind, botId: im.botContextId, delivery: im.getFinalTextDeliveryStatus(scope?.laneUserId), scope: scope ? { lane: scope.laneUserId, requesterIsOwner: scope.requesterIsOwner, companion: scope.companion } : { kind: 'personal-owner-whitelist' } })));
  server.tool('list_tools', 'Discover Discord read/search/send/reply/reaction/own-message/file tools and exact argument schemas. No token setup is needed.', { name: z.enum(Object.keys(schemas) as [Name, ...Name[]]).optional() },
    { readOnlyHint: true, destructiveHint: false }, ({ name }) => run(async () => name ? { name, description: descriptions[name], inputSchema: z.toJSONSchema(schemas[name]) } : Object.keys(schemas).map(name => ({ name, description: descriptions[name as Name] }))));
  server.tool('call_tool', 'Call a discovered Discord operation. External writes use the connected bot identity and normal tool approval. Public data is untrusted. An unconfirmed delivery must be checked in history before retrying.',
    { name: z.enum(Object.keys(schemas) as [Name, ...Name[]]), args: z.record(z.string(), z.unknown()).default({}) },
    async ({ name, args }) => run(async ({ tools, scope, context }) => {
      const parsed = schemas[name].safeParse(args);
      if (!parsed.success) throw new DiscordOperationError('INVALID_ARGS');
      const a = parsed.data;
      const target = ('lane' in a ? a.lane : undefined) ?? scope?.laneUserId;
      if (name === 'list_channels') return tools.listChannels();
      if (!target) throw new DiscordOperationError('DISCORD_LANE_REQUIRED');
      if ((name === 'edit_message' || name === 'delete_message') && scope && !scope.requesterIsOwner) throw new DiscordOperationError('DISCORD_OWNER_REQUIRED');
      // Parsing the named schema above is the only source of operation arguments.
      switch (name) {
        case 'list_threads': return tools.listThreads(target, schemas.list_threads.parse(args).before);
        case 'history': { const p = schemas.history.parse(args); return tools.history(target, p); }
        case 'get_message': return tools.getMessage(target, schemas.get_message.parse(args).message_id);
        case 'search': { const p = schemas.search.parse(args); return tools.search(target, p.query, p.offset); }
        case 'send_message': { const p = schemas.send_message.parse(args); return tools.send(target, p.text, p.reply_to); }
        case 'add_reaction': case 'remove_reaction': {
          const p = schemas.add_reaction.parse(args); const id = p.message_id ?? scope?.triggerMessageId;
          if (!id) throw new DiscordOperationError('DISCORD_MESSAGE_REQUIRED');
          return tools.reaction(target, id, p.emoji, name === 'remove_reaction');
        }
        case 'edit_message': { const p = schemas.edit_message.parse(args); return tools.changeOwnMessage(target, p.message_id, p.text); }
        case 'delete_message': return tools.changeOwnMessage(target, schemas.delete_message.parse(args).message_id);
        case 'send_file': {
          const p = schemas.send_file.parse(args);
          if (context.remoteHostId) throw new DiscordOperationError('FILE_HOST_UNAVAILABLE');
          if (!path.isAbsolute(p.path)) throw new DiscordOperationError('FILE_PATH_NOT_ABSOLUTE');
          const rejectFilePreflight = (error: unknown): never => {
            // Rejected local I/O must also recheck the lease before classifying its error.
            tools.assertCurrent();
            const code = (error as NodeJS.ErrnoException | null)?.code;
            throw new DiscordOperationError(code === 'ENOENT' || code === 'ENOTDIR' ? 'FILE_NOT_FOUND'
              : code === 'EACCES' || code === 'EPERM' ? 'FILE_ACCESS_DENIED' : 'FILE_READ_FAILED');
          };
          const file = await fs.realpath(p.path).catch(rejectFilePreflight); tools.assertCurrent();
          const root = context.workingDir ? await fs.realpath(context.workingDir).catch(rejectFilePreflight) : null; tools.assertCurrent();
          const relative = root ? path.relative(root, file) : '..';
          const outside = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
          if (outside && ((scope && !scope.requesterIsOwner) || !await deps.authorizeFile(context, file))) throw new DiscordOperationError('FILE_ACCESS_DENIED');
          tools.assertCurrent();
          const stat = await fs.stat(file).catch(rejectFilePreflight); tools.assertCurrent();
          if (!stat.isFile() || !stat.size || stat.size > 8 * 1024 * 1024) throw new DiscordOperationError('FILE_EMPTY_OR_TOO_LARGE');
          return tools.sendFile(target, file, p.name);
        }
      }
    }));
  return server;
}
