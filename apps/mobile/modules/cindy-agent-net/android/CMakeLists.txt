cmake_minimum_required(VERSION 3.22.1)
project(cindy_agent_net_bridge LANGUAGES CXX)
if(NOT DEFINED CINDY_AGENT_NET_NATIVE_DIR)
  message(FATAL_ERROR "CINDY_AGENT_NET_NATIVE_DIR is required")
endif()
add_library(cindy_agent_net_native SHARED IMPORTED)
set_target_properties(cindy_agent_net_native PROPERTIES
  IMPORTED_LOCATION "${CINDY_AGENT_NET_NATIVE_DIR}/dist/android/${ANDROID_ABI}/libcindy_agent_net_native.so"
  # Rust's cdylib has no SONAME by default. Link by library name rather than
  # embedding the build machine's absolute path in the APK's DT_NEEDED.
  IMPORTED_NO_SONAME TRUE)
add_library(cindy_agent_net_bridge SHARED src/main/cpp/bridge.cpp)
target_include_directories(cindy_agent_net_bridge PRIVATE "${CINDY_AGENT_NET_NATIVE_DIR}/include")
target_link_libraries(cindy_agent_net_bridge cindy_agent_net_native)
