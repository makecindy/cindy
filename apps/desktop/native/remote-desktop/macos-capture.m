#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <CoreImage/CoreImage.h>
#import <IOSurface/IOSurface.h>
#import <IOKit/pwr_mgt/IOPMLib.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <dlfcn.h>
#import <signal.h>
#import <unistd.h>
#import <stdatomic.h>
#import <time.h>

static _Atomic(time_t) lastRequest;
static atomic_bool awaitingFrame;

// Compatibility capture for an already logged-in macOS session. These public
// legacy symbols are unavailable at compile time in SDK 15+, and may eventually
// disappear at runtime. Resolve them explicitly and fail closed if unavailable.
// No private WindowServer APIs, elevation, TCC changes, or network listener.
typedef void (^FrameHandler)(int32_t, uint64_t, IOSurfaceRef, const void *);
typedef CFTypeRef (*CreateStream)(CGDirectDisplayID, size_t, size_t, int32_t,
                                 CFDictionaryRef, dispatch_queue_t, FrameHandler);
typedef CGError (*StartStream)(CFTypeRef);

static NSData *encodeCaptureSurface(CIContext *context, CGColorSpaceRef color, IOSurfaceRef surface,
                                    double quality, long frameLimit, BOOL overlay) {
  CIImage *image = [CIImage imageWithIOSurface:surface];
  NSData *jpeg = [context JPEGRepresentationOfImage:image colorSpace:color
    options:@{(__bridge NSString *)kCGImageDestinationLossyCompressionQuality: @(quality)}];
  NSUInteger limit = (NSUInteger)frameLimit;
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
  return jpeg.length <= limit ? jpeg : nil;
}

// The serial capture queue owns this slot. Demand mode keeps only the newest
// surface, without copying or encoding frames the recorder will never request.
// Pinning both the CF object and its use count prevents WindowServer reuse
// after the callback returns (CGDisplayStreamFrameAvailableHandler contract).
@interface CaptureFrameStore : NSObject
- (instancetype)initWithOnRequest:(BOOL)onRequest encoder:(NSData *(^)(IOSurfaceRef))encoder;
- (void)acceptSurface:(IOSurfaceRef)surface;
- (NSData *)jpeg;
- (void)clear;
@end
@implementation CaptureFrameStore {
  BOOL _onRequest;
  IOSurfaceRef _surface;
  NSData *_jpeg;
  NSData *(^_encoder)(IOSurfaceRef);
}
- (instancetype)initWithOnRequest:(BOOL)onRequest encoder:(NSData *(^)(IOSurfaceRef))encoder {
  if ((self = [super init])) { _onRequest = onRequest; _encoder = [encoder copy]; }
  return self;
}
- (void)releaseSurface {
  if (!_surface) return;
  IOSurfaceDecrementUseCount(_surface);
  CFRelease(_surface);
  _surface = NULL;
}
- (void)acceptSurface:(IOSurfaceRef)surface {
  if (_onRequest) {
    CFRetain(surface);
    IOSurfaceIncrementUseCount(surface);
    [self releaseSurface];
    _surface = surface;
    _jpeg = nil;
  } else {
    _jpeg = _encoder(surface);
  }
}
- (NSData *)jpeg {
  if (_surface) {
    _jpeg = _encoder(_surface);
    [self releaseSurface];
  }
  return _jpeg;
}
- (void)clear { [self releaseSurface]; _jpeg = nil; }
- (void)dealloc { [self releaseSurface]; }
@end

// A disconnected client can otherwise leave replayd starting a stream after the
// helper has exited. Serialize capture setup, start completion and stop on a
// control queue independent of pixel encoding / a blocked stdout write.
@interface CaptureLifetime : NSObject {
  dispatch_queue_t _queue;
  SCStream *_stream;
  dispatch_source_t _deadline;
  NSMutableArray *_signals;
  void (^_exitHandler)(int);
  int64_t _shutdownTimeout;
  atomic_bool _stopping;
  BOOL _starting, _stopSent, _finished;
  int _exitCode;
}
@property(nonatomic, readonly) dispatch_queue_t queue;
@property(nonatomic, readonly) BOOL stopping;
- (instancetype)initWithShutdownTimeout:(int64_t)timeout exitHandler:(void (^)(int))exitHandler;
- (void)observeTerminationSignals;
- (void)startStream:(SCStream *)stream; // Called on queue, after checking stopping.
- (void)requestExit:(int)code; // May be called from any queue.
@end

