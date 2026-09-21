// Standalone native regression: compile with the same frameworks as macos-capture.m.
// Including production code keeps this test on the actual shape-recognition path.
#define main captureHelperMain
#include "macos-capture.m"
#undef main
#import <objc/runtime.h>
#include <assert.h>

static NSCursor *unavailableCursor(id receiver, SEL selector) { return nil; }
static NSCursor *testHand;
static NSCursor *availableHand(id receiver, SEL selector) { return testHand; }

int main(void) {
  @autoreleasepool {
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
