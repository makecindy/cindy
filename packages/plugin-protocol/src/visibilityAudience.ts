import { PluginProtocolError } from './internal/parse.js';

/**
 * Organization plugin visibility audience.
 *
 * Mirrors plugin-server `management/types.ts` `VisibilityAudience` and the rules of its
 * `parseVisibilityAudience`. The server stays authoritative; this copy lets the client refuse
 * to send a value the server would reject, and gives both repositories the same fixtures.
 */

/** Organization role names accepted by plugin policy writers. */
export const ORGANIZATION_ROLES = ['owner', 'admin', 'finance', 'department_manager', 'member'] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export type VisibilityAudience =
  | { type: 'all' }
  | {
      type: 'matchAny';
      membershipIds?: string[];
      /** Cindy department IDs; matches current members of these departments and descendants. */
      departmentIds?: string[];
      emails?: string[];
      /** Legacy condition: shown and removable, never newly added by authors. */
      roles?: OrganizationRole[];
    };

export const VISIBILITY_AUDIENCE_MAX_ITEMS = 500;
const MEMBERSHIP_ID_MAX_LENGTH = 128;
const DEPARTMENT_ID_MAX_LENGTH = 191;
/** Longest email the server accepts in an audience; it checks no other email format. */
export const VISIBILITY_AUDIENCE_EMAIL_MAX_LENGTH = 320;

function stringArray(value: unknown, path: string, maxItemLength: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > VISIBILITY_AUDIENCE_MAX_ITEMS) {
    throw new PluginProtocolError(`${path} 必须是最多 ${VISIBILITY_AUDIENCE_MAX_ITEMS} 项的数组`);
  }
  const values = value.map((item, index) => {
    if (typeof item !== 'string' || item.length === 0 || item.length > maxItemLength) {
      throw new PluginProtocolError(`${path}[${index}] 必须是 1–${maxItemLength} 字符的字符串`);
    }
    return item;
  });
  return [...new Set(values)].sort();
}

/**
 * Validates and normalizes an audience exactly like plugin-server: arrays are de-duplicated and
 * sorted, emails lowercased, empty arrays dropped, and `matchAny` needs at least one item.
 *
 * `existingRoles` (the roles already on the plugin) switches to the author rule of plugin-server
 * `preservesLegacyAudience`: existing role conditions may be kept or removed, whatever their
 * name, but no role may be added.
 */
export function parseVisibilityAudience(
  value: unknown,
  path = 'visibilityAudience',
  options: { existingRoles?: readonly string[] } = {},
): VisibilityAudience {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PluginProtocolError(`${path} 必须是对象`);
  }
  const raw = value as Record<string, unknown>;
  if ('departmentUnitIds' in raw) {
    throw new PluginProtocolError(`${path} 不支持 departmentUnitIds，请使用 Cindy departmentIds`);
  }
  if (raw.type === 'all') return { type: 'all' };
  if (raw.type !== 'matchAny') {
    throw new PluginProtocolError(`${path}.type 仅支持 all / matchAny`);
  }
  const membershipIds = stringArray(raw.membershipIds, `${path}.membershipIds`, MEMBERSHIP_ID_MAX_LENGTH);
  const departmentIds = stringArray(raw.departmentIds, `${path}.departmentIds`, DEPARTMENT_ID_MAX_LENGTH);
  const rawEmails = stringArray(raw.emails, `${path}.emails`, VISIBILITY_AUDIENCE_EMAIL_MAX_LENGTH);
  const emails = rawEmails ? [...new Set(rawEmails.map((email) => email.toLowerCase()))].sort() : undefined;
  let roles: OrganizationRole[] | undefined;
  if (raw.roles !== undefined) {
    if (!Array.isArray(raw.roles) || raw.roles.length > VISIBILITY_AUDIENCE_MAX_ITEMS) {
      throw new PluginProtocolError(`${path}.roles 必须是最多 ${VISIBILITY_AUDIENCE_MAX_ITEMS} 项的数组`);
    }
    const existing = options.existingRoles;
    roles = [...new Set(raw.roles.map((role, index) => {
      if (existing) {
        if (typeof role !== 'string' || !existing.includes(role)) {
          throw new PluginProtocolError(`${path}.roles[${index}] 不能新增按角色匹配的条件`);
        }
        return role as OrganizationRole;
      }
      if (!(ORGANIZATION_ROLES as readonly unknown[]).includes(role)) {
        throw new PluginProtocolError(`${path}.roles[${index}] 非法`);
      }
      return role as OrganizationRole;
    }))].sort();
  }
  if ((membershipIds?.length ?? 0) + (departmentIds?.length ?? 0) + (emails?.length ?? 0) + (roles?.length ?? 0) === 0) {
    throw new PluginProtocolError(`${path}.matchAny 至少包含一个匹配项`);
  }
  return {
    type: 'matchAny',
    ...(membershipIds?.length ? { membershipIds } : {}),
    ...(departmentIds?.length ? { departmentIds } : {}),
    ...(emails?.length ? { emails } : {}),
    ...(roles?.length ? { roles } : {}),
  };
}

/** Compares two audiences after normalization; an unparsable value never equals anything. */
export function sameVisibilityAudience(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(parseVisibilityAudience(left)) === JSON.stringify(parseVisibilityAudience(right));
  } catch {
    return false;
  }
}
