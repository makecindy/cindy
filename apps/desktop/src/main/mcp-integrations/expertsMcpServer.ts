/**
 * cindy_experts — the expert creator's one tool (ROADMAP 3.8, ADR 0007).
 *
 * `draft_expert` checks a proposed expert, shows it to the owner on a card in the calling
 * session, and waits. Approve writes a NEW folder under ~/.cindy-harness/experts (atomic, never
 * overwrites); Reject or no answer writes nothing. The tool is mounted only for Hermes sessions
 * started as an expert whose expert.md lists `tools: [draft_expert]` (hermesBridgeHost), and
 * every call re-checks that binding here, so a session that reaches the route without it fails
 * closed. Pi never mounts it (piEnvironment); Claude Code and Codex never receive the provider.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { McpProvider } from '@cindy/maker-core';
import {
  expertDraftExists,
  renderExpertMarkdown,
  validateExpertDraft,
  writeExpertDraft,
  type ExpertDraft,
  type WriteExpertDraftResult,
} from '@cindy/maker-core/expert-draft';
import { resolveLiziMcpSessionContext, type LiziMcpSessionContext } from '@cindy/mcps';
import * as path from 'node:path';

import type { ExpertDraftDecision } from '../maker-ipc/expertDraftConfirm.js';

export const CINDY_EXPERTS_MCP_SERVER_NAME = 'cindy_experts';
export const DRAFT_EXPERT_TOOL = 'draft_expert';

export interface ExpertsMcpDeps {
  getSessionContext(): Pick<LiziMcpSessionContext, 'agentKind' | 'sessionId'> | undefined;
  /** Experts root (production: ~/.cindy-harness/experts). */
  rootDir(): string;
  /** True when the session is bound to an expert whose tools list `draft_expert`. */
  sessionMayDraft(sessionId: string): boolean;
  confirm(input: { sessionId: string; draft: ExpertDraft; targetDir: string; markdown: string }): Promise<ExpertDraftDecision>;
  write?: (rootDir: string, draft: ExpertDraft) => WriteExpertDraftResult;
}

function reply(payload: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true as const } : {}),
  };
}

const TOOL_DESCRIPTION = [
  'Propose a NEW Cindy expert. The owner sees the full draft on a card and approves or rejects it;',
  'this call waits for that answer (up to 9 minutes). On approval the expert is saved to',
  '~/.cindy-harness/experts/<slug>/expert.md and appears in the expert picker. A draft cannot',
  'grant tools and cannot replace an existing expert. On rejection, read the owner\'s note,',
  'ask what to change if it is unclear, and propose again only when the owner wants it.',
].join(' ');

export function createExpertsMcpServer(deps: ExpertsMcpDeps): McpServer {
  const server = new McpServer({ name: CINDY_EXPERTS_MCP_SERVER_NAME, version: '1.0.0' });
  server.tool(
    DRAFT_EXPERT_TOOL,
    TOOL_DESCRIPTION,
    {
      slug: z.string().describe('Folder name: lowercase letters, digits and dashes, e.g. "uk-cold-email-writer".'),
      name: z.string().describe('Display name, one line.'),
      description: z.string().describe('One sentence: what this expert does.'),
      prompt: z.string().describe('The expert\'s full system prompt (Markdown): role, method, rules, output format.'),
      model: z.string().optional().describe('Optional routing.yaml route name. Omit unless the owner named one.'),
      tags: z.array(z.string()).optional().describe('Optional short tags.'),
      memory: z.boolean().optional().describe('Keep per-expert notes across sessions. Default false.'),
    },
    { readOnlyHint: false, destructiveHint: false },
    async (args) => {
      const ctx = deps.getSessionContext();
      const sessionId = ctx?.sessionId;
      if (!ctx || ctx.agentKind !== 'hermes' || !sessionId) {
        return reply({ status: 'refused', errorCode: 'NO_SESSION_CONTEXT', message: 'draft_expert only runs inside a Hermes session.' }, true);
      }
      if (!deps.sessionMayDraft(sessionId)) {
        return reply({
          status: 'refused',
          errorCode: 'NOT_EXPERT_CREATOR',
          message: 'This session was not started as an expert whose expert.md lists "tools: [draft_expert]".',
        }, true);
      }
      const check = validateExpertDraft(args);
      if (!check.ok) {
        return reply({ status: 'invalid', errors: check.errors, message: 'Fix these and call draft_expert again.' }, true);
      }
      const draft = check.draft;
      const root = deps.rootDir();
      if (expertDraftExists(root, draft.slug)) {
        return reply({ status: 'invalid', errors: [`an expert "${draft.slug}" already exists`], message: 'Pick a different slug.' }, true);
      }

      let decision: ExpertDraftDecision;
      try {
        decision = await deps.confirm({ sessionId, draft, targetDir: path.join(root, draft.slug), markdown: renderExpertMarkdown(draft) });
      } catch (error) {
        return reply({ status: 'refused', message: error instanceof Error ? error.message : String(error) }, true);
      }
      if (!decision.approved) {
        return reply({
          status: decision.reason === 'timeout' ? 'no_answer' : 'rejected',
          message: decision.reason === 'timeout'
            ? 'The owner did not answer in time. Nothing was written.'
            : 'The owner rejected the draft. Nothing was written.',
          ...(decision.reason === 'rejected' && decision.note ? { ownerNote: decision.note } : {}),
        });
      }
      const written = (deps.write ?? writeExpertDraft)(root, draft);
      if (!written.ok) {
        return reply({ status: 'not_written', reason: written.reason, message: written.message }, true);
      }
      return reply({
        status: 'saved',
        slug: draft.slug,
        file: written.file,
        message: `Saved. The owner can now pick "${draft.name}" in the expert picker for a new Hermes task.`,
      });
    },
  );
  return server;
}

/** The provider Hermes' shared tool bridge serves; Pi filters it out by name. */
export function createExpertsMcpProvider(deps: Omit<ExpertsMcpDeps, 'getSessionContext'>): McpProvider {
  return {
    name: CINDY_EXPERTS_MCP_SERVER_NAME,
    toClaudeSdkConfig: (ctx) => ({
      type: 'sdk',
      name: CINDY_EXPERTS_MCP_SERVER_NAME,
      instance: createExpertsMcpServer({
        ...deps,
        getSessionContext: () => resolveLiziMcpSessionContext(ctx as LiziMcpSessionContext),
      }),
    }),
  };
}
