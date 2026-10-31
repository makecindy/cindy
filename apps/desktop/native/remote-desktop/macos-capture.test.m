// Standalone native regression: compile with the same frameworks as macos-capture.m.
// Including production code keeps this test on the actual shape-recognition path.
#define main captureHelperMain
#include "macos-capture.m"
#undef main
#import <objc/runtime.h>
#include <assert.h>
#include <spawn.h>
#include <sys/wait.h>
extern char **environ;

static NSCursor *unavailableCursor(id receiver, SEL selector) { return nil; }
static NSCursor *testHand;
static NSCursor *availableHand(id receiver, SEL selector) { return testHand; }

// Real production lifecycle, with only the OS's asynchronous replies controlled.
// A child.kill() mock cannot catch the historical start-after-client-exit race.
@interface TestCaptureStream : NSObject
@property(nonatomic) int starts, stops;
@property(nonatomic, copy) void (^startReply)(NSError *);
@property(nonatomic, copy) void (^stopReply)(NSError *);
@end
@implementation TestCaptureStream
- (void)startCaptureWithCompletionHandler:(void (^)(NSError *))reply {
  self.starts++;
  self.startReply = reply;
}
- (void)stopCaptureWithCompletionHandler:(void (^)(NSError *))reply {
  self.stops++;
  self.stopReply = reply;
}
@end
static void drainLifetime(CaptureLifetime *lifetime) { dispatch_sync(lifetime.queue, ^{}); }
static void completeStart(TestCaptureStream *stream, NSError *error) {
  void (^reply)(NSError *) = stream.startReply;
  stream.startReply = nil;
  assert(reply);
  reply(error);
}
static void completeStop(TestCaptureStream *stream, NSError *error) {
  void (^reply)(NSError *) = stream.stopReply;
  stream.stopReply = nil;
  assert(reply);
  reply(error);
}
static void testCaptureLifetime(void) {
  // Cancellation during start must wait for both the late start and real stop.
  __block int exits = 0, code = -1;
  CaptureLifetime *lifetime = [[CaptureLifetime alloc] initWithShutdownTimeout:5 * NSEC_PER_SEC
    exitHandler:^(int value) { exits++; code = value; }];
  TestCaptureStream *stream = [TestCaptureStream new];
  dispatch_sync(lifetime.queue, ^{ [lifetime startStream:(SCStream *)stream]; });
  [lifetime requestExit:0];
  drainLifetime(lifetime);
  assert(stream.starts == 1 && stream.stops == 0 && exits == 0);
  completeStart(stream, nil);
  drainLifetime(lifetime);
  assert(stream.stops == 1 && exits == 0);
  [lifetime requestExit:5];
  drainLifetime(lifetime);
  assert(stream.stops == 1 && exits == 0);
  completeStop(stream, nil);
  drainLifetime(lifetime);
  assert(exits == 1 && code == 0);

  // A content lookup that completes after cancellation must not start capture.
  __block int earlyExits = 0;
  CaptureLifetime *early = [[CaptureLifetime alloc] initWithShutdownTimeout:5 * NSEC_PER_SEC
    exitHandler:^(int value) { earlyExits++; assert(value == 0); }];
  TestCaptureStream *late = [TestCaptureStream new];
  [early requestExit:0];
  drainLifetime(early);
  dispatch_sync(early.queue, ^{ [early startStream:(SCStream *)late]; });
  assert(earlyExits == 1 && late.starts == 0);

  // Failed starts also release the stream and preserve the failure exit code.
  __block int failedExits = 0, failedCode = -1;
  CaptureLifetime *failed = [[CaptureLifetime alloc] initWithShutdownTimeout:5 * NSEC_PER_SEC
    exitHandler:^(int value) { failedExits++; failedCode = value; }];
  TestCaptureStream *broken = [TestCaptureStream new];
  dispatch_sync(failed.queue, ^{ [failed startStream:(SCStream *)broken]; });
  completeStart(broken, [NSError errorWithDomain:@"test" code:1 userInfo:nil]);
  drainLifetime(failed);
  drainLifetime(failed); // start's callback enqueues the failure exit request.
  assert(broken.stops == 1 && failedExits == 0);
  completeStop(broken, nil);
  drainLifetime(failed);
  assert(failedExits == 1 && failedCode == 5);

  // Already-started capture still waits for stop; stop failures are not success.
  for (NSNumber *fails in @[@NO, @YES]) {
    __block int stoppedExits = 0, stoppedCode = -1;
    CaptureLifetime *started = [[CaptureLifetime alloc] initWithShutdownTimeout:5 * NSEC_PER_SEC
      exitHandler:^(int value) { stoppedExits++; stoppedCode = value; }];
    TestCaptureStream *active = [TestCaptureStream new];
    dispatch_sync(started.queue, ^{ [started startStream:(SCStream *)active]; });
    completeStart(active, nil);
    drainLifetime(started);
    [started requestExit:0];
    drainLifetime(started);
    assert(active.stops == 1 && stoppedExits == 0);
    NSError *error = fails.boolValue ? [NSError errorWithDomain:@"test" code:1 userInfo:nil] : nil;
    completeStop(active, error);
    drainLifetime(started);
    assert(stoppedExits == 1 && stoppedCode == (fails.boolValue ? 5 : 0));
  }

  // The bounded fallback must exit once even if a stalled start replies later.
  dispatch_semaphore_t ended = dispatch_semaphore_create(0);
  __block int stalledExits = 0;
  CaptureLifetime *stalled = [[CaptureLifetime alloc] initWithShutdownTimeout:0
    exitHandler:^(int value) { stalledExits++; dispatch_semaphore_signal(ended); }];
  TestCaptureStream *hung = [TestCaptureStream new];
  dispatch_sync(stalled.queue, ^{ [stalled startStream:(SCStream *)hung]; });
  [stalled requestExit:0];
  assert(dispatch_semaphore_wait(ended, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC)) == 0);
  completeStart(hung, nil);
  drainLifetime(stalled);
  assert(stalledExits == 1 && hung.stops == 0);
  puts("PASS capture lifetime: pending start, late setup, stop completion/error, bounded exit");
}