@implementation CaptureLifetime
- (instancetype)initWithShutdownTimeout:(int64_t)timeout exitHandler:(void (^)(int))exitHandler {
  if ((self = [super init])) {
    _queue = dispatch_queue_create("cindy-capture-lifetime", DISPATCH_QUEUE_SERIAL);
    _signals = [NSMutableArray new];
    _shutdownTimeout = timeout;
    _exitHandler = [exitHandler copy];
    atomic_init(&_stopping, false);
  }
  return self;
}
- (dispatch_queue_t)queue { return _queue; }
- (BOOL)stopping { return atomic_load(&_stopping); }
- (void)finishExit {
  if (_finished) return;
  _finished = YES;
  if (_deadline) { dispatch_source_cancel(_deadline); _deadline = nil; }
  for (dispatch_source_t source in _signals) dispatch_source_cancel(source);
  [_signals removeAllObjects];
  _stream = nil;
  _exitHandler(_exitCode);
}
- (void)stopStream {
  if (_starting || _stopSent || _finished) return;
  if (!_stream) { [self finishExit]; return; }
  _stopSent = YES;
  [_stream stopCaptureWithCompletionHandler:^(NSError *error) {
    dispatch_async(self->_queue, ^{
      if (error && self->_exitCode == 0) self->_exitCode = 5;
      [self finishExit];
    });
  }];
}
- (void)startStream:(SCStream *)stream {
  dispatch_assert_queue(_queue);
  if (self.stopping) return;
  _stream = stream;
  _starting = YES;
  [stream startCaptureWithCompletionHandler:^(NSError *error) {
    dispatch_async(self->_queue, ^{
      if (self->_finished) return;
      self->_starting = NO;
      if (error) [self requestExit:5];
      else if (self.stopping) [self stopStream];
    });
  }];
}
- (void)requestExit:(int)code {
  dispatch_async(_queue, ^{
    if (self->_finished) return;
    if (!atomic_exchange(&self->_stopping, true)) {
      self->_exitCode = code;
      self->_deadline = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, self->_queue);
      dispatch_source_set_timer(self->_deadline,
        dispatch_time(DISPATCH_TIME_NOW, self->_shutdownTimeout), DISPATCH_TIME_FOREVER, 0);
      dispatch_source_set_event_handler(self->_deadline, ^{ [self finishExit]; });
      dispatch_resume(self->_deadline);
    }
    // stopCapture must follow start's completion; stopping a not-yet-started
    // stream cannot prevent a late successful start in the system service.
    [self stopStream];
  });
}
- (void)observeTerminationSignals {
  dispatch_sync(_queue, ^{
    for (NSNumber *number in @[@(SIGTERM), @(SIGINT)]) {
      int value = number.intValue;
      signal(value, SIG_IGN);
      dispatch_source_t source = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, value, 0, self->_queue);
      dispatch_source_set_event_handler(source, ^{ [self requestExit:0]; });
      [self->_signals addObject:source];
      dispatch_resume(source);
    }
  });
}
@end

@interface PrivacyCaptureOutput : NSObject <SCStreamOutput, SCStreamDelegate>
@property(copy) FrameHandler handler;
@property(strong) SCStream *stream;
@property(strong) CaptureLifetime *lifetime;
@end
@implementation PrivacyCaptureOutput
- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sample ofType:(SCStreamOutputType)type {
  if (self.lifetime.stopping || type != SCStreamOutputTypeScreen || !CMSampleBufferIsValid(sample)) return;
  CVPixelBufferRef buffer = CMSampleBufferGetImageBuffer(sample);
  if (buffer) self.handler(0, 0, CVPixelBufferGetIOSurface(buffer), NULL);
}
- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error { [self.lifetime requestExit:5]; }
@end

