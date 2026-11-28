package com.xdtmaker.realtimeaudio

import android.Manifest
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.util.Base64
import androidx.core.content.ContextCompat
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.ArrayDeque
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

private const val EVENT_AUDIO_CHUNK = "onAudioChunk"
private const val EVENT_AUDIO_ERROR = "onAudioError"
private const val MAX_RECENT_CHUNKS = 128
private const val DRAIN_INTERVAL_MS = 5L
private const val PREWARM_KEEP_ALIVE_SECONDS = 10L

class XdtMobileRealtimeAudioModule : Module() {
  private val capture = XdtAudioCapture()
  private val mainHandler = Handler(Looper.getMainLooper())
  // Serializes all lifecycle mutations (start / stop / stopAndDrain / prewarm /
  // keep-alive cleanup / background teardown), mirroring iOS sessionStateQueue.
  private val stateExecutor = Executors.newSingleThreadScheduledExecutor { runnable ->
    Thread(runnable, "xdt-realtime-audio-state").apply { isDaemon = true }
  }

  private var drainTask: ScheduledFuture<*>? = null
  private var prewarmCleanupTask: ScheduledFuture<*>? = null
  private val recentChunks = ArrayDeque<Map<String, Any>>(MAX_RECENT_CHUNKS)
  private var captureId: String = ""
  private var sessionActivatedAt: Double = 0.0
  private var engineStartedAt: Double = 0.0
  private var isCapturing: Boolean = false
  private var targetSampleRate: Double = 16_000.0

  override fun definition() = ModuleDefinition {
    Name("XdtMobileRealtimeAudio")

    Events(EVENT_AUDIO_CHUNK, EVENT_AUDIO_ERROR)

    // Plain Map<String, Any?> options: avoids R8 stripping Expo Record metadata.
    AsyncFunction("start") { options: Map<String, Any?>? ->
      runOnStateThread {
        startCaptureLocked(options)
        mapOf(
          "backend" to "android-native",
          // Port types only: device names/addresses can contain personal information.
          "inputPortTypes" to capture.currentInputPortTypes(),
          "inputSampleRate" to capture.inputSampleRate,
          "inputChannels" to 1,
          "ioBufferDurationMs" to capture.ioBufferDurationMs,
          "sessionActivatedAt" to sessionActivatedAt,
          "engineStartedAt" to engineStartedAt,
        )
      }
    }

    AsyncFunction("stop") {
      runOnStateThread {
        stopCaptureLocked(releasePrewarmed = false)
      }
    }

    // Additive parity with iOS: returns only audio captured before stoppedAt
    // that JS has not already acknowledged via chunkIndex > afterIndex.
    AsyncFunction("stopAndDrain") { afterIndex: Int, stoppedAt: Double ->
      runOnStateThread {
        stopCaptureLocked(releasePrewarmed = false)
        try {
          if (!stoppedAt.isFinite()) {
            throw CodedException("ERR_AUDIO_STOP_TIME", "Invalid microphone stop time.", null)
          }
          val firstIndex = (recentChunks.peekFirst()?.get("chunkIndex") as? Number)?.toInt() ?: 0
          if (capture.overflowed || (recentChunks.isNotEmpty() && firstIndex > afterIndex + 1)) {
            throw CodedException("ERR_AUDIO_OVERFLOW", "Realtime microphone delivery fell behind.", null)
          }
          recentChunks.mapNotNull { chunk ->
            val index = (chunk["chunkIndex"] as? Number)?.toInt() ?: return@mapNotNull null
            if (index <= afterIndex) return@mapNotNull null
            val capturedAt = (chunk["capturedAt"] as? Number)?.toDouble() ?: return@mapNotNull null
            val sampleRate = (chunk["sampleRate"] as? Number)?.toDouble() ?: return@mapNotNull null
            val base64 = chunk["base64Pcm16"] as? String ?: return@mapNotNull null
            val pcm = runCatching { Base64.decode(base64, Base64.DEFAULT) }.getOrNull()
              ?: return@mapNotNull null
            val maxFrames = floor(max(0.0, (stoppedAt - capturedAt) * sampleRate / 1_000.0))
            val retainedFrames = min(pcm.size / 2, maxFrames.toInt())
            if (retainedFrames <= 0) return@mapNotNull null
            val trimmed = if (retainedFrames * 2 == pcm.size) pcm else pcm.copyOf(retainedFrames * 2)
            HashMap<String, Any>(chunk).apply {
              this["base64Pcm16"] = Base64.encodeToString(trimmed, Base64.NO_WRAP)
              this["durationMs"] = retainedFrames.toDouble() / sampleRate * 1_000.0
            }
          }
        } finally {
          recentChunks.clear()
        }
      }
    }

    AsyncFunction("prewarm") {
      runOnStateThread {
        prewarmLocked()
      }
    }

    // Foreground-only voice input: release live capture and speculative prewarm
    // immediately when leaving the foreground.
    OnActivityEntersBackground {
      runOnStateThreadBestEffort {
        stopCaptureLocked(releasePrewarmed = true)
      }
    }

    OnDestroy {
      runOnStateThreadBestEffort {
        stopCaptureLocked(releasePrewarmed = true)
      }
      stateExecutor.shutdown()
    }
  }

