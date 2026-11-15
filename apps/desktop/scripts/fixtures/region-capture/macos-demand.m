// Integration/performance fixture, appended after the real native source with
// main renamed. Uses actual IOSurfaces, frame ownership and the production JPEG
// codec; no display capture, user pixels, synthetic timers or unit-test mocks.
#import <sys/resource.h>
#import <CommonCrypto/CommonDigest.h>
#import <assert.h>

static IOSurfaceRef fixtureSurface(size_t width, size_t height, unsigned seed, BOOL noise) {
  CVPixelBufferRef buffer = NULL;
  CVReturn created = CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA,
    (__bridge CFDictionaryRef)@{(id)kCVPixelBufferIOSurfacePropertiesKey:@{}}, &buffer);
  assert(created == kCVReturnSuccess);
  IOSurfaceRef surface = CVPixelBufferGetIOSurface(buffer);
  CFRetain(surface);
  CVPixelBufferRelease(buffer);
  assert(surface);
  IOSurfaceLock(surface, 0, NULL);
  uint32_t *pixels = IOSurfaceGetBaseAddress(surface);
  size_t stride = IOSurfaceGetBytesPerRow(surface) / 4;
  uint32_t random = 12345 + seed;
  for (size_t y = 0; y < height; y++) for (size_t x = 0; x < width; x++) {
    random = random * 1664525 + 1013904223;
    pixels[y * stride + x] = noise ? (random | 0xff000000) :
      (0xff000000 | (((x + seed * 9) % 256) << 16) | ((y % 256) << 8) | ((x / 16 + y / 16) % 256));
  }
  IOSurfaceUnlock(surface, 0, NULL);
  return surface;
}

static double cpuMs(void) {
  struct rusage usage;
  getrusage(RUSAGE_SELF, &usage);
  return (usage.ru_utime.tv_sec + usage.ru_stime.tv_sec) * 1000.0 +
    (usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) / 1000.0;
}
static NSString *digest(NSData *data) {
  unsigned char hash[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(data.bytes, (CC_LONG)data.length, hash);
  NSMutableString *result = [NSMutableString string];
  for (size_t i = 0; i < sizeof(hash); i++) [result appendFormat:@"%02x", hash[i]];
  return result;
}
static void emit(NSDictionary *value) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:NULL];
  fwrite(data.bytes, 1, data.length, stdout); putchar('\n'); fflush(stdout);
}

static void ownershipChecks(void) {
  IOSurfaceRef a = fixtureSurface(8, 8, 1, NO), b = fixtureSurface(8, 8, 2, NO);
  __block int calls = 0;
  CaptureFrameStore *store = [[CaptureFrameStore alloc] initWithOnRequest:YES encoder:^NSData *(IOSurfaceRef surface) {
    calls++;
    assert(IOSurfaceIsInUse(surface));
    return [NSData dataWithBytes:IOSurfaceGetBaseAddress(surface) length:4];
  }];
  assert(!store.jpeg); // request before the first complete frame
  [store acceptSurface:a];
  [store acceptSurface:b];
  assert(calls == 0 && !IOSurfaceIsInUse(a) && IOSurfaceIsInUse(b));
  NSData *first = store.jpeg;
  assert(first && calls == 1 && !IOSurfaceIsInUse(b));
  assert([first isEqualToData:[NSData dataWithBytes:IOSurfaceGetBaseAddress(b) length:4]]);
  assert([store.jpeg isEqualToData:first] && calls == 1); // static screen
  [store acceptSurface:a];
  [store clear]; // display blanked: no stale image, no pinned surface
  assert(!store.jpeg && !IOSurfaceIsInUse(a));
  [store acceptSurface:b];
  assert(store.jpeg && calls == 2); // resume must return the latest frame
  [store acceptSurface:a];
  store = nil;
  assert(!IOSurfaceIsInUse(a)); // disposal with an unencoded frame
  __block int failed = 0;
  store = [[CaptureFrameStore alloc] initWithOnRequest:YES encoder:^NSData *(IOSurfaceRef surface) {
    return ++failed == 1 ? nil : first;
  }];
  [store acceptSurface:a];
  assert(!store.jpeg && !IOSurfaceIsInUse(a));
  assert(!store.jpeg && failed == 1); // no retry storm on the same bad frame
  [store acceptSurface:b];
  assert(store.jpeg && failed == 2);
  [store clear];
  CFRelease(a); CFRelease(b);
  emit(@{@"checks": @[@"cold-request", @"latest-frame", @"skip-unused", @"surface-reuse-protection",
    @"static-repeat", @"blank-invalidates", @"resume", @"dispose", @"encode-failure", @"failure-recovery"]});
}

