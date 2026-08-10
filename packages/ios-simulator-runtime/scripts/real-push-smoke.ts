import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createIOSSimulatorRuntime,
  createIOSSimulatorSimctlLifecycle,
  createNodeIOSSimulatorCommandRunner,
} from "../src/index.js";

const BUNDLE_ID = "com.cindy.iossimulator.pushsmoke";
const MIN_IOS = "16.4";
const MARKER_RELATIVE_PATH = "Library/Caches/cindy-push-marker.json";

const APP_SOURCE = `
#import <UIKit/UIKit.h>
#import <UserNotifications/UserNotifications.h>

static void WriteMarker(NSDictionary *values) {
  NSString *directory = [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Caches"];
  [[NSFileManager defaultManager] createDirectoryAtPath:directory
                              withIntermediateDirectories:YES
                                               attributes:nil
                                                    error:nil];
  NSMutableDictionary *marker = [values mutableCopy];
  marker[@"writtenAt"] = [NSDate date].description;
  NSData *data = [NSJSONSerialization dataWithJSONObject:marker options:0 error:nil];
  [data writeToFile:[directory stringByAppendingPathComponent:@"cindy-push-marker.json"]
         atomically:YES];
}

@interface AppDelegate : UIResponder <UIApplicationDelegate, UNUserNotificationCenterDelegate>
@property(nonatomic, strong) UIWindow *window;
@end

@implementation AppDelegate
- (BOOL)application:(UIApplication *)application
    didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
  (void)application;
  (void)launchOptions;
  UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
  center.delegate = self;
  WriteMarker(@{ @"event": @"launched" });
  WriteMarker(@{ @"event": @"registering" });
  [application registerForRemoteNotifications];
  return YES;
}

- (void)application:(UIApplication *)application
    didRegisterForRemoteNotificationsWithDeviceToken:(NSData *)deviceToken {
  (void)application;
  WriteMarker(@{ @"event": @"registered", @"tokenBytes": @(deviceToken.length) });
}

- (void)application:(UIApplication *)application
    didFailToRegisterForRemoteNotificationsWithError:(NSError *)error {
  (void)application;
  WriteMarker(@{ @"event": @"registration-failed", @"error": error.localizedDescription ?: @"unknown" });
}

- (void)application:(UIApplication *)application
    didReceiveRemoteNotification:(NSDictionary *)userInfo
    fetchCompletionHandler:(void (^)(UIBackgroundFetchResult result))completionHandler {
  (void)application;
  WriteMarker(@{ @"event": @"remote", @"userInfo": userInfo ?: @{} });
  completionHandler(UIBackgroundFetchResultNewData);
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
       willPresentNotification:(UNNotification *)notification
         withCompletionHandler:(void (^)(UNNotificationPresentationOptions options))completionHandler {
  (void)center;
  WriteMarker(@{ @"event": @"presented", @"userInfo": notification.request.content.userInfo ?: @{} });
  completionHandler(UNNotificationPresentationOptionBanner);
}
@end

int main(int argc, char *argv[]) {
  @autoreleasepool {
    return UIApplicationMain(argc, argv, nil, NSStringFromClass([AppDelegate class]));
  }
}
`;

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDevelopmentRegion</key><string>en</string>
<key>CFBundleExecutable</key><string>PushSmoke</string>
<key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundleName</key><string>PushSmoke</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleSupportedPlatforms</key><array><string>iPhoneSimulator</string></array>
<key>DTPlatformName</key><string>iphonesimulator</string>
<key>DTSDKName</key><string>iphonesimulator26.4</string>
<key>LSRequiresIPhoneOS</key><true/>
<key>MinimumOSVersion</key><string>${MIN_IOS}</string>
<key>UIBackgroundModes</key><array><string>remote-notification</string></array>
<key>UIDeviceFamily</key><array><integer>1</integer><integer>2</integer></array>
<key>UIRequiredDeviceCapabilities</key><array><string>arm64</string></array>
</dict></plist>
`;

const ENTITLEMENTS_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>aps-environment</key><string>development</string>
</dict></plist>
`;

