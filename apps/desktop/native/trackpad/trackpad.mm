// Local AppKit input only. No global event tap, private MultitouchSupport API,
// accessibility permission, cursor warping, or changes to Chromium's view class.
#import <Cocoa/Cocoa.h>
#include <node_api.h>
#include <string>

@interface CindyTrackpad : NSObject
@property(nonatomic, weak) NSWindow *window;
@property(nonatomic, weak) NSView *view;
@property(nonatomic, strong) id monitor;
@property(nonatomic, strong) id resign;
@property(nonatomic, strong) NSMutableDictionary *identities;
@property(nonatomic) napi_threadsafe_function callback;
@property(nonatomic) BOOL tracking;
@property(nonatomic) BOOL suppressGestures;
@property(nonatomic) BOOL waitingForLift;
@property(nonatomic) BOOL previousRestingTouches;
@property(nonatomic) uint32_t serial;
- (void)finish;
- (NSEvent *)event:(NSEvent *)event;
@end

static CindyTrackpad *capture;
static uint32_t nextSerial = 0;

static void Deliver(napi_env env, napi_value callback, void *, void *data) {
  auto text = static_cast<std::string *>(data);
  if (env && callback) {
    napi_value value, receiver, result;
    napi_create_string_utf8(env, text->c_str(), text->size(), &value);
    napi_get_undefined(env, &receiver);
    napi_call_function(env, receiver, callback, 1, &value, &result);
  }
  delete text;
}

@implementation CindyTrackpad
- (void)emit:(NSDictionary *)frame {
  if (!self.callback) return;
  NSData *data = [NSJSONSerialization dataWithJSONObject:frame options:0 error:nil];
  if (!data) return;
  auto text = new std::string(static_cast<const char *>(data.bytes), data.length);
  if (napi_call_threadsafe_function(self.callback, text, napi_tsfn_nonblocking) != napi_ok)
    delete text;
}
- (void)finish {
  if (self.monitor) self.view.wantsRestingTouches = self.previousRestingTouches;
  if (self.tracking) [self emit:@{@"phase":@"cancel", @"touches":@[]}];
  self.tracking = NO;
  if (self.monitor) [NSEvent removeMonitor:self.monitor];
  if (self.resign) [[NSNotificationCenter defaultCenter] removeObserver:self.resign];
  self.monitor = nil;
  self.resign = nil;
  if (self.callback) napi_release_threadsafe_function(self.callback, napi_tsfn_release);
  self.callback = nullptr;
}
- (NSEvent *)event:(NSEvent *)event {
  NSWindow *window = self.window;
  NSView *view = self.view;
  if (!window || !view || !window.isKeyWindow || !NSApp.isActive || view.window != window) {
    [self finish];
    return event;
  }
  if (event.window != window) return event;
  if (event.type == NSEventTypeGesture) {
    // Generic touch events, never reconstructed from magnify/rotate events.
    NSSet<NSTouch *> *all = [event touchesMatchingPhase:NSTouchPhaseAny inView:view];
    if (!all.count) return event;
    NSMutableArray<NSTouch *> *active = [NSMutableArray array];
    BOOL cancelled = NO;
    for (NSTouch *touch in all) {
      if (touch.type != NSTouchTypeIndirect) continue;
      if (touch.phase == NSTouchPhaseCancelled) cancelled = YES;
      if (touch.phase & NSTouchPhaseTouching) [active addObject:touch];
    }
    if (self.waitingForLift) {
      if (!active.count) self.waitingForLift = NO;
      return event;
    }
    if (cancelled || active.count > 2) {
      if (self.tracking) [self emit:@{@"phase":@"cancel", @"touches":@[]}];
      self.tracking = NO;
      self.suppressGestures = NO;
      self.waitingForLift = active.count > 0;
      return event;
    }
    BOOL beginning = !self.tracking;
    if (beginning) {
      if (active.count != 2) { self.suppressGestures = NO; return event; }
      if ([NSEvent pressedMouseButtons]) return event;
      NSPoint mouse = [window.contentView convertPoint:[window mouseLocationOutsideOfEventStream] fromView:nil];
      NSView *hit = [window.contentView hitTest:mouse];
      if (hit != view && ![hit isDescendantOf:view]) return event;
      [self.identities removeAllObjects];
      self.tracking = YES;
      self.suppressGestures = YES;
    }
    NSMutableArray *points = [NSMutableArray array];
    NSSize device = NSZeroSize;
    for (NSTouch *touch in active) {
      NSNumber *identifier = self.identities[touch.identity];
      if (!identifier) {
        // Adding/replacing a finger after the initial pair starts a fresh gesture.
        if (self.identities.count >= 2) {
          [self emit:@{@"phase":@"cancel", @"touches":@[]}];
          self.tracking = NO;
          self.suppressGestures = NO;
          self.waitingForLift = YES;
          return event;
        }
        identifier = @(self.identities.count);
        self.identities[touch.identity] = identifier;
      }
      NSPoint p = touch.normalizedPosition;
      device = touch.deviceSize;
      [points addObject:@{@"id":identifier, @"x":@(p.x), @"y":@(1-p.y)}];
    }
    [self emit:@{@"phase":beginning?@"begin":active.count?@"change":@"end",
                 @"touches":points, @"width":@(device.width), @"height":@(device.height)}];
    if (!active.count) self.tracking = NO;
    return event;
  }
  // The same fingers also produce native wheel/magnify/rotate. Consume those
  // only for this captured sequence; an ordinary mouse wheel still works.
  if (self.suppressGestures && (event.type == NSEventTypeMagnify ||
      event.type == NSEventTypeRotate || (event.type == NSEventTypeScrollWheel &&
      (event.phase != NSEventPhaseNone || event.momentumPhase != NSEventPhaseNone)))) return nil;
  if (event.type == NSEventTypeLeftMouseDown || event.type == NSEventTypeRightMouseDown) {
    if (self.tracking) [self emit:@{@"phase":@"cancel", @"touches":@[]}];
    self.tracking = NO;
    self.suppressGestures = NO;
    self.waitingForLift = YES;
  }
  return event;
}
@end

