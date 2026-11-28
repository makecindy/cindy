package com.xdtmaker.realtimeaudio

import android.annotation.SuppressLint
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTimestamp
import android.media.MediaRecorder
import android.os.Build
import android.os.Process
import android.util.Base64
import java.io.ByteArrayOutputStream
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.roundToLong

/**
 * Lock-free ring-buffered Android AudioRecord capture with hardware timestamps.
 *
 * Mirrors iOS XdtAudioCapture:
 * - Pre-allocates 256 x 4096-sample slots (~2 MiB) so the urgent-priority
 *   reader thread performs zero heap allocations per read.
 * - Anchors AudioRecord.getTimestamp(TIMEBASE_MONOTONIC) to wall clock time so
 *   stopAndDrain() can trim accurately to the user's stop gesture time.
 * - Packetizes to 10ms for the first chunk and 40ms thereafter, resampling
 *   continuously if the hardware HAL rejects the requested sample rate.
 */
internal class XdtAudioCapture {
  private class AudioSlot {
    val samples = ShortArray(MAX_FRAMES)
    var frames: Int = 0
    var monoTimeNs: Long = 0L
  }

  private val slots = Array(SLOT_COUNT) { AudioSlot() }
  private val written = AtomicInteger(0)
  private val read = AtomicInteger(0)
  private val overflowFlag = AtomicBoolean(false)
  private val running = AtomicBoolean(false)

  private var audioRecord: AudioRecord? = null
  private var prewarmedRecord: AudioRecord? = null
  private var prewarmedSampleRate: Int = 0
  private var prewarmedReadFrames: Int = 0
  private var readerThread: Thread? = null

  @Volatile var inputSampleRate: Double = 16_000.0
    private set
  @Volatile var ioBufferDurationMs: Double = 10.0
    private set

  private var targetRate: Double = 16_000.0
  private var monoAnchorNs: Long = 0L
  private var wallAnchorMs: Double = 0.0
  private var sourceFrames: Long = 0L
  private var outputFrames: Long = 0L
  private var chunkIndex: Int = 0
  private val pending = ByteArrayOutputStream(4096)
  private var pendingCapturedAtMs: Double = 0.0

  val overflowed: Boolean
    get() = overflowFlag.get()

  val isRunning: Boolean
    get() = running.get()

  @SuppressLint("MissingPermission")
  fun prewarm(requestedSampleRate: Double) {
    if (running.get()) return
    val normalizedRate = requestedSampleRate.takeIf { it.isFinite() && it in 8_000.0..192_000.0 }
      ?.roundToInt()
      ?: 16_000
    val existing = prewarmedRecord
    if (existing != null && existing.state == AudioRecord.STATE_INITIALIZED && prewarmedSampleRate == normalizedRate) {
      return
    }
    releasePrewarmed()
    val created = createAudioRecord(normalizedRate) ?: return
    prewarmedRecord = created.record
    prewarmedSampleRate = created.actualSampleRate
    prewarmedReadFrames = created.readFrames
  }

  fun releasePrewarmed() {
    val existing = prewarmedRecord
    prewarmedRecord = null
    prewarmedSampleRate = 0
    prewarmedReadFrames = 0
    if (existing != null) {
      runCatching { existing.release() }
    }
  }

  @SuppressLint("MissingPermission")
  fun start(requestedSampleRate: Double, onReadError: (String) -> Unit) {
    stop()
    if (!requestedSampleRate.isFinite() || requestedSampleRate < 8_000.0 || requestedSampleRate > 192_000.0) {
      throw IllegalArgumentException("Unsupported microphone sample rate.")
    }

    val desiredRate = requestedSampleRate.roundToInt()
    val prepared = takePrewarmedOrCreate(desiredRate)
      ?: throw IllegalStateException("Microphone did not provide a supported PCM format.")

    val record = prepared.record
    audioRecord = record
    inputSampleRate = prepared.actualSampleRate.toDouble()
    ioBufferDurationMs = prepared.readFrames.toDouble() / inputSampleRate * 1_000.0
    targetRate = requestedSampleRate

    written.set(0)
    read.set(0)
    overflowFlag.set(false)
    sourceFrames = 0L
    outputFrames = 0L
    chunkIndex = 0
    pending.reset()
    pendingCapturedAtMs = 0.0

    monoAnchorNs = System.nanoTime()
    wallAnchorMs = System.currentTimeMillis().toDouble()

    try {
      record.startRecording()
      if (record.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
        throw IllegalStateException("AudioRecord failed to enter recording state.")
      }
    } catch (error: Throwable) {
      audioRecord = null
      runCatching { record.release() }
      throw error
    }

    running.set(true)
    val readFrames = prepared.readFrames
    val actualRate = prepared.actualSampleRate
    val thread = Thread(
      { runReaderLoop(record, readFrames, actualRate, onReadError) },
      "xdt-realtime-audio-capture",
    )
    readerThread = thread
    thread.start()
  }

