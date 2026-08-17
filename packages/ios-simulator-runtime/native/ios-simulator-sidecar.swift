import Accelerate
import CoreMedia
import CoreVideo
import Darwin
import Foundation
import IOSurface
import ObjectiveC
import VideoToolbox

let protocolVersion = 1
let maxBodyBytes = 16 * 1024 * 1024
let maxMetadataBytes = 64 * 1024
let maxFramebufferBytes = maxBodyBytes - maxMetadataBytes - 4
let maxScreenID: UInt32 = 16
let bgraPixelFormat = UInt32(kCVPixelFormatType_32BGRA)
let maxCorrectnessFramesPerSecond = 15
let maxH264CorrectnessFramesPerSecond = 30
let maxProductH264FramesPerSecond = 60
let maxCorrectnessFrames = 900
let maxGestureSamples = 4_096
let maxGestureDurationMilliseconds = 60_000
let h264EncodingTimeoutSeconds: TimeInterval = 5
let productH264Requested = CommandLine.arguments.contains(
    "--enable-h264-stream"
)
let productHIDRequested = CommandLine.arguments.contains(
    "--enable-continuous-input"
)

@_silgen_name("cindy_simulator_kit_unmasked_surface")
func simulatorKitUnmaskedSurface(_ screen: AnyObject) -> IOSurfaceRef?

typealias ObjCClassTwoObjectArgs = @convention(c) (
    AnyClass,
    Selector,
    AnyObject,
    UnsafeMutablePointer<NSError?>
) -> AnyObject?
typealias ObjCObjectErrorArg = @convention(c) (
    AnyObject,
    Selector,
    UnsafeMutablePointer<NSError?>
) -> AnyObject?
typealias ObjCObjectNoArgs = @convention(c) (AnyObject, Selector) -> AnyObject?
typealias ObjCAlloc = @convention(c) (AnyClass, Selector) -> AnyObject
typealias ObjCInitDeviceScreen = @convention(c) (
    AnyObject,
    Selector,
    AnyObject,
    UInt32
) -> AnyObject?
typealias ObjCInitHIDClient = @convention(c) (
    AnyObject,
    Selector,
    AnyObject,
    UnsafeMutablePointer<NSError?>
) -> AnyObject?
typealias ObjCSendHIDMessage = @convention(c) (
    AnyObject,
    Selector,
    UnsafeMutableRawPointer,
    Bool,
    AnyObject?,
    AnyObject?
) -> Void
typealias IndigoMouseMessage = @convention(c) (
    UnsafePointer<CGPoint>,
    UnsafePointer<CGPoint>?,
    UInt32,
    UInt,
    CGFloat,
    CGFloat,
    UInt32
) -> UnsafeMutableRawPointer?

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(2)
}

typealias MTLSetShaderCachePathFunction = @convention(c) (NSString) -> Void

/**
 * Metal normally discovers its shader-cache root through
 * confstr(_CS_DARWIN_USER_CACHE_DIR), which requires the broad dirhelper
 * service. Route it into this Sidecar instance's Host-owned 0700 temp root
 * before SimulatorKit or VideoToolbox initializes instead of opening the
 * user's real cache directory to the sandbox.
 */
func configurePrivateMetalShaderCache() {
    let environment = ProcessInfo.processInfo.environment
    // Unsandboxed correctness harnesses do not provide a private cache root;
    // they retain Metal's normal system cache behavior.
    guard let configuredCacheDirectory = environment[
        "CINDY_IOS_SIDECAR_METAL_CACHE_DIR"
    ] else { return }
    guard let rawTemporaryDirectory = environment["TMPDIR"] else {
        fail("private Metal cache requires TMPDIR")
    }
    let temporaryDirectory = URL(
        fileURLWithPath: rawTemporaryDirectory,
        isDirectory: true
    ).standardizedFileURL
    guard temporaryDirectory.path.hasPrefix("/"),
          temporaryDirectory.path != "/" else {
        fail("private Metal cache requires an absolute private TMPDIR")
    }
    let expectedCacheDirectory = temporaryDirectory.appendingPathComponent(
        "metal-cache",
        isDirectory: true
    ).standardizedFileURL.path
    let cacheDirectory = URL(
        fileURLWithPath: configuredCacheDirectory,
        isDirectory: true
    ).standardizedFileURL.path
    guard cacheDirectory == expectedCacheDirectory else {
        fail("private Metal cache must be inside the Host-owned TMPDIR")
    }

    let metalPath = "/System/Library/Frameworks/Metal.framework/Metal"
    guard let metal = dlopen(metalPath, RTLD_LAZY | RTLD_LOCAL),
          let symbol = dlsym(metal, "MTLSetShaderCachePath") else {
        fail("private Metal cache routing is unavailable")
    }
    let setShaderCachePath = unsafeBitCast(
        symbol,
        to: MTLSetShaderCachePathFunction.self
    )
    setShaderCachePath(cacheDirectory as NSString)
}

func argument(_ name: String) -> String {
    guard let index = CommandLine.arguments.firstIndex(of: name),
          index + 1 < CommandLine.arguments.count else {
        fail("missing argument \(name)")
    }
    return CommandLine.arguments[index + 1]
}

guard CommandLine.arguments.contains("--stdio") else {
    fail("stdio mode is required")
}
let simulatorUdid = argument("--simulator-udid").trimmingCharacters(
    in: .whitespacesAndNewlines
)
guard !simulatorUdid.isEmpty else {
    fail("simulator UDID is required")
}
guard let generation = Int(argument("--generation")), generation > 0 else {
    fail("generation must be a positive integer")
}
configurePrivateMetalShaderCache()

enum FramebufferCaptureError: Error {
    case nativeSymbolsUnavailable
    case deviceUnavailable
    case surfaceUnavailable
    case unsupportedPixelFormat
    case invalidSurface
    case frameTooLarge

    var publicMessage: String {
        switch self {
        case .nativeSymbolsUnavailable:
            return "Native framebuffer symbols are unavailable."
        case .deviceUnavailable:
            return "The exact simulator device is unavailable."
        case .surfaceUnavailable:
            return "The exact simulator framebuffer is unavailable."
        case .unsupportedPixelFormat:
            return "The simulator framebuffer pixel format is unsupported."
        case .invalidSurface:
            return "The simulator framebuffer metadata is invalid."
        case .frameTooLarge:
            return "The simulator framebuffer exceeds the protocol limit."
        }
    }
}

enum H264EncodingError: Error {
    case sessionUnavailable
    case sessionConfigurationFailed(String)
    case pixelBufferUnavailable
    case invalidFrame
    case encodeFailed
    case encodeTimedOut
    case encodedFrameTooLarge

    var publicMessage: String {
        switch self {
        case .sessionUnavailable:
            return "The hardware H.264 encoder is unavailable."
        case .sessionConfigurationFailed(let detail):
            return "The hardware H.264 encoder rejected \(detail)."
        case .pixelBufferUnavailable:
            return "The H.264 input buffer is unavailable."
        case .invalidFrame:
            return "The H.264 encoder returned an invalid access unit."
        case .encodeFailed:
            return "The H.264 encoder failed."
        case .encodeTimedOut:
            return "The H.264 encoder timed out."
        case .encodedFrameTooLarge:
            return "The H.264 access unit exceeds the protocol limit."
        }
    }
}

enum NativeHIDError: Error {
    case symbolsUnavailable
    case clientUnavailable
    case invalidGesture
    case messageUnavailable

    var publicMessage: String {
        switch self {
        case .symbolsUnavailable:
            return "Native HID symbols are unavailable."
        case .clientUnavailable:
            return "Native HID is unavailable for the exact simulator."
        case .invalidGesture:
            return "Native HID gesture parameters are invalid."
        case .messageUnavailable:
            return "Native HID rejected a gesture sample."
        }
    }
}

struct FramebufferMetadata {
    let width: Int
    let height: Int
    let bytesPerRow: Int
    let byteCount: Int
    let screenID: UInt32

    var json: [String: Any] {
        return [
            "width": width,
            "height": height,
            "bytesPerRow": bytesPerRow,
            "byteCount": byteCount,
            "screenId": Int(screenID),
            "pixelFormat": "BGRA"
        ]
    }
}

struct CapturedFramebuffer {
    let metadata: FramebufferMetadata
    let bytes: Data
    let timestampMicros: UInt64
}

struct EncodedH264AccessUnit {
    let bytes: Data
    let width: Int
    let height: Int
    let timestampMicros: UInt64
    let keyFrame: Bool
}

/**
 * Owns one asynchronous VideoToolbox callback. The source-frame refcon keeps
 * this object alive even if an encoder timeout invalidates the session.
 */
final class PendingH264Encoding {
    let width: Int
    let height: Int
    let timestampMicros: UInt64

    private let condition = NSCondition()
    private var completed = false
    private var accessUnit: EncodedH264AccessUnit?
    private var error: H264EncodingError?

    init(width: Int, height: Int, timestampMicros: UInt64) {
        self.width = width
        self.height = height
        self.timestampMicros = timestampMicros
    }

    func complete(
        accessUnit: EncodedH264AccessUnit?,
        error: H264EncodingError?
    ) {
        condition.lock()
        guard !completed else {
            condition.unlock()
            return
        }
        completed = true
        self.accessUnit = accessUnit
        self.error = error
        condition.broadcast()
        condition.unlock()
    }

    func wait(timeout: TimeInterval) throws -> EncodedH264AccessUnit {
        condition.lock()
        let deadline = Date(timeIntervalSinceNow: timeout)
        while !completed && condition.wait(until: deadline) {}
        let finished = completed
        let result = accessUnit
        let failure = error
        condition.unlock()
        guard finished else {
            throw H264EncodingError.encodeTimedOut
        }
        if let failure {
            throw failure
        }
        guard let result else {
            throw H264EncodingError.invalidFrame
        }
        return result
    }
}

func appendAnnexBNal(_ bytes: UnsafeRawBufferPointer, to output: inout Data) {
    output.append(contentsOf: [0, 0, 0, 1])
    output.append(bytes.bindMemory(to: UInt8.self))
}

func isH264KeyFrame(_ sampleBuffer: CMSampleBuffer) -> Bool {
    guard let attachments = CMSampleBufferGetSampleAttachmentsArray(
        sampleBuffer,
        createIfNecessary: false
    ) as? [[CFString: Any]],
        let first = attachments.first else {
        return true
    }
    return (first[kCMSampleAttachmentKey_NotSync] as? Bool) != true
}

