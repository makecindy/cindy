import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// guard: credentials-and-local-storage.md requires legacy keys to be removed at startup/logout.
// The storage unit suite tests actual deletion; this cross-module check prevents dropping AuthContext callers.
// mobile-development.md native boundary: register Android capture while retaining ExpoAudio
// for older native packages. JS guards check the registration and fallback order;
// actual recording is covered in mobileRealtimeAudio and native device verification.
describe('native e2e security and native boundary contracts', () => {
it('clears local mobile voice credentials on logout and at auth startup', () => {
    const authContext = readFileSync(resolve(process.cwd(), 'src/auth/AuthContext.tsx'), 'utf8');

    expect(authContext).toContain(
      "from '@/session/mobileVoiceCredentialStore'",
    );
    expect(authContext).toContain("from '@/session/mobileVoiceHistoryStore'");
    // BYOK/穿透存储模块已删除:清理统一收敛进 clearAllMobileVoiceCredentials
    // (含 serviceMode 与 LiteLLM key 的存量键)。
    expect(authContext).not.toContain('mobileVoiceLiteLlmSettings');
    expect(authContext).not.toContain('mobileVoiceServiceMode');
    expect(authContext).toContain(
      'await clearAllMobileVoiceCredentials().catch(() => undefined);',
    );
    expect(authContext).toContain(
      'await clearAllMobileVoiceInputHistories().catch(() => undefined);',
    );
    // Scope the ordering check to the shared local-session cleanup: both logout and confirmed
    // account deletion use it, and refresh-token deletion remains serialized against refresh.
    const cleanupStart = authContext.indexOf('const clearLocalSession = useCallback(async (');
    const cleanupBody = authContext.slice(cleanupStart, authContext.indexOf('}, [', cleanupStart));
    const refreshTokenDelete = cleanupBody.indexOf('await serializeRefreshTokenMutation(() =>');
    expect(refreshTokenDelete).toBeGreaterThanOrEqual(0);
    expect(cleanupBody).toContain('deleteSecureItem(AUTH_SESSION_KEY).catch(() => undefined)');
    expect(cleanupBody.indexOf('await clearAllMobileVoiceCredentials().catch(() => undefined);')).toBeLessThan(refreshTokenDelete);
    expect(cleanupBody.indexOf('await clearAllMobileVoiceInputHistories().catch(() => undefined);')).toBeLessThan(refreshTokenDelete);
    const logoutStart = authContext.indexOf('const logout = useCallback(async () => {');
    const logoutBody = authContext.slice(logoutStart, authContext.indexOf('}, [', logoutStart));
    expect(logoutBody).toContain('clearMobileLoginCredentialsForLogout({');
    expect(logoutBody).toContain(
      'clearReceipt: () => persistAccountDeletionReceipt(null),',
    );
    expect(logoutBody).toContain(
      'await clearLocalSession({ persistedAuthAlreadyCleared: true });',
    );
    // 启动(auth 初始化)也要做一次存量清理,防旧版本留下的桌面 key 继续躺在
    // secure storage(与 LEGACY_* token 清理同一批)。
    expect(authContext).toContain('clearAllMobileVoiceCredentials().catch(() => undefined),');
  });
  it('prefers Android native realtime voice and keeps Expo AudioStream for older builds', () => {
    const expoModuleConfig = JSON.parse(readFileSync(
      resolve(process.cwd(), 'modules/xdt-mobile-realtime-audio/expo-module.config.json'),
      'utf8',
    )) as { platforms: string[]; android?: { modules: string[] } };
    const realtimeAudio = readFileSync(resolve(process.cwd(), 'src/session/mobileRealtimeAudio.ts'), 'utf8');
    const appJson = readFileSync(resolve(process.cwd(), 'app.json'), 'utf8');

    // New Android binaries use AudioRecord; older binaries retain the existing
    // Expo AudioStream path so an OTA update does not break microphone access.
    expect(expoModuleConfig.platforms).toEqual(['apple', 'android']);
    expect(expoModuleConfig.android?.modules).toContain('com.xdtmaker.realtimeaudio.XdtMobileRealtimeAudioModule');
    expect(appJson).toContain('"recordAudioAndroid": true');
    expect(realtimeAudio).toContain('const binding = getNativeBinding();');
    expect(realtimeAudio).toContain('const expoAudioModule = getExpoAudioNativeModule();');
    expect(realtimeAudio.indexOf('const binding = getNativeBinding();')).toBeLessThan(realtimeAudio.indexOf('const expoAudioModule = getExpoAudioNativeModule();'));
    expect(realtimeAudio).toContain("requireNativeModule<ExpoAudioNativeModule>('ExpoAudio')");
    expect(realtimeAudio).toContain('new module.AudioStream({');
    expect(realtimeAudio).toContain("encoding: 'int16'");
    expect(realtimeAudio).toContain('convertExpoAudioPcm16(');
    expect(realtimeAudio).toContain("throw new UnavailabilityError('Cindy mobile voice input', 'realtime microphone PCM capture')");
    expect(realtimeAudio).toContain('EXPO_PUBLIC_XDT_MOBILE_E2E_MOCK_AUDIO');
  });

  // The old credential relay must not become reachable through a local developer command.
  it('keeps the retired voice credential relay out of developer entry points', () => {
    const scripts = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')).scripts;
    expect(Object.keys(scripts).some((key) => key.includes('voice:credential:') || ['test:voice-cloud:doctor', 'test:voice-cloud:device', 'test:voice-cloud:local-desktop-relay'].includes(key))).toBe(false);
    for (const file of ['scripts/local-device-link-smoke.mjs', 'scripts/mock-device-link-host.mjs']) {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8');
      for (const removed of ['voiceCredentialOverride', 'loadVoiceCredentialOverride', '--voice-credential-file']) expect(source).not.toContain(removed);
    }
  });
});