const PROJECT_YML = `name: PushSmoke
targets:
  PushSmoke:
    type: application
    platform: iOS
    deploymentTarget: "${MIN_IOS}"
    sources:
      - path: Sources
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: ${BUNDLE_ID}
        PRODUCT_NAME: PushSmoke
        INFOPLIST_FILE: Sources/Info.plist
        CODE_SIGN_ENTITLEMENTS: Sources/PushSmoke.entitlements
        TARGETED_DEVICE_FAMILY: "1,2"
        CODE_SIGN_IDENTITY: "-"
        CODE_SIGNING_REQUIRED: "NO"
`;

async function run(): Promise<void> {
  const runner = createNodeIOSSimulatorCommandRunner();
  const lifecycle = createIOSSimulatorSimctlLifecycle();
  let udid: string | null = null;
  let tempRoot: string | null = null;
  try {
    const environment = await createIOSSimulatorRuntime().inspect();
    if (!environment.ready) {
      throw new Error(
        environment.error ?? environment.issue ?? "environment unavailable",
      );
    }
    const runtime = environment.runtimes.find(
      (candidate) => candidate.isAvailable && candidate.version === MIN_IOS,
    );
    const template = environment.devices.find(
      (candidate) =>
        candidate.isAvailable &&
        candidate.runtimeIdentifier === runtime?.identifier &&
        candidate.deviceTypeIdentifier,
    );
    if (!runtime || !template?.deviceTypeIdentifier) {
      throw new Error(`No available iOS ${MIN_IOS} runtime/device template`);
    }

    tempRoot = await mkdtemp(path.join(os.tmpdir(), "cindy-ios-push-smoke-"));
    const projectRoot = path.join(tempRoot, "project");
    const sourcesRoot = path.join(projectRoot, "Sources");
    await mkdir(sourcesRoot, { recursive: true });
    await writeFile(path.join(sourcesRoot, "main.m"), APP_SOURCE, {
      encoding: "utf8",
      mode: 0o600,
    });
    await writeFile(path.join(sourcesRoot, "Info.plist"), INFO_PLIST, {
      encoding: "utf8",
      mode: 0o600,
    });
    await writeFile(
      path.join(sourcesRoot, "PushSmoke.entitlements"),
      ENTITLEMENTS_PLIST,
      { encoding: "utf8", mode: 0o600 },
    );
    await writeFile(path.join(projectRoot, "project.yml"), PROJECT_YML, {
      encoding: "utf8",
      mode: 0o600,
    });
    const generate = await runner.run("/usr/local/bin/xcodegen", ["generate"], {
      timeoutMs: 30_000,
      maxBufferBytes: 512 * 1024,
      cwd: projectRoot,
    });
    if (generate.exitCode !== 0) {
      throw new Error(
        `push smoke xcode project generation failed: ${generate.stderr}`,
      );
    }
    const derivedDataPath = path.join(tempRoot, "DerivedData");
    const build = await runner.run(
      "/usr/bin/xcodebuild",
      [
        "-project",
        path.join(projectRoot, "PushSmoke.xcodeproj"),
        "-scheme",
        "PushSmoke",
        "-sdk",
        "iphonesimulator",
        "-configuration",
        "Debug",
        "-derivedDataPath",
        derivedDataPath,
        "build",
        "CODE_SIGN_IDENTITY=-",
        "CODE_SIGNING_REQUIRED=NO",
        "CODE_SIGNING_ALLOWED=YES",
      ],
      {
        timeoutMs: 180_000,
        maxBufferBytes: 8 * 1024 * 1024,
        cwd: projectRoot,
      },
    );
    if (build.exitCode !== 0) {
      throw new Error(`push smoke app xcodebuild failed: ${build.stderr}`);
    }

    const created = await lifecycle.createExact({
      name: `Cindy Push Smoke ${Date.now()}`,
      deviceTypeIdentifier: template.deviceTypeIdentifier,
      runtimeIdentifier: runtime.identifier,
    });
    udid = created.udid;
    await lifecycle.bootExact(udid);

    const appPath = path.join(
      derivedDataPath,
      "Build",
      "Products",
      "Debug-iphonesimulator",
      "PushSmoke.app",
    );
    const install = await runner.run("/usr/bin/xcrun", [
      "simctl",
      "install",
      udid,
      appPath,
    ]);
    if (install.exitCode !== 0)
      throw new Error(`push smoke app install failed: ${install.stderr}`);
    const launch = await runner.run("/usr/bin/xcrun", [
      "simctl",
      "launch",
      udid,
      BUNDLE_ID,
    ]);
    if (launch.exitCode !== 0) {
      const verify = await runner.run("/usr/bin/codesign", [
        "--verify",
        "--deep",
        "--verbose=4",
        appPath,
      ]);
      const fileInfo = await runner.run("/usr/bin/file", [
        path.join(appPath, "PushSmoke"),
      ]);
      const appInfo = await runner.run("/usr/bin/xcrun", [
        "simctl",
        "listapps",
        udid,
      ]);
      const crashLog = await runner.run("/usr/bin/xcrun", [
        "simctl",
        "spawn",
        udid,
        "log",
        "show",
        "--last",
        "2m",
        "--style",
        "compact",
        "--predicate",
        `process == "PushSmoke"`,
      ]);
      throw new Error(
        `push smoke app launch failed: ${launch.stderr}\n${launch.stdout}\n` +
          `codesign: ${verify.stderr}\nfile: ${fileInfo.stdout}\n` +
          `appInfo: ${appInfo.stdout}\ncrashLog: ${crashLog.stdout}\n${crashLog.stderr}`,
      );
    }
    const containerResult = await runner.run("/usr/bin/xcrun", [
      "simctl",
      "get_app_container",
      udid,
      BUNDLE_ID,
      "data",
    ]);
    if (containerResult.exitCode !== 0) {
      throw new Error(
        `unable to locate push smoke app container: ${containerResult.stderr}`,
      );
    }
    const markerPath = path.join(
      containerResult.stdout.trim(),
      MARKER_RELATIVE_PATH,
    );
    const registrationDeadline = Date.now() + 30_000;
    let registration: Record<string, unknown> | null = null;
    while (Date.now() < registrationDeadline) {
      try {
        registration = JSON.parse(await readFile(markerPath, "utf8")) as Record<
          string,
          unknown
        >;
        if (registration.event === "registered") break;
      } catch {
        // The app may not have finished launching or registering yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (registration?.event !== "registered") {
      throw new Error(
        `push smoke app did not register for remote notifications: ${JSON.stringify(registration)}`,
      );
    }

    const marker = randomUUID();
    await lifecycle.pushNotification?.(udid, BUNDLE_ID, {
      aps: { alert: { title: "Cindy push smoke", body: marker } },
      cindySmokeMarker: marker,
    });
    const pushDeadline = Date.now() + 30_000;
    let delivered: Record<string, unknown> | null = null;
    while (Date.now() < pushDeadline) {
      try {
        const value = JSON.parse(await readFile(markerPath, "utf8")) as Record<
          string,
          unknown
        >;
        const userInfo = value.userInfo;
        if (
          (value.event === "remote" || value.event === "presented") &&
          userInfo &&
          typeof userInfo === "object" &&
          (userInfo as Record<string, unknown>).cindySmokeMarker === marker
        ) {
          delivered = value;
          break;
        }
      } catch {
        // Keep polling until the bounded deadline.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!delivered)
      throw new Error(
        "simctl push was accepted but the app did not observe the payload",
      );
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        udid,
        runtime: runtime.identifier,
        bundleId: BUNDLE_ID,
        registration: registration.event,
        delivery: delivered.event,
      })}\n`,
    );
  } finally {
    if (udid) {
      await lifecycle.shutdownExact(udid).catch(() => undefined);
      await lifecycle.deleteExact(udid).catch(() => undefined);
    }
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  }
}

await run();
