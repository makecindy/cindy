// Own-window backdrop only. No screen capture, global input, or foreign window IDs.
// CGS is private SPI: resolve at runtime and report failure to the material fallback.
#import <Cocoa/Cocoa.h>
#include <node_api.h>
#include <dlfcn.h>
#include <cmath>
#include <cstring>
#import <objc/runtime.h>

using Connection = uint32_t (*)(void);
using SetBlur = int32_t (*)(uint32_t, uint32_t, uint32_t);

static char originalBackgroundKey;

static NSWindow *OwnedWindow(void *bytes) {
  if (![NSThread isMainThread]) return nil;
  void *handle = nullptr;
  std::memcpy(&handle, bytes, sizeof(handle));
  for (NSWindow *window in NSApp.windows) {
    if ((__bridge void *)window.contentView == handle) return window;
  }
  return nil;
}
static NSColor *CornerMaskBackground() {
  // AppKit disables the WindowServer corner mask for a completely clear
  // background. Keep its native mask (including resize/fullscreen geometry)
  // without adding a visible tint or changing renderer/content opacity.
  return [NSColor.whiteColor colorWithAlphaComponent:0.001];
}
static void RestoreBackground(NSWindow *window) {
  NSColor *original = objc_getAssociatedObject(window, &originalBackgroundKey);
  // The caller may already have installed the next theme's background.
  if (original && [window.backgroundColor isEqual:CornerMaskBackground()]) {
    window.backgroundColor = original;
  }
  objc_setAssociatedObject(window, &originalBackgroundKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}
static void PreserveCornerMask(NSWindow *window) {
  if (window.backgroundColor.alphaComponent != 0) return;
  objc_setAssociatedObject(window, &originalBackgroundKey, window.backgroundColor,
                           OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  window.backgroundColor = CornerMaskBackground();
}

static napi_value Apply(napi_env env, napi_callback_info info) {
  size_t argc = 2, length = 0;
  napi_value args[2], result;
  void *bytes = nullptr;
  double radius = 0;
  bool isBuffer = false;
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 2 || napi_is_buffer(env, args[0], &isBuffer) != napi_ok || !isBuffer ||
      napi_get_buffer_info(env, args[0], &bytes, &length) != napi_ok || length != sizeof(void *) ||
      napi_get_value_double(env, args[1], &radius) != napi_ok || !std::isfinite(radius) ||
      radius < 0 || radius > 20 || std::floor(radius) != radius) {
    napi_throw_type_error(env, nullptr, "Invalid desktop blur handle or radius");
    return nullptr;
  }
  bool applied = false;
  if ([NSThread isMainThread]) {
    // Compare to live, owned views rather than dereferencing an arbitrary pointer.
    NSWindow *target = OwnedWindow(bytes);
    static void *library = dlopen(
      "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", RTLD_LAZY);
    static Connection connection = library ? (Connection)dlsym(library, "CGSMainConnectionID") : nullptr;
    static SetBlur setBlur = library ? (SetBlur)dlsym(library, "CGSSetWindowBackgroundBlurRadius") : nullptr;
    if (target && connection && setBlur) {
      if (radius > 0) PreserveCornerMask(target);
      applied = setBlur(connection(), (uint32_t)target.windowNumber, (uint32_t)radius) == 0;
      if (radius == 0 || !applied) RestoreBackground(target);
    }
  }
  napi_get_boolean(env, applied, &result);
  return result;
}

NAPI_MODULE_INIT() {
  napi_property_descriptor properties[] = {
    {"apply", nullptr, Apply, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 1, properties);
  return exports;
}