func annexBH264Data(
    from sampleBuffer: CMSampleBuffer,
    keyFrame: Bool
) throws -> Data {
    guard CMSampleBufferDataIsReady(sampleBuffer),
          let formatDescription =
            CMSampleBufferGetFormatDescription(sampleBuffer),
          let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else {
        throw H264EncodingError.invalidFrame
    }

    var output = Data()
    var nalUnitHeaderLength: Int32 = 0
    if keyFrame {
        var parameterSetCount = 0
        var parameterSetPointer: UnsafePointer<UInt8>?
        var parameterSetSize = 0
        let firstStatus =
            CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                formatDescription,
                parameterSetIndex: 0,
                parameterSetPointerOut: &parameterSetPointer,
                parameterSetSizeOut: &parameterSetSize,
                parameterSetCountOut: &parameterSetCount,
                nalUnitHeaderLengthOut: &nalUnitHeaderLength
            )
        guard firstStatus == noErr, parameterSetCount >= 2 else {
            throw H264EncodingError.invalidFrame
        }
        for index in 0..<parameterSetCount {
            parameterSetPointer = nil
            parameterSetSize = 0
            let status =
                CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                    formatDescription,
                    parameterSetIndex: index,
                    parameterSetPointerOut: &parameterSetPointer,
                    parameterSetSizeOut: &parameterSetSize,
                    parameterSetCountOut: nil,
                    nalUnitHeaderLengthOut: &nalUnitHeaderLength
                )
            guard status == noErr,
                  let parameterSetPointer,
                  parameterSetSize > 0 else {
                throw H264EncodingError.invalidFrame
            }
            appendAnnexBNal(
                UnsafeRawBufferPointer(
                    start: parameterSetPointer,
                    count: parameterSetSize
                ),
                to: &output
            )
        }
    } else {
        var parameterSetPointer: UnsafePointer<UInt8>?
        var parameterSetSize = 0
        var parameterSetCount = 0
        let status = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            formatDescription,
            parameterSetIndex: 0,
            parameterSetPointerOut: &parameterSetPointer,
            parameterSetSizeOut: &parameterSetSize,
            parameterSetCountOut: &parameterSetCount,
            nalUnitHeaderLengthOut: &nalUnitHeaderLength
        )
        guard status == noErr else {
            throw H264EncodingError.invalidFrame
        }
    }
    guard nalUnitHeaderLength >= 1, nalUnitHeaderLength <= 4 else {
        throw H264EncodingError.invalidFrame
    }

    let blockLength = CMBlockBufferGetDataLength(blockBuffer)
    guard blockLength > 0 else {
        throw H264EncodingError.invalidFrame
    }
    var avccBytes = [UInt8](repeating: 0, count: blockLength)
    let copyStatus = avccBytes.withUnsafeMutableBytes { rawBytes in
        CMBlockBufferCopyDataBytes(
            blockBuffer,
            atOffset: 0,
            dataLength: blockLength,
            destination: rawBytes.baseAddress!
        )
    }
    guard copyStatus == kCMBlockBufferNoErr else {
        throw H264EncodingError.invalidFrame
    }

    var offset = 0
    let headerLength = Int(nalUnitHeaderLength)
    while offset < avccBytes.count {
        guard offset + headerLength <= avccBytes.count else {
            throw H264EncodingError.invalidFrame
        }
        var nalLength = 0
        for byte in avccBytes[offset..<(offset + headerLength)] {
            nalLength = (nalLength << 8) | Int(byte)
        }
        offset += headerLength
        guard nalLength > 0, offset + nalLength <= avccBytes.count else {
            throw H264EncodingError.invalidFrame
        }
        avccBytes.withUnsafeBytes { rawBytes in
            appendAnnexBNal(
                UnsafeRawBufferPointer(
                    rebasing: rawBytes[offset..<(offset + nalLength)]
                ),
                to: &output
            )
        }
        offset += nalLength
    }
    guard !output.isEmpty else {
        throw H264EncodingError.invalidFrame
    }
    return output
}

let h264CompressionOutputCallback: VTCompressionOutputCallback = {
    _, sourceFrameRefCon, status, _, sampleBuffer in
    guard let sourceFrameRefCon else { return }
    let pending = Unmanaged<PendingH264Encoding>
        .fromOpaque(sourceFrameRefCon)
        .takeRetainedValue()
    guard status == noErr, let sampleBuffer else {
        pending.complete(accessUnit: nil, error: .encodeFailed)
        return
    }
    do {
        let keyFrame = isH264KeyFrame(sampleBuffer)
        let bytes = try annexBH264Data(
            from: sampleBuffer,
            keyFrame: keyFrame
        )
        pending.complete(
            accessUnit: EncodedH264AccessUnit(
                bytes: bytes,
                width: pending.width,
                height: pending.height,
                timestampMicros: pending.timestampMicros,
                keyFrame: keyFrame
            ),
            error: nil
        )
    } catch let error as H264EncodingError {
        pending.complete(accessUnit: nil, error: error)
    } catch {
        pending.complete(accessUnit: nil, error: .invalidFrame)
    }
}

/**
 * Synchronous one-frame-at-a-time wrapper around the realtime hardware
 * VideoToolbox encoder. Resolution changes rebuild the session and force IDR.
 */
final class VideoToolboxH264Encoder {
    private var session: VTCompressionSession?
    private var width = 0
    private var height = 0
    private var framesPerSecond = 0
    private var forceNextKeyFrame = true

    deinit {
        invalidate()
    }

    func invalidate() {
        if let session {
            VTCompressionSessionInvalidate(session)
        }
        session = nil
        width = 0
        height = 0
        forceNextKeyFrame = true
    }

    private func setProperty(
        _ name: String,
        _ key: CFString,
        value: CFTypeRef
    ) throws {
        guard let session else {
            throw H264EncodingError.sessionUnavailable
        }
        let status = VTSessionSetProperty(
            session,
            key: key,
            value: value
        )
        guard status == noErr else {
            throw H264EncodingError.sessionConfigurationFailed(
                "\(name) with status \(status)"
            )
        }
    }

    private func rebuild(
        width: Int,
        height: Int,
        framesPerSecond: Int
    ) throws {
        invalidate()
        let encoderSpecification: [CFString: Any] = [
            kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder:
                true,
            kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder:
                true
        ]
        var createdSession: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: Int32(width),
            height: Int32(height),
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: encoderSpecification as CFDictionary,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: h264CompressionOutputCallback,
            refcon: nil,
            compressionSessionOut: &createdSession
        )
        guard status == noErr, let createdSession else {
            throw H264EncodingError.sessionUnavailable
        }
        session = createdSession
        self.width = width
        self.height = height
        self.framesPerSecond = framesPerSecond

