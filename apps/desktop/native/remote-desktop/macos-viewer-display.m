#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>

// Experimental CoreGraphics SPI, also used by Chromium's virtual display tests.
// Resolve classes at runtime: an OS without this SPI must retain normal displays.
@interface NSObject (CindyVirtualDisplay)
- (id)initWithDescriptor:(id)descriptor;
- (id)initWithWidth:(unsigned int)width height:(unsigned int)height refreshRate:(double)rate;
- (BOOL)applySettings:(id)settings;
- (unsigned int)displayID;
@end

static id display;
static CGDirectDisplayID sourceDisplay;
static CGDisplayModeRef sourceMode;

static void cleanup(void) {
  if (sourceDisplay && CGDisplayIsOnline(sourceDisplay)) {
    CGDisplayConfigRef config;
    if (CGBeginDisplayConfiguration(&config) == kCGErrorSuccess) {
      CGConfigureDisplayMirrorOfDisplay(config, sourceDisplay, kCGNullDirectDisplay);
      if (sourceMode) CGConfigureDisplayWithDisplayMode(config, sourceDisplay, sourceMode, NULL);
      CGCompleteDisplayConfiguration(config, kCGConfigureForSession);
    }
  }
  display = nil;
  if (sourceMode) CGDisplayModeRelease(sourceMode);
  sourceMode = NULL;
}
static void emit(NSDictionary *value) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

static BOOL available(void) {
  return NSClassFromString(@"CGVirtualDisplay") && NSClassFromString(@"CGVirtualDisplayDescriptor") &&
    NSClassFromString(@"CGVirtualDisplaySettings") && NSClassFromString(@"CGVirtualDisplayMode");
}

static BOOL setSize(unsigned int width, unsigned int height) {
  if (!display) {
    id descriptor = [NSClassFromString(@"CGVirtualDisplayDescriptor") new];
    [descriptor setValue:@"Cindy Remote Desktop" forKey:@"name"];
    [descriptor setValue:@(4096) forKey:@"maxPixelsWide"];
    [descriptor setValue:@(4096) forKey:@"maxPixelsHigh"];
    [descriptor setValue:@(0x4349) forKey:@"vendorID"];
    [descriptor setValue:@(1) forKey:@"productID"];
    [descriptor setValue:@(getpid()) forKey:@"serialNum"];
    if ([descriptor respondsToSelector:NSSelectorFromString(@"setSerialNumber:")])
      [descriptor setValue:@(getpid()) forKey:@"serialNumber"];
    [descriptor setValue:dispatch_get_main_queue() forKey:@"queue"];
    [descriptor setValue:[NSValue valueWithSize:NSMakeSize(300, 300)] forKey:@"sizeInMillimeters"];
    display = [[NSClassFromString(@"CGVirtualDisplay") alloc] initWithDescriptor:descriptor];
    if (!display) return NO;
  }
  id mode = [[NSClassFromString(@"CGVirtualDisplayMode") alloc] initWithWidth:width height:height refreshRate:60];
  id settings = [NSClassFromString(@"CGVirtualDisplaySettings") new];
  [settings setValue:@0 forKey:@"hiDPI"];
  [settings setValue:@[mode] forKey:@"modes"];
  return [display applySettings:settings];
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc == 2 && strcmp(argv[1], "--probe") == 0) {
      emit(@{@"available": @(available())});
      return available() ? 0 : 2;
    }
    if (!available()) return 2;
    signal(SIGTERM, SIG_IGN);
    signal(SIGINT, SIG_IGN);
    dispatch_source_t termination = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGTERM, 0, dispatch_get_main_queue());
    dispatch_source_set_event_handler(termination, ^{ cleanup(); exit(0); });
    dispatch_resume(termination);
    dispatch_source_t interrupt = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGINT, 0, dispatch_get_main_queue());
    dispatch_source_set_event_handler(interrupt, ^{ cleanup(); exit(0); });
    dispatch_resume(interrupt);
    // Only a live owning process retains the display. EOF/exit releases it.
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      char *line = NULL;
      size_t capacity = 0;
      while (getline(&line, &capacity, stdin) > 0) {
        NSData *data = [[NSString stringWithUTF8String:line] dataUsingEncoding:NSUTF8StringEncoding];
        NSDictionary *command = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
        dispatch_sync(dispatch_get_main_queue(), ^{
          @try {
            if (![command isKindOfClass:NSDictionary.class]) { emit(@{@"error": @"INVALID_REQUEST"}); return; }
            // Electron's display IDs travel as decimal strings, unlike JSON dimensions.
            long long sourceNumber = [command[@"sourceDisplayId"] longLongValue];
            if (sourceNumber <= 0 || sourceNumber > UINT32_MAX) {
              emit(@{@"error": @"DISPLAY_SOURCE_UNAVAILABLE"}); return;
            }
            unsigned int source = (unsigned int)sourceNumber;
            if (!sourceDisplay) {
              if (!source || !CGDisplayIsOnline(source) || CGDisplayIsInMirrorSet(source)) {
                emit(@{@"error": @"DISPLAY_SOURCE_UNAVAILABLE"}); return;
              }
              sourceDisplay = source;
              sourceMode = CGDisplayCopyDisplayMode(source);
            } else if (source && source != sourceDisplay) {
              emit(@{@"error": @"DISPLAY_SOURCE_UNAVAILABLE"}); return;
            }
            unsigned int width = [command[@"width"] unsignedIntValue];
            unsigned int height = [command[@"height"] unsignedIntValue];
            if (width < 320 || height < 320 || width > 4096 || height > 4096 || !setSize(width, height)) {
              emit(@{@"error": @"DISPLAY_SIZE_FAILED"});
              return;
            }
            CGDisplayConfigRef config;
            if (CGBeginDisplayConfiguration(&config) != kCGErrorSuccess) {
              emit(@{@"error": @"DISPLAY_MIRROR_FAILED"}); return;
            }
            if (CGConfigureDisplayMirrorOfDisplay(config, sourceDisplay, [display displayID]) != kCGErrorSuccess) {
              CGCancelDisplayConfiguration(config);
              emit(@{@"error": @"DISPLAY_MIRROR_FAILED"}); return;
            }
            if (CGCompleteDisplayConfiguration(config, kCGConfigureForSession) != kCGErrorSuccess) {
              emit(@{@"error": @"DISPLAY_MIRROR_FAILED"}); return;
            }
            emit(@{@"id": @([display displayID]), @"width": @(width), @"height": @(height)});
          } @catch (NSException *exception) {
            emit(@{@"error": @"DISPLAY_UNAVAILABLE"});
          }
        });
      }
      free(line);
      dispatch_async(dispatch_get_main_queue(), ^{ cleanup(); exit(0); });
    });
    dispatch_main();
  }
}