// Regression for the SkyLight first-call deadlock: on some macOS 13 systems
// (seen on dual-GPU MacBookPro14,3) the first display API call in a process
// can hang forever inside SkyLight's initDisplayState() — CGDisplayIsOnline()
// resolves to SLSDisplayStatusQuery, which deadlocks on an internal lock.
// main() warms up with CGMainDisplayID() first to avoid it. The deadlock is
// per-process initialization state, so the check must run in a fresh child.
static void testFirstDisplayQueryDoesNotHang(const char *self) {
  pid_t pid = 0;
  const char *args[] = {self, "--display-probe", NULL};
  assert(posix_spawn(&pid, self, NULL, NULL, (char *const *)args, environ) == 0);
  int status = 0, ticks = 0;
  for (;;) {
    pid_t r = waitpid(pid, &status, WNOHANG);
    if (r == pid) break;
    if (ticks++ >= 50) { // 5s budget: a hung display query fails here.
      kill(pid, SIGKILL);
      waitpid(pid, &status, 0);
      fprintf(stderr, "FAIL first display query: fresh process hung\n");
      exit(1);
    }
    usleep(100000);
  }
  assert(WIFEXITED(status) && WEXITSTATUS(status) == 2);
  puts("PASS first display query: fresh process exits promptly (no SkyLight hang)");
}

int main(int argc, const char *argv[]) {
  if (argc == 2 && strcmp(argv[1], "--display-probe") == 0) {
    // Unknown display id: must return 2 through CGDisplayIsOnline without
    // hanging, exactly as a failed connection attempt in production does.
    const char *probe[] = {"macos-capture", "123456789", NULL};
    return captureHelperMain(2, probe);
  }
  testFirstDisplayQueryDoesNotHang(argv[0]);
  @autoreleasepool {
    testCaptureLifetime();
    testHand = [[NSCursor alloc] initWithImage:[[NSImage alloc] initWithSize:NSMakeSize(16, 16)]
                                     hotSpot:NSZeroPoint];
    assert(testHand);
    SEL selectors[] = {
      @selector(arrowCursor), @selector(IBeamCursor), @selector(pointingHandCursor),
      @selector(crosshairCursor), @selector(openHandCursor), @selector(closedHandCursor),
      @selector(resizeLeftRightCursor), @selector(resizeUpDownCursor),
      @selector(operationNotAllowedCursor), @selector(dragCopyCursor),
      @selector(dragLinkCursor), @selector(IBeamCursorForVerticalLayout)
    };
    const size_t count = sizeof(selectors) / sizeof(selectors[0]);
    IMP original[sizeof(selectors) / sizeof(selectors[0])];
    for (size_t i = 0; i < count; i++) {
      Method method = class_getClassMethod(NSCursor.class, selectors[i]);
      original[i] = method_getImplementation(method);
    }
    @try {
      // A missing entry must neither abort capture nor shift later mappings.
      for (size_t i = 0; i < count; i++) {
        method_setImplementation(class_getClassMethod(NSCursor.class, selectors[i]), (IMP)unavailableCursor);
      }
      method_setImplementation(class_getClassMethod(NSCursor.class, selectors[2]), (IMP)availableHand);
      assert([standardCursorShape(testHand) isEqualToString:@"pointer"]);
      assert([standardCursorShape(nil) isEqualToString:@"default"]);
      for (size_t i = 0; i < count; i++) {
        method_setImplementation(class_getClassMethod(NSCursor.class, selectors[i]), (IMP)unavailableCursor);
      }
      assert([standardCursorShape(testHand) isEqualToString:@"default"]);
    } @catch (NSException *exception) {
      fprintf(stderr, "FAIL cursor recognition: %s\n", exception.name.UTF8String);
      return 1;
    } @finally {
      for (size_t i = 0; i < count; i++) {
        method_setImplementation(class_getClassMethod(NSCursor.class, selectors[i]), original[i]);
      }
    }
    puts("PASS cursor recognition: unavailable candidate, stable mapping, nil input, fallback");
  }
  return 0;
}
