#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <CoreImage/CoreImage.h>
#import <IOSurface/IOSurface.h>
#import <IOKit/pwr_mgt/IOPMLib.h>
#import <dlfcn.h>
#import <signal.h>
#import <unistd.h>
#import <stdatomic.h>
#import <time.h>

static _Atomic(time_t) lastRequest;

// Compatibility capture for an already logged-in macOS session. These public
// legacy symbols are unavailable at compile time in SDK 15+, and may eventually
// disappear at runtime. Resolve them explicitly and fail closed if unavailable.
// No private WindowServer APIs, elevation, TCC changes, or network listener.
typedef void (^FrameHandler)(int32_t, uint64_t, IOSurfaceRef, const void *);
typedef CFTypeRef (*CreateStream)(CGDirectDisplayID, size_t, size_t, int32_t,
                                 CFDictionaryRef, dispatch_queue_t, FrameHandler);
typedef CGError (*StartStream)(CFTypeRef);

static NSDictionary *readCursor(CGDirectDisplayID display) {
  // Read on the main queue. currentSystemCursor returns the actual global shape,
  // including cursors supplied by other applications (not this helper's cursor).
  typedef boolean_t (*CursorVisible)(void);
  CursorVisible visible = (CursorVisible)dlsym(RTLD_DEFAULT, "CGCursorIsVisible");
  if (!visible) return nil;
  NSCursor *cursor = [NSCursor currentSystemCursor];
  if (!cursor) return nil;
  NSImage *image = cursor.image;
  NSSize size = image.size;
  if (size.width <= 0 || size.height <= 0 || size.width > 256 || size.height > 256) return nil;
  CGImageRef cg = [image CGImageForProposedRect:NULL context:nil hints:nil];
  if (!cg || CGImageGetWidth(cg) > 512 || CGImageGetHeight(cg) > 512) return nil;
  NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithCGImage:cg];
  NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
  if (!png || png.length > 49152) return nil;
  CGEventRef event = CGEventCreate(NULL);
  if (!event) return nil;
  CGPoint point = CGEventGetLocation(event);
  CFRelease(event);
  CGRect bounds = CGDisplayBounds(display);
  if (bounds.size.width <= 0 || bounds.size.height <= 0) return nil;
  NSPoint hot = cursor.hotSpot;
  return @{
    @"visible": visible() && CGRectContainsPoint(bounds, point) ? @YES : @NO,
    @"x": @(fmax(0, fmin(1, (point.x - bounds.origin.x) / bounds.size.width))),
    @"y": @(fmax(0, fmin(1, (point.y - bounds.origin.y) / bounds.size.height))),
    @"width": @(size.width), @"height": @(size.height),
    @"hotX": @(fmax(0, fmin(size.width, hot.x))),
    @"hotY": @(fmax(0, fmin(size.height, hot.y))),
    @"png": [png base64EncodedStringWithOptions:0]
  };
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    BOOL overlay = argc == 5 && strcmp(argv[2], "cursor-overlay") == 0;
    if (argc != 2 && !overlay) return 2;
    int fps = overlay && strcmp(argv[3], "60") == 0 ? 60 : (overlay ? 30 : 15);
    double quality = overlay ? atof(argv[4]) : 0.55;
    if (quality < 0.1 || quality > 1) return 2;
    char *end = NULL;
    unsigned long value = strtoul(argv[1], &end, 10);
    if (!*argv[1] || *end || value > UINT32_MAX || !CGDisplayIsOnline((uint32_t)value)) return 2;
    if (!CGPreflightScreenCaptureAccess()) return 3;
    // A sleeping display can accept CGDisplayStreamStart yet deliver no frames.
    // Wake its pixels without changing the lock/authentication state. Main holds
    // prevent-display-sleep only for the authenticated viewer lease.
    IOPMAssertionID activity = kIOPMNullAssertionID;
    IOPMAssertionDeclareUserActivity(CFSTR("Cindy remote desktop viewer"), kIOPMUserActiveLocal, &activity);
    CreateStream create = (CreateStream)dlsym(RTLD_DEFAULT, "CGDisplayStreamCreateWithDispatchQueue");
    StartStream start = (StartStream)dlsym(RTLD_DEFAULT, "CGDisplayStreamStart");
    const CFStringRef *intervalKey = dlsym(RTLD_DEFAULT, "kCGDisplayStreamMinimumFrameTime");
    const CFStringRef *cursorKey = dlsym(RTLD_DEFAULT, "kCGDisplayStreamShowCursor");
    if (!create || !start || !intervalKey || !cursorKey) return 4;
    CGDirectDisplayID display = (uint32_t)value;
    size_t width = CGDisplayPixelsWide(display), height = CGDisplayPixelsHigh(display);
    if (!width || !height) return 2;
    // This is a negotiated capture mode, not a snapshot of cursor availability.
    // A temporarily hidden/unreadable cursor must not permanently bake the
    // cursor into video or stop subsequent shape/visibility polling.
    BOOL separateCursor = overlay;
    // Preserve full selected display resolution for the cursor-overlay path.
    // The legacy compatibility path retains its original inexpensive bounds.
    double scale = MIN(1.0, (overlay ? 4096.0 : 1280.0) / MAX(width, height));
    width = MAX(1, (size_t)(width * scale)); height = MAX(1, (size_t)(height * scale));
    dispatch_queue_t queue = dispatch_queue_create("cindy.desktop.capture", DISPATCH_QUEUE_SERIAL);
    CIContext *context = [CIContext contextWithOptions:@{ kCIContextCacheIntermediates: @NO }];
    CGColorSpaceRef color = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    __block NSData *latest = nil;
    __block BOOL requested = NO;
    atomic_store(&lastRequest, time(NULL));
    void (^reply)(void) = ^{
      if (!requested || !latest) return;
      requested = NO;
      NSData *data;
      if (overlay) {
        __block NSDictionary *cursor = nil;
        if (separateCursor) dispatch_sync(dispatch_get_main_queue(), ^{ cursor = readCursor(display); });
        NSDictionary *frame = @{@"jpeg": [latest base64EncodedStringWithOptions:0], @"cursor": cursor ?: [NSNull null]};
        NSMutableData *line = [[NSJSONSerialization dataWithJSONObject:frame options:0 error:NULL] mutableCopy];
        [line appendBytes:"\n" length:1];
        data = line;
      } else {
        NSString *line = [[latest base64EncodedStringWithOptions:0] stringByAppendingString:@"\n"];
        data = [line dataUsingEncoding:NSUTF8StringEncoding];
      }
      const uint8_t *bytes = data.bytes;
      size_t remaining = data.length;
      while (remaining) {
        ssize_t count = write(STDOUT_FILENO, bytes, remaining);
        if (count <= 0) _exit(0);
        bytes += count; remaining -= count;
      }
    };
    CFTypeRef stream = create(display, width, height, 'BGRA',
      (__bridge CFDictionaryRef)@{(__bridge NSString *)*intervalKey: @(1.0/fps), (__bridge NSString *)*cursorKey: separateCursor ? @NO : @YES}, queue,
      ^(int32_t status, uint64_t timestamp, IOSurfaceRef surface, const void *update) {
        @autoreleasepool {
          if (status == 3) _exit(5); // stopped; never serve the previous session's frame
          if (status == 2) { latest = nil; return; } // blank display
          if (status != 0 || !surface) return;
          CIImage *image = [CIImage imageWithIOSurface:surface];
          NSData *jpeg = [context JPEGRepresentationOfImage:image colorSpace:color
            options:@{(__bridge NSString *)kCGImageDestinationLossyCompressionQuality: @(quality)}];
          NSUInteger limit = overlay ? 1000000 : 180000;
          if (overlay) {
            for (NSNumber *q in @[@0.45, @0.25, @0.1]) {
              if (jpeg.length <= limit) break;
              jpeg = [context JPEGRepresentationOfImage:image colorSpace:color
                options:@{(__bridge NSString *)kCGImageDestinationLossyCompressionQuality: q}];
            }
            // Bound high-detail screens without turning them into disconnects.
            for (int attempt = 0; jpeg.length > limit && attempt < 4; attempt++) {
              image = [image imageByApplyingTransform:CGAffineTransformMakeScale(0.75, 0.75)];
              jpeg = [context JPEGRepresentationOfImage:image colorSpace:color
                options:@{(__bridge NSString *)kCGImageDestinationLossyCompressionQuality: @0.25}];
            }
          }
          latest = jpeg.length <= limit ? jpeg : nil;
          reply();
        }
      });
    if (!stream || start(stream) != kCGErrorSuccess) return 5;
    signal(SIGPIPE, SIG_IGN);
    // stdin is a private parent pipe: one byte asks for one latest frame. EOF
    // and a stalled parent both terminate capture without retaining any pixels.
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
      char byte;
      while (read(STDIN_FILENO, &byte, 1) == 1) {
        if (byte != 'f') _exit(2);
        atomic_store(&lastRequest, time(NULL));
        dispatch_async(queue, ^{ requested = YES; reply(); });
      }
      _exit(0);
    });
    dispatch_source_t watchdog = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_global_queue(QOS_CLASS_UTILITY, 0));
    dispatch_source_set_timer(watchdog, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), NSEC_PER_SEC, 0);
    dispatch_source_set_event_handler(watchdog, ^{
      if (time(NULL) - atomic_load(&lastRequest) > 5) _exit(0);
    });
    dispatch_resume(watchdog);
    dispatch_main();
  }
}
