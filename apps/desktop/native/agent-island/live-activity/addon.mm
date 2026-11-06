// N-API shim for CindyAgentActivityController.swift: `apply(json) -> json`.
#include <node_api.h>
#include <stdlib.h>
#include <string.h>

extern "C" char *cindy_agent_activity_apply(const char *input);

static napi_value Apply(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  napi_value result;
  if (argc < 1) {
    napi_get_undefined(env, &result);
    return result;
  }
  size_t length = 0;
  if (napi_get_value_string_utf8(env, argv[0], nullptr, 0, &length) != napi_ok) {
    napi_throw_type_error(env, nullptr, "apply expects a JSON string");
    return nullptr;
  }
  char *input = static_cast<char *>(malloc(length + 1));
  napi_get_value_string_utf8(env, argv[0], input, length + 1, &length);
  char *output = cindy_agent_activity_apply(input);
  free(input);
  const char *text = output ? output : "{\"ok\":false,\"error\":\"native-null\"}";
  napi_create_string_utf8(env, text, strlen(text), &result);
  free(output);
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "apply", NAPI_AUTO_LENGTH, Apply, nullptr, &fn);
  napi_set_named_property(env, exports, "apply", fn);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
