#import <Foundation/Foundation.h>
#import <ServiceManagement/ServiceManagement.h>
#include <node_api.h>

// Run in Cindy's signed process so mainAppService identifies Cindy itself.
// Only the result is delivered to JS; smd never runs on the event loop.
static const char *Perform(int operation) API_AVAILABLE(macos(13.0)) {
  SMAppService *service = SMAppService.mainAppService;
  if (operation == 1) [service registerAndReturnError:nil];
  if (operation == 0) [service unregisterAndReturnError:nil];
  // Read back even on registration error: it may already be registered or
  // awaiting user approval. The caller verifies the requested outcome.
  switch (service.status) {
    case SMAppServiceStatusEnabled: return "enabled";
    case SMAppServiceStatusRequiresApproval: return "requires-approval";
    // Electron reports openAtLogin=false for a missing service too. A fresh
    // install must still be able to register its first login item.
    case SMAppServiceStatusNotFound:
    case SMAppServiceStatusNotRegistered: return "not-registered";
    default: return "unavailable";
  }
}

static void Deliver(napi_env env, napi_value callback, void *, void *data) {
  if (!env) return;
  napi_value status, receiver;
  napi_create_string_utf8(env, static_cast<const char *>(data), NAPI_AUTO_LENGTH, &status);
  napi_get_undefined(env, &receiver);
  napi_call_function(env, receiver, callback, 1, &status, nullptr);
}

static napi_value Start(napi_env env, napi_callback_info info) {
  size_t count = 2;
  napi_value args[2], label;
  int32_t operation;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  if (count != 2 || napi_get_value_int32(env, args[0], &operation) != napi_ok ||
      operation < -1 || operation > 1) {
    napi_throw_type_error(env, nullptr, "Invalid login item operation");
    return nullptr;
  }
  napi_create_string_utf8(env, "login-item", NAPI_AUTO_LENGTH, &label);
  napi_threadsafe_function completion;
  if (napi_create_threadsafe_function(env, args[1], nullptr, label, 1, 1, nullptr,
                                      nullptr, nullptr, Deliver, &completion) != napi_ok) {
    napi_throw_error(env, nullptr, "Unable to schedule login item operation");
    return nullptr;
  }
  napi_unref_threadsafe_function(env, completion);
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    @autoreleasepool {
      const char *status = "unavailable";
      if (@available(macOS 13.0, *)) status = Perform(operation);
      if (napi_call_threadsafe_function(completion, const_cast<char *>(status),
                                        napi_tsfn_nonblocking) != napi_closing) {
        napi_release_threadsafe_function(completion, napi_tsfn_release);
      }
    }
  });
  return nullptr;
}

NAPI_MODULE_INIT() {
  napi_value start;
  napi_create_function(env, "start", NAPI_AUTO_LENGTH, Start, nullptr, &start);
  napi_set_named_property(env, exports, "start", start);
  return exports;
}