        try setProperty(
            "realtime mode",
            kVTCompressionPropertyKey_RealTime,
            value: kCFBooleanTrue
        )
        try setProperty(
            "frame reordering",
            kVTCompressionPropertyKey_AllowFrameReordering,
            value: kCFBooleanFalse
        )
        try setProperty(
            "H.264 profile",
            kVTCompressionPropertyKey_ProfileLevel,
            value: kVTProfileLevel_H264_Main_AutoLevel
        )
        try setProperty(
            "expected frame rate",
            kVTCompressionPropertyKey_ExpectedFrameRate,
            value: NSNumber(value: framesPerSecond)
        )
        try setProperty(
            "keyframe interval",
            kVTCompressionPropertyKey_MaxKeyFrameInterval,
            value: NSNumber(value: max(framesPerSecond * 2, 1))
        )
        let pixelsPerSecond = Int64(width)
            * Int64(height)
            * Int64(framesPerSecond)
        let bitrate = min(
            max(pixelsPerSecond / 8, 1_000_000),
            20_000_000
        )
        try setProperty(
            "average bitrate",
            kVTCompressionPropertyKey_AverageBitRate,
            value: NSNumber(value: bitrate)
        )
        let prepareStatus =
            VTCompressionSessionPrepareToEncodeFrames(createdSession)
        guard prepareStatus == noErr else {
            invalidate()
            throw H264EncodingError.sessionConfigurationFailed(
                "frame preparation with status \(prepareStatus)"
            )
        }
        forceNextKeyFrame = true
    }

    private func pixelBuffer(
        from framebuffer: CapturedFramebuffer,
        scalingPercent: Int,
        orientation: String
    ) throws -> (buffer: CVPixelBuffer, width: Int, height: Int) {
        let metadata = framebuffer.metadata
        let scaledWidth = max(
            2,
            ((metadata.width * scalingPercent / 100) / 2) * 2
        )
        let scaledHeight = max(
            2,
            ((metadata.height * scalingPercent / 100) / 2) * 2
        )
        let outputWidth = orientation == "LANDSCAPE"
            ? scaledHeight
            : scaledWidth
        let outputHeight = orientation == "LANDSCAPE"
            ? scaledWidth
            : scaledHeight
        let attributes: [CFString: Any] = [
            kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary
        ]
        var buffer: CVPixelBuffer?
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            outputWidth,
            outputHeight,
            kCVPixelFormatType_32BGRA,
            attributes as CFDictionary,
            &buffer
        )
        guard status == kCVReturnSuccess, let buffer else {
            throw H264EncodingError.pixelBufferUnavailable
        }
        guard CVPixelBufferLockBaseAddress(buffer, []) == kCVReturnSuccess else {
            throw H264EncodingError.pixelBufferUnavailable
        }
        defer {
            CVPixelBufferUnlockBaseAddress(buffer, [])
        }
        guard let destination = CVPixelBufferGetBaseAddress(buffer) else {
            throw H264EncodingError.pixelBufferUnavailable
        }
        let destinationBytesPerRow = CVPixelBufferGetBytesPerRow(buffer)
        let destinationRowBytes = outputWidth * 4
        guard destinationBytesPerRow >= destinationRowBytes else {
            throw H264EncodingError.pixelBufferUnavailable
        }
        let scaleError = framebuffer.bytes.withUnsafeBytes { source -> vImage_Error in
            guard let sourceBase = source.baseAddress else {
                return kvImageNullPointerArgument
            }
            if orientation == "PORTRAIT" &&
                scaledWidth == metadata.width &&
                scaledHeight == metadata.height {
                let sourceRowBytes = metadata.width * 4
                for row in 0..<metadata.height {
                    memcpy(
                        destination.advanced(
                            by: row * destinationBytesPerRow
                        ),
                        sourceBase.advanced(
                            by: row * metadata.bytesPerRow
                        ),
                        sourceRowBytes
                    )
                }
                return kvImageNoError
            }
            var sourceBuffer = vImage_Buffer(
                data: UnsafeMutableRawPointer(mutating: sourceBase),
                height: vImagePixelCount(metadata.height),
                width: vImagePixelCount(metadata.width),
                rowBytes: metadata.bytesPerRow
            )
            var destinationBuffer = vImage_Buffer(
                data: destination,
                height: vImagePixelCount(outputHeight),
                width: vImagePixelCount(outputWidth),
                rowBytes: destinationBytesPerRow
            )
            if orientation == "LANDSCAPE" {
                var scaledBytes = [UInt8](
                    repeating: 0,
                    count: scaledWidth * scaledHeight * 4
                )
                return scaledBytes.withUnsafeMutableBytes {
                    scaledRaw -> vImage_Error in
                    guard let scaledBase = scaledRaw.baseAddress else {
                        return kvImageNullPointerArgument
                    }
                    var scaledBuffer = vImage_Buffer(
                        data: scaledBase,
                        height: vImagePixelCount(scaledHeight),
                        width: vImagePixelCount(scaledWidth),
                        rowBytes: scaledWidth * 4
                    )
                    let scaleResult = vImageScale_ARGB8888(
                        &sourceBuffer,
                        &scaledBuffer,
                        nil,
                        vImage_Flags(kvImageHighQualityResampling)
                    )
                    guard scaleResult == kvImageNoError else {
                        return scaleResult
                    }
                    let background: [UInt8] = [0, 0, 0, 255]
                    return background.withUnsafeBufferPointer {
                        backgroundPointer in
                        vImageRotate90_ARGB8888(
                            &scaledBuffer,
                            &destinationBuffer,
                            UInt8(kRotate90DegreesClockwise),
                            backgroundPointer.baseAddress!,
                            vImage_Flags(kvImageNoFlags)
                        )
                    }
                }
            }
            return vImageScale_ARGB8888(
                &sourceBuffer,
                &destinationBuffer,
                nil,
                vImage_Flags(kvImageHighQualityResampling)
            )
        }
        guard scaleError == kvImageNoError else {
            throw H264EncodingError.pixelBufferUnavailable
        }
        return (buffer, outputWidth, outputHeight)
    }

    func encode(
        framebuffer: CapturedFramebuffer,
        framesPerSecond: Int,
        scalingPercent: Int = 100,
        orientation: String = "PORTRAIT",
        sequence: Int,
        maxFrameBytes: Int
    ) throws -> EncodedH264AccessUnit {
        let input = try pixelBuffer(
            from: framebuffer,
            scalingPercent: scalingPercent,
            orientation: orientation
        )
        if session == nil ||
            width != input.width ||
            height != input.height ||
            self.framesPerSecond != framesPerSecond {
            try rebuild(
                width: input.width,
                height: input.height,
                framesPerSecond: framesPerSecond
            )
        }
        guard let session else {
            throw H264EncodingError.sessionUnavailable
        }
        let pending = PendingH264Encoding(
            width: input.width,
            height: input.height,
            timestampMicros: framebuffer.timestampMicros
        )
        let sourceFrameRefCon = Unmanaged.passRetained(pending).toOpaque()
        let periodicKeyFrame = sequence % max(framesPerSecond * 2, 1) == 0
        let requireKeyFrame = forceNextKeyFrame || periodicKeyFrame
        let frameProperties: CFDictionary? = requireKeyFrame
            ? [
                kVTEncodeFrameOptionKey_ForceKeyFrame: true
            ] as CFDictionary
            : nil
        var infoFlags = VTEncodeInfoFlags()
        let status = VTCompressionSessionEncodeFrame(
            session,
            imageBuffer: input.buffer,
            presentationTimeStamp: CMTime(
                value: CMTimeValue(framebuffer.timestampMicros),
                timescale: 1_000_000
            ),
            duration: CMTime(
                value: 1,
                timescale: CMTimeScale(framesPerSecond)
            ),
            frameProperties: frameProperties,
            sourceFrameRefcon: sourceFrameRefCon,
            infoFlagsOut: &infoFlags
        )
        guard status == noErr else {
            Unmanaged<PendingH264Encoding>
                .fromOpaque(sourceFrameRefCon)
                .release()
            throw H264EncodingError.encodeFailed
        }
        do {
            let accessUnit = try pending.wait(
                timeout: h264EncodingTimeoutSeconds
            )
            guard accessUnit.bytes.count <= maxFrameBytes,
                  accessUnit.bytes.count <= maxFramebufferBytes else {
                throw H264EncodingError.encodedFrameTooLarge
            }
            if requireKeyFrame && !accessUnit.keyFrame {
                throw H264EncodingError.invalidFrame
            }
            forceNextKeyFrame = false
            return accessUnit
        } catch {
            if error is H264EncodingError {
                invalidate()
            }
            throw error
        }
    }
}

final class NativeFrameStreamState {
    let streamID: String
    let framesPerSecond: Int
    let maxFrames: Int
    let maxFrameBytes: Int
    let scalingPercent: Int
    let orientation: String

    private let condition = NSCondition()
    private var cancelled = false
    private var waitingForSequence: Int?
    private var acknowledgedSequence = -1

    init(
        streamID: String,
        framesPerSecond: Int,
        maxFrames: Int,
        maxFrameBytes: Int,
        scalingPercent: Int = 100,
        orientation: String = "PORTRAIT"
    ) {
        self.streamID = streamID
        self.framesPerSecond = framesPerSecond
        self.maxFrames = maxFrames
        self.maxFrameBytes = maxFrameBytes
        self.scalingPercent = scalingPercent
        self.orientation = orientation
    }

    func cancel() {
        condition.lock()
        cancelled = true
        condition.broadcast()
        condition.unlock()
    }

    func waitUntil(uptimeNanoseconds: UInt64) -> Bool {
        condition.lock()
        defer { condition.unlock() }
        while !cancelled {
            let now = DispatchTime.now().uptimeNanoseconds
            if now >= uptimeNanoseconds {
                return true
            }
            let remaining = Double(uptimeNanoseconds - now) / 1_000_000_000
            condition.wait(until: Date(timeIntervalSinceNow: remaining))
        }
        return false
    }

    func beginWaitingForAcknowledgement(sequence: Int) -> Bool {
        condition.lock()
        defer { condition.unlock() }
        guard !cancelled,
              waitingForSequence == nil,
              sequence == acknowledgedSequence + 1 else {
            return false
        }
        waitingForSequence = sequence
        return true
    }

    func canAcknowledge(sequence: Int) -> Bool {
        condition.lock()
        defer { condition.unlock() }
        return !cancelled && waitingForSequence == sequence
    }

    func acknowledge(sequence: Int) {
        condition.lock()
        if !cancelled && waitingForSequence == sequence {
            acknowledgedSequence = sequence
            waitingForSequence = nil
            condition.broadcast()
        }
        condition.unlock()
    }

    func waitForAcknowledgement(sequence: Int) -> Bool {
        condition.lock()
        defer { condition.unlock() }
        while !cancelled && acknowledgedSequence < sequence {
            condition.wait()
        }
        return !cancelled && acknowledgedSequence == sequence
    }
}

struct NativeTouchSample {
    let x: Double
    let y: Double
    let phase: String
    let delayMilliseconds: Int
    let edge: UInt32
}

final class NativeGestureState {
    let streamID: String

    private let condition = NSCondition()
    private var cancelled = false
    private var completed = false

    init(streamID: String) {
        self.streamID = streamID
    }

    func cancel() {
        condition.lock()
        cancelled = true
        condition.broadcast()
        condition.unlock()
    }

    func wait(milliseconds: Int) -> Bool {
        condition.lock()
        defer { condition.unlock() }
        let deadline = Date(
            timeIntervalSinceNow: Double(milliseconds) / 1_000
        )
        while !cancelled && Date() < deadline {
            condition.wait(until: deadline)
        }
        return !cancelled
    }

    func markCompleted() {
        condition.lock()
        completed = true
        condition.broadcast()
        condition.unlock()
    }

    func waitForCompletion(timeoutMilliseconds: Int) -> Bool {
        condition.lock()
        defer { condition.unlock() }
        let deadline = Date(
            timeIntervalSinceNow: Double(timeoutMilliseconds) / 1_000
        )
        while !completed && Date() < deadline {
            condition.wait(until: deadline)
        }
        return completed
    }
}

final class NativeLiveGestureState {
    let gestureID: String
    let edge: UInt32
    let startedAt = Date()
    var lastSample: NativeTouchSample
    var moveCount = 0

    init(gestureID: String, sample: NativeTouchSample) {
        self.gestureID = gestureID
        self.edge = sample.edge
        self.lastSample = sample
    }
}

struct NativeProbe {
    let coreSimulatorLoaded: Bool
    let simulatorKitLoaded: Bool
    let deviceDiscovery: Bool
    let framebufferSymbols: Bool
    let framebufferCapture: Bool
    let framebuffer: FramebufferMetadata?
    let hid: Bool

    var json: [String: Any] {
        let framebufferValue: Any = framebuffer.map {
            $0.json
        } ?? NSNull()
        return [
            "coreSimulatorLoaded": coreSimulatorLoaded,
            "simulatorKitLoaded": simulatorKitLoaded,
            "deviceDiscovery": deviceDiscovery,
            "framebufferSymbols": framebufferSymbols,
            "framebufferCapture": framebufferCapture,
            "framebuffer": framebufferValue,
            "hid": hid
        ]
    }
}

struct FrameworkProbe {
    let coreSimulatorLoaded: Bool
    let simulatorKitLoaded: Bool
    let deviceDiscovery: Bool
    let framebufferSymbols: Bool
    let hid: Bool
}

struct NativeProductStreamProfile: Equatable {
    let framesPerSecond: Int
    let scalingPercent: Int
    let orientation: String
}

