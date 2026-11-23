/**
 * Organization plugin author IPC: colleague / department picker for the visibility audience and
 * the author's own plugin management (#1541). Desktop-only: these screens live in desktop
 * dialogs and pages, so the channels are not on the device-link allowlist.
 */
import { ipcMain } from 'electron';
import { z } from 'zod';

import { parseVisibilityAudience, PluginProtocolError } from '@cindy/plugin-protocol';

import { isIpcError, isIpcErrorCode } from '../../shared/ipc-errors.js';
import { visibilityAudienceSchema } from '../../shared/pluginAuthor.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { ServerApiError } from '../serverApiClient.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { PluginAuthorUnsupportedError, type PluginAuthorApi } from './api.js';
import { createPluginAuthorApi } from './host.js';
import { organizationReviewUpdates } from '../plugin-contributions/reviewUpdates.js';

/** Maps author/picker failures to stable IPC codes without leaking server details. */
export function mapPluginAuthorError(error: unknown): never {
  // Only the list probe and the change signal decide "older server"; they throw this error.
  // A 404 anywhere else is a business answer (plugin or version not found).
  if (error instanceof PluginAuthorUnsupportedError) {
    throwIpcError('UNSUPPORTED_CAPABILITY', 'Plugin author features are not available on this server');
  }
  // Checked before IPC errors: server codes can look like IPC codes but carry server messages.
  if (error instanceof ServerApiError) {
    if (error.statusCode === 0) throwIpcError('INTERNAL', 'Network unavailable');
    if (isIpcErrorCode(error.code)) throwIpcError(error.code, 'Plugin author request failed');
    if (error.statusCode === 403) throwIpcError('PERMISSION_DENIED', 'Plugin author request denied');
    if (error.statusCode === 404) throwIpcError('NOT_FOUND', 'Plugin author resource not found');
    throwIpcError('INTERNAL', 'Plugin author request failed');
  }
  if (isIpcError(error)) throw error;
  throwIpcError('INTERNAL', 'Plugin author request failed');
}

const departmentId = z.string().min(1).max(191);
const resourceId = z.string().min(1).max(256);

/** Author management handlers (#1504 permission table); the server enforces creator/maintainer roles. */
export function createPluginAuthorManagementHandlers(api: () => PluginAuthorApi) {
  return {
    listPlugins: (raw: unknown) => api().listPages(z.string().min(1).max(4096).optional().parse(raw) ?? null),
    plugin: (raw: unknown) => api().detail(resourceId.parse(raw)),
    updatePlugin: (raw: unknown) => {
      const input = z.object({
        pluginId: resourceId,
        update: z.union([
          z.object({ visibilityAudience: visibilityAudienceSchema }).strict(),
          z.object({ status: z.enum(['active', 'disabled']) }).strict(),
        ]),
      }).strict().parse(raw);
      const update = input.update;
      if (!('visibilityAudience' in update)) return api().update(input.pluginId, update);
      const audience = update.visibilityAudience;
      if (audience.type !== 'matchAny' || !audience.roles?.length) {
        parseVisibilityAudience(audience);
        return api().update(input.pluginId, update);
      }
      // Same rule as the server: role conditions already on the plugin may stay (even legacy
      // names); adding one is refused. Read the current audience to know which roles exist.
      return api().detail(input.pluginId).then((current) => {
        const existingRoles = current.visibilityAudience?.type === 'matchAny' ? current.visibilityAudience.roles ?? [] : [];
        parseVisibilityAudience(audience, 'visibilityAudience', { existingRoles });
        return api().update(input.pluginId, update);
      });
    },
    cancelReview: (raw: unknown) => {
      const input = z.object({ pluginId: resourceId, releaseId: resourceId }).strict().parse(raw);
      return api().cancelReview(input.pluginId, input.releaseId);
    },
    releases: (raw: unknown) => {
      const input = z.object({ pluginId: resourceId, cursor: z.string().min(1).max(4096).optional() }).strict().parse(raw);
      return api().releases(input.pluginId, input.cursor);
    },
    maintainers: (raw: unknown) => api().maintainers(resourceId.parse(raw)),
    addMaintainer: (raw: unknown) => {
      const input = z.object({ pluginId: resourceId, membershipId: z.string().min(1).max(191) }).strict().parse(raw);
      return api().addMaintainer(input.pluginId, input.membershipId);
    },
    removeMaintainer: (raw: unknown) => {
      const input = z.object({ pluginId: resourceId, authorizationId: resourceId }).strict().parse(raw);
      return api().removeMaintainer(input.pluginId, input.authorizationId);
    },
  };
}

export function createPluginAuthorPickerHandlers(api: () => PluginAuthorApi) {
  return {
    departments: () => api().departments(),
    departmentMembers: (raw: unknown) => {
      const input = z.object({ departmentId, page: z.number().int().min(1).max(10_000) }).strict().parse(raw);
      return api().departmentMembers(input.departmentId, input.page);
    },
    searchColleagues: (raw: unknown) => {
      const query = z.string().trim().min(1).max(254).parse(raw);
      return api().searchColleagues(query);
    },
    lookupColleagues: (raw: unknown) => {
      const ids = z.array(z.string().min(1).max(128)).min(1).max(500).parse(raw);
      return api().lookupColleagues(ids);
    },
  };
}

let registered = false;

export function registerPluginAuthorIpc(): void {
  if (registered) return;
  registered = true;
  const handlers = createPluginAuthorPickerHandlers(createPluginAuthorApi);
  const management = createPluginAuthorManagementHandlers(createPluginAuthorApi);
  const handle = (name: string, action: (raw: unknown) => unknown) => {
    ipcMain.handle(`plugin-author:${name}`, async (event, raw: unknown) => {
      assertTrustedAppRendererEvent(event);
      try {
        return await action(raw);
      } catch (error) {
        if (error instanceof z.ZodError || error instanceof PluginProtocolError) {
          throwIpcError('INVALID_PARAMS', 'Invalid plugin author request');
        }
        mapPluginAuthorError(error);
      }
    });
  };
  handle('departments', () => handlers.departments());
  handle('department-members', handlers.departmentMembers);
  handle('search-colleagues', handlers.searchColleagues);
  handle('lookup-colleagues', handlers.lookupColleagues);
  handle('list-plugins', management.listPlugins);
  handle('review-updates', () => organizationReviewUpdates());
  handle('plugin', management.plugin);
  handle('update-plugin', management.updatePlugin);
  handle('cancel-review', management.cancelReview);
  handle('releases', management.releases);
  handle('maintainers', management.maintainers);
  handle('add-maintainer', management.addMaintainer);
  handle('remove-maintainer', management.removeMaintainer);
}
