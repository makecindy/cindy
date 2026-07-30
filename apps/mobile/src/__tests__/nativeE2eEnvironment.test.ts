import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('native e2e environment', () => {
  it('uses a Java 17 runtime for Maestro without requiring global shell changes', () => {
    const helper = readFileSync(resolve(process.cwd(), 'scripts/java-runtime-env.mjs'), 'utf8');
    const doctor = readFileSync(resolve(process.cwd(), 'scripts/native-e2e-doctor.mjs'), 'utf8');
    const runner = readFileSync(resolve(process.cwd(), 'scripts/maestro-e2e.mjs'), 'utf8');

    expect(helper).toContain('const MIN_JAVA_MAJOR = 17');
    expect(helper).toContain("brew', ['--prefix', 'openjdk@17']");
    expect(helper).toContain("'/usr/libexec/java_home', ['-v', version]");
    expect(helper).toContain('JAVA_HOME: javaHome');
    expect(helper).toContain("PATH: [join(javaHome, 'bin'), baseEnv.PATH]");
    expect(doctor).toContain("import { javaRuntimeDetail, resolveJavaRuntimeEnv } from './java-runtime-env.mjs';");
    expect(doctor).toContain('const toolEnv = resolveJavaRuntimeEnv(process.env);');
    expect(doctor).toContain("spawnSync('maestro', ['--version'], { encoding: 'utf8', env: toolEnv })");
    expect(runner).toContain("import { resolveJavaRuntimeEnv } from './java-runtime-env.mjs';");
    expect(runner).toContain('const toolEnv = resolveJavaRuntimeEnv(process.env);');
    expect(runner).toContain('...toolEnv');
    expect(runner).toContain("process.env.XDT_MOBILE_E2E_EXPO_LAUNCH_DELAY_MS ?? '20000'");
    expect(runner).toContain("process.env.XDT_MOBILE_E2E_EXPO_TERMINATE_BEFORE_OPEN ?? 'true'");
    expect(runner).toContain("process.env.XDT_MOBILE_E2E_EXPO_OPEN_BEFORE_TEST ?? 'true'");
    expect(runner).toContain("if (expoUrl && expoTerminateBeforeOpen === 'true') terminateExpoApp(platform);");
    expect(runner).toContain('function expoUrlWithRoute(url, route)');
    expect(runner).toContain('XDT_MOBILE_E2E_HOST_AUTOMATIONS_URL');
    expect(runner).toContain('function terminateExpoApp(platform)');
    expect(runner).toContain('function terminateApp(targetAppId, platform)');
    expect(runner).toContain('function launchNativeApp(targetAppId, platform)');
    expect(runner).toContain('terminateApp(appId, platform);');
    expect(runner).toContain('launchNativeApp(appId, platform);');
    expect(runner).toContain("MAESTRO_DRIVER_STARTUP_TIMEOUT: process.env.MAESTRO_DRIVER_STARTUP_TIMEOUT ?? '120000'");
    expect(runner).toContain("`XDT_MOBILE_E2E_EXPO_URL=${expoUrl ?? ''}`");
    expect(runner).toContain('sleepSync(expoLaunchDelayMs)');
  });

  it('opens the Expo target route before shared flows while cleaning native stale overlays', () => {
    const loginFlow = readFileSync(resolve(process.cwd(), 'e2e/maestro/login_mock_no_clear.yaml'), 'utf8');
    const loginLaunchFlow = readFileSync(resolve(process.cwd(), 'e2e/maestro/login_mock.yaml'), 'utf8');
    const openSessionFlow = readFileSync(resolve(process.cwd(), 'e2e/maestro/open_session.yaml'), 'utf8');
    const openSessionNoLaunchFlow = readFileSync(resolve(process.cwd(), 'e2e/maestro/open_session_no_launch.yaml'), 'utf8');
    const messageSelectionFlow = readFileSync(resolve(process.cwd(), 'e2e/maestro/message_selection.yaml'), 'utf8');
    const filePreviewFlow = readFileSync(resolve(process.cwd(), 'e2e/maestro/file_preview.yaml'), 'utf8');
    const visualOfflineFlow = readFileSync(resolve(process.cwd(), 'e2e/maestro/visual_session_offline.yaml'), 'utf8');

    expect(loginFlow).toContain('id: "devices.screen"');
    expect(loginFlow).toContain('id: "session.backButton"');
    expect(loginFlow).toContain('text: "^允许$"');
    expect(loginFlow).not.toContain('text: "Continue"');
    expect(loginFlow).not.toContain('text: "Close"');
    expect(loginLaunchFlow).not.toContain('openLink');
    expect(loginLaunchFlow).toContain('- runFlow: login_mock_no_clear.yaml');
    for (const flow of [openSessionFlow, openSessionNoLaunchFlow]) {
      expect(flow).toContain('id: "connection.syncButton"');
      expect(flow).toContain('optional: true');
      expect(flow).toContain('Sync devices when the connection row is visible');
    }
    expect(openSessionFlow).toContain('Open the recent Expo Go XDMaker project if launchApp lands on Expo Home');
    expect(openSessionFlow).toContain('text: "XDMaker"');
    expect(openSessionFlow).toContain('waitForAnimationToEnd');
    expect(loginFlow).toContain('waitForAnimationToEnd');
    expect(messageSelectionFlow).toContain('- runFlow: open_session_no_launch.yaml');
    expect(messageSelectionFlow).not.toContain('- runFlow: open_session.yaml');
    expect(filePreviewFlow).toContain('- runFlow: open_session_no_launch.yaml');
    expect(filePreviewFlow).not.toContain('- runFlow: open_session.yaml');
    expect(visualOfflineFlow).toContain('id: "session.composerInput"');
    expect(visualOfflineFlow).toContain('- eraseText');
    expect(visualOfflineFlow).toContain('- inputText: "Offline visual draft"');
    expect(visualOfflineFlow).toContain('- hideKeyboard');
    expect(visualOfflineFlow).toContain('id: "session.sendButton"');
    expect(visualOfflineFlow).not.toContain('session.collaborationReadOnlyComposer');
  });

  it('can own the Expo lifecycle for iOS local runtime smoke', () => {
    const packageJson = readFileSync(resolve(process.cwd(), 'package.json'), 'utf8');
    const localSmoke = readFileSync(resolve(process.cwd(), 'scripts/local-device-link-smoke.mjs'), 'utf8');

    expect(packageJson).toContain('"test:e2e:local:ios"');
    expect(packageJson).toContain('--start-server --start-expo --mock-host --profile ios-iphone-17-pro-expo-go');
    expect(localSmoke).toContain("if (arg === '--start-expo')");
    expect(localSmoke).toContain("if (arg === '--no-mock-audio')");
    expect(localSmoke).toContain("const useMockAudio = voiceProxySelected && !options.noMockAudio;");
    expect(localSmoke).toContain("if (arg === '--voice-cloud-preflight')");
    expect(localSmoke).toContain("if (arg === '--voice-cloud-all-candidates')");
    // 穿透 credential 工具族已随 device-link:voice:credential-sync 下线删除:
    // smoke 不再有任何 voice credential fetch/override 面。
    expect(localSmoke).not.toContain('voice-credential');
    expect(localSmoke).not.toContain('voiceCredential');
    expect(localSmoke).toContain('expectedControllableDeviceId: options.mockHost ? mockHostDeviceId : undefined');
    expect(localSmoke).toContain('function isControllableDevice(device)');
    expect(localSmoke).toContain('function runVoiceCloudPreflight()');
    expect(localSmoke).toContain("...(options.voiceCloudAllCandidates ? ['--all-candidates'] : [])");
    expect(localSmoke).toContain('preflightEnv.XDT_MOBILE_VOICE_PROXY_BASE_URL = voiceProxyBaseUrl;');
    expect(localSmoke).toContain("preflightEnv.XDT_MOBILE_VOICE_PROXY_API_KEY = 'sk-mock-mobile-voice-key';");
    expect(localSmoke).toContain('runNodeScript(voiceCloudPreflightScript, args, preflightEnv);');
    expect(localSmoke).toContain('function startMockHostProcess(baseUrl, hostDeviceId, scenario, realDbPath)');
    expect(localSmoke).toContain('await stopMockHost.ready;');
    expect(localSmoke).toContain('mock host did not become ready within');
    expect(localSmoke).toContain("line.includes('mock-device-link-host ready')");
    expect(localSmoke).toContain('async function stopActiveMockHost()');
    expect(localSmoke.indexOf('await stopActiveMockHost();')).toBeLessThan(
      localSmoke.indexOf('if (options.mockHost) await cleanupE2eDeviceRecords(apiBase, mockHostDeviceId);'),
    );
    expect(localSmoke).toContain('async function startExpoProcess(url)');
    expect(localSmoke).toContain('async function assertExpoReady(url');
    expect(localSmoke).toContain('Expo Go native E2E needs Metro before Maestro opens the app.');
    expect(localSmoke).toContain('EXPO_PUBLIC_XDT_API_BASE_URL: apiBase');
    expect(localSmoke).toContain("&& (flowSuite === 'visual' || flowSuite === 'full' || flowSuite === 'file' || flowSuite === 'automations')");
    expect(localSmoke).toContain("flowSuite === 'visual' ? `${mockHostDeviceId}-${flowSlug(flow)}` : mockHostDeviceId");
    expect(localSmoke).toContain("if (flowSuite === 'full' && flow === 'fixture_controls_smoke.yaml') return 'controls';");
    expect(localSmoke).toContain("if (suite === 'controls') return 'controls';");
  });

  it('can run the iOS smoke against local desktop SQLite data without hardcoding a user path', () => {
    const packageJson = readFileSync(resolve(process.cwd(), 'package.json'), 'utf8');
    const mockHost = readFileSync(resolve(process.cwd(), 'scripts/mock-device-link-host.mjs'), 'utf8');

    expect(packageJson).toContain('"test:e2e:local:real-db:ios"');
    expect(packageJson).toContain('--mock-host-real-db auto');
    expect(mockHost).toContain('function resolveRealDbPath(dbPath, Database)');
    expect(mockHost).toContain("rawPath && rawPath !== 'auto'");
    expect(mockHost).toContain("path.join(home, 'Library', 'Application Support', 'xdt-maker')");
    expect(mockHost).toContain("path.join(appData, 'xdt-maker')");
    expect(mockHost).toContain('--real-db auto could not find a readable XDMaker SQLite DB with sessions');
  });

  it('keeps the mock host capable of exercising deferred session Agent switching', () => {
    const mockHost = readFileSync(resolve(process.cwd(), 'scripts/mock-device-link-host.mjs'), 'utf8');

    expect(mockHost).toContain("case 'maker:switch-session-agent':");
    expect(mockHost).toContain("case 'maker:get-session-agent-switch-intent':");
    expect(mockHost).toContain("case 'maker:provider:list':");
    expect(mockHost).toContain('supportsSessionAgentSwitch: true');
    expect(mockHost.indexOf('applyPendingAgentSwitchIntent(id);')).toBeLessThan(
      mockHost.indexOf("const text = typeof queued?.text === 'string'"),
    );
  });

  it('can run reconnect smoke as a self-contained local relay gate', () => {
    const packageJson = readFileSync(resolve(process.cwd(), 'package.json'), 'utf8');
    const reconnectSmoke = readFileSync(resolve(process.cwd(), 'scripts/device-link-reconnect-smoke.mjs'), 'utf8');

    expect(packageJson).toContain('"test:e2e:reconnect:local": "node scripts/device-link-reconnect-smoke.mjs --start-server"');
    expect(reconnectSmoke).toContain("if (arg === '--start-server')");
    expect(reconnectSmoke).toContain('function startServerProcess()');
    expect(reconnectSmoke).toContain("XDT_DEV_AUTH_ENABLED: process.env.XDT_DEV_AUTH_ENABLED ?? '1'");
    expect(reconnectSmoke).toContain('Or pass --start-server.');
  });

  it('keeps cloud voice preflight opt-in and secret-redacted with the credential relay removed', () => {
    const packageJson = readFileSync(resolve(process.cwd(), 'package.json'), 'utf8');
    const preflight = readFileSync(resolve(process.cwd(), 'scripts/mobile-voice-cloud-preflight.mjs'), 'utf8');
    const mockVoiceProxy = readFileSync(resolve(process.cwd(), 'scripts/mock-voice-proxy.mjs'), 'utf8');
    const mockHost = readFileSync(resolve(process.cwd(), 'scripts/mock-device-link-host.mjs'), 'utf8');
    const readme = readFileSync(resolve(process.cwd(), 'README.md'), 'utf8');

    expect(packageJson).toContain('"test:voice-cloud:preflight": "node scripts/mobile-voice-cloud-preflight.mjs"');
    expect(packageJson).toContain('"test:voice-cloud:preflight:run": "node scripts/mobile-voice-cloud-preflight.mjs --run"');
    // 穿透 credential 工具族(export/fetch/relay smoke/doctor/device gate)已随
    // device-link:voice:credential-sync 下线一并删除,不能再出现在 package scripts 里。
    expect(packageJson).not.toContain('voice:credential:');
    expect(packageJson).not.toContain('test:voice-cloud:doctor');
    expect(packageJson).not.toContain('test:voice-cloud:local-desktop-relay');
    expect(packageJson).not.toContain('test:voice-cloud:device');
    expect(preflight).toContain('dry run passed; add --run to call the cloud endpoints');
    expect(preflight).toContain('XDT_MOBILE_VOICE_CREDENTIAL_JSON');
    expect(preflight).toContain('XDT_MOBILE_VOICE_PROXY_API_KEY');
    expect(preflight).toContain('XDT_MOBILE_VOICE_PREFLIGHT_ALL_CANDIDATES');
    expect(preflight).toContain("if (arg === '--all-candidates')");
    expect(preflight).toContain('async function preflightAsrCandidates');
    expect(preflight).toContain('async function preflightRefinerCandidates');
    expect(preflight).toContain("credentialAsrChain(credential).slice(0, 1)");
    expect(preflight).toContain("credentialRefinerChain(credential).slice(0, 1)");
    expect(preflight).toContain('mobileRealtimeAsrUnsupportedReason');
    expect(preflight).toContain('asr.mode is not supported for mobile realtime preflight');
    expect(preflight).toContain("validateProviderChain(credential, 'asrProviderChain'");
    expect(preflight).toContain("validateProviderChain(credential, 'refinerProviderChain'");
    expect(preflight).toContain('function credentialAsrChain(credential)');
    expect(preflight).toContain('function credentialRefinerChain(credential)');
    expect(preflight).toContain("const primary = normalized.split(/[-_]/)[0];");
    expect(preflight).toContain("case 'mandarin':");
    expect(preflight).toContain('function redactionCandidates(secret)');
    expect(preflight).not.toContain('console.log(credential.proxyApiKey');
    expect(preflight).not.toContain('console.warn(credential.proxyApiKey');
    expect(preflight).not.toContain('console.error(credential.proxyApiKey');
    expect(readme).toContain('--voice-cloud-all-candidates');
    expect(readme).toContain('VOICE_CREDENTIAL_SYNC_REMOVED');
    expect(readme).not.toContain('voice:credential:');
    expect(readme).not.toContain('test:voice-cloud:doctor');
    expect(readme).not.toContain('test:voice-cloud:device');
    expect(mockVoiceProxy).toContain("url.pathname !== '/dashscope/api-ws/v1/realtime'");
    // mock host 与 desktop dispatch 语义对齐:credential-sync 一律返回下线错误,
    // 不再存在 mock 凭证或 credential override 面。
    expect(mockHost).toContain("case 'device-link:voice:credential-sync':");
    expect(mockHost).toContain("err.code = 'VOICE_CREDENTIAL_SYNC_REMOVED';");
    expect(mockHost).toContain('手机语音输入已改用 Cindy 官方语音服务,请升级手机版。');
    expect(mockHost).not.toContain('mockVoiceCredential');
    expect(mockHost).not.toContain('voiceCredentialOverride');
    expect(mockHost).not.toContain('loadVoiceCredentialOverride');
    expect(mockHost).not.toContain("'--voice-credential-file'");
    expect(mockHost).toContain("case 'device-link:voice:dictionary-learning':");
    expect(mockHost).toContain("ignoreReason: 'mock-host'");
  });

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
    const cleanupStart = authContext.indexOf('const clearLocalSession = useCallback(async () => {');
    const cleanupBody = authContext.slice(cleanupStart, authContext.indexOf('}, [', cleanupStart));
    const refreshTokenDelete = cleanupBody.indexOf('await serializeRefreshTokenMutation(() =>');
    expect(refreshTokenDelete).toBeGreaterThanOrEqual(0);
    expect(cleanupBody).toContain('deleteSecureItem(AUTH_SESSION_KEY).catch(() => undefined)');
    expect(cleanupBody.indexOf('await clearAllMobileVoiceCredentials().catch(() => undefined);')).toBeLessThan(refreshTokenDelete);
    expect(cleanupBody.indexOf('await clearAllMobileVoiceInputHistories().catch(() => undefined);')).toBeLessThan(refreshTokenDelete);
    const logoutStart = authContext.indexOf('const logout = useCallback(async () => {');
    const logoutBody = authContext.slice(logoutStart, authContext.indexOf('}, [', logoutStart));
    expect(logoutBody).toContain('await persistAccountDeletionReceipt(null);');
    expect(logoutBody).toContain('await clearLocalSession();');
    // 启动(auth 初始化)也要做一次存量清理,防旧版本留下的桌面 key 继续躺在
    // secure storage(与 LEGACY_* token 清理同一批)。
    expect(authContext).toContain('clearAllMobileVoiceCredentials().catch(() => undefined),');
  });

  it('backs Android realtime voice with the Expo AudioStream already shipped in the app', () => {
    const expoModuleConfig = readFileSync(
      resolve(process.cwd(), 'modules/xdt-mobile-realtime-audio/expo-module.config.json'),
      'utf8',
    );
    const realtimeAudio = readFileSync(resolve(process.cwd(), 'src/session/mobileRealtimeAudio.ts'), 'utf8');
    const appJson = readFileSync(resolve(process.cwd(), 'app.json'), 'utf8');

    // The latency-tuned custom recorder stays Apple-only. Android reuses the
    // PCM SharedObject from expo-audio, which is already a native dependency.
    expect(expoModuleConfig).toContain('"platforms": ["apple"]');
    expect(expoModuleConfig).not.toContain('"android"');
    expect(appJson).toContain('"recordAudioAndroid": true');
    expect(realtimeAudio).toContain("requireNativeModule<ExpoAudioNativeModule>('ExpoAudio')");
    expect(realtimeAudio).toContain('new module.AudioStream({');
    expect(realtimeAudio).toContain("encoding: 'int16'");
    expect(realtimeAudio).toContain('convertExpoAudioPcm16(');
    expect(realtimeAudio).toContain("throw new UnavailabilityError('Cindy mobile voice input', 'realtime microphone PCM capture')");
    expect(realtimeAudio).toContain('EXPO_PUBLIC_XDT_MOBILE_E2E_MOCK_AUDIO');
  });

  it('sends the realtime voice draft returned by the controller instead of stale React state', () => {
    const sessionScreen = readFileSync(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');

    expect(sessionScreen).toContain('const documentBeforeStop = composerDocumentRef.current;');
    expect(sessionScreen).toContain('const latestDraft = await controller.stop();');
    expect(sessionScreen).toContain('await sendLatest({ documentOverride: latestDocument });');
    expect(sessionScreen.indexOf('const documentBeforeStop = composerDocumentRef.current;')).toBeLessThan(
      sessionScreen.indexOf('const latestDraft = await controller.stop();'),
    );
    expect(sessionScreen).toContain('const latestDocument = latestDraft.trim()');
    expect(sessionScreen).toContain('readCurrentDraft: () => draftRef.current');
    expect(sessionScreen).toContain('onDraftChanged: setComposerDraft');
    expect(sessionScreen).toContain('createMobileVoiceControllerSession({');
    expect(sessionScreen).not.toContain('await sendLatest({ draftOverride: latestDraft });');
  });

  it('guards the mobile voice composer against the legacy desktop transcription path', () => {
    const scopeGuard = readFileSync(resolve(process.cwd(), 'scripts/mobile-scope-guard.mjs'), 'utf8');

    expect(scopeGuard).toContain("roots: ['app']");
    expect(scopeGuard).toContain("'transcribeVoice('");
    expect(scopeGuard).toContain("'DEVICE_LINK_VOICE_TRANSCRIBE_CHANNEL'");
    expect(scopeGuard).toContain("'device-link:voice:transcribe'");
    expect(scopeGuard).toContain('Mobile voice composer must use the realtime controller + managed Cindy voice service');
  });
});
