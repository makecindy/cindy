import fs from 'node:fs/promises';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type { LiziMcpSessionContext, SessionPathAuthorization, SessionPathAuthorizationRequest, SkillhubAgentCallback } from '@cindy/mcps';
import type { SkillhubIdentityPolicy } from '../../shared/skillhubIdentityPolicy';
import type { SkillhubMarketService } from './marketService';
import type { SkillPublishService } from './publishService';

/** Reuse the same publisher, account policy and managed roots as the Skills page. */
export interface SkillhubAgentServices {
  market: Pick<SkillhubMarketService, 'listMarket' | 'info' | 'getScanStatus'>;
  publisher: Pick<SkillPublishService, 'publish'>;
  ownerScope: () => string | null;
  policy: () => SkillhubIdentityPolicy;
  isManagedPath: (absolutePath: string) => boolean;
  errorCode: (error: unknown) => string;
}
let services: SkillhubAgentServices | undefined;

export function configureSkillhubAgentServices(next: SkillhubAgentServices): void {
  services = next;
}

const fail = (errorCode: string, message: string) => ({ ok: false as const, errorCode, message });
function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Agent identity comes from the live host context, never from tool arguments. */
export function createSkillhubAgentTools(deps: {
  isCurrentSession: (context: LiziMcpSessionContext) => boolean;
  authorizePath: (request: SessionPathAuthorizationRequest) => Promise<SessionPathAuthorization>;
  getServices?: () => SkillhubAgentServices | undefined;
}): SkillhubAgentCallback {
  return async (request, context) => {
    if (!context.sessionId || context.remoteHostId || !deps.isCurrentSession(context)) {
      return fail('NO_SESSION_CONTEXT', 'A current local Cindy task is required.');
    }
    const host = (deps.getServices ?? (() => services))();
    if (!host) return fail('HOST_NOT_READY', 'SkillHub is not ready.');
    const owner = host.ownerScope();
    if (!owner) return fail('UNAUTHORIZED', 'Sign in to Cindy to search SkillHub or publish your Skills.');
    const isCurrent = () => host.ownerScope() === owner && deps.isCurrentSession(context);
    const changed = () => fail('CANCELLED', 'The active account or task changed. Check the published version before retrying.');
    try {
      if (request.action === 'search') {
        const organization = host.policy().ownerType === 'organization';
        if (request.scope === 'team' && !organization) return fail('UNSUPPORTED_CAPABILITY', 'Organization Skill search requires an organization identity. Use scope=market for the public marketplace.');
        const scopes: Array<'market' | 'team'> = request.scope && request.scope !== 'all'
          ? [request.scope] : organization ? ['market', 'team'] : ['market'];
        if (request.cursor && (!request.scope || request.scope === 'all')) return fail('INVALID_ARGS', 'Choose one catalog when requesting its next page.');
        // Keep catalogs separate: identical slugs are different resources, with independent pages.
        const results = await Promise.allSettled(scopes.map((scope) => host.market.listMarket({
          q: request.query, scope, cursor: request.cursor, limit: 24,
        })));
        if (!isCurrent()) return changed();
        if (results.every((result) => result.status === 'rejected')) {
          const first = results[0];
          return fail(first?.status === 'rejected' ? host.errorCode(first.reason) : 'INTERNAL', 'Skill search is unavailable. Check sign-in and try the public or organization catalog separately.');
        }
        return {
          ok: true,
          query: request.query,
          catalogs: results.map((result, index) => result.status === 'fulfilled' ? {
            catalog_scope: scopes[index], ok: true,
            skills: result.value.items.map((item) => ({
              name: item.name, display_name: item.displayName, description: item.description,
              version: item.latestVersion, author: item.authorName,
              catalog_scope: scopes[index], visibility: item.publishedVisibility,
            })),
            next_cursor: result.value.nextCursor,
          } : {
            catalog_scope: scopes[index], ok: false, error_code: host.errorCode(result.reason),
            guidance: 'This catalog could not be searched. Results from the other catalog are still available.',
          }),
        };
      }
      if (request.action === 'list') {
        const result = await host.market.listMarket({ mine: true, q: request.query, cursor: request.cursor, limit: 50 });
        if (!isCurrent()) return changed();
        return {
          ok: true,
          skills: result.items.map((item) => ({
            name: item.name, display_name: item.displayName, description: item.description,
            version: item.latestVersion, is_creator: item.isCreator === true,
            can_manage: item.canManage === true,
            visibility: item.publishedVisibility, pending_version: item.pendingVersion,
          })),
          next_cursor: result.nextCursor,
          allowed_visibilities: host.policy().allowedVisibilities.map((value) => value === 'DEPARTMENT_SCOPED' ? 'shared' : value.toLowerCase()),
        };
      }
      if (request.action === 'status') {
        const result = await host.market.getScanStatus({ slug: request.name, version: request.version });
        return isCurrent() ? { ...result, ok: true } : changed();
      }

      const input = request.input;
      if (!path.isAbsolute(input.path) || input.path.includes('\0')) return fail('INVALID_ARGS', 'path must be an absolute local Skill folder.');
      const visibility = input.visibility === 'shared' ? 'DEPARTMENT_SCOPED' : input.visibility === 'public' ? 'PUBLIC' : 'PRIVATE';
      if (input.mode === 'create' && (!input.visibility || !host.policy().allowedVisibilities.includes(visibility))) {
        return fail('INVALID_VISIBILITY', 'Choose a visibility supported by the signed-in identity; list_my_published_skills returns the available choices.');
      }
      if (input.mode === 'update' && (input.visibility || input.visible_slugs || input.tags)) {
        return fail('INVALID_ARGS', 'Updates preserve the existing visibility, ownership and tags.');
      }
      const absolutePath = await fs.realpath(input.path);
      if (!isCurrent()) return changed();
      if (host.isManagedPath(absolutePath)) return fail('PERMISSION_DENIED', 'Cindy built-in and plugin-managed Skills cannot be published as your own.');
      const workingDir = context.workingDir ? await fs.realpath(context.workingDir) : null;
      if (!workingDir || !isCurrent()) return changed();
      let authorization: SessionPathAuthorization = { allowed: true };
      if (!isInside(workingDir, absolutePath)) {
        authorization = await deps.authorizePath({
          sessionId: context.sessionId, sessionInstanceId: context.sessionInstanceId,
          workingDir, path: absolutePath, toolName: 'publish_skill', operation: 'read',
        });
        if (!authorization.allowed) return fail('PERMISSION_DENIED', authorization.reason);
      }
      const grant = authorization;
      const directoryIdentity = await fs.stat(absolutePath);
      const isAuthorized = () => {
        if (!isCurrent() || grant.isCurrent?.() === false) return false;
        try {
          const current = statSync(absolutePath);
          return realpathSync.native(absolutePath) === absolutePath
            && current.dev === directoryIdentity.dev && current.ino === directoryIdentity.ino;
        } catch { return false; }
      };
      if (!isAuthorized()) return changed();
      const skillMdPath = path.join(absolutePath, 'SKILL.md');
      // The upload is a folder, not an arbitrary file or an external SKILL.md symlink.
      if (!directoryIdentity.isDirectory() || !(await fs.lstat(skillMdPath)).isFile()) {
        return fail('MANIFEST_INVALID', 'The Skill folder must contain a regular SKILL.md file.');
      }
      const raw = await fs.readFile(skillMdPath, 'utf8');
      let frontmatter: Record<string, unknown>;
      try { frontmatter = matter(raw).data; }
      catch { return fail('MANIFEST_INVALID', 'SKILL.md has invalid YAML frontmatter.'); }
      if (frontmatter.name !== input.name || typeof frontmatter.description !== 'string' || !frontmatter.description.trim()) {
        return fail('MANIFEST_INVALID', 'SKILL.md must have a matching name and a non-empty description.');
      }
      if (!isAuthorized()) return changed();

      let existing: Awaited<ReturnType<SkillhubMarketService['info']>> | undefined;
      try { existing = await host.market.info(input.name); }
      catch (error) {
        if (!['NOT_FOUND', 'SKILL_NOT_FOUND'].includes(host.errorCode(error))) throw error;
      }
      if (!isAuthorized()) return changed();
      const info = existing && 'info' in existing ? existing.info : undefined;
      if (input.mode === 'create' && info) return fail('NAME_TAKEN', 'That Skill already exists. Use update only if you are its original author, or choose another name.');
      if (input.mode === 'update' && !info) return fail('NOT_FOUND', 'The published Skill was not found. Check its exact name.');
      if (input.mode === 'update' && info?.isCreator !== true) return fail('NOT_AUTHOR', 'Original authorship could not be confirmed. Only the original author can publish a new version of this Skill.');
      if (input.mode === 'update' && info?.canManage !== true) return fail('PERMISSION_DENIED', 'This account does not have management access to the published Skill.');

      const result = await host.publisher.publish({
        absolutePath, name: input.name, isFirstPublish: input.mode === 'create',
        displayName: input.display_name, summary: input.summary,
        description: frontmatter.description.trim(), changelog: input.changelog,
        // Ownership comes from the signed-in identity; visibleSlugs only selects the audience.
        ...(input.mode === 'create' ? { visibility, tags: input.tags, visibleSlugs: input.visible_slugs } : {}),
      }, undefined, { isCurrent: isAuthorized });
      // A committed publication remains successful even if the task closes afterwards.
      if (result.success && result.result) return {
        ok: true, name: result.result.name, version: result.result.version, status: 'uploaded',
        guidance: 'The version was uploaded. Use get_skill_publish_status to check scan/review status; upload success does not mean public approval.',
      };
      return fail(result.errorCode ?? 'INTERNAL', 'Skill upload did not complete. Check the existing version/status before retrying.');
    } catch (error) {
      if (!isCurrent()) return changed();
      const localCode = (error as NodeJS.ErrnoException)?.code;
      if (localCode === 'ENOENT' || localCode === 'ENOTDIR') return fail('NOT_FOUND', 'The local Skill folder or SKILL.md was not found.');
      return fail(host.errorCode(error), 'Could not complete the SkillHub operation. Check sign-in, access and the published version before retrying.');
    }
  };
}