  fun stop() {
    running.set(false)
    val record = audioRecord
    if (record != null) {
      runCatching {
        if (record.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
          record.stop()
        }
      }
    }
    val thread = readerThread
    readerThread = null
    if (thread != null && thread !== Thread.currentThread()) {
      runCatching { thread.join(500L) }
    }
    audioRecord = null
    if (record != null) {
      runCatching { record.release() }
    }
  }

  fun currentInputPortTypes(): List<String> {
    val device = runCatching { audioRecord?.routedDevice }.getOrNull() ?: return listOf("unknown")
    return listOf(mapAudioDeviceType(device.type))
  }

  fun drain(): List<Map<String, Any>> {
    val packets = ArrayList<Map<String, Any>>()
    var currentRead = read.get()
    val currentWritten = written.get()
    val inRate = inputSampleRate
    val outRate = targetRate
    while (currentRead != currentWritten) {
      val slot = slots[Math.floorMod(currentRead, SLOT_COUNT)]
      val frames = slot.frames
      val end = sourceFrames + frames
      val outputEnd = ceil(end * outRate / inRate).toLong()
      while (outputFrames < outputEnd) {
        val source = floor(outputFrames * inRate / outRate).toLong()
        val offset = (source - sourceFrames).toInt().coerceIn(0, max(0, frames - 1))
        if (pending.size() == 0) {
          val deltaMs = (slot.monoTimeNs - monoAnchorNs) / 1_000_000.0
          pendingCapturedAtMs = wallAnchorMs + deltaMs + (offset.toDouble() / inRate) * 1_000.0
        }
        val sample = if (frames > 0) slot.samples[offset].toInt() else 0
        pending.write(sample and 0xff)
        pending.write((sample ushr 8) and 0xff)

        // First packet 10ms, subsequent packets 40ms (matching iOS XdtAudioCapture.m).
        val framesPerPacket = (outRate * if (chunkIndex == 0) 0.010 else 0.040).roundToLong().coerceAtLeast(1L)
        if (pending.size() / 2L >= framesPerPacket) {
          packets.add(takePending())
        }
        outputFrames += 1L
      }
      sourceFrames = end
      currentRead += 1
      read.set(currentRead)
    }
    if (!running.get() && pending.size() > 0) {
      packets.add(takePending())
    }
    return packets
  }

  private fun takePending(): Map<String, Any> {
    val bytes = pending.toByteArray()
    pending.reset()
    val frames = bytes.size / 2
    val packet = HashMap<String, Any>(5)
    packet["base64Pcm16"] = Base64.encodeToString(bytes, Base64.NO_WRAP)
    packet["capturedAt"] = pendingCapturedAtMs
    packet["chunkIndex"] = chunkIndex++
    packet["sampleRate"] = targetRate
    packet["durationMs"] = frames.toDouble() / targetRate * 1_000.0
    return packet
  }

  private fun runReaderLoop(
    record: AudioRecord,
    readFrames: Int,
    actualSampleRate: Int,
    onReadError: (String) -> Unit,
  ) {
    runCatching { Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO) }
    val scratch = ShortArray(readFrames)
    val timestamp = AudioTimestamp()
    var totalCapturedFrames = 0L
    val nsPerFrame = 1_000_000_000.0 / actualSampleRate.toDouble()