func methodImplementation(
    _ cls: AnyClass,
    _ selector: Selector,
    classMethod: Bool = false
) -> IMP? {
    let method = classMethod
        ? class_getClassMethod(cls, selector)
        : class_getInstanceMethod(cls, selector)
    guard let method else { return nil }
    return method_getImplementation(method)
}

func exactSimulatorDevice() throws -> AnyObject {
    guard let serviceContextClass = NSClassFromString("SimServiceContext"),
          let sharedImplementation = methodImplementation(
              serviceContextClass,
              NSSelectorFromString("sharedServiceContextForDeveloperDir:error:"),
              classMethod: true
          ),
          let defaultSetImplementation = methodImplementation(
              serviceContextClass,
              NSSelectorFromString("defaultDeviceSetWithError:")
          ) else {
        throw FramebufferCaptureError.nativeSymbolsUnavailable
    }
    let sharedSelector = NSSelectorFromString(
        "sharedServiceContextForDeveloperDir:error:"
    )
    let shared = unsafeBitCast(
        sharedImplementation,
        to: ObjCClassTwoObjectArgs.self
    )
    let developerDir = ProcessInfo.processInfo.environment["DEVELOPER_DIR"]
        ?? "/Applications/Xcode.app/Contents/Developer"
    var error: NSError?
    guard let context = shared(
        serviceContextClass,
        sharedSelector,
        developerDir as NSString,
        &error
    ) else {
        throw FramebufferCaptureError.deviceUnavailable
    }
    let defaultSetSelector = NSSelectorFromString("defaultDeviceSetWithError:")
    let defaultSet = unsafeBitCast(
        defaultSetImplementation,
        to: ObjCObjectErrorArg.self
    )
    guard let deviceSet = defaultSet(
        context,
        defaultSetSelector,
        &error
    ),
        let devicesImplementation = methodImplementation(
            type(of: deviceSet),
            NSSelectorFromString("devicesByUDID")
        ) else {
        throw FramebufferCaptureError.deviceUnavailable
    }
    let devicesSelector = NSSelectorFromString("devicesByUDID")
    let devicesGetter = unsafeBitCast(
        devicesImplementation,
        to: ObjCObjectNoArgs.self
    )
    guard let devices = devicesGetter(
        deviceSet,
        devicesSelector
    ) as? NSDictionary else {
        throw FramebufferCaptureError.deviceUnavailable
    }
    let normalizedUdid = simulatorUdid.uppercased()
    guard let device = devices.first(where: { key, _ in
        String(describing: key).uppercased() == normalizedUdid
    })?.value as AnyObject? else {
        throw FramebufferCaptureError.deviceUnavailable
    }
    return device
}

final class NativeHIDInjector {
    private let client: AnyObject
    private let sendSelector = NSSelectorFromString(
        "sendWithMessage:freeWhenDone:completionQueue:completion:"
    )
    private let sendMessage: ObjCSendHIDMessage
    private let mouseMessage: IndigoMouseMessage
    private let lock = NSLock()

    init(device: AnyObject) throws {
        guard let mouseSymbol = dlsym(
            UnsafeMutableRawPointer(bitPattern: -2),
            "IndigoHIDMessageForMouseNSEvent"
        ),
            let clientClass = NSClassFromString(
                "_TtC12SimulatorKit24SimDeviceLegacyHIDClient"
            ),
            let allocateImplementation = methodImplementation(
                clientClass,
                NSSelectorFromString("alloc"),
                classMethod: true
            ),
            let initializeImplementation = methodImplementation(
                clientClass,
                NSSelectorFromString("initWithDevice:error:")
            ) else {
            throw NativeHIDError.symbolsUnavailable
        }
        let allocate = unsafeBitCast(
            allocateImplementation,
            to: ObjCAlloc.self
        )
        let initialize = unsafeBitCast(
            initializeImplementation,
            to: ObjCInitHIDClient.self
        )
        let allocated = allocate(
            clientClass,
            NSSelectorFromString("alloc")
        )
        var error: NSError?
        guard let client = initialize(
            allocated,
            NSSelectorFromString("initWithDevice:error:"),
            device,
            &error
        ),
            let sendImplementation = methodImplementation(
                type(of: client),
                sendSelector
            ) else {
            throw NativeHIDError.clientUnavailable
        }
        self.client = client
        self.sendMessage = unsafeBitCast(
            sendImplementation,
            to: ObjCSendHIDMessage.self
        )
        self.mouseMessage = unsafeBitCast(
            mouseSymbol,
            to: IndigoMouseMessage.self
        )
    }

    func send(
        first: NativeTouchSample,
        second: NativeTouchSample? = nil
    ) throws {
        let eventType: UInt
        switch first.phase {
        case "down", "move":
            // SimulatorKit maintains contact state internally. Repeated
            // left-mouse-down samples are its supported continuous-touch path.
            eventType = 1
        case "up", "cancel":
            eventType = 2
        default:
            throw NativeHIDError.invalidGesture
        }
        if let second, second.phase != first.phase {
            throw NativeHIDError.invalidGesture
        }
        var firstPoint = CGPoint(x: first.x, y: first.y)
        let message: UnsafeMutableRawPointer?
        if var secondPoint = second.map({ CGPoint(x: $0.x, y: $0.y) }) {
            message = withUnsafePointer(to: &secondPoint) { secondPointer in
                mouseMessage(
                    &firstPoint,
                    secondPointer,
                    0x32,
                    eventType,
                    1,
                    1,
                    0
                )
            }
        } else {
            message = mouseMessage(
                &firstPoint,
                nil,
                0x32,
                eventType,
                1,
                1,
                first.edge
            )
        }
        guard let message else {
            throw NativeHIDError.messageUnavailable
        }
        lock.lock()
        sendMessage(
            client,
            sendSelector,
            message,
            true,
            nil,
            nil
        )
        lock.unlock()
    }

    func releaseStaleContact() throws {
        try send(
            first: NativeTouchSample(
                x: 0.5,
                y: 0.5,
                phase: "cancel",
                delayMilliseconds: 0,
                edge: 0
            )
        )
    }
}

func captureFramebuffer(
    surface: IOSurfaceRef,
    screenID: UInt32,
    maxFrameBytes: Int
) throws -> CapturedFramebuffer {
    let width = IOSurfaceGetWidth(surface)
    let height = IOSurfaceGetHeight(surface)
    let bytesPerRow = IOSurfaceGetBytesPerRow(surface)
    let allocationSize = IOSurfaceGetAllocSize(surface)
    guard width > 0,
          height > 0,
          width <= 8_192,
          height <= 8_192,
          bytesPerRow >= width * 4,
          bytesPerRow <= 64 * 1_024 else {
        throw FramebufferCaptureError.invalidSurface
    }
    let (byteCount, overflow) = bytesPerRow.multipliedReportingOverflow(
        by: height
    )
    guard !overflow,
          byteCount > 0,
          byteCount <= allocationSize else {
        throw FramebufferCaptureError.invalidSurface
    }
    guard IOSurfaceGetPixelFormat(surface) == bgraPixelFormat else {
        throw FramebufferCaptureError.unsupportedPixelFormat
    }
    guard byteCount <= maxFrameBytes,
          byteCount <= maxFramebufferBytes else {
        throw FramebufferCaptureError.frameTooLarge
    }
    let lockStatus = IOSurfaceLock(surface, [.readOnly], nil)
    guard lockStatus == kIOReturnSuccess else {
        throw FramebufferCaptureError.surfaceUnavailable
    }
    defer {
        IOSurfaceUnlock(surface, [.readOnly], nil)
    }
    let baseAddress = IOSurfaceGetBaseAddress(surface)
    let bytes = Data(bytes: baseAddress, count: byteCount)
    let captured = CapturedFramebuffer(
        metadata: FramebufferMetadata(
            width: width,
            height: height,
            bytesPerRow: bytesPerRow,
            byteCount: byteCount,
            screenID: screenID
        ),
        bytes: bytes,
        timestampMicros: DispatchTime.now().uptimeNanoseconds / 1_000
    )
    return captured
}

func probeNativeFrameworks() -> FrameworkProbe {
    let serviceContextClass = NSClassFromString("SimServiceContext")
    let deviceSetClass = NSClassFromString("SimDeviceSet")
    let screenClass = NSClassFromString(
        "_TtC12SimulatorKit15SimDeviceScreen"
    )
    let deviceDiscovery = serviceContextClass != nil
        && deviceSetClass != nil
    let framebufferSymbols = screenClass.map {
        class_getInstanceMethod(
            $0,
            NSSelectorFromString("initWithDevice:screenID:")
        ) != nil
    } ?? false
    let hidClass = NSClassFromString(
        "_TtC12SimulatorKit24SimDeviceLegacyHIDClient"
    )
    let hidSymbols = dlsym(
        UnsafeMutableRawPointer(bitPattern: -2),
        "IndigoHIDMessageForMouseNSEvent"
    ) != nil
        && hidClass.map {
            class_getInstanceMethod(
                $0,
                NSSelectorFromString("initWithDevice:error:")
            ) != nil
                && class_getInstanceMethod(
                    $0,
                    NSSelectorFromString(
                        "sendWithMessage:freeWhenDone:completionQueue:completion:"
                    )
                ) != nil
        } ?? false
    return FrameworkProbe(
        coreSimulatorLoaded: serviceContextClass != nil,
        simulatorKitLoaded: screenClass != nil,
        deviceDiscovery: deviceDiscovery,
        framebufferSymbols: framebufferSymbols,
        hid: hidSymbols
    )
}

func uint32LE(_ data: Data, _ offset: Int) -> Int {
    Int(data[offset])
        | (Int(data[offset + 1]) << 8)
        | (Int(data[offset + 2]) << 16)
        | (Int(data[offset + 3]) << 24)
}

func framedData(kind: UInt8, body: Data) -> Data {
    guard body.count <= maxBodyBytes else {
        fail("unable to encode response")
    }
    var output = Data()
    let length = UInt32(body.count)
    output.append(UInt8(length & 0xff))
    output.append(UInt8((length >> 8) & 0xff))
    output.append(UInt8((length >> 16) & 0xff))
    output.append(UInt8((length >> 24) & 0xff))
    output.append(kind)
    output.append(body)
    return output
}

func framedJSON(_ value: [String: Any], kind: UInt8 = 1) -> Data {
    guard JSONSerialization.isValidJSONObject(value),
          let body = try? JSONSerialization.data(withJSONObject: value) else {
        fail("unable to encode response")
    }
    return framedData(kind: kind, body: body)
}

