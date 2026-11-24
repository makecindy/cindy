/**
 * Visibility audience for an organization plugin publish (#1541).
 *
 * Before the confirmation screen, Main asks the server what this publish may do with the audience
 * (#1593 publish-context) and what the screen starts with. After confirmation it decides whether
 * the prepare request carries the field: only a real change is sent, so a publish never overwrites
 * someone else's edit with an unchanged copy.
 */
import { ORGANIZATION_ROLES, parseVisibilityAudience, type VisibilityAudience } from '@cindy/plugin-protocol';

import {
  COLLEAGUE_SEARCH_LIMIT,
  type AuthorMemberReference,
  type AuthorVisibilityAudience,
  type Colleague,
} from '../../shared/pluginAuthor.js';
import {
  PUBLISHER_AUDIENCE_HINT_MAX_ITEMS,
  type PluginPublisherConfirmDecision,
  type PublisherAudienceContext,
  type PublisherAudienceHint,
  type PublisherAudienceUnresolved,
  type PublisherDeniedReason,
} from '../../shared/pluginPublisher.js';
import type { PluginAuthorApi } from '../plugin-author/api.js';
import { ServerApiError } from '../serverApiClient.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COLLEAGUE_SEARCH_MAX_LENGTH = 254;
const ALL: AuthorVisibilityAudience = { type: 'all' };

export interface AudienceContextDeps {
  api: Pick<PluginAuthorApi, 'publishContext' | 'departments' | 'searchColleagues'>;
}

/** Errors the upload itself would return for anyone; publish-context answers with them first. */
function deniedReason(error: unknown): PublisherDeniedReason | null {
  if (!(error instanceof ServerApiError)) return null;
  if (error.statusCode === 403) return 'forbidden';
  if (error.statusCode !== 409) return null;
  if (error.code === 'PLUGIN_ARCHIVED') return 'archived';
  if (error.code === 'COMMON_PLUGIN_MANAGED') return 'commonManaged';
  if (error.code === 'PLUGIN_REPOSITORY_MANAGED') return 'repositoryManaged';
  return null;
}

function cleanHintList(values: readonly string[] | undefined): string[] {
  const result: string[] = [];
  for (const value of values ?? []) {
    const text = value.trim();
    if (text && !result.includes(text)) result.push(text);
    if (result.length >= PUBLISHER_AUDIENCE_HINT_MAX_ITEMS) break;
  }
  return result;
}

export function normalizeAudienceHint(hint: PublisherAudienceHint | undefined): Required<PublisherAudienceHint> | null {
  if (!hint) return null;
  const normalized = {
    departments: cleanHintList(hint.departments),
    members: cleanHintList(hint.members),
    emails: cleanHintList(hint.emails),
  };
  return normalized.departments.length + normalized.members.length + normalized.emails.length > 0 ? normalized : null;
}

/**
 * Matches the names the user said to exactly one department or active member. Fuzzy server
 * search results only count when the name or email matches exactly; several exact matches are
 * "ambiguous" and left for the user to pick. Unmatched names are reported, never guessed.
 */
export async function resolveAudienceHint(
  api: AudienceContextDeps['api'],
  hint: Required<PublisherAudienceHint>,
  signal: AbortSignal,
): Promise<{
  departmentIds: string[];
  members: AuthorMemberReference[];
  emails: string[];
  unresolved: PublisherAudienceUnresolved[];
}> {
  const unresolved: PublisherAudienceUnresolved[] = [];
  const departmentIds: string[] = [];
  const members: AuthorMemberReference[] = [];
  const emails: string[] = [];

  if (hint.departments.length > 0) {
    let departments: Awaited<ReturnType<PluginAuthorApi['departments']>> | null = null;
    try {
      departments = await api.departments(signal);
    } catch {
      departments = null;
    }
    for (const text of hint.departments) {
      const matches = (departments ?? []).filter((department) => department.name.trim() === text);
      if (matches.length === 1) {
        if (!departmentIds.includes(matches[0].id)) departmentIds.push(matches[0].id);
      } else {
        unresolved.push({ kind: 'department', text, reason: matches.length > 1 ? 'ambiguous' : 'not_found' });
      }
    }
  }

  for (const text of hint.members) {
    let found: Colleague[] = [];
    let truncated = false;
    try {
      // The colleague search accepts at most 254 characters; longer text cannot match anyone.
      if (text.length <= COLLEAGUE_SEARCH_MAX_LENGTH) {
        const results = await api.searchColleagues(text, signal);
        // The server returns at most COLLEAGUE_SEARCH_LIMIT people, not ordered by relevance:
        // a full page may hide another person with the same name.
        truncated = results.length >= COLLEAGUE_SEARCH_LIMIT;
        found = results.filter((member) => member.active);
      }
    } catch {
      found = [];
    }
    const lower = text.toLowerCase();
    // Text shaped like an email is an email: only an exact email matches, never a display name
    // that happens to equal it.
    const isEmail = EMAIL_PATTERN.test(text);
    const matches = isEmail
      ? found.filter((member) => member.email?.toLowerCase() === lower)
      : found.filter((member) => member.displayName?.trim() === text);
    if (truncated && !isEmail) {
      // Only an exact email is certain on a full page; a name may belong to someone not shown.
      unresolved.push({ kind: 'member', text, reason: 'ambiguous' });
    } else if (matches.length === 1) {
      const [match] = matches;
      if (!members.some((member) => member.membershipId === match.membershipId)) {
        members.push({ membershipId: match.membershipId, displayName: match.displayName, email: match.email });
      }
    } else if (matches.length === 0 && isEmail) {
      // A full email with no active member still matches whoever joins with it.
      if (!emails.includes(lower)) emails.push(lower);
    } else {
      unresolved.push({ kind: 'member', text, reason: matches.length > 1 ? 'ambiguous' : 'not_found' });
    }
  }

  for (const text of hint.emails) {
    const lower = text.toLowerCase();
    if (EMAIL_PATTERN.test(lower)) {
      if (!emails.includes(lower)) emails.push(lower);
    } else {
      unresolved.push({ kind: 'email', text, reason: 'not_found' });
    }
  }
  return { departmentIds, members, emails, unresolved };
}

