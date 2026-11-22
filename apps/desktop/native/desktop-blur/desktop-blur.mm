// Own-window backdrop only. No screen capture, global input, or foreign window IDs.
// CGS is private SPI: resolve at runtime and report failure to the material fallback.
#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#include <node_api.h>
#include <dlfcn.h>
#include <cmath>
#include <cstring>
#include <algorithm>
#import <objc/runtime.h>
#import <objc/message.h>

using Connection = uint32_t (*)(void);
using SetBlur = int32_t (*)(uint32_t, uint32_t, uint32_t);

static char originalBackgroundKey;
static char sidebarKey;
static char radiusKey;
static char neutralStateKey;

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

// The sidebar keeps only the material's blur; Cindy paints its color in CSS, in
// the main area's hue (user decision, 2026-11-11). AppKit's private layer tree is
// a backdrop layer (blur + saturation) beside tint, blend and desktop-tinting
// layers. Any other layout is left untouched, keeping the system material.
static void StripMaterialColor(CALayer *layer) {
  for (CALayer *child in layer.sublayers) {
    if (![NSStringFromClass(child.class) isEqualToString:@"CABackdropLayer"]) {
      StripMaterialColor(child);
      continue;
    }
    NSMutableArray *filters = [NSMutableArray array];
    for (id filter in child.filters) {
      id name = [filter respondsToSelector:@selector(name)] ? [filter valueForKey:@"name"] : nil;
      if ([name isEqual:@"gaussianBlur"] || [name isEqual:@"sdrNormalize"]) [filters addObject:filter];
    }
    child.filters = filters;
    for (CALayer *sibling in layer.sublayers) {
      if (sibling != child && sibling.sublayers.count == 0) sibling.hidden = YES;
    }
    return;
  }
}
static void StripView(NSView *view) {
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  StripMaterialColor(view.layer);
  [CATransaction commit];
}
// AppKit rebuilds these layers on appearance, state and layout changes. A
// one-time hook on NSVisualEffectView strips them again after each rebuild, only
// for views marked here; no class is swapped, so KVO and other views are
// unaffected. Unmarking restores the untouched system material (0% and artwork).
static void InstallStripHook() {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    Class base = NSVisualEffectView.class;
    for (NSString *selectorName in @[@"updateLayer", @"layout", @"viewDidChangeEffectiveAppearance"]) {
      SEL selector = NSSelectorFromString(selectorName);
      Method method = class_getInstanceMethod(base, selector);
      if (!method) continue;
      IMP original = method_getImplementation(method);
      IMP hook = imp_implementationWithBlock(^(NSVisualEffectView *self) {
        ((void (*)(id, SEL))original)(self, selector);
        if (objc_getAssociatedObject(self, &neutralStateKey)) StripView(self);
      });
      if (!class_addMethod(base, selector, hook, method_getTypeEncoding(method))) {
        method_setImplementation(method, hook);
      }
    }
  });
}
static void SetNeutral(NSVisualEffectView *view, bool neutral) {
  NSNumber *state = objc_getAssociatedObject(view, &neutralStateKey);
  if (neutral) {
    InstallStripHook();
    if (!state) {
      objc_setAssociatedObject(view, &neutralStateKey, @(view.state), OBJC_ASSOCIATION_RETAIN_NONATOMIC);
      // An inactive window would swap the blur for an opaque gray in another hue.
      view.state = NSVisualEffectStateActive;
    }
    StripView(view);
  } else if (state) {
    objc_setAssociatedObject(view, &neutralStateKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    view.state = (NSVisualEffectState)state.integerValue;
    // Reassigning the appearance makes AppKit rebuild its own tint layers.
    NSAppearance *appearance = view.appearance;
    view.appearance = nil;
    view.appearance = appearance;
  }
}

static napi_value SetSidebar(napi_env env, napi_callback_info info) {
  size_t argc = 3, length = 0;
  napi_value args[3], result;
  void *bytes = nullptr;
  double width = 0;
  bool isBuffer = false, dark = false;
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 3 || napi_is_buffer(env, args[0], &isBuffer) != napi_ok || !isBuffer ||
      napi_get_buffer_info(env, args[0], &bytes, &length) != napi_ok || length != sizeof(void *) ||
      napi_get_value_double(env, args[1], &width) != napi_ok || !std::isfinite(width) ||
      width < 0 || width > 16384 || napi_get_value_bool(env, args[2], &dark) != napi_ok) {
    napi_throw_type_error(env, nullptr, "Invalid sidebar material handle or geometry");
    return nullptr;
  }
  NSWindow *window = OwnedWindow(bytes);
  if (window) {
    // Electron attaches its effect through Chromium's NativeViewHost, below
    // the web content. Reuse that view instead of adding an unmanaged NSView
    // inside Chromium's layer-hosting contentView (which may not sample behind).
    SEL selector = NSSelectorFromString(@"vibrantView");
    id candidate = [window respondsToSelector:selector]
      ? ((id (*)(id, SEL))objc_msgSend)(window, selector) : nil;
    NSVisualEffectView *view = [candidate isKindOfClass:NSVisualEffectView.class] ? candidate : nil;
    if (width == 0) {
      if (view) SetNeutral(view, false);
      objc_setAssociatedObject(window, &sidebarKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
      if ([objc_getAssociatedObject(window, &radiusKey) doubleValue] == 0) RestoreBackground(window);
    } else if (view) {
      view.appearance = [NSAppearance appearanceNamed:dark ? NSAppearanceNameDarkAqua : NSAppearanceNameAqua];
      CGFloat visibleWidth = std::min(width, (double)window.contentView.bounds.size.width);
      // Keep one transparent guard point in the fixed cap: stretching the first
      // transparent sample would interpolate the opaque edge across the content.
      // Only the second transparent point stretches; the sidebar edge stays sharp.
      NSImage *mask = [NSImage imageWithSize:NSMakeSize(visibleWidth + 2, 1)
        flipped:NO drawingHandler:^BOOL(NSRect rect) {
          [NSColor.whiteColor setFill];
          NSRectFill(NSMakeRect(0, 0, visibleWidth, rect.size.height));
          return YES;
        }];
      mask.capInsets = NSEdgeInsetsMake(0, visibleWidth + 1, 0, 0);
      mask.resizingMode = NSImageResizingModeStretch;
      view.maskImage = mask;
      SetNeutral(view, true);
      objc_setAssociatedObject(window, &sidebarKey, @YES, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
      PreserveCornerMask(window);
    } else {
      napi_get_boolean(env, false, &result);
      return result;
    }
  }
  napi_get_boolean(env, window != nil, &result);
  return result;
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
      if (applied) objc_setAssociatedObject(target, &radiusKey, @(radius), OBJC_ASSOCIATION_RETAIN_NONATOMIC);
      if ((radius == 0 || !applied) && !objc_getAssociatedObject(target, &sidebarKey)) RestoreBackground(target);
    }
  }
  napi_get_boolean(env, applied, &result);
  return result;
}

NAPI_MODULE_INIT() {
  napi_property_descriptor properties[] = {
    {"apply", nullptr, Apply, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"setSidebar", nullptr, SetSidebar, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 2, properties);
  return exports;
}