static NSString *standardCursorShape(NSCursor *cursor) {
  if (!cursor) return @"default";
  // Some AppKit standard cursors are unavailable in capture-only processes.
  // A C array preserves nil entries (and their shape indices); NSArray would
  // throw before we could skip them, terminating the screen capture process.
  NSCursor *cursors[] = {
    NSCursor.arrowCursor, NSCursor.IBeamCursor, NSCursor.pointingHandCursor,
    NSCursor.crosshairCursor, NSCursor.openHandCursor, NSCursor.closedHandCursor,
    NSCursor.resizeLeftRightCursor, NSCursor.resizeUpDownCursor,
    NSCursor.operationNotAllowedCursor, NSCursor.dragCopyCursor,
    NSCursor.dragLinkCursor, NSCursor.IBeamCursorForVerticalLayout
  };
  NSArray<NSString *> *shapes = @[
    @"default", @"text", @"pointer", @"crosshair", @"grab", @"grabbing",
    @"ew-resize", @"ns-resize", @"not-allowed", @"copy", @"alias", @"vertical-text"
  ];
  NSData *raster = nil;
  for (NSUInteger i = 0; i < sizeof(cursors) / sizeof(cursors[0]); i++) {
    NSCursor *candidate = cursors[i];
    if (!candidate) continue;
    if ([cursor isEqual:candidate]) return shapes[i];
    if (!NSEqualSizes(cursor.image.size, candidate.image.size) ||
        !NSEqualPoints(cursor.hotSpot, candidate.hotSpot)) continue;
    if (!raster) raster = cursor.image.TIFFRepresentation;
    if (raster && [raster isEqualToData:candidate.image.TIFFRepresentation]) return shapes[i];
  }
  return @"default";
}

// Window-only views report the cursor relative to the window's live frame.
static CGRect windowBounds(CGWindowID window) {
  CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, window);
  CGRect bounds = CGRectNull;
  if (list && CFArrayGetCount(list) > 0) {
    CFDictionaryRef info = CFArrayGetValueAtIndex(list, 0);
    CFDictionaryRef raw = CFDictionaryGetValue(info, kCGWindowBounds);
    if (!raw || !CGRectMakeWithDictionaryRepresentation(raw, &bounds)) bounds = CGRectNull;
  }
  if (list) CFRelease(list);
  return bounds;
}