    while (running.get()) {
      val framesRead = try {
        record.read(scratch, 0, readFrames, AudioRecord.READ_BLOCKING)
      } catch (_: Throwable) {
        if (running.get()) {
          onReadError("Realtime microphone capture was interrupted.")
        }
        break
      }

      if (framesRead > 0) {
        val nowNs = System.nanoTime()
        val slotStartFrame = totalCapturedFrames
        totalCapturedFrames += framesRead.toLong()
        val slotMonoNs = computeSlotTimestampNs(record, timestamp, slotStartFrame, framesRead, nowNs, nsPerFrame)

        val currentWritten = written.get()
        val currentRead = read.get()
        if (framesRead > MAX_FRAMES || currentWritten - currentRead >= SLOT_COUNT) {
          overflowFlag.set(true)
          continue
        }
        val slot = slots[Math.floorMod(currentWritten, SLOT_COUNT)]
        System.arraycopy(scratch, 0, slot.samples, 0, framesRead)
        slot.frames = framesRead
        slot.monoTimeNs = slotMonoNs
        written.set(currentWritten + 1)
      } else if (framesRead < 0) {
        if (running.get()) {
          onReadError(describeReadError(framesRead))
        }
        break
      }
    }
  }

  private fun computeSlotTimestampNs(
    record: AudioRecord,
    timestamp: AudioTimestamp,
    slotStartFrame: Long,
    framesRead: Int,
    nowNs: Long,
    nsPerFrame: Double,
  ): Long {
    val fallbackNs = nowNs - (framesRead * nsPerFrame).roundToLong()
    val status = runCatching {
      record.getTimestamp(timestamp, AudioTimestamp.TIMEBASE_MONOTONIC)
    }.getOrDefault(AudioRecord.ERROR_INVALID_OPERATION)
    if (status != AudioRecord.SUCCESS || timestamp.nanoTime <= 0L) {
      return fallbackNs
    }
    val candidateNs = timestamp.nanoTime + ((slotStartFrame - timestamp.framePosition) * nsPerFrame).roundToLong()
    // Guard against OEM HALs returning bogus/uninitialized monotonic epochs.
    return if (abs(candidateNs - fallbackNs) <= MAX_TIMESTAMP_DRIFT_NS) candidateNs else fallbackNs
  }

  @SuppressLint("MissingPermission")
  private fun takePrewarmedOrCreate(desiredRate: Int): PreparedRecord? {
    val existing = prewarmedRecord
    if (existing != null) {
      val rate = prewarmedSampleRate
      val readFrames = prewarmedReadFrames
      prewarmedRecord = null
      prewarmedSampleRate = 0
      prewarmedReadFrames = 0
      if (existing.state == AudioRecord.STATE_INITIALIZED && rate == desiredRate) {
        return PreparedRecord(existing, rate, readFrames)
      }
      runCatching { existing.release() }
    }
    return createAudioRecord(desiredRate)
  }

  @SuppressLint("MissingPermission")
  private fun createAudioRecord(desiredRate: Int): PreparedRecord? {
    val candidateRates = listOf(desiredRate, 16_000, 48_000, 44_100).distinct()
    val candidateSources = listOf(
      MediaRecorder.AudioSource.VOICE_RECOGNITION,
      MediaRecorder.AudioSource.MIC,
    )
    for (rate in candidateRates) {
      val minBufferBytes = AudioRecord.getMinBufferSize(
        rate,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
      )
      if (minBufferBytes <= 0) continue
      val readFrames = (rate / 100).coerceIn(160, MAX_FRAMES)
      val bufferBytes = max(minBufferBytes, readFrames * 2 * 4)
      for (source in candidateSources) {
        val candidate = runCatching {
          AudioRecord(
            source,
            rate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            bufferBytes,
          )
        }.getOrNull() ?: continue
        if (candidate.state == AudioRecord.STATE_INITIALIZED) {
          return PreparedRecord(candidate, rate, readFrames)
        }
        runCatching { candidate.release() }
      }
    }
    return null
  }

  private fun describeReadError(code: Int): String = when (code) {
    AudioRecord.ERROR_DEAD_OBJECT -> "Realtime voice input microphone route became unavailable."
    else -> "Realtime voice input was interrupted by the system."
  }

  private fun mapAudioDeviceType(type: Int): String {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && type == AudioDeviceInfo.TYPE_BLE_HEADSET) {
      return "BluetoothLE"
    }
    return when (type) {
      AudioDeviceInfo.TYPE_BUILTIN_MIC -> "MicrophoneBuiltIn"
      AudioDeviceInfo.TYPE_WIRED_HEADSET -> "MicrophoneWired"
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "BluetoothHFP"
      AudioDeviceInfo.TYPE_USB_DEVICE, AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_USB_ACCESSORY -> "USBAudio"
      else -> "unknown"
    }
  }

  private data class PreparedRecord(
    val record: AudioRecord,
    val actualSampleRate: Int,
    val readFrames: Int,
  )

  private companion object {
    const val SLOT_COUNT = 256
    const val MAX_FRAMES = 4096
    const val MAX_TIMESTAMP_DRIFT_NS = 5_000_000_000L
  }
}
