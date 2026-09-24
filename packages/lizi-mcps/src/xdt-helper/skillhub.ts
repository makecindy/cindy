import { z } from 'zod';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult, LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

const slug = z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,127}$/);
const publishShape = {
  path: z.string().trim().min(1).max(4096),
  name: slug,
  mode: z.enum(['create', 'update']),
  visibility: z.enum(['public', 'private', 'shared']).optional(),
  display_name: z.string().trim().min(1).max(200).optional(),
  summary: z.string().trim().min(1).max(1000).optional(),
  tags: z.array(slug).max(20).optional(),
  changelog: z.string().trim().max(5000).optional(),
  visible_slugs: z.array(slug).max(100).optional(),
};
export type SkillhubPublishInput = z.infer<z.ZodObject<typeof publishShape>>;
export type SkillhubAgentRequest =
  | { action: 'search'; query: string; scope?: 'market' | 'team' | 'all'; cursor?: string }
  | { action: 'list'; query?: string; cursor?: string }
  | { action: 'publish'; input: SkillhubPublishInput }
  | { action: 'status'; name: string; version: string };
export type SkillhubAgentCallback = (
  request: SkillhubAgentRequest,
  context: LiziMcpSessionContext,
) => Promise<ControlResult<Record<string, unknown>, string>>;

/** SkillHub uses the existing progressive helper surface; credentials stay in the host. */
export function registerSkillhubTools(registry: XdtHelperToolRegistry, deps: {
  getSessionContext: () => LiziMcpSessionContext;
  execute: SkillhubAgentCallback;
}): void {
  const execute = async (request: SkillhubAgentRequest) => {
    const context = deps.getSessionContext();
    if (!context.sessionId) return errorPayload('NO_SESSION_CONTEXT', 'No Cindy task is bound to this call.');
    if (context.remoteHostId) return errorPayload('UNSUPPORTED_CAPABILITY', 'SkillHub tools require a local Cindy task. For uploads, copy remote Skill files to the Cindy host first.');
    const result = await deps.execute(request, context);
    return result.ok ? okPayload(result) : errorPayload(result.errorCode, result.message);
  };
  registry.register({
    name: 'search_skills', category: 'skills',
    description: 'Search Cindy SkillHub by keyword. scope=market searches the public marketplace; scope=team searches the current organization (organization identities only). Omit scope or use all to search both for organization users, or the public market for personal users. Results retain catalog_scope to distinguish same-name Skills. To paginate, specify one scope and its next_cursor. Search does not install or publish anything.',
    inputShape: {
      query: z.string().trim().min(1).max(200),
      scope: z.enum(['market', 'team', 'all']).optional(),
      cursor: z.string().regex(/^[1-9][0-9]{0,6}$/).optional(),
    },
    handler: async ({ query, scope, cursor }) => {
      if (cursor && (!scope || scope === 'all')) return errorPayload('INVALID_ARGS', 'For pagination, specify market or team and that catalog’s next_cursor.');
      return execute({ action: 'search', query, scope, cursor });
    },
  });
  registry.register({
    name: 'list_my_published_skills', category: 'skills',
    description: 'List the signed-in user’s published Skills and allowed first-publish visibility. Updates require confirmed is_creator and can_manage; being listed here alone does not prove authorship. Follow next_cursor for more results.',
    inputShape: { query: z.string().trim().max(200).optional(), cursor: z.string().regex(/^[1-9][0-9]{0,6}$/).optional() },
    handler: ({ query, cursor }) => execute({ action: 'list', query, cursor }),
  });
  registry.register({
    name: 'publish_skill', category: 'skills',
    description: 'Upload a local Skill folder to SkillHub or publish a new version of your own Skill. Use only when the user requests upload/publication. path must contain SKILL.md; name must match its frontmatter. mode=create requires explicit visibility; ownership comes from the signed-in identity, and visible_slugs selects only the shared audience. mode=update requires confirmed authorship and management access and preserves visibility and ownership. Version is assigned by the server. Success means uploaded, not necessarily approved. If the result is uncertain, check status before retrying.',
    inputShape: publishShape,
    handler: async (input) => {
      if (input.mode === 'create' && !input.visibility) return errorPayload('INVALID_ARGS', 'First publication requires the user’s visibility choice.');
      if (input.mode === 'update' && (input.visibility || input.visible_slugs || input.tags)) return errorPayload('INVALID_ARGS', 'Updates preserve visibility, ownership and tags. Omit those fields.');
      if (input.visibility !== 'shared' && input.visible_slugs) return errorPayload('INVALID_ARGS', 'Sharing targets require shared visibility.');
      return execute({ action: 'publish', input });
    },
  });
  registry.register({
    name: 'get_skill_publish_status', category: 'skills',
    description: 'Read the scan/review status for an uploaded Skill version. Report pending review truthfully; do not repeatedly publish or poll while awaiting human review.',
    inputShape: { name: slug, version: z.string().trim().min(1).max(128).regex(/^[^\u0000-\u001f\u007f]+$/) },
    handler: ({ name, version }) => execute({ action: 'status', name, version }),
  });
}
