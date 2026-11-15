import { ipcMain } from 'electron';
import { z } from 'zod';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import * as host from './host.js';
import { reviewUpdates, markReviewRead } from './reviewUpdates.js';

let registered = false;
const id = z.string().min(1).max(256);
export function registerPluginContributionsIpc(): void {
  if (registered) return;
  registered = true;
  const handle = <S extends z.ZodTypeAny>(
    name: string,
    schema: S,
    action: (input: z.infer<S>) => unknown,
  ) => {
    ipcMain.handle(`plugin-contributions:${name}`, async (event, raw: unknown) => {
      assertTrustedAppRendererEvent(event);
      const parsed = schema.safeParse(raw);
      if (!parsed.success) throwIpcError('INVALID_PARAMS', 'Invalid contribution request');
      try {
        return await action(parsed.data);
      } catch (error) {
        host.mapContributionError(error);
      }
    });
  };
  handle(
    'prepare',
    z
      .object({
        instanceId: id,
        expected: z
          .object({ directory: z.string().min(1).max(4096), approvalToken: id })
          .strict()
          .optional(),
      })
      .strict(),
    ({ instanceId, expected }) => host.prepareContribution(instanceId, 'manual', expected),
  );
  handle('submit', id, host.submitContribution);
  handle('status', id, host.contributionTransferStatus);
  handle('cancel', id, host.cancelContribution);
  handle(
    'cancel-review',
    z
      .object({
        pluginId: id,
        release: z
          .object({
            releaseId: id,
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            revision: z.string().datetime(),
          })
          .strict(),
      })
      .strict(),
    ({ pluginId, release }) => host.cancelPluginReview(pluginId, release),
  );
  handle('set-anonymity', z.object({ pluginId: id, anonymous: z.boolean() }).strict(),
    ({ pluginId, anonymous }) => host.setPluginAnonymity(pluginId, anonymous));
  handle('discard', id, host.discardContribution);
  handle('review-updates', z.undefined(), reviewUpdates);
  handle('mark-review-read', z.object({ pluginId: id, key: z.string().min(1).max(1024) }).strict(),
    ({ pluginId, key }) => markReviewRead(pluginId, key));
  handle(
    'list',
    z
      .object({
        query: z.string().max(200),
        filter: z.enum(['all', 'pending', 'needs_action', 'published']),
        cursor: z.string().max(4096).optional(),
      })
      .strict(),
    host.listMyPlugins,
  );
  handle(
    'submission',
    z.object({ pluginId: id, submissionId: id }).strict(),
    ({ pluginId, submissionId }) => host.myPluginSubmission(pluginId, submissionId),
  );
  handle(
    'releases',
    z.object({ pluginId: id, cursor: z.string().max(4096).optional() }).strict(),
    ({ pluginId, cursor }) => host.myPluginReleases(pluginId, cursor),
  );
  handle(
    'detail',
    z.object({ pluginId: id, cursor: z.string().max(4096).optional() }).strict(),
    ({ pluginId, cursor }) => host.myPluginDetail(pluginId, cursor),
  );
}