func response(
    id: String,
    result: [String: Any]? = nil,
    error: [String: Any]? = nil
) -> Data {
    var value: [String: Any] = ["id": id]
    if let result {
        value["ok"] = true
        value["result"] = result
    } else {
        value["ok"] = false
        value["error"] = error
            ?? ["code": "UNSUPPORTED", "message": "unsupported operation"]
    }
    return framedJSON(value)
}

func streamFrame(
    streamID: String,
    sequence: Int,
    framebuffer: CapturedFramebuffer
) -> Data {
    let metadata = framebuffer.metadata
    let value: [String: Any] = [
        "streamId": streamID,
        "simulatorUdid": simulatorUdid,
        "generation": generation,
        "sequence": sequence,
        "encoding": "bgra",
        "width": metadata.width,
        "height": metadata.height,
        "orientation": metadata.width <= metadata.height
            ? "PORTRAIT"
            : "LANDSCAPE",
        "scale": 1,
        "colorSpace": "unknown",
        "timestampMicros": framebuffer.timestampMicros,
        "bytesPerRow": metadata.bytesPerRow
    ]
    guard JSONSerialization.isValidJSONObject(value),
          let metadataBytes = try? JSONSerialization.data(
              withJSONObject: value
          ),
          metadataBytes.count <= maxMetadataBytes else {
        fail("unable to encode frame metadata")
    }
    var body = Data()
    let metadataLength = UInt32(metadataBytes.count)
    body.append(UInt8(metadataLength & 0xff))
    body.append(UInt8((metadataLength >> 8) & 0xff))
    body.append(UInt8((metadataLength >> 16) & 0xff))
    body.append(UInt8((metadataLength >> 24) & 0xff))
    body.append(metadataBytes)
    body.append(framebuffer.bytes)
    return framedData(kind: 3, body: body)
}

func streamFrame(
    streamID: String,
    sequence: Int,
    accessUnit: EncodedH264AccessUnit
) -> Data {
    let value: [String: Any] = [
        "streamId": streamID,
        "simulatorUdid": simulatorUdid,
        "generation": generation,
        "sequence": sequence,
        "encoding": "h264",
        "h264Format": "annex-b",
        "width": accessUnit.width,
        "height": accessUnit.height,
        "orientation": accessUnit.width <= accessUnit.height
            ? "PORTRAIT"
            : "LANDSCAPE",
        "scale": 1,
        "colorSpace": "unknown",
        "timestampMicros": accessUnit.timestampMicros,
        "keyFrame": accessUnit.keyFrame
    ]
    guard JSONSerialization.isValidJSONObject(value),
          let metadataBytes = try? JSONSerialization.data(
              withJSONObject: value
          ),
          metadataBytes.count <= maxMetadataBytes else {
        fail("unable to encode frame metadata")
    }
    var body = Data()
    let metadataLength = UInt32(metadataBytes.count)
    body.append(UInt8(metadataLength & 0xff))
    body.append(UInt8((metadataLength >> 8) & 0xff))
    body.append(UInt8((metadataLength >> 16) & 0xff))
    body.append(UInt8((metadataLength >> 24) & 0xff))
    body.append(metadataBytes)
    body.append(accessUnit.bytes)
    return framedData(kind: 3, body: body)
}

func streamEnd(
    streamID: String,
    reason: String,
    message: String? = nil
) -> Data {
    var value: [String: Any] = [
        "streamId": streamID,
        "simulatorUdid": simulatorUdid,
        "generation": generation,
        "reason": reason
    ]
    if let message {
        value["message"] = message
    }
    return framedJSON(value, kind: 4)
}

let outputLock = NSLock()
func write(_ data: Data) {
    outputLock.lock()
    defer { outputLock.unlock() }
    FileHandle.standardOutput.write(data)
}

func jsonNumber(_ value: Any?) -> NSNumber? {
    guard let number = value as? NSNumber,
          CFGetTypeID(number) != CFBooleanGetTypeID() else {
        return nil
    }
    return number
}

func touchEdge(_ value: Any?) throws -> UInt32 {
    switch value as? String ?? "none" {
    case "none":
        return 0
    case "left":
        return 1
    case "top":
        return 2
    case "bottom":
        return 3
    case "right":
        return 4
    default:
        throw NativeHIDError.invalidGesture
    }
}

func touchPath(_ value: Any?) throws -> [NativeTouchSample] {
    guard let points = value as? [[String: Any]],
          points.count >= 2,
          points.count <= maxGestureSamples else {
        throw NativeHIDError.invalidGesture
    }
    var samples: [NativeTouchSample] = []
    samples.reserveCapacity(points.count)
    var durationMilliseconds = 0
    var gestureEdge: UInt32?
    for (index, point) in points.enumerated() {
        guard let x = jsonNumber(point["x"])?.doubleValue,
              let y = jsonNumber(point["y"])?.doubleValue,
              x.isFinite,
              y.isFinite,
              x >= 0,
              x <= 1,
              y >= 0,
              y <= 1,
              let phase = point["phase"] as? String,
              let rawDelay = jsonNumber(point["dtMs"])?.doubleValue,
              rawDelay.isFinite,
              rawDelay.rounded() == rawDelay,
              rawDelay >= 0,
              rawDelay <= Double(maxGestureDurationMilliseconds) else {
            throw NativeHIDError.invalidGesture
        }
        let delayMilliseconds = Int(rawDelay)
        if index == 0 {
            guard phase == "down", delayMilliseconds == 0 else {
                throw NativeHIDError.invalidGesture
            }
        } else if index == points.count - 1 {
            guard phase == "up" || phase == "cancel" else {
                throw NativeHIDError.invalidGesture
            }
        } else {
            guard phase == "move", delayMilliseconds >= 4 else {
                throw NativeHIDError.invalidGesture
            }
        }
        durationMilliseconds += delayMilliseconds
        guard durationMilliseconds <= maxGestureDurationMilliseconds else {
            throw NativeHIDError.invalidGesture
        }
        let edge = try touchEdge(point["edge"])
        gestureEdge = gestureEdge ?? edge
        guard edge == gestureEdge else {
            throw NativeHIDError.invalidGesture
        }
        samples.append(
            NativeTouchSample(
                x: x,
                y: y,
                phase: phase,
                delayMilliseconds: delayMilliseconds,
                edge: edge
            )
        )
    }
    return samples
}

func liveTouchSample(
    _ value: Any?,
    phase: String,
    expectedEdge: UInt32? = nil
) throws -> NativeTouchSample {
    guard let point = value as? [String: Any],
          let x = jsonNumber(point["x"])?.doubleValue,
          let y = jsonNumber(point["y"])?.doubleValue,
          x.isFinite,
          y.isFinite,
          x >= 0,
          x <= 1,
          y >= 0,
          y <= 1 else {
        throw NativeHIDError.invalidGesture
    }
    let edge = try touchEdge(point["edge"])
    if let expectedEdge, edge != expectedEdge {
        throw NativeHIDError.invalidGesture
    }
    return NativeTouchSample(
        x: x,
        y: y,
        phase: phase,
        delayMilliseconds: 0,
        edge: edge
    )
}

func liveGestureID(_ value: Any?) throws -> String {
    guard let raw = value as? String else {
        throw NativeHIDError.invalidGesture
    }
    let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !value.isEmpty,
          value.utf8.count <= 128,
          value.unicodeScalars.allSatisfy({
              CharacterSet.alphanumerics.contains($0)
                  || CharacterSet(charactersIn: "._:-").contains($0)
          }) else {
        throw NativeHIDError.invalidGesture
    }
    return value
}

func synchronizedTouchPaths(
    firstValue: Any?,
    secondValue: Any?
) throws -> ([NativeTouchSample], [NativeTouchSample]) {
    let first = try touchPath(firstValue)
    let second = try touchPath(secondValue)
    guard first.count == second.count else {
        throw NativeHIDError.invalidGesture
    }
    for index in first.indices {
        guard first[index].phase == second[index].phase,
              first[index].delayMilliseconds
                == second[index].delayMilliseconds,
              first[index].edge == 0,
              second[index].edge == 0 else {
            throw NativeHIDError.invalidGesture
        }
    }
    return (first, second)
}

let streamRegistryLock = NSLock()
var activeFrameStream: NativeFrameStreamState?
let gestureRegistryLock = NSLock()
var currentGesture: NativeGestureState?
var currentLiveGesture: NativeLiveGestureState?
let framebufferCaptureLock = NSLock()

func captureCurrentFramebuffer(
    screen: AnyObject,
    screenID: UInt32,
    maxFrameBytes: Int
) throws -> CapturedFramebuffer {
    framebufferCaptureLock.lock()
    defer { framebufferCaptureLock.unlock() }
    guard let surface = simulatorKitUnmaskedSurface(screen) else {
        throw FramebufferCaptureError.surfaceUnavailable
    }
    return try captureFramebuffer(
        surface: surface,
        screenID: screenID,
        maxFrameBytes: maxFrameBytes
    )
}

func activeStream(withID streamID: String) -> NativeFrameStreamState? {
    streamRegistryLock.lock()
    defer { streamRegistryLock.unlock() }
    guard activeFrameStream?.streamID == streamID else {
        return nil
    }
    return activeFrameStream
}

func finishFrameStream(_ state: NativeFrameStreamState) {
    streamRegistryLock.lock()
    if activeFrameStream === state {
        activeFrameStream = nil
    }
    streamRegistryLock.unlock()
}

func activeGesture(withID streamID: String) -> NativeGestureState? {
    gestureRegistryLock.lock()
    defer { gestureRegistryLock.unlock() }
    guard currentGesture?.streamID == streamID else {
        return nil
    }
    return currentGesture
}

func reserveGesture(_ state: NativeGestureState) -> Bool {
    gestureRegistryLock.lock()
    defer { gestureRegistryLock.unlock() }
    guard currentGesture == nil, currentLiveGesture == nil else { return false }
    currentGesture = state
    return true
}

func finishGesture(_ state: NativeGestureState) {
    gestureRegistryLock.lock()
    if currentGesture === state {
        currentGesture = nil
    }
    gestureRegistryLock.unlock()
}

