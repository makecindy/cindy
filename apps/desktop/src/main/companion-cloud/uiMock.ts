/** Optional service fixture for the real Desktop --mock companion route. */
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { getActiveAppSession, LOCAL_DATA_OWNER_ID } from '../appSessionState.js';
import { isUiMockDataEnabled } from '../localDb/uiMockSeed.js';
import { createBotProfile } from '../localDb/ipc/bots.js';
import { BotProfileSourceTooLong, readBotProfileSource } from '../../shared/botProfileSources.js';
import type { CompanionCloudActionResult, CompanionCloudSnapshot } from '../../shared/companionCloud.js';

const BOT_ID = 'ui-mock-profile-recovery';
let restored = false;

/** Missing fixture is the ordinary mock mode. Only the isolated, local-owner sandbox can opt in. */
export function companionProfileUiMock() {
  if (app.isPackaged || !isUiMockDataEnabled() || process.env.XDT_ISOLATED !== '1'
    || getActiveAppSession().dataOwnerId !== LOCAL_DATA_OWNER_ID) return undefined;
  let source: unknown;
  try {
    source = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'ui-mock', 'companion-profile.json'), 'utf8')).soul;
  } catch { return undefined; }
  if (typeof source !== 'string') return undefined;
  const soul = source;
  const failure = { field: 'identitySource' as const, maxLength: 12000 };
  return {
    botId: BOT_ID,
    snapshot: (): CompanionCloudSnapshot => ({ enabled: true, selfDeviceId: 'ui-mock-desk', humanActorId: 'ui-mock-human',
      demotedBotIds: restored ? [] : [BOT_ID], actors: [{ id: 'ui-mock-profile-actor', externalId: BOT_ID, name: 'Profile recovery',
        avatar: null, homeDeviceId: 'ui-mock-desk', homeDevice: { deviceId: 'ui-mock-desk', name: 'Mock desktop', isSelf: true, online: true },
        ...(!restored ? { profileFailure: failure } : {}) }] }),
    async takeOver(): Promise<CompanionCloudActionResult> {
      try {
        readBotProfileSource(soul, 'identitySource');
        await createBotProfile({ id: BOT_ID, name: 'Profile recovery', identitySource: soul });
        restored = true;
        return { ok: true };
      } catch (error) {
        return error instanceof BotProfileSourceTooLong ? { ok: false, code: 'FAILED', profileFailure: error.failure } : { ok: false, code: 'FAILED' };
      }
    },
    transcript: { messages: [{ id: 'ui-mock-profile-message', seq: '1', role: 'user' as const,
      text: 'This saved conversation remains available while the profile is being corrected.', createdAt: 1 }] },
  };
}
