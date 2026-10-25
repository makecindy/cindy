import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// guard: Reanimated serializes worklet captures across UI/JS native runtimes.
// A Node mock cannot reproduce a captured runOnJS wrapper becoming a non-callable
// RemoteFunction; retain the original cross-runtime regression in required guard.
it('invokes the composer attach bridge inline inside the worklet', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/session/composerPullThrough.tsx'), 'utf8',
  ).replace(/\r\n/g, '\n');
  expect(source).toContain('runOnJS(setAttach)(');
  expect(source).not.toMatch(/=\s*runOnJS\(setAttach\)/);
});

// guard: export spans Swift rendering, a hidden WebView, and the system share
// extension's deferred file read. These contracts cannot run in the JS unit host.
it('bounds native export and preserves the hidden document and system share boundaries', () => {
  const native = readFileSync(resolve(process.cwd(), 'modules/xdt-screenshot-monitor/ios/XdtScreenshotMonitorModule.swift'), 'utf8');
  expect(native).toContain('captureWidth * captureHeight <= conversationShareMaxSourcePixels');
  expect(native).toContain('waitForWebContentPaint(webView)');
  expect(native).toContain('merged.hasVisibleVariation');
  expect(native).toContain('no active window scene');
  expect(native).toContain('hostingWindow?.isHidden = true');
  const web = readFileSync(resolve(process.cwd(), 'src/session/ConversationShareWebView.tsx'), 'utf8');
  expect(web).toContain('onShouldStartLoadWithRequest={interceptNavigation}');
  expect(web).toContain('interceptHtmlNavigation(request, documentSettledRef.current)');
  expect(web).toContain('allowFileAccess={false}');
  expect(web).toContain('mediaCapturePermissionGrantType="deny"');
  const route = readFileSync(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');
  const share = route.indexOf("await sharing.shareAsync(localUri, { mimeType: 'image/png' });");
  const completed = route.indexOf('shareCompleted = true;', share);
  const inactive = route.indexOf('if (!isShareOperationActive()) return;', share);
  expect(share).toBeGreaterThanOrEqual(0);
  expect(completed).toBeGreaterThan(share);
  expect(inactive).toBeGreaterThan(completed);
  expect(route).toContain('if (!shareCompleted && localUri)');
});

// guard: native WebView commands and late callbacks cross the React/native host
// boundary; the runtime models and richContentViews exercise their behavior.
it('cancels native player loading and rejects callbacks after editor disposal', () => {
  const media = readFileSync(resolve(process.cwd(), 'src/session/mediaPlayerWebView.tsx'), 'utf8');
  const composer = readFileSync(resolve(process.cwd(), 'src/session/ComposerRichInput.tsx'), 'utf8');
  expect(media).toContain('webViewRef.current?.stopLoading();');
  expect(media).toContain('lifecycleRef.current.consumeReloadOnActive()');
  expect(media).toContain('if (!mountedRef.current) return;');
  expect(composer).toContain('if (disposedRef.current) return;');
});

// guard: mobile-development.md native/runtime boundary and engineering-conventions.md section 3.2.
// Native distribution authority, recording cleanup, and delegate/JS call sites must stay connected.
// JS unit tests exercise their bridges but cannot execute Swift, Android delegates, or native clipping.
// Keep existing cross-runtime assertions here; do not substitute these for the unit behavior suites.
describe('mobile native boundary contracts', () => {
  it('keeps StoreKit 2 authoritative and receipt lookup as a fallback', () => {
    const swift = readFileSync(
      resolve(
        process.cwd(),
        'modules/xdt-ios-app-distribution/ios/XdtIosAppDistributionModule.swift',
      ),
      'utf8',
    );
    const moduleConfig = readFileSync(
      resolve(process.cwd(), 'modules/xdt-ios-app-distribution/expo-module.config.json'),
      'utf8',
    );
    const endpointGate = readFileSync(
      resolve(process.cwd(), 'src/config/useStartupEndpointGate.ts'),
      'utf8',
    );
    const startupBundleCheck = readFileSync(
      resolve(process.cwd(), 'src/update/useBundleUpdatePrompt.ts'),
      'utf8',
    );
    const resumeUpdateCheck = readFileSync(
      resolve(process.cwd(), 'src/update/useResumeUpdateCheck.ts'),
      'utf8',
    );
    const settings = readFileSync(
      resolve(process.cwd(), 'app/settings.tsx'),
      'utf8',
    );

    expect(swift).toContain('try await AppTransaction.shared');
    expect(swift).toContain('case .verified(let transaction)');
    expect(swift).toContain('case .sandbox:');
    expect(swift).toContain('receiptName == "sandboxReceipt"');
    expect(moduleConfig).toContain('"platforms": ["apple"]');
    expect(moduleConfig).not.toContain('"android"');
    // The async StoreKit lookup must complete inside the endpoint gate, before
    // REVIEW_MODE is consumed by any update hook or settings screen.
    expect(endpointGate).toContain('resolveIsTestFlight: isTestFlightBuild');
    // Startup, settings, and resume must all consume the resolved TestFlight
    // state before deciding whether the full-package channel is available.
    for (const source of [startupBundleCheck, settings, resumeUpdateCheck]) {
      expect(source).toContain('isTestFlightBuild: IS_TESTFLIGHT_BUILD');
    }
  });

  it('keeps the iOS native realtime recorder wired for interruption cleanup', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'modules/xdt-mobile-realtime-audio/ios/XdtMobileRealtimeAudioModule.swift'),
      'utf8',
    );

    expect(source).toContain('AVAudioSession.interruptionNotification');
    expect(source).toContain('AVAudioSession.routeChangeNotification');
    expect(source).toContain('removeAudioSessionObservers()');
    expect(source).toContain('handleAudioSessionInterruption');
    expect(source).toContain('handleAudioRouteChange');
    expect(source).toContain('OnAppEntersBackground');
    expect(source).toContain('stopCapture(deactivateImmediately: true)');
    expect(source).toContain('stopCapture()');
    expect(source).toContain('unsignedIntegerValue(notification.userInfo?[AVAudioSessionInterruptionTypeKey])');
    expect(source).toContain('unsignedIntegerValue(notification.userInfo?[AVAudioSessionRouteChangeReasonKey])');
  });

  it('cancels voice runs in both composers when the app enters the background', () => {
    const newSessionSource = readFileSync(
      resolve(process.cwd(), 'app/sessions/new.tsx'),
      'utf8',
    );
    const existingSessionSource = readFileSync(
      resolve(process.cwd(), 'app/sessions/[sessionId].tsx'),
      'utf8',
    );

    for (const source of [newSessionSource, existingSessionSource]) {
      expect(source).toContain("AppState.addEventListener('change'");
      expect(source).toContain("nextState !== 'background'");
      expect(source).toContain('voiceControllerSessionRef.current = null');
      expect(source).toContain('discardPendingPrewarm()');
      expect(source).not.toContain("setAudioModeAsync");
    }
    expect(newSessionSource).toContain('cancelVoiceForDeviceSwitch();');
    expect(existingSessionSource).toContain('cancelVoiceForAppBackground();');
  });

  it('wires first-party Apple, public Google, and the minimal official WeChat bridge', () => {
    const appJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'app.json'), 'utf8'),
    );
    const packageJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
    );
    const configSource = readFileSync(
      resolve(process.cwd(), 'app.config.js'),
      'utf8',
    );
    const pluginSource = readFileSync(
      resolve(process.cwd(), 'modules/xdt-wechat-login/plugin/index.js'),
      'utf8',
    );
    const iosPodspec = readFileSync(
      resolve(
        process.cwd(),
        'modules/xdt-wechat-login/ios/XdtWechatLogin.podspec',
      ),
      'utf8',
    );
    const androidGradle = readFileSync(
      resolve(process.cwd(), 'modules/xdt-wechat-login/android/build.gradle'),
      'utf8',
    );
    const moduleConfig = readFileSync(
      resolve(
        process.cwd(),
        'modules/xdt-wechat-login/expo-module.config.json',
      ),
      'utf8',
    );
    const iosCoordinator = readFileSync(
      resolve(
        process.cwd(),
        'modules/xdt-wechat-login/ios/XdtWechatAuthCoordinator.swift',
      ),
      'utf8',
    );
    const iosWechatPodfilePlugin = readFileSync(
      resolve(process.cwd(), 'plugins/with-wechat-opensdk-modulemap.js'),
      'utf8',
    );
    const iosSubscriber = readFileSync(
      resolve(
        process.cwd(),
        'modules/xdt-wechat-login/ios/XdtWechatLoginAppDelegateSubscriber.swift',
      ),
      'utf8',
    );

    expect(appJson.expo.ios.usesAppleSignIn).toBe(true);
    expect(appJson.expo.plugins).toContain('expo-apple-authentication');
    expect(packageJson.dependencies['expo-apple-authentication']).toBeTruthy();
    expect(
      packageJson.dependencies['@react-native-google-signin/google-signin'],
    ).toBe('16.1.2');
    expect(packageJson.dependencies['xdt-wechat-login']).toBe(
      'file:./modules/xdt-wechat-login',
    );
    expect(
      existsSync(
        resolve(
          process.cwd(),
          'modules/xdt-feishu-login/expo-module.config.json',
        ),
      ),
    ).toBe(false);
    expect(configSource).toContain(
      "'@react-native-google-signin/google-signin'",
    );
    expect(configSource).toContain("'xdt-wechat-login/plugin'");
    expect(pluginSource).toContain("'weixinULAPI'");
    expect(pluginSource).toContain("'.wxapi.WXEntryActivity'");
    expect(pluginSource).toContain('withWechatEntryActivity(config, appId)');
    expect(pluginSource).toContain('createWXAPI(this, ${kotlinAppId}, false)');
    expect(iosPodspec).toContain("s.dependency 'WechatOpenSDK', '2.0.5'");
    expect(androidGradle).toContain('wechat-sdk-android:6.8.38');
    expect(moduleConfig).toContain('XdtWechatLoginAppDelegateSubscriber');
    expect(iosCoordinator).toContain(
      'WXApi.handleOpenUniversalLink(userActivity, delegate: self)',
    );
    expect(iosCoordinator).toContain('#if targetEnvironment(simulator)');
    expect(iosCoordinator).toContain('ERR_WECHAT_UNAVAILABLE_ON_SIMULATOR');
    expect(iosWechatPodfilePlugin).toContain(
      'xdt-wechat-login: arm64 simulator stub linkage',
    );
    expect(iosWechatPodfilePlugin).toContain(
      "other_linker_flags[:libraries].delete?('WechatOpenSDK')",
    );
    expect(iosWechatPodfilePlugin).toContain(
      "OTHER_LDFLAGS[sdk=iphoneos*]",
    );
    expect(iosSubscriber).toContain('continue userActivity: NSUserActivity');
  });

  // DESIGN §5: the same native ancestor must clip input, palette, and held cards.
  it('keeps all bottom controls under the native reservation clipping ancestor', () => {
    const source = ts.createSourceFile('session.tsx', readFileSync(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const elements = new Map<string, ts.JsxElement>();
    function visit(node: ts.Node) {
      if (ts.isJsxElement(node)) {
        const id = node.openingElement.attributes.properties.find(prop => ts.isJsxAttribute(prop) && prop.name.getText(source) === 'testID') as ts.JsxAttribute | undefined;
        if (id?.initializer && ts.isStringLiteral(id.initializer)) elements.set(id.initializer.text, node);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    const viewport = elements.get('session.bottomViewport')!;
    const layer = elements.get('session.bottomLayer')!;
    expect(layer.parent).toBe(viewport);
    expect(layer.openingElement.getText(source)).toContain('onLayout={handleBottomOverlayLayout}');
    expect(viewport.openingElement.getText(source)).toContain('pointerEvents="box-none"');
    for (const component of ['SessionComposerPalette', 'ComposerActivityStatus', 'SessionComposerInput']) {
      expect(viewport.getText(source)).toContain('<' + component);
    }
  });
  // mobile-development.md: Metro-only manifest routing must not enter native fingerprint config.
  it('connects Metro manifest injection to runtime while keeping dev release routing outside production config', () => {
    const runtime = readFileSync(resolve(process.cwd(), 'src/config/env.ts'), 'utf8');
    const config = readFileSync(resolve(process.cwd(), 'app.config.js'), 'utf8');
    expect(runtime).toContain('process.env.EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL');
    expect(config).toContain("...(region === 'dev'");
    expect(config).toContain('EXPO_PUBLIC_CINDY_DEV_RELEASE_ENDPOINT_MANIFEST_BASE_URL:');
    expect(config).toContain("resolveManifestBaseUrl('cn')");
    expect(config).not.toContain('xdtProductionEnv: mobileBundleEnv');
  });
});

// guard: mobile-development.md Google Play install authority: all JS update entry points must honor it.
it('keeps content OTA independent while suppressing website APK checks on Google Play installs', () => {
const layout = readFileSync(resolve(process.cwd(), 'app/_layout.tsx'), 'utf8');
expect(layout).toContain('const otaReady = useStartupOtaGate(channel);');
const settings = readFileSync(resolve(process.cwd(), 'app/settings.tsx'), 'utf8');
expect(settings).toContain('isGooglePlayInstallation: playManagedUpdates,');
expect(settings).toContain('checkBundleUpdate: bundleCheckEnabled ? checkBundleUpdate : undefined,');
expect(settings).toContain('const updateCheckEnabled = bundleCheckEnabled || updatesEnabled;');
expect(settings).toContain("t('settings.version.googlePlayUpdateManaged')");
});

// guard: native persistent history hosts must wrap routes and replace route prefetch ownership.
describe('persistent native history ownership', () => {
  // guard: mobile-development.md native rendering boundary; a route-local notice cannot
  // paint above Android's opaque resident message surface regardless of its zIndex.
  it('hosts transient route notices above the resident message surface', () => {
    const source = ts.createSourceFile('session.tsx', readFileSync(
      resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8',
    ), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const notices: ts.JsxSelfClosingElement[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'SessionTransientNotice') notices.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(notices).toHaveLength(1);
    const parent = notices[0]!.parent;
    expect(ts.isJsxElement(parent)).toBe(true);
    if (!ts.isJsxElement(parent)) return;
    expect(parent.openingElement.tagName.getText(source)).toBe('MessageHistoryOverlay');
    // Unlike the sidebar panel, a notice needs the overlay on persistent layouts too.
    expect(parent.openingElement.attributes.properties).toHaveLength(0);
  });
  // guard: keep the real route wired to the shared list and native clipping layers.
  // The provider behavior suite cannot exercise Android native stacking.
  it('keeps the persistent sidebar on the shared list below its native host', () => {
    const home = readFileSync(resolve(process.cwd(), 'src/session/HomeSurface.tsx'), 'utf8');
    expect(home).toContain('{residentList.enabled ? (');
    expect(home).not.toContain('residentList.enabled && !embedded');
    const route = readFileSync(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');
    const layout = readFileSync(resolve(process.cwd(), 'src/session/SessionTaskLayout.tsx'), 'utf8');
    expect(route).toContain('<SessionTaskLayout>');
    expect(layout).toContain('<MessageHistoryOverlay enabled={false}>');
    expect(layout).toContain('persistent={paneLayout.persistent}');
  });
  it('does not keep the old route preloading mechanism alongside the resident host', () => {
    const home = readFileSync(resolve(process.cwd(), 'src/session/HomeSurface.tsx'), 'utf8');
    expect(home).not.toContain('useRecentTaskPreload');
    expect(home).not.toContain('router.prefetch');
    const layout = readFileSync(resolve(process.cwd(), 'app/_layout.tsx'), 'utf8');
    // Source structure is independent of checkout line endings.
    for (const source of [layout.replace(/\r\n/g, '\n'), layout.replace(/\r?\n/g, '\r\n')]) {
      const provider = source.search(/<RecentMessageHistoriesProvider(?:\s|>)/);
      const residentProvider = source.indexOf('<ResidentHomeListProvider>');
      const stack = source.search(/<Stack\s/);
      expect(provider).toBeGreaterThanOrEqual(0);
      expect(residentProvider).toBeGreaterThan(provider);
      expect(stack).toBeGreaterThan(provider);
      expect(stack).toBeGreaterThan(residentProvider);
      expect(source.indexOf('</ResidentHomeListProvider>')).toBeGreaterThan(stack);
      expect(source.indexOf('</RecentMessageHistoriesProvider>')).toBeGreaterThan(
        source.indexOf('</ResidentHomeListProvider>'),
      );
    }
  });
});