  private fun <T> runOnStateThread(block: () -> T): T {
    return try {
      stateExecutor.submit(Callable { block() }).get()
    } catch (error: java.util.concurrent.ExecutionException) {
      throw error.cause ?: error
    }
  }

  private fun runOnStateThreadBestEffort(block: () -> Unit) {
    if (stateExecutor.isShutdown) return
    runCatching {
      stateExecutor.submit(block).get(1L, TimeUnit.SECONDS)
    }
  }

  private fun hasMicrophonePermission(): Boolean {
    val context = appContext.reactContext ?: return false
    return ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
      PackageManager.PERMISSION_GRANTED
  }

  private fun prewarmLocked() {
    cancelPrewarmCleanupLocked()
    if (isCapturing) return
    try {
      if (!hasMicrophonePermission()) return
      capture.prewarm(targetSampleRate)
    } catch (_: Throwable) {
      // Best-effort only; start() surfaces configuration failures.
    } finally {
      schedulePrewarmCleanupLocked()
    }
  }

  private fun startCaptureLocked(options: Map<String, Any?>?) {
    cancelPrewarmCleanupLocked()
    if (isCapturing) return

    val requestedRate = (options?.get("sampleRate") as? Number)?.toDouble()
    if (requestedRate != null && requestedRate.isFinite() && requestedRate > 0.0) {
      targetSampleRate = requestedRate
    }
    captureId = options?.get("captureId") as? String ?: ""
    recentChunks.clear()

    if (!hasMicrophonePermission()) {
      schedulePrewarmCleanupLocked()
      throw CodedException(
        "ERR_MIC_PERMISSION_DENIED",
        "Microphone permission is required for realtime voice input.",
        null,
      )
    }

    sessionActivatedAt = System.currentTimeMillis().toDouble()
    val activeCaptureId = captureId
    try {
      capture.start(targetSampleRate) { errorMessage ->
        if (stateExecutor.isShutdown) return@start
        stateExecutor.execute {
          if (!isCapturing || captureId != activeCaptureId) return@execute
          emitError(errorMessage, activeCaptureId)
          stopCaptureLocked(releasePrewarmed = true)
        }
      }
      engineStartedAt = System.currentTimeMillis().toDouble()
      isCapturing = true
      drainTask = stateExecutor.scheduleAtFixedRate(
        {
          if (!isCapturing) return@scheduleAtFixedRate
          collectChunksLocked(emit = true)
          if (capture.overflowed) {
            emitError("Realtime microphone delivery fell behind.", captureId)
            stopCaptureLocked(releasePrewarmed = true)
          }
        },
        0L,
        DRAIN_INTERVAL_MS,
        TimeUnit.MILLISECONDS,
      )
    } catch (error: Throwable) {
      capture.stop()
      schedulePrewarmCleanupLocked()
      if (error is CodedException) throw error
      throw CodedException(
        "ERR_AUDIO_ENGINE_START",
        "Failed to start realtime audio engine: ${error.message ?: error.javaClass.simpleName}",
        error,
      )
    }
  }

  private fun collectChunksLocked(emit: Boolean) {
    val activeId = captureId
    for (raw in capture.drain()) {
      val chunk = HashMap<String, Any>(raw).apply {
        this["captureId"] = activeId
      }
      recentChunks.addLast(chunk)
      while (recentChunks.size > MAX_RECENT_CHUNKS) {
        recentChunks.removeFirst()
      }
      if (emit) {
        mainHandler.post {
          runCatching { sendEvent(EVENT_AUDIO_CHUNK, chunk) }
        }
      }
    }
  }

  private fun stopCaptureLocked(releasePrewarmed: Boolean) {
    drainTask?.cancel(false)
    drainTask = null
    capture.stop()
    collectChunksLocked(emit = false)
    isCapturing = false
    if (releasePrewarmed) {
      cancelPrewarmCleanupLocked()
      capture.releasePrewarmed()
    } else {
      schedulePrewarmCleanupLocked()
    }
  }

  private fun schedulePrewarmCleanupLocked() {
    cancelPrewarmCleanupLocked()
    if (stateExecutor.isShutdown) return
    prewarmCleanupTask = stateExecutor.schedule(
      {
        prewarmCleanupTask = null
        if (!isCapturing) {
          capture.releasePrewarmed()
        }
      },
      PREWARM_KEEP_ALIVE_SECONDS,
      TimeUnit.SECONDS,
    )
  }

  private fun cancelPrewarmCleanupLocked() {
    prewarmCleanupTask?.cancel(false)
    prewarmCleanupTask = null
  }

  private fun emitError(message: String, id: String) {
    mainHandler.post {
      runCatching {
        sendEvent(EVENT_AUDIO_ERROR, mapOf("message" to message, "captureId" to id))
      }
    }
  }
}
