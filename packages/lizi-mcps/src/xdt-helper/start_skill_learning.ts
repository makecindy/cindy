import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult, LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

export interface StartSkillLearningParams {
  callerSessionId: string;
  input: string;
  sourceKind: 'session' | 'freetext' | 'hub';
  hubSlug?: string;
  hubCatalogScope?: 'market' | 'team';
}

export interface AuthorizedSkillLearningContext {
  /** Host-attested runtime identity; never sourced from model tool arguments. */
  sessionInstanceId: string;
}

export type AuthorizeSkillLearningCallback = (
  params: StartSkillLearningParams,
  context: LiziMcpSessionContext,
) => Promise<ControlResult<AuthorizedSkillLearningContext, string>>;

export type StartSkillLearningCallback = (
  params: StartSkillLearningParams,
  authorization: AuthorizedSkillLearningContext,
) => Promise<ControlResult<{ runId: string }, string>>;

export function registerStartSkillLearningTool(
  registry: XdtHelperToolRegistry,
  deps: {
    getSessionContext: () => LiziMcpSessionContext;
    authorizeSkillLearning: AuthorizeSkillLearningCallback;
    startSkillLearning: StartSkillLearningCallback;
  },
): void {
  registry.register({
    name: 'start_skill_learning',
    category: 'skills',
    description:
      "Start Cindy's managed Learn flow for the current task. The host gathers evidence, distills into a separate task, stages the proposed Skill, and requires review before installation. Use only for an explicit /learn request. Call once and do not poll.",
    inputShape: {
      source_kind: z.enum(['session', 'freetext', 'hub']),
      input: z.string().max(12_000).optional(),
      hub_slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(200).optional(),
      hub_catalog_scope: z.enum(['market', 'team']).optional(),
    },
    handler: async ({ source_kind, input, hub_slug, hub_catalog_scope }) => {
      const context = deps.getSessionContext();
      if (!context.sessionId) {
        return errorPayload('NO_SESSION_CONTEXT', 'No Cindy task is bound to this call.');
      }

      const normalizedInput = input?.trim() ?? '';
      if (source_kind === 'freetext' && !normalizedInput) {
        return errorPayload('INVALID_ARGS', 'A freetext Learn request requires non-empty input.');
      }
      if (source_kind === 'hub' && !hub_slug) {
        return errorPayload('INVALID_ARGS', 'A SkillHub Learn request requires hub_slug.');
      }
      if (source_kind !== 'hub' && (hub_slug || hub_catalog_scope)) {
        return errorPayload(
          'INVALID_ARGS',
          'hub_slug and hub_catalog_scope are only valid when source_kind is hub.',
        );
      }

      const request: StartSkillLearningParams = {
        callerSessionId: context.sessionId,
        input: normalizedInput,
        sourceKind: source_kind,
        ...(hub_slug ? { hubSlug: hub_slug } : {}),
        ...(source_kind === 'hub'
          ? { hubCatalogScope: hub_catalog_scope ?? 'market' }
          : {}),
      };
      const authorization = await deps.authorizeSkillLearning(request, context);
      if (!authorization.ok) {
        return errorPayload(authorization.errorCode, authorization.message);
      }

      const result = await deps.startSkillLearning(request, {
        sessionInstanceId: authorization.sessionInstanceId,
      });
      return result.ok
        ? okPayload({
            run_id: result.runId,
            status: 'collecting',
            guidance:
              'Learn started. Progress and the review action appear in Cindy; do not call this tool again or poll.',
          })
        : errorPayload(result.errorCode, result.message);
    },
  });
}