int main(int argc, char **argv) {
  @autoreleasepool {
    ownershipChecks();
    int samples = argc > 1 ? atoi(argv[1]) : 20;
    CGColorSpaceRef color = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    for (NSArray *scenario in @[@[@1920, @1080, @NO], @[@3840, @2160, @NO], @[@3840, @2160, @YES]]) {
      size_t width = [scenario[0] unsignedLongValue], height = [scenario[1] unsignedLongValue];
      BOOL noise = [scenario[2] boolValue];
      IOSurfaceRef surfaces[3];
      for (int i = 0; i < 3; i++) surfaces[i] = fixtureSurface(width, height, i, noise);
      CIContext *reference = [CIContext contextWithOptions:@{ kCIContextCacheIntermediates: @NO }];
      NSMutableArray *parity = [NSMutableArray array];
      // Real pre-change codec extracted from the specified baseline source.
      // Test both normal and forced size fallback; compare every JPEG byte.
      for (NSNumber *budget in @[@3000000, @100000]) {
        CaptureFrameStore *store = [[CaptureFrameStore alloc] initWithOnRequest:YES encoder:^NSData *(IOSurfaceRef surface) {
          return encodeCaptureSurface(reference, color, surface, 0.9, budget.longValue, YES);
        }];
        for (int i = 0; i < 3; i++) {
          NSData *before = baselineEncode(reference, color, surfaces[i], 0.9, budget.longValue, YES);
          [store acceptSurface:surfaces[(i + 1) % 3]];
          [store acceptSurface:surfaces[(i + 2) % 3]];
          [store acceptSurface:surfaces[i]];
          NSData *after = store.jpeg;
          if (!before || ![before isEqualToData:after]) emit(@{@"parityFailure":@YES, @"width":@(width), @"height":@(height),
            @"noise":@(noise), @"frame":@(i), @"budget":budget, @"beforeBytes":@(before.length), @"afterBytes":@(after.length),
            @"beforeHash":digest(before), @"afterHash":digest(after)});
          assert(before && [before isEqualToData:after]);
          assert([store.jpeg isEqualToData:before]);
          [parity addObject:@{@"budget":budget, @"frame":@(i), @"bytes":@(after.length), @"sha256":digest(after)}];
        }
        [store clear];
      }
      emit(@{@"parity":parity, @"width":@(width), @"height":@(height), @"noise":@(noise)});
      for (NSNumber *mode in @[@NO, @YES, @YES, @NO]) {
        @autoreleasepool {
          BOOL demand = mode.boolValue;
          __block int encoded = 0;
          CIContext *context = [CIContext contextWithOptions:@{ kCIContextCacheIntermediates: @NO }];
          CaptureFrameStore *store = [[CaptureFrameStore alloc] initWithOnRequest:demand encoder:^NSData *(IOSurfaceRef surface) {
            encoded++;
            return demand ? encodeCaptureSurface(context, color, surface, 0.9, 3000000, YES)
              : baselineEncode(context, color, surface, 0.9, 3000000, YES);
          }];
          NSMutableArray *roundMs = [NSMutableArray array], *requestMs = [NSMutableArray array];
          double cpuStart = cpuMs();
          for (int n = 0; n < samples; n++) {
            @autoreleasepool {
              double start = NSProcessInfo.processInfo.systemUptime;
              for (int i = 0; i < 3; i++) [store acceptSurface:surfaces[(n + i) % 3]];
              double requested = NSProcessInfo.processInfo.systemUptime;
              NSData *jpeg = store.jpeg;
              double done = NSProcessInfo.processInfo.systemUptime;
              assert(jpeg);
              [roundMs addObject:@((done - start) * 1000)];
              [requestMs addObject:@((done - requested) * 1000)];
            }
          }
          double cpu = cpuMs() - cpuStart;
          assert(encoded == samples * (demand ? 1 : 3));
          // Paused consumers may still receive changing system surfaces, but
          // must not cause any demand encodes. Clear before resuming.
          int beforePause = encoded;
          for (int i = 0; i < 30; i++) [store acceptSurface:surfaces[i % 3]];
          int pausedEncodes = encoded - beforePause;
          assert(pausedEncodes == (demand ? 0 : 30));
          [store clear];
          for (int i = 0; i < 3; i++) assert(!IOSurfaceIsInUse(surfaces[i]));
          emit(@{@"side":demand ? @"after" : @"before", @"width":@(width), @"height":@(height),
            @"noise":@(noise), @"samples":@(samples), @"encodes":@(beforePause), @"pausedEncodes":@(pausedEncodes),
            @"roundMs":roundMs, @"requestMs":requestMs, @"cpuMs":@(cpu)});
        }
      }
      for (int i = 0; i < 3; i++) CFRelease(surfaces[i]);
    }
    CGColorSpaceRelease(color);
  }
}
