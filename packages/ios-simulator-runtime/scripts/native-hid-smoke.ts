import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createIOSSimulatorRuntime,
  createIOSSimulatorSimctlLifecycle,
  createNodeIOSSimulatorCommandRunner,
  createIOSSimulatorNativeSidecarSandboxPolicy,
  IOSSimulatorNativeSidecarProcessManager,
  parseIOSSimulatorCompatibilitySelectors,
  selectIOSSimulatorCompatibilityRuntimes,
  selectIOSSimulatorNativeArchitectures,
} from "../src/index.js";

const BUNDLE_ID = "com.cindy.iossimulator.hidsmoke";
const MARKER_RELATIVE_PATH = "Library/Caches/cindy-hid-marker.json";
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const architecture = selectIOSSimulatorNativeArchitectures(
  process.arch,
  parseIOSSimulatorCompatibilitySelectors(
    process.env.CINDY_IOS_SIDECAR_ARCH,
    "CINDY_IOS_SIDECAR_ARCH",
  ),
)[0];
if (!architecture) throw new Error("A native sidecar architecture is required");
const binaryPath = path.resolve(
  packageRoot,
  "..",
  "..",
  "apps",
  "desktop",
  "resources",
  "ios-simulator",
  "native",
  architecture,
  "ios-simulator-sidecar",
);

const APP_SOURCE = `
#import <UIKit/UIKit.h>

static NSInteger sequence = 0;
static NSInteger beganCount = 0;
static NSInteger movedCount = 0;
static NSInteger endedCount = 0;
static NSInteger cancelledCount = 0;
static NSInteger maxTouches = 0;
static NSString *currentScreen = @"unknown";

static void WriteMarker(NSString *event, NSSet<UITouch *> *touches, UIEvent *uiEvent) {
  NSInteger total = uiEvent.allTouches.count;
  NSInteger active = 0;
  for (UITouch *touch in uiEvent.allTouches) {
    if (touch.phase != UITouchPhaseEnded && touch.phase != UITouchPhaseCancelled) {
      active += 1;
    }
  }
  maxTouches = MAX(maxTouches, total);
  NSDictionary *marker = @{
    @"sequence": @(++sequence),
    @"event": event,
    @"screen": currentScreen,
    @"sampleTouches": @(touches.count),
    @"activeTouches": @(active),
    @"maxTouches": @(maxTouches),
    @"began": @(beganCount),
    @"moved": @(movedCount),
    @"ended": @(endedCount),
    @"cancelled": @(cancelledCount)
  };
  NSString *directory = [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Caches"];
  [[NSFileManager defaultManager] createDirectoryAtPath:directory
                            withIntermediateDirectories:YES
                                             attributes:nil
                                                  error:nil];
  NSData *data = [NSJSONSerialization dataWithJSONObject:marker options:0 error:nil];
  [data writeToFile:[directory stringByAppendingPathComponent:@"cindy-hid-marker.json"]
         atomically:YES];
}

@interface TouchView : UIView
@end

@implementation TouchView
- (instancetype)initWithFrame:(CGRect)frame {
  self = [super initWithFrame:frame];
  if (self) {
    self.multipleTouchEnabled = YES;
    self.backgroundColor = [UIColor colorWithRed:0.08 green:0.12 blue:0.2 alpha:1];
  }
  return self;
}
- (void)touchesBegan:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
  beganCount += touches.count;
  WriteMarker(@"began", touches, event);
}
- (void)touchesMoved:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
  movedCount += touches.count;
  WriteMarker(@"moved", touches, event);
}
- (void)touchesEnded:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
  endedCount += touches.count;
  WriteMarker(@"ended", touches, event);
}
- (void)touchesCancelled:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
  cancelledCount += touches.count;
  WriteMarker(@"cancelled", touches, event);
}
@end

@interface ScreenController : UIViewController
@property(nonatomic, copy) NSString *screenName;
@property(nonatomic) CGFloat edgeStartX;
- (instancetype)initWithScreenName:(NSString *)screenName;
@end

@implementation ScreenController
- (instancetype)initWithScreenName:(NSString *)screenName {
  self = [super initWithNibName:nil bundle:nil];
  if (self) {
    self.screenName = screenName;
  }
  return self;
}
- (void)loadView {
  self.view = [[TouchView alloc] initWithFrame:UIScreen.mainScreen.bounds];
}
- (void)viewDidLoad {
  [super viewDidLoad];
  if ([self.screenName isEqualToString:@"detail"]) {
    UIPanGestureRecognizer *pan =
        [[UIPanGestureRecognizer alloc] initWithTarget:self
                                                action:@selector(handleEdgePan:)];
    pan.cancelsTouchesInView = NO;
    [self.view addGestureRecognizer:pan];
  }
}
- (void)handleEdgePan:(UIPanGestureRecognizer *)recognizer {
  if (recognizer.state == UIGestureRecognizerStateBegan) {
    self.edgeStartX = [recognizer locationInView:self.view].x;
  } else if (recognizer.state == UIGestureRecognizerStateEnded) {
    CGFloat displacement = [recognizer translationInView:self.view].x;
    if (self.edgeStartX <= 5 && displacement >= self.view.bounds.size.width / 2) {
      [self.navigationController popViewControllerAnimated:NO];
    }
  }
}
- (void)viewDidAppear:(BOOL)animated {
  [super viewDidAppear:animated];
  currentScreen = self.screenName;
  WriteMarker(@"screen", [NSSet set], nil);
}
@end

@interface AppDelegate : UIResponder <UIApplicationDelegate>
@property(nonatomic, strong) UIWindow *window;
@end

@implementation AppDelegate
- (BOOL)application:(UIApplication *)application
    didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
  (void)application;
  (void)launchOptions;
  self.window = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
  ScreenController *root = [[ScreenController alloc] initWithScreenName:@"root"];
  UINavigationController *navigation =
      [[UINavigationController alloc] initWithRootViewController:root];
  navigation.navigationBarHidden = YES;
  ScreenController *detail = [[ScreenController alloc] initWithScreenName:@"detail"];
  [navigation pushViewController:detail animated:NO];
  navigation.interactivePopGestureRecognizer.enabled = YES;
  self.window.rootViewController = navigation;
  [self.window makeKeyAndVisible];
  WriteMarker(@"launched", [NSSet set], nil);
  return YES;
}
@end

int main(int argc, char *argv[]) {
  @autoreleasepool {
    return UIApplicationMain(argc, argv, nil, NSStringFromClass([AppDelegate class]));
  }
}
`;

