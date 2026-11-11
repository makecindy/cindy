package com.xdtmaker.speakeronnx

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.util.Base64
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest

/**
 * Runs the speaker filter models (Silero VAD and the voiceprint model) with
 * ONNX Runtime. Feature extraction and gating live in shared TypeScript; this
 * module only loads the two models and runs float32 tensors, one call at a
 * time (calls are serialized on this module's lock).
 */
class CindySpeakerOnnxModule : Module() {
  private val lock = Any()
  private var sessions: Map<String, OrtSession> = emptyMap()
  private var loadedPaths: Map<String, String> = emptyMap()

  override fun definition() = ModuleDefinition {
    Name("CindySpeakerOnnx")

    // Loads (or keeps) both models. Same paths as last time is a no-op.
    AsyncFunction("loadModels") { vadPath: String, embeddingPath: String ->
      synchronized(lock) {
        val wanted = mapOf("vad" to vadPath, "embedding" to embeddingPath)
        if (wanted == loadedPaths) return@synchronized
        val env = OrtEnvironment.getEnvironment()
        val next = LinkedHashMap<String, OrtSession>()
        try {
          wanted.forEach { (name, path) ->
            next[name] = OrtSession.SessionOptions().use { options ->
              options.setIntraOpNumThreads(1)
              env.createSession(path, options)
            }
          }
        } catch (error: Throwable) {
          // A later model may fail after an earlier native session was opened.
          next.values.forEach { runCatching { it.close() } }
          throw error
        }
        closeSessions()
        sessions = next
        loadedPaths = wanted
      }
    }

    AsyncFunction("unloadModels") {
      synchronized(lock) { closeSessions() }
    }

    // `packed` holds the little-endian float32 data of every input, in the
    // order of `names`, each sized by its `dims`. Returns, per output, its dims
    // and its float32 data as base64.
    AsyncFunction("run") { model: String, names: List<String>, dims: List<List<Int>>, packed: ByteArray ->
      synchronized(lock) {
        val session = sessions[model] ?: throw SpeakerOnnxException("model $model is not loaded")
        if (names.size != dims.size) throw SpeakerOnnxException("names and dims differ in length")
        val env = OrtEnvironment.getEnvironment()
        val inputs = LinkedHashMap<String, OnnxTensor>()
        try {
          var offset = 0
          names.forEachIndexed { index, name ->
            val shape = dims[index].map { it.toLong() }.toLongArray()
            val count = shape.fold(1L) { acc, value -> acc * value }.toInt()
            val byteCount = count * 4
            if (count < 0 || offset + byteCount > packed.size) {
              throw SpeakerOnnxException("input $name exceeds the packed data")
            }
            val buffer = ByteBuffer.wrap(packed, offset, byteCount).slice().order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer()
            inputs[name] = OnnxTensor.createTensor(env, buffer, shape)
            offset += byteCount
          }
          if (offset != packed.size) throw SpeakerOnnxException("packed data has trailing bytes")
          session.run(inputs).use { result ->
            val out = HashMap<String, Map<String, Any>>()
            for ((name, value) in result) {
              val tensor = value as? OnnxTensor ?: continue
              val floats = tensor.floatBuffer
              val bytes = ByteBuffer.allocate(floats.remaining() * 4).order(ByteOrder.LITTLE_ENDIAN)
              bytes.asFloatBuffer().put(floats)
              out[name] = mapOf(
                "dims" to tensor.info.shape.map { it.toInt() },
                "base64" to Base64.encodeToString(bytes.array(), Base64.NO_WRAP),
              )
            }
            out
          }
        } finally {
          inputs.values.forEach { it.close() }
        }
      }
    }

    // Hex SHA-256 of a downloaded model file, read in chunks.
    AsyncFunction("sha256File") { path: String ->
      val digest = MessageDigest.getInstance("SHA-256")
      File(path.removePrefix("file://")).inputStream().use { input ->
        val buffer = ByteArray(1 shl 20)
        while (true) {
          val read = input.read(buffer)
          if (read < 0) break
          digest.update(buffer, 0, read)
        }
      }
      digest.digest().joinToString("") { "%02x".format(it) }
    }

    OnDestroy {
      synchronized(lock) { closeSessions() }
    }
  }

  private fun closeSessions() {
    sessions.values.forEach { runCatching { it.close() } }
    sessions = emptyMap()
    loadedPaths = emptyMap()
  }
}

class SpeakerOnnxException(message: String) :
  CodedException("ERR_SPEAKER_ONNX", "Speaker ONNX inference failed: $message", null)