func reserveLiveGesture(_ state: NativeLiveGestureState) -> Bool {
    gestureRegistryLock.lock()
    defer { gestureRegistryLock.unlock() }
    guard currentGesture == nil, currentLiveGesture == nil else { return false }
    currentLiveGesture = state
    return true
}

func liveGesture(withID gestureID: String) -> NativeLiveGestureState? {
    gestureRegistryLock.lock()
    defer { gestureRegistryLock.unlock() }
    guard currentLiveGesture?.gestureID == gestureID else { return nil }
    return currentLiveGesture
}

func finishLiveGesture(_ state: NativeLiveGestureState) {
    gestureRegistryLock.lock()
    if currentLiveGesture === state {
        currentLiveGesture = nil
    }
    gestureRegistryLock.unlock()
}

func cancelLiveGesture(
    _ state: NativeLiveGestureState,
    injector: NativeHIDInjector
) {
    let last = state.lastSample
    try? injector.send(
        first: NativeTouchSample(
            x: last.x,
            y: last.y,
            phase: "cancel",
            delayMilliseconds: 0,
            edge: last.edge
        )
    )
    finishLiveGesture(state)
}

func runGesture(
    state: NativeGestureState,
    injector: NativeHIDInjector,
    first: [NativeTouchSample],
    second: [NativeTouchSample]? = nil
) {
    var reason = "max-frames"
    var message: String?
    var contactActive = false
    var lastFirst = first[0]
    var lastSecond = second?[0]

    defer {
        if contactActive {
            let releaseFirst = NativeTouchSample(
                x: lastFirst.x,
                y: lastFirst.y,
                phase: "cancel",
                delayMilliseconds: 0,
                edge: lastFirst.edge
            )
            let releaseSecond = lastSecond.map {
                NativeTouchSample(
                    x: $0.x,
                    y: $0.y,
                    phase: "cancel",
                    delayMilliseconds: 0,
                    edge: $0.edge
                )
            }
            try? injector.send(
                first: releaseFirst,
                second: releaseSecond
            )
        }
        finishGesture(state)
        write(
            streamEnd(
                streamID: state.streamID,
                reason: reason,
                message: message
            )
        )
        state.markCompleted()
    }

    do {
        for index in first.indices {
            let firstSample = first[index]
            let secondSample = second?[index]
            guard state.wait(
                milliseconds: firstSample.delayMilliseconds
            ) else {
                reason = "aborted"
                return
            }
            try injector.send(
                first: firstSample,
                second: secondSample
            )
            lastFirst = firstSample
            lastSecond = secondSample
            contactActive =
                firstSample.phase != "up"
                && firstSample.phase != "cancel"
        }
    } catch let error as NativeHIDError {
        reason = "error"
        message = error.publicMessage
    } catch {
        reason = "error"
        message = "Native HID gesture failed."
    }
}

func runCorrectnessStream(
    state: NativeFrameStreamState,
    screen: AnyObject,
    screenID: UInt32
) {
    let startedAt = DispatchTime.now().uptimeNanoseconds
    let frameInterval = UInt64(
        1_000_000_000 / state.framesPerSecond
    )
    var reason = "max-frames"
    var message: String?

    do {
        for sequence in 0..<state.maxFrames {
            let target = startedAt + UInt64(sequence) * frameInterval
            guard state.waitUntil(uptimeNanoseconds: target) else {
                reason = "aborted"
                break
            }
            let captured = try captureCurrentFramebuffer(
                screen: screen,
                screenID: screenID,
                maxFrameBytes: state.maxFrameBytes
            )
            guard state.beginWaitingForAcknowledgement(
                sequence: sequence
            ) else {
                reason = "aborted"
                break
            }
            write(streamFrame(
                streamID: state.streamID,
                sequence: sequence,
                framebuffer: captured
            ))
            guard state.waitForAcknowledgement(sequence: sequence) else {
                reason = "aborted"
                break
            }
        }
    } catch let error as FramebufferCaptureError {
        reason = "error"
        message = error.publicMessage
    } catch {
        reason = "error"
        message = "Native framebuffer correctness stream failed."
    }

    finishFrameStream(state)
    write(streamEnd(
        streamID: state.streamID,
        reason: reason,
        message: message
    ))
}

func runH264Stream(
    state: NativeFrameStreamState,
    screen: AnyObject,
    screenID: UInt32,
    failureMessage: String
) {
    let startedAt = DispatchTime.now().uptimeNanoseconds
    let frameInterval = UInt64(
        1_000_000_000 / state.framesPerSecond
    )
    let encoder = VideoToolboxH264Encoder()
    var reason = "max-frames"
    var message: String?

    do {
        for sequence in 0..<state.maxFrames {
            let target = startedAt + UInt64(sequence) * frameInterval
            guard state.waitUntil(uptimeNanoseconds: target) else {
                reason = "aborted"
                break
            }
            let captured = try captureCurrentFramebuffer(
                screen: screen,
                screenID: screenID,
                maxFrameBytes: maxFramebufferBytes
            )
            let accessUnit = try encoder.encode(
                framebuffer: captured,
                framesPerSecond: state.framesPerSecond,
                scalingPercent: state.scalingPercent,
                orientation: state.orientation,
                sequence: sequence,
                maxFrameBytes: state.maxFrameBytes
            )
            guard state.beginWaitingForAcknowledgement(
                sequence: sequence
            ) else {
                reason = "aborted"
                break
            }
            write(streamFrame(
                streamID: state.streamID,
                sequence: sequence,
                accessUnit: accessUnit
            ))
            guard state.waitForAcknowledgement(sequence: sequence) else {
                reason = "aborted"
                break
            }
        }
    } catch let error as FramebufferCaptureError {
        reason = "error"
        message = error.publicMessage
    } catch let error as H264EncodingError {
        reason = "error"
        message = error.publicMessage
    } catch {
        reason = "error"
        message = failureMessage
    }

    encoder.invalidate()
    finishFrameStream(state)
    write(streamEnd(
        streamID: state.streamID,
        reason: reason,
        message: message
    ))
}

let frameworkProbe = probeNativeFrameworks()
let retainedExactSimulatorDevice = try? exactSimulatorDevice()
let nativeHIDInjector: NativeHIDInjector?
if productHIDRequested,
   frameworkProbe.hid,
   let device = retainedExactSimulatorDevice {
    nativeHIDInjector = try? NativeHIDInjector(device: device)
} else {
    nativeHIDInjector = nil
}
var retainedFramebufferScreen: AnyObject?
var retainedFramebufferScreenID: UInt32?
var initialFramebufferSurface: IOSurfaceRef?
if frameworkProbe.framebufferSymbols,
   let device = retainedExactSimulatorDevice,
   let screenClass = NSClassFromString(
       "_TtC12SimulatorKit15SimDeviceScreen"
   ),
   let allocateImplementation = methodImplementation(
       screenClass,
       NSSelectorFromString("alloc"),
       classMethod: true
   ),
   let initializeImplementation = methodImplementation(
       screenClass,
       NSSelectorFromString("initWithDevice:screenID:")
   ) {
    let allocSelector = NSSelectorFromString("alloc")
    let allocate = unsafeBitCast(
        allocateImplementation,
        to: ObjCAlloc.self
    )
    let initSelector = NSSelectorFromString("initWithDevice:screenID:")
    let initialize = unsafeBitCast(
        initializeImplementation,
        to: ObjCInitDeviceScreen.self
    )
    let screenIDs = Array(UInt32(0)...maxScreenID)
    screenDiscovery: for screenID in screenIDs {
        let allocated = allocate(screenClass, allocSelector)
        guard let screen = initialize(
            allocated,
            initSelector,
            device,
            screenID
        ) else {
            continue
        }
        retainedFramebufferScreen = screen
        let attempts = screenID == 1 ? 80 : 8
        Thread.sleep(forTimeInterval: 0.05)
        for _ in 0..<attempts {
            guard let retainedScreen = retainedFramebufferScreen else {
                break
            }
            if let surface = simulatorKitUnmaskedSurface(retainedScreen) {
                retainedFramebufferScreenID = screenID
                initialFramebufferSurface = surface
                break screenDiscovery
            }
            Thread.sleep(forTimeInterval: 0.025)
        }
        retainedFramebufferScreen = nil
    }
}
let initialCapture: CapturedFramebuffer?
if let surface = initialFramebufferSurface,
   let screenID = retainedFramebufferScreenID {
    initialCapture = try? captureFramebuffer(
        surface: surface,
        screenID: screenID,
        maxFrameBytes: maxFramebufferBytes
    )
} else {
    initialCapture = nil
}
let nativeProbe = NativeProbe(
    coreSimulatorLoaded: frameworkProbe.coreSimulatorLoaded,
    simulatorKitLoaded: frameworkProbe.simulatorKitLoaded,
    deviceDiscovery: frameworkProbe.deviceDiscovery,
    framebufferSymbols: frameworkProbe.framebufferSymbols,
    framebufferCapture: initialCapture != nil,
    framebuffer: initialCapture?.metadata,
    hid: nativeHIDInjector != nil
)
let productH264Enabled = productH264Requested
    && nativeProbe.framebufferCapture
var configuredProductH264Profile: NativeProductStreamProfile?
let capabilities: [String: Any] = [
    "accessibility": false,
    "sessions": false,
    "jpegStream": false,
    "h264Stream": productH264Enabled,
    "bgraStream": false,
    "discreteInput": false,
    "continuousInput": nativeProbe.hid,
    "multiTouch": nativeProbe.hid
]
let readinessMessage = nativeProbe.framebufferCapture
    ? "Native framebuffer single-frame capture is ready."
    : "Native framebuffer single-frame capture is unavailable."