const PROJECT_YML = `name: HIDSmoke
targets:
  HIDSmoke:
    type: application
    platform: iOS
    deploymentTarget: "16.4"
    sources:
      - path: Sources
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: ${BUNDLE_ID}
        PRODUCT_NAME: HIDSmoke
        GENERATE_INFOPLIST_FILE: YES
        INFOPLIST_KEY_UIApplicationSceneManifest_Generation: NO
        TARGETED_DEVICE_FAMILY: "1,2"
        CODE_SIGN_IDENTITY: "-"
        CODE_SIGNING_REQUIRED: "NO"
`;

interface Marker {
  sequence: number;
  event: string;
  screen: string;
  activeTouches: number;
  maxTouches: number;
  began: number;
  moved: number;
  ended: number;
  cancelled: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findSidecarPid(
  runner: ReturnType<typeof createNodeIOSSimulatorCommandRunner>,
  simulatorUdid: string,
): Promise<number> {
  const result = await runner.run("/bin/ps", ["-axo", "pid=,command="]);
  if (result.exitCode !== 0) {
    throw new Error(`Unable to inspect HID sidecar process: ${result.stderr}`);
  }
  for (const line of result.stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (
      match?.[2]?.includes("ios-simulator-sidecar") &&
      match[2].includes(simulatorUdid)
    ) {
      return Number(match[1]);
    }
  }
  throw new Error("Unable to locate the exact HID smoke sidecar process.");
}

async function readMarker(
  markerPath: string,
  predicate: (marker: Marker) => boolean,
  description: string,
  timeoutMs = 10_000,
): Promise<Marker> {
  const deadline = Date.now() + timeoutMs;
  let last: Marker | null = null;
  while (Date.now() < deadline) {
    try {
      last = JSON.parse(await readFile(markerPath, "utf8")) as Marker;
      if (predicate(last)) return last;
    } catch {
      // The app or atomic marker replacement may still be in progress.
    }
    await delay(50);
  }
  throw new Error(`${description} was not observed: ${JSON.stringify(last)}`);
}

async function run(): Promise<void> {
  const runtime = createIOSSimulatorRuntime();
  const lifecycle = createIOSSimulatorSimctlLifecycle();
  const runner = createNodeIOSSimulatorCommandRunner();
  const manager = new IOSSimulatorNativeSidecarProcessManager({
    binaryPath,
    enableContinuousInput: true,
    sandboxPolicy: createIOSSimulatorNativeSidecarSandboxPolicy({
      required: true,
      platform: process.platform,
    }),
  });
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "cindy-native-hid-smoke-"),
  );
  let simulatorUdid: string | null = null;
  try {
    const environment = await runtime.inspect();
    if (!environment.ready) {
      throw new Error(
        environment.error ?? environment.issue ?? "environment unavailable",
      );
    }
    const requestedRuntime = parseIOSSimulatorCompatibilitySelectors(
      process.env.CINDY_IOS_SIMULATOR_RUNTIME,
      "CINDY_IOS_SIMULATOR_RUNTIME",
    );
    const selectedRuntime = requestedRuntime
      ? selectIOSSimulatorCompatibilityRuntimes(
          environment.runtimes,
          requestedRuntime,
        )[0]
      : (environment.runtimes.find(
          (candidate) =>
            candidate.isAvailable &&
            candidate.identifier.includes(".SimRuntime.iOS-") &&
            candidate.version === "26.4",
        ) ??
        environment.runtimes.find(
          (candidate) =>
            candidate.isAvailable &&
            candidate.identifier.includes(".SimRuntime.iOS-"),
        ));
    const template =
      environment.devices.find(
        (candidate) =>
          candidate.isAvailable &&
          candidate.runtimeIdentifier === selectedRuntime?.identifier &&
          candidate.deviceTypeIdentifier,
      ) ??
      environment.devices.find(
        (candidate) => candidate.isAvailable && candidate.deviceTypeIdentifier,
      );
    if (!selectedRuntime || !template?.deviceTypeIdentifier) {
      throw new Error("No compatible iOS runtime/device template");
    }

    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(projectRoot, "Sources");
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(path.join(sourceRoot, "main.m"), APP_SOURCE, "utf8");
    await writeFile(path.join(projectRoot, "project.yml"), PROJECT_YML, "utf8");
    const generated = await runner.run(
      process.env.CINDY_XCODEGEN_PATH ?? "xcodegen",
      ["generate"],
      {
        cwd: projectRoot,
        timeoutMs: 30_000,
        maxBufferBytes: 512 * 1024,
      },
    );
    if (generated.exitCode !== 0) {
      throw new Error(
        `HID smoke project generation failed: ${generated.stderr}`,
      );
    }
    const derivedData = path.join(tempRoot, "DerivedData");
    const build = await runner.run(
      "/usr/bin/xcodebuild",
      [
        "-project",
        path.join(projectRoot, "HIDSmoke.xcodeproj"),
        "-scheme",
        "HIDSmoke",
        "-sdk",
        "iphonesimulator",
        "-configuration",
        "Debug",
        "-derivedDataPath",
        derivedData,
        "build",
        "CODE_SIGN_IDENTITY=-",
        "CODE_SIGNING_REQUIRED=NO",
        "CODE_SIGNING_ALLOWED=YES",
      ],
      {
        cwd: projectRoot,
        timeoutMs: 180_000,
        maxBufferBytes: 8 * 1024 * 1024,
      },
    );
    if (build.exitCode !== 0) {
      throw new Error(`HID smoke app build failed: ${build.stderr}`);
    }

    const created = await lifecycle.createExact({
      name: `Cindy Native HID Smoke ${Date.now()}`,
      deviceTypeIdentifier: template.deviceTypeIdentifier,
      runtimeIdentifier: selectedRuntime.identifier,
    });
    simulatorUdid = created.udid;
    await lifecycle.bootExact(simulatorUdid);
    const appPath = path.join(
      derivedData,
      "Build",
      "Products",
      "Debug-iphonesimulator",
      "HIDSmoke.app",
    );
    for (const [operation, argv] of [
      ["install", ["simctl", "install", simulatorUdid, appPath]],
      ["launch", ["simctl", "launch", simulatorUdid, BUNDLE_ID]],
    ] as const) {
      const result = await runner.run("/usr/bin/xcrun", argv);
      if (result.exitCode !== 0) {
        throw new Error(`HID smoke ${operation} failed: ${result.stderr}`);
      }
    }
    const container = await runner.run("/usr/bin/xcrun", [
      "simctl",
      "get_app_container",
      simulatorUdid,
      BUNDLE_ID,
      "data",
    ]);
    if (container.exitCode !== 0) {
      throw new Error(`HID smoke container lookup failed: ${container.stderr}`);
    }
    const markerPath = path.join(container.stdout.trim(), MARKER_RELATIVE_PATH);
    await readMarker(
      markerPath,
      (value) => value.screen === "detail",
      "detail launch",
    );

    const running = await manager.start({
      instanceId: "native-hid-smoke",
      simulatorUdid,
      generation: 1,
    });
    if (
      !running.handshake.capabilities.continuousInput ||
      !running.handshake.capabilities.multiTouch ||
      running.handshake.probe.hid !== true
    ) {
      throw new Error(
        `Native HID capability probe failed: ${JSON.stringify(running.handshake)}`,
      );
    }

    const beforeSingle = await readMarker(
      markerPath,
      () => true,
      "single baseline",
    );
    await running.adapter.touchPath([
      { phase: "down", x: 0.25, y: 0.3 },
      { phase: "move", x: 0.35, y: 0.45, dtMs: 80 },
      { phase: "move", x: 0.45, y: 0.6, dtMs: 80 },
      { phase: "up", x: 0.55, y: 0.7, dtMs: 80 },
    ]);
    const single = await readMarker(
      markerPath,
      (value) =>
        value.ended > beforeSingle.ended &&
        value.moved > beforeSingle.moved &&
        value.activeTouches === 0,
      "single-finger drag",
    );

    await running.adapter.beginTouch("live-drag", {
      x: 0.25,
      y: 0.3,
    });
    await delay(40);
    await running.adapter.moveTouch("live-drag", {
      x: 0.4,
      y: 0.5,
    });
    await delay(40);
    await running.adapter.endTouch("live-drag", {
      x: 0.55,
      y: 0.7,
    });
    const live = await readMarker(
      markerPath,
      (value) =>
        value.ended > single.ended &&
        value.moved > single.moved &&
        value.activeTouches === 0,
      "live single-finger drag",
    );
    await running.adapter.beginTouch("live-cancel", {
      x: 0.35,
      y: 0.35,
    });
    await running.adapter.endTouch("live-cancel", { x: 0.45, y: 0.45 }, true);
    const liveCancelled = await readMarker(
      markerPath,
      (value) => value.sequence > live.sequence && value.activeTouches === 0,
      "live touch cancellation",
    );

    const beforeMulti = liveCancelled;
    await running.adapter.touch2Path(
      [
        { phase: "down", x: 0.45, y: 0.5 },
        { phase: "move", x: 0.35, y: 0.5, dtMs: 100 },
        { phase: "up", x: 0.25, y: 0.5, dtMs: 100 },
      ],
      [
        { phase: "down", x: 0.55, y: 0.5 },
        { phase: "move", x: 0.65, y: 0.5, dtMs: 100 },
        { phase: "up", x: 0.75, y: 0.5, dtMs: 100 },
      ],
    );
    const multi = await readMarker(
      markerPath,
      (value) =>
        value.ended >= beforeMulti.ended + 2 &&
        value.maxTouches >= 2 &&
        value.activeTouches === 0,
      "two-finger gesture",
    );

    const abortController = new AbortController();
    const aborted = running.adapter.touchPath(
      [
        { phase: "down", x: 0.3, y: 0.3 },
        { phase: "move", x: 0.4, y: 0.4, dtMs: 1_000 },
        { phase: "up", x: 0.5, y: 0.5, dtMs: 1_000 },
      ],
      abortController.signal,
    );
    await delay(100);
    abortController.abort();
    await aborted;
    const cancelled = await readMarker(
      markerPath,
      (value) => value.sequence > multi.sequence && value.activeTouches === 0,
      "abort release",
    );

    const crashGesture = running.adapter.touchPath([
      { phase: "down", x: 0.35, y: 0.35 },
      { phase: "move", x: 0.45, y: 0.45, dtMs: 1_000 },
      { phase: "up", x: 0.55, y: 0.55, dtMs: 1_000 },
    ]);
    await delay(100);
    const crashedPid = await findSidecarPid(runner, simulatorUdid);
    process.kill(crashedPid, "SIGKILL");
    await crashGesture.catch(() => undefined);
    const crashDeadline = Date.now() + 5_000;
    while (
      manager.diagnostics("native-hid-smoke").running &&
      Date.now() < crashDeadline
    ) {
      await delay(25);
    }
    const restarted = await manager.recover({
      instanceId: "native-hid-smoke",
      simulatorUdid,
      generation: 1,
    });
    const beforeRecovery = await readMarker(
      markerPath,
      (value) => value.activeTouches === 0,
      "sidecar-exit release",
    );
    await restarted.adapter.touchPath([
      { phase: "down", x: 0.65, y: 0.3 },
      { phase: "move", x: 0.6, y: 0.4, dtMs: 80 },
      { phase: "up", x: 0.55, y: 0.5, dtMs: 80 },
    ]);
    const recovered = await readMarker(
      markerPath,
      (value) =>
        value.ended > beforeRecovery.ended && value.activeTouches === 0,
      "post-crash recovery",
    );

    await restarted.adapter.touchPath([
      { phase: "down", x: 0.001, y: 0.5, edge: "left" },
      { phase: "move", x: 0.4, y: 0.5, dtMs: 200, edge: "left" },
      { phase: "up", x: 0.8, y: 0.5, dtMs: 200, edge: "left" },
    ]);
    let edgeRecognized = true;
    let edge: Marker;
    try {
      edge = await readMarker(
        markerPath,
        (value) => value.screen === "root",
        "left-edge navigation",
        2_000,
      );
    } catch {
      edgeRecognized = false;
      edge = await readMarker(
        markerPath,
        () => true,
        "left-edge diagnostic marker",
      );
    }

    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        simulatorUdid,
        xcode: environment.xcodeVersion,
        developerDir: environment.xcodeSelectPath,
        architecture,
        runtime: {
          identifier: selectedRuntime.identifier,
          version: selectedRuntime.version,
          buildVersion: selectedRuntime.buildVersion,
        },
        capabilities: restarted.handshake.capabilities,
        probe: restarted.handshake.probe,
        single: {
          movedDelta: single.moved - beforeSingle.moved,
          endedDelta: single.ended - beforeSingle.ended,
        },
        live: {
          movedDelta: live.moved - single.moved,
          endedDelta: live.ended - single.ended,
          releaseEvent: liveCancelled.event,
          activeTouches: liveCancelled.activeTouches,
        },
        multi: {
          maxTouches: multi.maxTouches,
          endedDelta: multi.ended - beforeMulti.ended,
        },
        abort: {
          terminalEvent: cancelled.event,
          activeTouches: cancelled.activeTouches,
        },
        crashRecovery: {
          crashedPid,
          terminalEvent: recovered.event,
          activeTouches: recovered.activeTouches,
        },
        edge: {
          screen: edge.screen,
          event: edge.event,
          systemGestureRecognized: edgeRecognized,
        },
      })}\n`,
    );
  } finally {
    await manager.stop("native-hid-smoke").catch(() => undefined);
    if (simulatorUdid) {
      await lifecycle.shutdownExact(simulatorUdid).catch(() => undefined);
      await lifecycle.deleteExact(simulatorUdid).catch(() => undefined);
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
}

await run();
