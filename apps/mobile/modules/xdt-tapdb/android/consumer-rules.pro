# TapSDK 4.x is already obfuscated and uses service loading / reflection.
# Keep the vendor namespaces as required by its integration guide. Put the rules
# on the wrapper so they reach every consuming CN/Global release build.
# https://developer.taptap.io/docs/sdk/access/quickstart/#android-code-obfuscation
-keep class com.taptap.** { *; }
-keep class com.tapsdk.** { *; }
