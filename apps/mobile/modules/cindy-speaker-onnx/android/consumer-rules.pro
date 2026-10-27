# ONNX Runtime JNI looks up Java classes, constructors and members by name.
# Keep the whole Java bridge, including TensorInfo and the map/sequence types,
# so R8 cannot rename or remove entry points used only from native code (#6190).
-keep class ai.onnxruntime.** { *; }