static NSDictionary *readCursor(CGRect bounds) {
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
  if (CGRectIsNull(bounds) || bounds.size.width <= 0 || bounds.size.height <= 0) return nil;
  NSPoint hot = cursor.hotSpot;
  return @{
    @"visible": visible() && CGRectContainsPoint(bounds, point) ? @YES : @NO,
    @"x": @(fmax(0, fmin(1, (point.x - bounds.origin.x) / bounds.size.width))),
    @"y": @(fmax(0, fmin(1, (point.y - bounds.origin.y) / bounds.size.height))),
    @"width": @(size.width), @"height": @(size.height),
    @"hotX": @(fmax(0, fmin(size.width, hot.x))),
    @"hotY": @(fmax(0, fmin(size.height, hot.y))),
    @"png": [png base64EncodedStringWithOptions:0],
    @"shape": standardCursorShape(cursor)
  };
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    // Local recordings opt into deferred encoding; existing invocations stay eager.
    // Overlay: <display> cursor-overlay[-demand] <fps> <quality> <physical max edge, 0 = logical> <max JPEG bytes> [excluded | window:<id>]
    BOOL onRequest = (argc == 7 || argc == 8) && strcmp(argv[2], "cursor-overlay-demand") == 0;
    BOOL overlay = onRequest || ((argc == 7 || argc == 8) && strcmp(argv[2], "cursor-overlay") == 0);
    if (argc != 2 && argc != 3 && !overlay) return 2;
    NSString *excluded = (overlay && argc == 8) || (!overlay && argc == 3)
      ? [NSString stringWithUTF8String:argv[argc - 1]] : @"";
    // 代输入 live view: only this one window is captured, never the rest of the screen.
    CGWindowID onlyWindow = 0;
    if ([excluded hasPrefix:@"window:"]) {
      char *windowEnd = NULL;
      const char *digits = argv[argc - 1] + 7;
      unsigned long id = strtoul(digits, &windowEnd, 10);
      if (!overlay || !*digits || *windowEnd || id == 0 || id > UINT32_MAX) return 2;
      onlyWindow = (CGWindowID)id;
      excluded = @"";
    }
    int fps = overlay && strcmp(argv[3], "60") == 0 ? 60 : (overlay ? 30 : 15);
    double quality = overlay ? atof(argv[4]) : 0.55;
    if (quality < 0.1 || quality > 1) return 2;
    long physicalEdge = overlay ? atol(argv[5]) : 0;
    long frameLimit = overlay ? atol(argv[6]) : 180000;
    if (physicalEdge < 0 || physicalEdge > 8192 || frameLimit < 100000 || frameLimit > 4000000) return 2;
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
    if (!excluded.length && !onlyWindow && (!create || !start || !intervalKey || !cursorKey)) return 4;
    CGDirectDisplayID display = (uint32_t)value;
    size_t width = CGDisplayPixelsWide(display), height = CGDisplayPixelsHigh(display);
    if (!width || !height) return 2;
    // CGDisplayPixelsWide reports logical points on HiDPI modes. Higher tiers
    // capture backing pixels instead, bounded by the requested long edge.
    double edgeLimit = overlay ? 4096.0 : 1280.0;
    if (physicalEdge) {
      CGDisplayModeRef mode = CGDisplayCopyDisplayMode(display);
      if (mode) {
        size_t pixelWidth = CGDisplayModeGetPixelWidth(mode), pixelHeight = CGDisplayModeGetPixelHeight(mode);
        CGDisplayModeRelease(mode);
        if (pixelWidth > width && pixelHeight > height) { width = pixelWidth; height = pixelHeight; }
      }
      // Never below what the logical capture would have produced.
      double logicalEdge = (double)MAX(CGDisplayPixelsWide(display), CGDisplayPixelsHigh(display));
      edgeLimit = MAX((double)physicalEdge, MIN(edgeLimit, logicalEdge));
    }
    // This is a negotiated capture mode, not a snapshot of cursor availability.
    // A temporarily hidden/unreadable cursor must not permanently bake the
    // cursor into video or stop subsequent shape/visibility polling.
    BOOL separateCursor = overlay;
    // Preserve full selected display resolution for the cursor-overlay path.
    // The legacy compatibility path retains its original inexpensive bounds.
    double scale = MIN(1.0, edgeLimit / MAX(width, height));
    width = MAX(1, (size_t)(width * scale)); height = MAX(1, (size_t)(height * scale));
    dispatch_queue_t queue = dispatch_queue_create("cindy.desktop.capture", DISPATCH_QUEUE_SERIAL);
    CaptureLifetime *lifetime = [[CaptureLifetime alloc] initWithShutdownTimeout:5 * NSEC_PER_SEC
      exitHandler:^(int code) { _exit(code); }];
    [lifetime observeTerminationSignals];
    void (^quit)(int) = ^(int code) { [lifetime requestExit:code]; };
    CIContext *context = [CIContext contextWithOptions:@{ kCIContextCacheIntermediates: @NO }];
    CGColorSpaceRef color = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CaptureFrameStore *frames = [[CaptureFrameStore alloc] initWithOnRequest:onRequest encoder:^NSData *(IOSurfaceRef surface) {
      return encodeCaptureSurface(context, color, surface, quality, frameLimit, overlay);
    }];
    __block BOOL requested = NO;
    atomic_store(&lastRequest, time(NULL));
    // The first system cursor read can block on WindowServer for many seconds.
    // Frames never wait for it: each reply carries the latest completed read
    // (null until one finishes) and starts the next read on the main queue.
    __block NSDictionary *cursor = nil;
    __block BOOL cursorReading = NO;
    void (^refreshCursor)(void) = ^{
      if (!separateCursor || cursorReading) return;
      cursorReading = YES;
      dispatch_async(dispatch_get_main_queue(), ^{
        NSDictionary *value = readCursor(onlyWindow ? windowBounds(onlyWindow) : CGDisplayBounds(display));
        dispatch_async(queue, ^{
          cursor = value;
          cursorReading = NO;
        });
      });
    };
    void (^reply)(void) = ^{
      if (lifetime.stopping || !requested) return;
      NSData *latest = [frames jpeg];
      if (!latest) return;
      requested = NO;
      NSData *data;
      if (overlay) {
        refreshCursor();
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
        if (count <= 0) { quit(0); return; }
        bytes += count; remaining -= count;
      }
      atomic_store(&awaitingFrame, false);
    };
    FrameHandler receiveFrame = ^(int32_t status, uint64_t timestamp, IOSurfaceRef surface, const void *update) {
        @autoreleasepool {
          if (lifetime.stopping) return;
          if (status == 3) { quit(5); return; } // stopped; never serve the previous session's frame
          if (status == 2) { [frames clear]; return; } // blank display
          if (status != 0 || !surface) return;
          [frames acceptSurface:surface];
          reply();
        }
      };
    if (onlyWindow) {
      double backing = 1;
      CGDisplayModeRef displayMode = CGDisplayCopyDisplayMode(display);
      if (displayMode) {
        backing = MAX(1.0, (double)CGDisplayModeGetPixelHeight(displayMode) / MAX(1.0, (double)CGDisplayPixelsHigh(display)));
        CGDisplayModeRelease(displayMode);
      }
      if (!physicalEdge) backing = 1; // the logical tier stays in points
      [SCShareableContent getShareableContentExcludingDesktopWindows:YES onScreenWindowsOnly:YES
        completionHandler:^(SCShareableContent *content, NSError *error) {
          dispatch_async(lifetime.queue, ^{
            if (lifetime.stopping) return;
            if (error) { quit(5); return; }
            SCWindow *selected = nil;
            for (SCWindow *candidate in content.windows) if (candidate.windowID == onlyWindow) selected = candidate;
            // A window that is gone or hidden is never replaced by anything else.
            if (!selected || selected.frame.size.width < 1 || selected.frame.size.height < 1) { quit(5); return; }
            SCContentFilter *filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:selected];
            double windowWidth = selected.frame.size.width * backing, windowHeight = selected.frame.size.height * backing;
            double fit = MIN(1.0, edgeLimit / MAX(windowWidth, windowHeight));
            SCStreamConfiguration *config = [SCStreamConfiguration new];
            config.width = MAX(2, (size_t)(windowWidth * fit) & ~(size_t)1);
            config.height = MAX(2, (size_t)(windowHeight * fit) & ~(size_t)1);
            // Fill the frame, so a point in the picture is the same fraction of the window.
            if ([config respondsToSelector:@selector(setScalesToFit:)]) [config setValue:@YES forKey:@"scalesToFit"];
            if ([config respondsToSelector:@selector(setPreservesAspectRatio:)]) [config setValue:@NO forKey:@"preservesAspectRatio"];
            config.minimumFrameInterval = CMTimeMake(1, fps);
            config.showsCursor = NO;
            config.pixelFormat = kCVPixelFormatType_32BGRA;
            config.queueDepth = 3;
            PrivacyCaptureOutput *output = [PrivacyCaptureOutput new];
            output.handler = receiveFrame;
            output.lifetime = lifetime;
            output.stream = [[SCStream alloc] initWithFilter:filter configuration:config delegate:output];
            NSError *failure = nil;
            if (![output.stream addStreamOutput:output type:SCStreamOutputTypeScreen sampleHandlerQueue:queue error:&failure]) { quit(5); return; }
            CFRetain((__bridge CFTypeRef)output);
            [lifetime startStream:output.stream];
          });
        }];
    } else if (excluded.length) {
      NSArray<NSString *> *ids = [excluded componentsSeparatedByString:@","];
      // Explicit exclusion is mandatory: NSWindowSharingNone alone is ignored
      // by modern ScreenCaptureKit. Never fall back to an unfiltered stream.
      [SCShareableContent getShareableContentExcludingDesktopWindows:NO onScreenWindowsOnly:NO
        completionHandler:^(SCShareableContent *content, NSError *error) {
          dispatch_async(lifetime.queue, ^{
            if (lifetime.stopping) return;
            if (error) { quit(5); return; }
            SCDisplay *selected = nil;
            for (SCDisplay *candidate in content.displays) if (candidate.displayID == display) selected = candidate;
            NSMutableArray<SCWindow *> *windows = [NSMutableArray array];
            for (SCWindow *window in content.windows)
              if ([ids containsObject:[NSString stringWithFormat:@"%u", window.windowID]]) [windows addObject:window];
            // ScreenCaptureKit may omit windows belonging to another display from
            // this display's shareable-content snapshot. A partial match is
            // still valid; an empty match is fail-closed.
            if (!selected || windows.count == 0) { quit(5); return; }
            SCContentFilter *filter = [[SCContentFilter alloc] initWithDisplay:selected excludingWindows:windows];
            SCStreamConfiguration *config = [SCStreamConfiguration new];
            config.width = width; config.height = height;
            config.minimumFrameInterval = CMTimeMake(1, fps);
            config.showsCursor = !separateCursor;
            config.pixelFormat = kCVPixelFormatType_32BGRA;
            config.queueDepth = 3;
            PrivacyCaptureOutput *output = [PrivacyCaptureOutput new];
            output.handler = receiveFrame;
            output.lifetime = lifetime;
            output.stream = [[SCStream alloc] initWithFilter:filter configuration:config delegate:output];
            NSError *failure = nil;
            if (![output.stream addStreamOutput:output type:SCStreamOutputTypeScreen sampleHandlerQueue:queue error:&failure]) { quit(5); return; }
            // Keep output alive until the lifetime stops the stream and exits.
            CFRetain((__bridge CFTypeRef)output);
            [lifetime startStream:output.stream];
          });
        }];
    } else {
      CFTypeRef stream = create(display, width, height, 'BGRA',
        (__bridge CFDictionaryRef)@{(__bridge NSString *)*intervalKey: @(1.0/fps), (__bridge NSString *)*cursorKey: separateCursor ? @NO : @YES}, queue, receiveFrame);
      if (!stream || start(stream) != kCGErrorSuccess) return 5;
    }
    if (overlay) dispatch_async(queue, refreshCursor);
    signal(SIGPIPE, SIG_IGN);
    // stdin is a private parent pipe: one byte asks for one latest frame. EOF
    // and a stalled parent both stop capture before exiting the helper.
    // A parent still waiting for its first frame gets a longer bound; it
    // normally gives up and closes this pipe first.
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
      char byte;
      while (read(STDIN_FILENO, &byte, 1) == 1) {
        if (byte != 'f') { quit(2); return; }
        atomic_store(&lastRequest, time(NULL));
        atomic_store(&awaitingFrame, true);
        dispatch_async(queue, ^{ requested = YES; reply(); });
      }
      quit(0);
    });
    dispatch_source_t watchdog = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_global_queue(QOS_CLASS_UTILITY, 0));
    dispatch_source_set_timer(watchdog, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), NSEC_PER_SEC, 0);
    dispatch_source_set_event_handler(watchdog, ^{
      // A pending frame extends the idle limit beyond the parent's cold-start
      // wait, but never indefinitely: a parent that stopped reading is stalled.
      if (time(NULL) - atomic_load(&lastRequest) > (atomic_load(&awaitingFrame) ? 15 : 5)) quit(0);
    });
    dispatch_resume(watchdog);
    dispatch_main();
  }
}