/**
 * Reads what the confirmation screen may do with the audience (#1593 publish-context). Never throws:
 * an upload that would fail for anyone is `denied`; any other read failure keeps the current
 * audience untouched.
 */
export async function loadPublisherAudienceContext(
  deps: AudienceContextDeps,
  input: { ghostId: string; hint?: PublisherAudienceHint },
  signal: AbortSignal,
): Promise<PublisherAudienceContext> {
  const hint = normalizeAudienceHint(input.hint);
  // An explicit request the screen cannot honour must stop the publish, never keep the audience.
  const keep = (reason?: 'legacyRoles'): PublisherAudienceContext =>
    hint ? { kind: 'blocked', reason: reason ?? 'locked' } : { kind: 'locked', ...(reason ? { reason } : {}) };
  let context: Awaited<ReturnType<PluginAuthorApi['publishContext']>>;
  try {
    context = await deps.api.publishContext(input.ghostId, signal);
  } catch (error) {
    const reason = deniedReason(error);
    return reason ? { kind: 'denied', reason } : keep();
  }
  let current: AuthorVisibilityAudience = ALL;
  let members: AuthorMemberReference[] = [];
  const isNew = !context.exists;
  if (context.exists) {
    // Not the creator, a maintainer or a plugin manager: the audience is neither shown nor sent.
    if (!context.canEdit) return keep();
    current = context.visibilityAudience;
    // The upload parses roles strictly, so an audience with role names outside the five current
    // ones cannot be resent or changed here; the author changes it in plugin details after
    // publishing, where the PATCH keeps legacy roles.
    if (hasLegacyRoles(current)) return keep('legacyRoles');
    members = context.visibilityAudienceMembers;
  }

  if (!hint) return { kind: 'editable', isNew, current, initial: current, members, unresolved: [] };
  const resolved = await resolveAudienceHint(deps.api, hint, signal);
  const initial: AuthorVisibilityAudience | { type: 'matchAny' } = {
    type: 'matchAny',
    ...(resolved.departmentIds.length ? { departmentIds: resolved.departmentIds } : {}),
    ...(resolved.members.length ? { membershipIds: resolved.members.map((member) => member.membershipId) } : {}),
    ...(resolved.emails.length ? { emails: resolved.emails } : {}),
  };
  const known = new Map([...members, ...resolved.members].map((member) => [member.membershipId, member]));
  return {
    kind: 'editable',
    isNew,
    current,
    initial,
    members: [...known.values()],
    unresolved: resolved.unresolved,
  };
}

function hasLegacyRoles(audience: AuthorVisibilityAudience): boolean {
  return audience.type === 'matchAny' &&
    (audience.roles ?? []).some((role) => !(ORGANIZATION_ROLES as readonly string[]).includes(role));
}

/** Thrown when the user's choice cannot be sent as a valid audience. */
export class PublisherAudienceInvalidError extends Error {}

/**
 * The audience to put on the prepare request, or undefined to leave the plugin's audience as is.
 * Sends only a real change, so an unchanged copy never overwrites someone else's edit.
 */
export function audienceToSend(
  context: PublisherAudienceContext | null,
  decision: PluginPublisherConfirmDecision,
): VisibilityAudience | undefined {
  if (!context || context.kind !== 'editable' || decision.visibilityAudience === undefined) return undefined;
  // Unchanged even if the stored value carries conditions this client cannot validate.
  if (looseAudienceKey(decision.visibilityAudience) === looseAudienceKey(context.current)) return undefined;
  let chosen: VisibilityAudience;
  try {
    // Roles already on the plugin may be kept or removed (even legacy names); none may be added.
    const existingRoles = context.current.type === 'matchAny' ? context.current.roles ?? [] : [];
    chosen = parseVisibilityAudience(decision.visibilityAudience, 'visibilityAudience', { existingRoles });
  } catch {
    throw new PublisherAudienceInvalidError('Invalid visibility audience');
  }
  if (context.isNew && chosen.type === 'all') return undefined;
  if (looseAudienceKey(chosen) === looseAudienceKey(context.current)) return undefined;
  return chosen;
}

/** Order-insensitive comparison key that does not validate; emails compare case-insensitively. */
function looseAudienceKey(audience: AuthorVisibilityAudience): string {
  if (audience.type === 'all') return 'all';
  const list = (values: readonly string[] | undefined, lower = false) =>
    [...new Set((values ?? []).map((value) => (lower ? value.toLowerCase() : value)))].sort();
  return JSON.stringify([
    list(audience.membershipIds),
    list(audience.departmentIds),
    list(audience.emails, true),
    list(audience.roles),
  ]);
}