var input = Data()
while true {
    var bytes = [UInt8](repeating: 0, count: 64 * 1024)
    let count = read(STDIN_FILENO, &bytes, bytes.count)
    if count <= 0 {
        if let live = currentLiveGesture, let injector = nativeHIDInjector {
            cancelLiveGesture(live, injector: injector)
        }
        exit(0)
    }
    input.append(contentsOf: bytes[0..<count])
    while input.count >= 5 {
        let bodyLength = uint32LE(input, 0)
        guard bodyLength >= 0 && bodyLength <= maxBodyBytes else {
            fail("frame length exceeds limit")
        }
        let total = 5 + bodyLength
        guard input.count >= total else { break }
        let kind = input[4]
        let body = input.subdata(in: 5..<total)
        input.removeSubrange(0..<total)
        guard kind == 1,
              let object = try? JSONSerialization.jsonObject(
                  with: body
              ) as? [String: Any],
              let id = object["id"] as? String,
              let op = object["op"] as? String,
              object["version"] as? Int == protocolVersion,
              object["simulatorUdid"] as? String == simulatorUdid,
              object["generation"] as? Int == generation else {
            fail("invalid sidecar request")
        }

        switch op {
        case "handshake":
            write(response(id: id, result: [
                "protocolVersion": protocolVersion,
                "simulatorUdid": simulatorUdid,
                "generation": generation,
                "ready": nativeProbe.framebufferCapture,
                "message": readinessMessage,
                "capabilities": capabilities,
                "probe": nativeProbe.json
            ]))
        case "availability":
            write(response(id: id, result: [
                "ready": nativeProbe.framebufferCapture,
                "message": readinessMessage
            ]))
        case "captureFrame":
            let params = object["params"] as? [String: Any]
            let requestedMax = params?["maxFrameBytes"] as? Int
            let captureLimit = requestedMax.map {
                min($0, maxFramebufferBytes)
            } ?? maxFramebufferBytes
            guard captureLimit > 0 else {
                write(response(id: id, error: [
                    "code": "INVALID_ARGUMENT",
                    "message": "maxFrameBytes must be positive."
                ]))
                continue
            }
            do {
                guard let retainedScreen = retainedFramebufferScreen,
                      let screenID = retainedFramebufferScreenID else {
                    throw FramebufferCaptureError.surfaceUnavailable
                }
                let captured = try captureCurrentFramebuffer(
                    screen: retainedScreen,
                    screenID: screenID,
                    maxFrameBytes: captureLimit
                )
                let streamID = "capture-\(id)"
                write(response(id: id, result: ["streamId": streamID]))
                write(streamFrame(
                    streamID: streamID,
                    sequence: 0,
                    framebuffer: captured
                ))
                write(streamEnd(
                    streamID: streamID,
                    reason: "max-frames"
                ))
            } catch let error as FramebufferCaptureError {
                write(response(id: id, error: [
                    "code": "UNAVAILABLE",
                    "message": error.publicMessage
                ]))
            } catch {
                write(response(id: id, error: [
                    "code": "UNAVAILABLE",
                    "message": "Native framebuffer capture failed."
                ]))
            }
        case "configureStream":
            guard productH264Enabled else {
                write(response(id: id, error: [
                    "code": "UNSUPPORTED",
                    "message": "Native H.264 product streaming is disabled."
                ]))
                continue
            }
            guard let params = object["params"] as? [String: Any],
                  params["encoding"] as? String == "h264",
                  let framesPerSecond = params["framesPerSecond"] as? Int,
                  framesPerSecond >= 1,
                  framesPerSecond <= maxProductH264FramesPerSecond,
                  let scalingPercent = params["scalingPercent"] as? Int,
                  scalingPercent >= 1,
                  scalingPercent <= 100,
                  let orientation = params["orientation"] as? String,
                  orientation == "PORTRAIT" ||
                    orientation == "LANDSCAPE" else {
                write(response(id: id, error: [
                    "code": "INVALID_ARGUMENT",
                    "message": "Native H.264 stream profile is invalid."
                ]))
                continue
            }
            let profile = NativeProductStreamProfile(
                framesPerSecond: framesPerSecond,
                scalingPercent: scalingPercent,
                orientation: orientation
            )
            streamRegistryLock.lock()
            let streamAlreadyActive = activeFrameStream != nil
            if !streamAlreadyActive {
                configuredProductH264Profile = profile
            }
            streamRegistryLock.unlock()
            guard !streamAlreadyActive else {
                write(response(id: id, error: [
                    "code": "BUSY",
                    "message": "A native framebuffer stream is already active."
                ]))
                continue
            }
            write(response(id: id, result: [
                "encoding": "h264",
                "framesPerSecond": framesPerSecond,
                "scalingPercent": scalingPercent,
                "orientation": orientation
            ]))
        case "startStream":
            guard productH264Enabled,
                  nativeProbe.framebufferCapture,
                  let screen = retainedFramebufferScreen,
                  let screenID = retainedFramebufferScreenID else {
                write(response(id: id, error: [
                    "code": "UNAVAILABLE",
                    "message": "Native H.264 product streaming is unavailable."
                ]))
                continue
            }
            guard let params = object["params"] as? [String: Any],
                  let rawProfile = params["profile"] as? [String: Any],
                  rawProfile["encoding"] as? String == "h264",
                  let framesPerSecond =
                    rawProfile["framesPerSecond"] as? Int,
                  framesPerSecond >= 1,
                  framesPerSecond <= maxProductH264FramesPerSecond,
                  let scalingPercent =
                    rawProfile["scalingPercent"] as? Int,
                  scalingPercent >= 1,
                  scalingPercent <= 100,
                  let orientation = rawProfile["orientation"] as? String,
                  orientation == "PORTRAIT" ||
                    orientation == "LANDSCAPE" else {
                write(response(id: id, error: [
                    "code": "INVALID_ARGUMENT",
                    "message": "Native H.264 stream profile is invalid."
                ]))
                continue
            }
            let profile = NativeProductStreamProfile(
                framesPerSecond: framesPerSecond,
                scalingPercent: scalingPercent,
                orientation: orientation
            )
            let requestedMaxFrames = params["maxFrames"] as? Int
            let frameCount = requestedMaxFrames ?? Int.max
            let requestedMaxFrameBytes = params["maxFrameBytes"] as? Int
            let frameByteLimit =
                requestedMaxFrameBytes ?? maxFramebufferBytes
            guard frameCount >= 1,
                  frameByteLimit >= 1,
                  frameByteLimit <= maxFramebufferBytes else {
                write(response(id: id, error: [
                    "code": "INVALID_ARGUMENT",
                    "message": "Native H.264 stream bounds are invalid."
                ]))
                continue
            }
            let streamID = "h264-\(id)"
            let state = NativeFrameStreamState(
                streamID: streamID,
                framesPerSecond: framesPerSecond,
                maxFrames: frameCount,
                maxFrameBytes: frameByteLimit,
                scalingPercent: scalingPercent,
                orientation: orientation
            )
            streamRegistryLock.lock()
            let profileMatches =
                configuredProductH264Profile == profile
            let streamAlreadyActive = activeFrameStream != nil
            if profileMatches && !streamAlreadyActive {
                activeFrameStream = state
            }
            streamRegistryLock.unlock()
            guard profileMatches else {
                write(response(id: id, error: [
                    "code": "INVALID_ARGUMENT",
                    "message":
                        "Native H.264 stream must use the configured profile."
                ]))
                continue
            }
            guard !streamAlreadyActive else {
                write(response(id: id, error: [
                    "code": "BUSY",
                    "message": "A native framebuffer stream is already active."
                ]))
                continue
            }
            write(response(id: id, result: ["streamId": streamID]))
            DispatchQueue.global(qos: .userInitiated).async {
                runH264Stream(
                    state: state,
                    screen: screen,
                    screenID: screenID,
                    failureMessage: "Native H.264 stream failed."
                )
            }
        case "startBgraCorrectnessStream":
            guard nativeProbe.framebufferCapture,
                  let screen = retainedFramebufferScreen,
                  let screenID = retainedFramebufferScreenID else {
                write(response(id: id, error: [
                    "code": "UNAVAILABLE",
                    "message": "Native framebuffer capture is unavailable."
                ]))
                continue
            }
            guard let params = object["params"] as? [String: Any],
                  let framesPerSecond = params["framesPerSecond"] as? Int,
                  framesPerSecond >= 1,
                  framesPerSecond <= maxCorrectnessFramesPerSecond,
                  let frameCount = params["maxFrames"] as? Int,
                  frameCount >= 1,
                  frameCount <= maxCorrectnessFrames,
                  let requestedMaxFrameBytes =
                    params["maxFrameBytes"] as? Int,
                  requestedMaxFrameBytes >= 1,
                  requestedMaxFrameBytes <= maxFramebufferBytes else {
                write(response(id: id, error: [
                    "code": "INVALID_ARGUMENT",
                    "message":
                        "Correctness stream bounds are invalid."
                ]))
                continue
            }
            let streamID = "bgra-correctness-\(id)"
            let state = NativeFrameStreamState(
                streamID: streamID,
                framesPerSecond: framesPerSecond,
                maxFrames: frameCount,
                maxFrameBytes: requestedMaxFrameBytes
            )
            streamRegistryLock.lock()
            let streamAlreadyActive = activeFrameStream != nil
            if !streamAlreadyActive {
                activeFrameStream = state
            }
            streamRegistryLock.unlock()
            guard !streamAlreadyActive else {
                write(response(id: id, error: [
                    "code": "BUSY",
                    "message":
                        "A framebuffer correctness stream is already active."
                ]))
                continue
            }
            write(response(id: id, result: ["streamId": streamID]))
            DispatchQueue.global(qos: .userInitiated).async {
                runCorrectnessStream(
                    state: state,
                    screen: screen,
                    screenID: screenID
                )
            }
        case "startH264CorrectnessStream":
            guard nativeProbe.framebufferCapture,
                  let screen = retainedFramebufferScreen,
                  let screenID = retainedFramebufferScreenID else {
                write(response(id: id, error: [
                    "code": "UNAVAILABLE",
                    "message": "Native framebuffer capture is unavailable."
                ]))
                continue
            }
            guard let params = object["params"] as? [String: Any],
                  let framesPerSecond = params["framesPerSecond"] as? Int,
                  framesPerSecond >= 1,
                  framesPerSecond <= maxH264CorrectnessFramesPerSecond,
                  let frameCount = params["maxFrames"] as? Int,
                  frameCount >= 1,
                  frameCount <= maxCorrectnessFrames,
                  let requestedMaxFrameBytes =
                    params["maxFrameBytes"] as? Int,
                  requestedMaxFrameBytes >= 1,
                  requestedMaxFrameBytes <= maxFramebufferBytes else {
                write(response(id: id, error: [
                    "code": "INVALID_ARGUMENT",
                    "message":
                        "H.264 correctness stream bounds are invalid."
                ]))
                continue
            }
            let streamID = "h264-correctness-\(id)"
            let state = NativeFrameStreamState(
                streamID: streamID,
                framesPerSecond: framesPerSecond,
                maxFrames: frameCount,
                maxFrameBytes: requestedMaxFrameBytes
            )
            streamRegistryLock.lock()
            let streamAlreadyActive = activeFrameStream != nil
            if !streamAlreadyActive {
                activeFrameStream = state
            }
            streamRegistryLock.unlock()
            guard !streamAlreadyActive else {
                write(response(id: id, error: [
                    "code": "BUSY",
                    "message":
                        "A framebuffer correctness stream is already active."
                ]))
                continue
            }
            write(response(id: id, result: ["streamId": streamID]))
            DispatchQueue.global(qos: .userInitiated).async {
                runH264Stream(
                    state: state,
                    screen: screen,
                    screenID: screenID,
                    failureMessage:
                        "Native H.264 correctness stream failed."
                )
            }
        case "beginTouch":
            guard let injector = nativeHIDInjector else {
                write(response(id: id, error: [
                    "code": "UNAVAILABLE",
                    "message": "Native HID is unavailable."
                ]))
                continue
            }
            do {
                guard let params = object["params"] as? [String: Any] else {
                    throw NativeHIDError.invalidGesture
                }
                let gestureID = try liveGestureID(params["gestureId"])
                let sample = try liveTouchSample(
                    params["point"],
                    phase: "down"
                )
                let state = NativeLiveGestureState(
                    gestureID: gestureID,
                    sample: sample
                )
                guard reserveLiveGesture(state) else {
                    write(response(id: id, error: [
                        "code": "BUSY",
                        "message": "A native HID gesture is already active."
                    ]))
                    continue
                }
                do {
                    try injector.send(first: sample)
                    write(response(id: id, result: [:]))
                } catch {
                    finishLiveGesture(state)
                    throw error
                }
            } catch let error as NativeHIDError {
                write(response(id: id, error: [
                    "code": "INVALID_ARGUMENT",
                    "message": error.publicMessage
                ]))
            } catch {
                write(response(id: id, error: [
                    "code": "UNAVAILABLE",
                    "message": "Native HID touch-down failed."
                ]))
            }
        case "moveTouch":
            guard let injector = nativeHIDInjector else {
                write(response(id: id, error: [
                    "code": "UNAVAILABLE",
                    "message": "Native HID is unavailable."
                ]))
                continue
            }
            do {
                guard let params = object["params"] as? [String: Any] else {
                    throw NativeHIDError.invalidGesture
                }
                let gestureID = try liveGestureID(params["gestureId"])
                guard let state = liveGesture(withID: gestureID) else {
                    write(response(id: id, error: [
                        "code": "NOT_FOUND",
                        "message": "The live native HID gesture is not active."
                    ]))
                    continue
                }
                guard state.moveCount < maxGestureSamples,
                      Date().timeIntervalSince(state.startedAt) * 1_000
                          <= Double(maxGestureDurationMilliseconds) else {
                    cancelLiveGesture(state, injector: injector)
                    write(response(id: id, error: [
                        "code": "TIMEOUT",
                        "message": "The live native HID gesture exceeded its bounds."
                    ]))
                    continue
                }
                let sample = try liveTouchSample(
                    params["point"],
                    phase: "move",
                    expectedEdge: state.edge
                )
                try injector.send(first: sample)
                state.lastSample = sample
                state.moveCount += 1
                write(response(id: id, result: [:]))
            } catch let error as NativeHIDError {
                write(response(id: id, error: [
                    "code": "INVALID_ARGUMENT",
                    "message": error.publicMessage
                ]))
            } catch {
                write(response(id: id, error: [
                    "code": "UNAVAILABLE",
                    "message": "Native HID touch-move failed."
                ]))
            }
        case "endTouch":
            guard let injector = nativeHIDInjector else {
                write(response(id: id, error: [
                    "code": "UNAVAILABLE",
                    "message": "Native HID is unavailable."
                ]))
                continue
            }
            do {
                guard let params = object["params"] as? [String: Any] else {
                    throw NativeHIDError.invalidGesture
                }
                let gestureID = try liveGestureID(params["gestureId"])
                guard let state = liveGesture(withID: gestureID) else {
                    write(response(id: id, error: [
                        "code": "NOT_FOUND",
                        "message": "The live native HID gesture is not active."
                    ]))
                    continue
                }
                let cancelled = params["cancelled"] as? Bool ?? false
                let sample = try liveTouchSample(
                    params["point"],
                    phase: cancelled ? "cancel" : "up",
                    expectedEdge: state.edge
                )
                defer { finishLiveGesture(state) }
                try injector.send(first: sample)
                state.lastSample = sample
                write(response(id: id, result: [:]))
            } catch let error as NativeHIDError {
                write(response(id: id, error: [
                    "code": "INVALID_ARGUMENT",
                    "message": error.publicMessage
                ]))
            } catch {
                write(response(id: id, error: [
                    "code": "UNAVAILABLE",
                    "message": "Native HID touch release failed."
                ]))
            }
        case "touchPath":
            guard let injector = nativeHIDInjector else {
                write(response(id: id, error: [
                    "code": "UNAVAILABLE",
                    "message": "Native HID is unavailable."
                ]))
                continue
            }
            do {
                guard let params = object["params"] as? [String: Any] else {
                    throw NativeHIDError.invalidGesture
                }
                let points = try touchPath(params["points"])
                let streamID = "gesture-\(id)"
                let state = NativeGestureState(streamID: streamID)
                guard reserveGesture(state) else {
                    write(response(id: id, error: [
                        "code": "BUSY",
                        "message": "A native HID gesture is already active."
                    ]))
                    continue
                }
                write(response(id: id, result: ["streamId": streamID]))
                DispatchQueue.global(qos: .userInteractive).async {
                    runGesture(
                        state: state,
                        injector: injector,
                        first: points
                    )
                }
            } catch let error as NativeHIDError {
                write(response(id: id, error: [
                    "code": "INVALID_ARGUMENT",
                    "message": error.publicMessage
                ]))
            } catch {
                write(response(id: id, error: [
                    "code": "INVALID_ARGUMENT",
                    "message": "Native HID gesture parameters are invalid."
                ]))
            }
        case "touch2Path":
            guard let injector = nativeHIDInjector else {
                write(response(id: id, error: [
                    "code": "UNAVAILABLE",
                    "message": "Native multi-touch is unavailable."
                ]))
                continue
            }
            do {
                guard let params = object["params"] as? [String: Any] else {
                    throw NativeHIDError.invalidGesture
                }
                let (first, second) = try synchronizedTouchPaths(
                    firstValue: params["first"],
                    secondValue: params["second"]
                )
                let streamID = "gesture-\(id)"
                let state = NativeGestureState(streamID: streamID)
                guard reserveGesture(state) else {
                    write(response(id: id, error: [
                        "code": "BUSY",
                        "message": "A native HID gesture is already active."
                    ]))
                    continue
                }
                write(response(id: id, result: ["streamId": streamID]))
                DispatchQueue.global(qos: .userInteractive).async {
                    runGesture(
                        state: state,
                        injector: injector,
                        first: first,
                        second: second
                    )
                }
            } catch let error as NativeHIDError {
                write(response(id: id, error: [
                    "code": "INVALID_ARGUMENT",
                    "message": error.publicMessage
                ]))
            } catch {
                write(response(id: id, error: [
                    "code": "INVALID_ARGUMENT",
                    "message":
                        "Native multi-touch gesture parameters are invalid."
                ]))
            }
        case "releaseInput":
            guard let injector = nativeHIDInjector else {
                write(response(id: id, error: [
                    "code": "UNAVAILABLE",
                    "message": "Native HID is unavailable."
                ]))
                continue
            }
            do {
                if let live = currentLiveGesture {
                    cancelLiveGesture(live, injector: injector)
                }
                try injector.releaseStaleContact()
                write(response(id: id, result: [:]))
            } catch let error as NativeHIDError {
                write(response(id: id, error: [
                    "code": "UNAVAILABLE",
                    "message": error.publicMessage
                ]))
            } catch {
                write(response(id: id, error: [
                    "code": "UNAVAILABLE",
                    "message": "Native HID recovery release failed."
                ]))
            }
        case "detach":
            gestureRegistryLock.lock()
            let gesture = currentGesture
            gestureRegistryLock.unlock()
            if let gesture {
                gesture.cancel()
                guard gesture.waitForCompletion(
                    timeoutMilliseconds: 1_000
                ) else {
                    write(response(id: id, error: [
                        "code": "TIMEOUT",
                        "message": "Native HID release timed out."
                    ]))
                    continue
                }
            }
            if let live = currentLiveGesture, let injector = nativeHIDInjector {
                cancelLiveGesture(live, injector: injector)
            }
            write(response(id: id, result: [:]))
        case "ackStreamFrame":
            guard let params = object["params"] as? [String: Any],
                  let streamID = params["streamId"] as? String,
                  let sequence = params["sequence"] as? Int,
                  sequence >= 0,
                  let state = activeStream(withID: streamID),
                  state.canAcknowledge(sequence: sequence) else {
                write(response(id: id, error: [
                    "code": "INVALID_ARGUMENT",
                    "message":
                        "Stream acknowledgement does not match the active frame."
                ]))
                continue
            }
            // The reply is placed on stdout before the worker is released,
            // keeping at most one unacknowledged framebuffer in flight.
            write(response(id: id, result: [:]))
            state.acknowledge(sequence: sequence)
        case "stopStream":
            guard let params = object["params"] as? [String: Any],
                  let streamID = params["streamId"] as? String else {
                write(response(id: id, error: [
                    "code": "INVALID_ARGUMENT",
                    "message": "streamId is required."
                ]))
                continue
            }
            if let state = activeStream(withID: streamID) {
                state.cancel()
                write(response(id: id, result: [:]))
            } else if let gesture = activeGesture(withID: streamID) {
                gesture.cancel()
                write(response(id: id, result: [:]))
            } else {
                write(response(id: id, error: [
                    "code": "NOT_FOUND",
                    "message": "The requested stream is not active."
                ]))
            }
        default:
            write(response(id: id, error: [
                "code": "UNSUPPORTED",
                "message": "Operation is not enabled in this sidecar build."
            ]))
        }
    }
}
