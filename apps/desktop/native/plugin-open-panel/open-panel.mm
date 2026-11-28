#import <Cocoa/Cocoa.h>
#include <node_api.h>
#include <cstring>

// Keep the identity of the sheet opened by one synchronous Electron call.
struct Panel {
  __weak NSWindow *parent;
  __weak NSOpenPanel *sheet;
};

static void FinalizePanel(napi_env, void *data, void *) {
  delete static_cast<Panel *>(data);
}

static napi_value Cancel(napi_env env, napi_callback_info info) {
  size_t count = 0;
  void *data = nullptr;
  napi_get_cb_info(env, info, &count, nullptr, nullptr, &data);
  const auto *panel = static_cast<Panel *>(data);
  NSWindow *parent = panel->parent;
  NSOpenPanel *sheet = panel->sheet;
  const bool ownsActiveSheet = [NSThread isMainThread] && parent && sheet &&
      parent.attachedSheet == sheet && sheet.sheetParent == parent;
  if (ownsActiveSheet) [parent endSheet:sheet returnCode:NSModalResponseCancel];
  napi_value result;
  napi_get_boolean(env, ownsActiveSheet, &result);
  return result;
}

static NSWindow *FindParent(napi_env env, napi_value value) {
  void *bytes = nullptr;
  size_t length = 0;
  if (napi_get_buffer_info(env, value, &bytes, &length) != napi_ok ||
      length != sizeof(void *)) return nil;
  void *handle = nullptr;
  std::memcpy(&handle, bytes, sizeof(handle));
  // The buffer contains an NSView pointer. Compare it to known local views
  // without dereferencing it or accepting a process-wide window number.
  for (NSWindow *window in NSApp.windows) {
    if ((__bridge void *)window.contentView == handle) return window;
  }
  return nil;
}

static napi_value Open(napi_env env, napi_callback_info info) {
  napi_value arguments[2], receiver, promise, result;
  size_t count = 2;
  if (napi_get_cb_info(env, info, &count, arguments, &receiver, nullptr) != napi_ok ||
      count != 2 || ![NSThread isMainThread]) return nullptr;
  NSWindow *parent = FindParent(env, arguments[0]);
  // Avoid creating a queued AppKit sheet whose ownership cannot be inspected.
  if (parent.attachedSheet) {
    napi_get_null(env, &result);
    return result;
  }
  if (napi_call_function(env, receiver, arguments[1], 0, nullptr, &promise) != napi_ok) return nullptr;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "promise", promise);
  NSWindow *sheet = parent.attachedSheet;
  if ([sheet isKindOfClass:NSOpenPanel.class] && sheet.sheetParent == parent) {
    auto *panel = new Panel{parent, (NSOpenPanel *)sheet};
    napi_value cancel;
    if (napi_create_function(env, nullptr, 0, Cancel, panel, &cancel) == napi_ok &&
        napi_add_finalizer(env, cancel, panel, FinalizePanel, nullptr, nullptr) == napi_ok) {
      napi_set_named_property(env, result, "cancel", cancel);
    } else {
      delete panel;
    }
  }
  return result;
}

NAPI_MODULE_INIT() {
  napi_value open;
  napi_create_function(env, nullptr, 0, Open, nullptr, &open);
  return open;
}
