import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';
import type { FeishuIM } from '@cindy/im';
import { buildFeishuAdapter as buildSharedAdapter, type FeishuAdapterOptions } from '@cindy/im-runtime/channels/feishu/adapter';
import type { ImOrchestratorConfig } from '../shared/types';
import { readImDefaultSettings } from '../defaultSettingsStore';
import { claimLegacyImPath, ownerScopedImUserDataPath } from '../ownerScopedStorage';
import { createLogger } from '../../logger';
import { resolveFeishuNotificationReply } from './notificationOrigin';
import { ui } from './uiText';
export { feishuToolsHint, type FeishuAdapterOptions } from '@cindy/im-runtime/channels/feishu/adapter';
const log = createLogger('im:feishu-adapter');
export function buildFeishuAdapter(im: FeishuIM, config: ImOrchestratorConfig, options: FeishuAdapterOptions = {}) {
  return buildSharedAdapter(im, config, {
    log, ui, readImDefaultSettings, resolveFeishuNotificationReply,
    ensureWorkingDir: botAppId => {
      const dir = ownerScopedImUserDataPath('im-working-dir', botAppId);
      claimLegacyImPath(path.join(app.getPath('userData'), 'im-working-dir', botAppId), dir);
      fs.mkdirSync(dir, { recursive: true }); return dir;
    },
    requestUtilityText: async (prompt, options) => {
      const [{ requestUtilityText }, { getMaker }] = await Promise.all([
        import('../../utility-model/oneShotCandidates.js'), import('../../maker-host/index.js'),
      ]);
      return requestUtilityText(getMaker(), prompt, options);
    },
  }, options);
}