static napi_value Start(napi_env env, napi_callback_info info) {
  size_t count = 2; napi_value args[2], result;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  void *bytes = nullptr; size_t length = 0; napi_valuetype type;
  if (count != 2 || napi_get_buffer_info(env, args[0], &bytes, &length) != napi_ok ||
      length != sizeof(void *) || napi_typeof(env, args[1], &type) != napi_ok || type != napi_function) {
    napi_throw_type_error(env, nullptr, "Invalid trackpad binding"); return nullptr;
  }
  NSView *root = (__bridge NSView *)(*static_cast<void **>(bytes));
  NSWindow *window = root.window;
  NSResponder *responder = window.firstResponder;
  NSView *view = [responder isKindOfClass:[NSView class]] ? (NSView *)responder : nil;
  NSView *hit = [window.contentView hitTest:[window.contentView
      convertPoint:[window mouseLocationOutsideOfEventStream] fromView:nil]];
  if (![NSThread isMainThread] || !NSApp.isActive || !window.isKeyWindow || !view ||
      (hit != view && ![hit isDescendantOf:view])) {
    napi_get_null(env, &result); return result;
  }
  [capture finish];
  CindyTrackpad *next = [CindyTrackpad new];
  next.window = window; next.view = view; next.serial = ++nextSerial;
  next.identities = [NSMutableDictionary dictionary];
  napi_value name; napi_create_string_utf8(env, "CindyTrackpad", NAPI_AUTO_LENGTH, &name);
  napi_threadsafe_function callback;
  if (napi_create_threadsafe_function(env, args[1], nullptr, name, 0, 1, nullptr,
      nullptr, nullptr, Deliver, &callback) != napi_ok) return nullptr;
  next.callback = callback;
  napi_unref_threadsafe_function(env, callback);
  // Chromium enables indirect touches. Keep a stationary finger in the pair;
  // restore this NSView preference when the local capture ends.
  next.previousRestingTouches = view.wantsRestingTouches;
  view.wantsRestingTouches = YES;
  __weak CindyTrackpad *weak = next;
  next.monitor = [NSEvent addLocalMonitorForEventsMatchingMask:
      NSEventMaskGesture | NSEventMaskMagnify | NSEventMaskRotate | NSEventMaskScrollWheel |
      NSEventMaskLeftMouseDown | NSEventMaskRightMouseDown handler:^NSEvent *(NSEvent *event) {
    return weak ? [weak event:event] : event;
  }];
  next.resign = [[NSNotificationCenter defaultCenter] addObserverForName:NSWindowDidResignKeyNotification
      object:window queue:nil usingBlock:^(NSNotification *) { [weak finish]; }];
  capture = next;
  napi_create_uint32(env, next.serial, &result); return result;
}
static napi_value Stop(napi_env env, napi_callback_info info) {
  size_t count=1; napi_value arg, result; uint32_t serial=0;
  napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr);
  if (count && napi_get_value_uint32(env, arg, &serial)==napi_ok && capture.serial==serial) {
    [capture finish]; capture=nil;
  }
  napi_get_undefined(env, &result); return result;
}
// Electron's before-mouse-event can report subframe-relative coordinates.
// Use window-content coordinates, independent of which Chromium NSView owns
// firstResponder. The host converts these into the embedded guest viewport.
static napi_value Position(napi_env env, napi_callback_info info) {
  size_t count=1; napi_value arg, result; void *bytes=nullptr; size_t length=0;
  napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr);
  if (!count || napi_get_buffer_info(env,arg,&bytes,&length)!=napi_ok || length!=sizeof(void *)) {
    napi_throw_type_error(env,nullptr,"Invalid window handle"); return nullptr;
  }
  NSView *root=(__bridge NSView *)(*static_cast<void **>(bytes));
  NSWindow *window=root.window;
  NSView *view=window.contentView;
  if (!view || !window.isKeyWindow || !NSApp.isActive) { napi_get_null(env,&result); return result; }
  NSPoint p=[view convertPoint:[window mouseLocationOutsideOfEventStream] fromView:nil];
  napi_create_object(env,&result); napi_value x,y;
  napi_create_double(env,p.x-view.bounds.origin.x,&x);
  napi_create_double(env,view.isFlipped?p.y-view.bounds.origin.y:NSMaxY(view.bounds)-p.y,&y);
  napi_set_named_property(env,result,"x",x); napi_set_named_property(env,result,"y",y);
  return result;
}
static void Cleanup(void *) { [capture finish]; capture=nil; }
NAPI_MODULE_INIT() {
  napi_property_descriptor properties[] = {
    {"start", nullptr, Start, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"position", nullptr, Position, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"stop", nullptr, Stop, nullptr, nullptr, nullptr, napi_default, nullptr}};
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  napi_add_env_cleanup_hook(env, Cleanup, nullptr);
  return exports;
}
