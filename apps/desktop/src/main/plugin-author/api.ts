/**
 * Organization plugin author and colleague-picker HTTP client (cindy-server #1553, #1593).
 *
 * Uses the account Access Token (org context), never the publisher Connection JWT. Every read is
 * bound to the account that started it: a response that arrives after the account, organization
 * or data owner changed is dropped with OWNER_CHANGED. Only the list probe tells a server without
 * author routes (a generic 404) apart, so the page can hide team sharing there.
 */
import { z } from 'zod';

import {
  cancelledReleaseSchema,
  COLLEAGUE_LOOKUP_MAX,
  maintainerAddedSchema,
  maintainerListSchema,
  colleagueSearchSchema,
  departmentListSchema,
  departmentMembersSchema,
  personalPluginDetailSchema,
  publishContextSchema,
  personalPluginChangesSchema,
  personalPluginListSchema,
  personalReleaseListSchema,
  type AuthorDepartment,
  type Colleague,
  type PersonalPluginChanges,
  type PersonalPluginDetail,
  type PersonalPublishContext,
  type PersonalPluginPage,
  type PersonalPluginSummary,
  type PersonalPluginUpdate,
  type PersonalReleasePage,
  type PluginMaintainer,
} from '../../shared/pluginAuthor.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { ServerApiError, type ApiFetchOptions } from '../serverApiClient.js';

const AUTHOR_API_TIMEOUT_MS = 15_000;
/** Author lists are small; this bounds a runaway cursor chain. */
const MAX_LIST_PAGES = 20;
const LIST_PAGE_LIMIT = 100;

/** Business codes allowed through the redacted error boundary. */
export const PLUGIN_AUTHOR_ERROR_CODES = [
  'NOT_FOUND',
  'PLUGIN_NOT_FOUND',
  'RELEASE_NOT_FOUND',
  'INVALID_PARAMS',
  'FORBIDDEN',
  'ORG_CONTEXT_REQUIRED',
  'RATE_LIMITED',
  'PLUGIN_ARCHIVED',
  'PLUGIN_DISABLED_BY_ADMIN',
  'PLUGIN_REVIEW_REQUIRED',
  'PLUGIN_REVIEW_STATE_CHANGED',
  'PLUGIN_REVIEW_FINAL',
  'COMMON_PLUGIN_MANAGED',
  'PLUGIN_REPOSITORY_MANAGED',
  'PLUGIN_GHOST_ID_CONFLICT',
  'PLUGIN_AUDIENCE_VALIDATION_UNAVAILABLE',
  'PLUGIN_MEMBER_LOOKUP_UNAVAILABLE',
] as const;

/** The server predates author APIs (#1553): the route itself does not exist. */
export class PluginAuthorUnsupportedError extends Error {
  constructor() {
    super('Plugin author APIs are not available on this server');
    this.name = 'PluginAuthorUnsupportedError';
  }
}

export type AuthorFetch = <T>(apiPath: string, options: ApiFetchOptions) => Promise<T>;

export interface PluginAuthorApiDeps {
  fetch: AuthorFetch;
  pluginBaseUrl(): string;
  authBaseUrl(): string;
  clientVersion(): string;
  /** Identity of the signed-in org member; null when not an organization member. */
  ownerKey(): string | null;
}

export function isUnsupportedAuthorRoute(error: unknown): boolean {
  return (
    error instanceof ServerApiError &&
    (error.statusCode === 404 || error.statusCode === 405) &&
    error.code !== 'PLUGIN_NOT_FOUND'
  );
}

function pluginPath(pluginId: string): string {
  return `/api/personal/plugins/${encodeURIComponent(pluginId)}`;
}

export class PluginAuthorApi {
  constructor(private readonly deps: PluginAuthorApiDeps) {}

  private owner(): string {
    const owner = this.deps.ownerKey();
    if (!owner) throwIpcError('PERMISSION_DENIED', 'Organization membership required');
    return owner;
  }

