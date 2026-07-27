/**
 * Locks the real Electron desktop path for device-link voice channels.
 *
 * Mobile voice credential sync itself is removed (mobile voice input now uses
 * the managed Cindy voice service); the channel stays matched so old mobile
 * builds get a readable rejection. This source guard prevents a future
 * bootstrap refactor from leaving dispatch unreachable from the running
 * desktop DeviceLinkClient.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const mainRoot = resolve(__dirname, '..');

describe('mobile voice credential sync desktop bootstrap path', () => {
  it('starts device-link service from Electron bootstrap', () => {
    const bootstrap = readFileSync(resolve(mainRoot, 'bootstrap-electron.ts'), 'utf8');

    expect(bootstrap).toMatch(/import \{[^}]*\binitDeviceLinkService\b[^}]*\} from '\.\/device-link';/);
    expect(bootstrap).toContain('initDeviceLinkService({');
    expect(bootstrap.indexOf('initDeviceLinkService({')).toBeLessThan(
      bootstrap.indexOf('registerDeviceLinkIpc();'),
    );
  });

  it('wires the DeviceLinkClient inbound frames into controlled-desktop dispatch', () => {
    const deviceLinkHost = readFileSync(resolve(mainRoot, 'device-link/index.ts'), 'utf8');

    expect(deviceLinkHost).toContain('wireInboundDispatch,');
    expect(deviceLinkHost).toContain('wireInboundDispatch(client);');
    expect(deviceLinkHost.indexOf('setControllersChangedListener((controllers) =>')).toBeLessThan(
      deviceLinkHost.indexOf('wireInboundDispatch(client);'),
    );
  });

  it('replays desktop subscriptions when a remote device becomes controllable again', () => {
    const deviceLinkHost = readFileSync(resolve(mainRoot, 'device-link/index.ts'), 'utf8');

    expect(deviceLinkHost).toContain('const available = snap.online && snap.remoteControlEnabled;');
    expect(deviceLinkHost).toContain('if (available && wasAvailable === false)');
    expect(deviceLinkHost).toContain('replayActiveSubscriptions(`presence-online:${snap.deviceId.slice(0, 8)}`, snap.deviceId);');
  });

  it('keeps device-link:voice:credential-sync matched but rejected (feature removed, readable error for old mobile)', () => {
    const dispatch = readFileSync(resolve(mainRoot, 'device-link/dispatch.ts'), 'utf8');

    expect(dispatch).toContain('DL_VOICE_CREDENTIAL_SYNC_CHANNEL');
    expect(dispatch).toContain('if (payload.channel === DL_VOICE_CREDENTIAL_SYNC_CHANNEL)');
    expect(dispatch).toContain("code: 'VOICE_CREDENTIAL_SYNC_REMOVED'");
    expect(dispatch).not.toContain('syncMobileVoiceCredential');
  });

  it('routes device-link:voice:dictionary-learning to desktop dictionary learning', () => {
    const dispatch = readFileSync(resolve(mainRoot, 'device-link/dispatch.ts'), 'utf8');

    expect(dispatch).toContain('DL_VOICE_DICTIONARY_LEARNING_CHANNEL');
    expect(dispatch).toContain("import { adviseAndRecordVoiceInputDictionaryLearning } from '../voice-input/index.js';");
    expect(dispatch).toContain('if (payload.channel === DL_VOICE_DICTIONARY_LEARNING_CHANNEL)');
    expect(dispatch).toContain('handleMobileVoiceDictionaryLearning(src, (payload.args ?? [])[0])');
  });
});
