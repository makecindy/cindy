#include <jni.h>
#include <cstdint>
#include "cindy_agent_net.h"

extern "C" JNIEXPORT jlong JNICALL
Java_app_cindy_agentnet_CindyAgentNetModule_nativeCreate(JNIEnv *env, jobject, jbyteArray input) {
  auto size = env->GetArrayLength(input);
  if (size > 128 * 1024) return 0;
  auto bytes = env->GetByteArrayElements(input, nullptr);
  if (!bytes) return 0;
  auto handle = cindy_agent_net_create(reinterpret_cast<const uint8_t *>(bytes), static_cast<size_t>(size));
  env->ReleaseByteArrayElements(input, bytes, JNI_ABORT);
  return reinterpret_cast<jlong>(handle);
}
extern "C" JNIEXPORT jstring JNICALL
Java_app_cindy_agentnet_CindyAgentNetModule_nativeCommand(JNIEnv *env, jobject, jlong id, jbyteArray input) {
  auto size = env->GetArrayLength(input);
  if (size > 2 * 1024 * 1024) return nullptr;
  auto bytes = env->GetByteArrayElements(input, nullptr);
  if (!bytes) return nullptr;
  auto result = cindy_agent_net_command(reinterpret_cast<CindyAgentNetEngine *>(id),
      reinterpret_cast<const uint8_t *>(bytes), static_cast<size_t>(size));
  env->ReleaseByteArrayElements(input, bytes, JNI_ABORT);
  if (!result) return nullptr;
  // Native result values are protocol IDs, base64url data, numeric counters and
  // fixed error codes; no arbitrary user text crosses NewStringUTF.
  auto value = env->NewStringUTF(result);
  cindy_agent_net_free_string(result);
  return value;
}
extern "C" JNIEXPORT void JNICALL
Java_app_cindy_agentnet_CindyAgentNetModule_nativeDestroy(JNIEnv *, jobject, jlong id) {
  cindy_agent_net_destroy(reinterpret_cast<CindyAgentNetEngine *>(id));
}
extern "C" JNIEXPORT jstring JNICALL
Java_app_cindy_agentnet_AgentNetNotifications_nativeOpen(JNIEnv *env, jobject, jbyteArray input) {
  auto size = env->GetArrayLength(input);
  if (size > 512 * 1024) return nullptr;
  auto bytes = env->GetByteArrayElements(input, nullptr);
  if (!bytes) return nullptr;
  auto result = cindy_agent_net_notification_open(reinterpret_cast<const uint8_t *>(bytes), static_cast<size_t>(size));
  env->ReleaseByteArrayElements(input, bytes, JNI_ABORT);
  if (!result) return nullptr;
  auto value = env->NewStringUTF(result); // result contains only ASCII/base64.
  cindy_agent_net_free_string(result);
  return value;
}
