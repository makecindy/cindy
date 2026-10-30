import CommonCrypto
import ExpoModulesCore
import Foundation
import onnxruntime_objc

/// Runs the speaker filter models (Silero VAD and the voiceprint model) with
/// ONNX Runtime. All feature extraction and gating logic lives in shared
/// TypeScript; this module only loads the two models and runs float32
/// tensors through them, one call at a time on its own serial queue.
public class CindySpeakerOnnxModule: Module {
  private let queue = DispatchQueue(label: "com.xdtmaker.speakeronnx", qos: .userInitiated)
  private var env: ORTEnv?
  private var sessions: [String: ORTSession] = [:]
  private var loadedPaths: [String: String] = [:]

  public func definition() -> ModuleDefinition {
    Name("CindySpeakerOnnx")

    /// Loads (or keeps) both models. Same paths as last time is a no-op.
    AsyncFunction("loadModels") { (vadPath: String, embeddingPath: String) in
      try self.queue.sync {
        let wanted = ["vad": vadPath, "embedding": embeddingPath]
        if wanted == self.loadedPaths { return }
        let env = try self.env ?? ORTEnv(loggingLevel: ORTLoggingLevel.warning)
        self.env = env
        var next: [String: ORTSession] = [:]
        for (name, path) in wanted {
          let options = try ORTSessionOptions()
          try options.setIntraOpNumThreads(1)
          next[name] = try ORTSession(env: env, modelPath: path, sessionOptions: options)
        }
        self.sessions = next
        self.loadedPaths = wanted
      }
    }

    AsyncFunction("unloadModels") {
      self.queue.sync {
        self.sessions = [:]
        self.loadedPaths = [:]
      }
    }

    /// `packed` holds the little-endian float32 data of every input, in the
    /// order of `names`, each sized by its `dims`. Returns, per output, its
    /// dims and its float32 data as base64.
    AsyncFunction("run") { (model: String, names: [String], dims: [[Int]], packed: Data) -> [String: [String: Any]] in
      try self.queue.sync {
        guard let session = self.sessions[model] else {
          throw SpeakerOnnxException("model \(model) is not loaded")
        }
        guard names.count == dims.count else {
          throw SpeakerOnnxException("names and dims differ in length")
        }
        var inputs: [String: ORTValue] = [:]
        var offset = 0
        for (index, name) in names.enumerated() {
          let shape = dims[index]
          let count = shape.reduce(1, *)
          let byteCount = count * MemoryLayout<Float>.size
          guard count >= 0, offset + byteCount <= packed.count else {
            throw SpeakerOnnxException("input \(name) exceeds the packed data")
          }
          let bytes = NSMutableData(data: packed.subdata(in: offset..<(offset + byteCount)))
          inputs[name] = try ORTValue(
            tensorData: bytes,
            elementType: ORTTensorElementDataType.float,
            shape: shape.map { NSNumber(value: $0) }
          )
          offset += byteCount
        }
        guard offset == packed.count else {
          throw SpeakerOnnxException("packed data has trailing bytes")
        }
        let outputNames = Set(try session.outputNames())
        let outputs = try session.run(withInputs: inputs, outputNames: outputNames, runOptions: nil)
        var result: [String: [String: Any]] = [:]
        for (name, value) in outputs {
          let info = try value.tensorTypeAndShapeInfo()
          let data = try value.tensorData() as Data
          result[name] = [
            "dims": info.shape.map { $0.intValue },
            "base64": data.base64EncodedString(),
          ]
        }
        return result
      }
    }

    /// Hex SHA-256 of a downloaded model file, read in chunks.
    AsyncFunction("sha256File") { (path: String) -> String in
      guard let handle = FileHandle(forReadingAtPath: path) else {
        throw SpeakerOnnxException("cannot open file")
      }
      defer { try? handle.close() }
      var context = CC_SHA256_CTX()
      CC_SHA256_Init(&context)
      while true {
        let chunk = handle.readData(ofLength: 1 << 20)
        if chunk.isEmpty { break }
        chunk.withUnsafeBytes { buffer in
          _ = CC_SHA256_Update(&context, buffer.baseAddress, CC_LONG(chunk.count))
        }
      }
      var digest = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
      CC_SHA256_Final(&digest, &context)
      return digest.map { String(format: "%02x", $0) }.joined()
    }
  }
}

final class SpeakerOnnxException: GenericException<String> {
  override var reason: String {
    "Speaker ONNX inference failed: \(param)"
  }
}