  private async request<S extends z.ZodTypeAny>(
    base: 'plugin' | 'auth',
    apiPath: string,
    schema: S,
    logLabel: string,
    init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<z.infer<S>> {
    const owner = this.owner();
    const raw = await this.deps.fetch<unknown>(apiPath, {
      baseUrl: base === 'plugin' ? this.deps.pluginBaseUrl : this.deps.authBaseUrl,
      method: init.method ?? 'GET',
      ...(init.body !== undefined ? { body: init.body } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
      headers: { 'x-cindy-version': this.deps.clientVersion() },
      cache: 'no-store',
      timeoutMs: AUTHOR_API_TIMEOUT_MS,
      redactErrorDetails: true,
      logLabel,
      allowedRedactedErrorCodes: PLUGIN_AUTHOR_ERROR_CODES,
      // Runs before every physical request, including the resend after a 401 refresh: a refresh
      // that switched the account must not let this request go out under the new identity.
      beforeHop: () => {
        if (this.deps.ownerKey() !== owner) throwIpcError('OWNER_CHANGED', 'Account changed');
      },
      expectedErrors: [{ status: 404, code: 'NOT_FOUND' }],
    });
    if (this.deps.ownerKey() !== owner) throwIpcError('OWNER_CHANGED', 'Account changed');
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throwIpcError('PRECONDITION_FAILED', 'Invalid plugin author response');
    return parsed.data;
  }

  /**
   * Organization plugins the member creates or maintains, reading up to MAX_LIST_PAGES server
   * pages from `cursor`. A non-null `nextCursor` means more remain; callers continue explicitly
   * instead of the list being truncated silently. Throws PluginAuthorUnsupportedError on
   * servers without author routes.
   */
  async listPages(cursor: string | null = null, signal?: AbortSignal): Promise<PersonalPluginPage> {
    const plugins: PersonalPluginSummary[] = [];
    const seen = new Set<string>();
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const query = new URLSearchParams({ limit: String(LIST_PAGE_LIMIT) });
      if (cursor) query.set('cursor', cursor);
      let response: z.infer<typeof personalPluginListSchema>;
      try {
        response = await this.request('plugin', `/api/personal/plugins?${query}`, personalPluginListSchema,
          '/api/personal/plugins', { signal });
      } catch (error) {
        if (isUnsupportedAuthorRoute(error)) throw new PluginAuthorUnsupportedError();
        throw error;
      }
      plugins.push(...response.plugins);
      cursor = response.nextCursor;
      if (!cursor) return { plugins, nextCursor: null };
      if (seen.has(cursor)) throwIpcError('PRECONDITION_FAILED', 'Repeated plugin author cursor');
      seen.add(cursor);
    }
    return { plugins, nextCursor: cursor };
  }

  /**
   * Cheap change signal for review results. Servers without it answer 404 — older author
   * servers route `/changes` as a plugin id — so any 404 means "no review signal available".
   */
  async changes(signal?: AbortSignal): Promise<PersonalPluginChanges> {
    return this.request('plugin', '/api/personal/plugins/changes', personalPluginChangesSchema,
      '/api/personal/plugins/changes', { signal });
  }

  /**
   * What publishing this ghostId may do with the audience (#1593). Errors that would fail the
   * upload for anyone (403 member publishing off, 409 archived / common / repository managed) are
   * thrown as the upload would throw them.
   */
  async publishContext(ghostId: string, signal?: AbortSignal): Promise<PersonalPublishContext> {
    return this.request('plugin', `/api/personal/plugins/publish-context?${new URLSearchParams({ ghostId })}`,
      publishContextSchema, '/api/personal/plugins/publish-context', { signal });
  }

  async detail(pluginId: string, signal?: AbortSignal): Promise<PersonalPluginDetail> {
    const response = await this.request('plugin', pluginPath(pluginId),
      personalPluginDetailSchema, '/api/personal/plugins/detail', { signal });
    if (response.plugin.id !== pluginId) throwIpcError('PRECONDITION_FAILED', 'Plugin author response mismatch');
    return response.plugin;
  }

  async update(pluginId: string, update: PersonalPluginUpdate): Promise<PersonalPluginDetail> {
    const response = await this.request('plugin', pluginPath(pluginId), personalPluginDetailSchema,
      '/api/personal/plugins/update', { method: 'PATCH', body: update });
    if (response.plugin.id !== pluginId) throwIpcError('PRECONDITION_FAILED', 'Plugin author response mismatch');
    return response.plugin;
  }

  /** Version history, newest first, with each version's review result when the server has it. */
  async releases(pluginId: string, cursor?: string): Promise<PersonalReleasePage> {
    const query = new URLSearchParams({ limit: '50' });
    if (cursor) query.set('cursor', cursor);
    return this.request('plugin', `${pluginPath(pluginId)}/releases?${query}`, personalReleaseListSchema,
      '/api/personal/plugins/releases');
  }

  async cancelReview(pluginId: string, releaseId: string): Promise<void> {
    const response = await this.request('plugin',
      `${pluginPath(pluginId)}/releases/${encodeURIComponent(releaseId)}/cancel-review`, cancelledReleaseSchema,
      '/api/personal/plugins/cancel-review', { method: 'POST', body: {} });
    if (response.release.id !== releaseId) throwIpcError('PRECONDITION_FAILED', 'Plugin author response mismatch');
  }

  async maintainers(pluginId: string): Promise<PluginMaintainer[]> {
    const response = await this.request('plugin', `${pluginPath(pluginId)}/maintainers`, maintainerListSchema,
      '/api/personal/plugins/maintainers');
    return response.maintainers;
  }

  async addMaintainer(pluginId: string, membershipId: string): Promise<PluginMaintainer> {
    try {
      const response = await this.request('plugin', `${pluginPath(pluginId)}/maintainers`, maintainerAddedSchema,
        '/api/personal/plugins/maintainers', { method: 'POST', body: { membershipId } });
      return response.maintainer;
    } catch (error) {
      // The server reports an existing maintainer grant as a conflict.
      if (error instanceof ServerApiError && error.code === 'PLUGIN_GHOST_ID_CONFLICT') {
        throwIpcError('PLUGIN_MAINTAINER_EXISTS', 'Already a maintainer');
      }
      throw error;
    }
  }

  async removeMaintainer(pluginId: string, authorizationId: string): Promise<void> {
    try {
      await this.request('plugin', `${pluginPath(pluginId)}/maintainers/${encodeURIComponent(authorizationId)}`,
        z.unknown(), '/api/personal/plugins/maintainers', { method: 'DELETE' });
    } catch (error) {
      // 204 No Content has no JSON body; the shared client reports it as an empty response.
      if (error instanceof ServerApiError && error.code === 'EMPTY_RESPONSE' && error.statusCode === 204) return;
      throw error;
    }
  }

  async departments(signal?: AbortSignal): Promise<AuthorDepartment[]> {
    const response = await this.request('auth', '/api/me/skill-audience-departments', departmentListSchema,
      '/api/me/skill-audience-departments', { signal });
    return response.departments;
  }

  async departmentMembers(departmentId: string, page: number, signal?: AbortSignal) {
    const query = new URLSearchParams({ departmentId, page: String(page) });
    return this.request('auth', `/api/me/colleagues?${query}`, departmentMembersSchema,
      '/api/me/colleagues', { signal });
  }

  async searchColleagues(q: string, signal?: AbortSignal): Promise<Colleague[]> {
    const query = new URLSearchParams({ q });
    const response = await this.request('auth', `/api/me/colleagues?${query}`, colleagueSearchSchema,
      '/api/me/colleagues', { signal });
    return response.members;
  }

  async lookupColleagues(membershipIds: readonly string[], signal?: AbortSignal): Promise<Colleague[]> {
    const unique = [...new Set(membershipIds)];
    const members: Colleague[] = [];
    for (let index = 0; index < unique.length; index += COLLEAGUE_LOOKUP_MAX) {
      const response = await this.request('auth', '/api/me/colleagues/lookup', colleagueSearchSchema,
        '/api/me/colleagues/lookup', {
          method: 'POST',
          body: { membershipIds: unique.slice(index, index + COLLEAGUE_LOOKUP_MAX) },
          signal,
        });
      members.push(...response.members);
    }
    return members;
  }
}
