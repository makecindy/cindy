import Foundation
import CindyRemoteCredentials
import DesktopNativeCaller

#if os(macOS)
import AppKit
/// The parent process is authenticated before arguments, storage or network are
/// touched. Only fixed errors are emitted; no diagnostic may echo a payload.
@main
@MainActor
struct CredentialHostMain {
  static func main() {
    let application = NSApplication.shared
    application.setActivationPolicy(.accessory)
    Task { await serve(); application.terminate(nil) }
    application.run()
  }
  static func serve() async {
    guard let caller = DesktopInputCaller.authenticate(resourceName: "cindy-macos-remote-credentials",
      developmentExecutable: "CREDENTIAL_HOST_DEVELOPMENT_EXECUTABLE"),
      CommandLine.arguments.count == 2, CommandLine.arguments[1].hasPrefix("/") else { exit(77) }
    let host = HostCredentialServer(directory: URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true))
    let viewer = MobileCredentialClient(storageDirectory: URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true).appendingPathComponent("viewer"))
    let input = AsyncStream<Data>(bufferingPolicy: .bufferingOldest(64)) { continuation in
      DispatchQueue(label: "cindy.credential.stdin").async {
        var buffer = Data()
        do {
          while let chunk = try CredentialPipeInput.readChunk(from: FileHandle.standardInput.fileDescriptor) {
            buffer.append(chunk)
            guard buffer.count <= 8 * 1024 * 1024 else { exit(77) }
            while let newline = buffer.firstIndex(of: 10) {
              let line = Data(buffer[..<newline]); buffer.removeSubrange(...newline)
              if case .dropped = continuation.yield(line) { exit(77) }
            }
          }
        } catch { /* EOF and pipe errors both close the security owner. */ }
        continuation.finish()
      }
    }
    func process(_ line: Data) async {
      guard caller.code() != nil else { exit(77) }
      var id = ""
      do {
        guard let value = try JSONSerialization.jsonObject(with: line) as? [String: Any],
          let requestID = value["id"] as? String, requestID.utf8.count <= 128,
          let method = value["method"] as? String else { throw CredentialError.invalidMessage }
        id = requestID
        func string(_ key: String) throws -> String {
          guard let result = value[key] as? String else { throw CredentialError.invalidMessage }; return result
        }
        let result: Any
        switch method {
        case "viewerSettings": result = try viewer.savedSettings(realm: string("realm"), membership: string("membership"), authDevice: string("authDevice"), target: string("target"))
        case "viewerConfigure": result = try await viewer.configure(realm: string("realm"), membership: string("membership"), authDevice: string("authDevice"), token: string("token"))
        case "viewerBegin": result = try await viewer.begin(target: string("target"), descriptor: string("descriptor"), setup: value["setup"] as? Bool == true, savedOnly: value["setup"] as? Bool != true, biometric: value["biometric"] as? Bool == true)
        case "viewerAccept": result = try viewer.accept(handle: string("handle"), offer: string("offer"))
        case "viewerReceive": result = try viewer.receive(handle: string("handle"), ciphertext: string("ciphertext"))
        case "viewerPassword": result = try await viewer.password(handle: string("handle"), useSaved: value["saved"] as? Bool == true, locale: string("locale"), theme: string("theme"))
        case "viewerAuthenticationStatus": result = try viewer.authenticationStatus(handle: string("handle"))
        case "viewerForget": try viewer.forgetSaved(realm: string("realm"), membership: string("membership"), authDevice: string("authDevice"), target: string("target")); result = true
        case "viewerBiometric": try await viewer.changeBiometric(realm: string("realm"), membership: string("membership"), authDevice: string("authDevice"), target: string("target"), enabled: value["enabled"] as? Bool == true, locale: string("locale")); result = true
        case "viewerEnd": result = viewer.end(handle: try string("handle")) ?? ""
        case "viewerReset": viewer.reset(); result = true
        case "configure": result = try await host.configure(realm: string("realm"), membership: string("membership"),
          authDevice: string("authDevice"), token: string("token"))
        case "updateToken":
          try host.updateToken(realm: string("realm"), membership: string("membership"), token: string("token")); result = true
        case "relayHeaders": result = try await host.relayHeaders()
        case "begin": result = try await host.begin(peer: string("peer"), offer: string("offer"), descriptor: string("descriptor"))
        case "receive": result = try await host.receive(peer: string("peer"), handle: string("handle"), ciphertext: string("ciphertext"))
        case "response":
          guard let success = value["success"] as? Bool else { throw CredentialError.invalidMessage }
          result = try host.response(peer: string("peer"), handle: string("handle"), id: string("requestId"),
            body: string("body"), success: success)
        case "status": result = host.status()
        case "close": host.close(peer: try string("peer")); result = true
        case "closeAll": host.closeAll(); result = true
        case "reset": host.reset(); result = true
        default: throw CredentialError.invalidMessage
        }
        guard caller.code() != nil else { exit(77) }
        try emit(["id": id, "result": result])
      } catch {
        try? emit(["id": id, "error": (error as? CredentialError)?.rawValue ?? CredentialError.unavailable.rawValue])
      }
    }
    var networkJobs: [UUID: Task<Void, Never>] = [:]
    for await line in input {
      let value = try? JSONSerialization.jsonObject(with: line) as? [String: Any]
      let method = value?["method"] as? String
      if let method, ["configure", "relayHeaders", "begin", "receive", "viewerConfigure", "viewerBegin", "viewerPassword", "viewerBiometric"].contains(method) {
        // Setup and OS unlock await independently. Status and close must remain
        // serviceable while an authentication attempt is awaiting loginwindow.
        guard networkJobs.count < 8 else {
          try? emit(["id": value?["id"] as? String ?? "", "error": CredentialError.unavailable.rawValue])
          continue
        }
        let id = UUID()
        networkJobs[id] = Task { await process(line); networkJobs.removeValue(forKey: id) }
      } else { await process(line) }
    }
    for job in networkJobs.values { job.cancel() }
    host.reset()
    viewer.reset()
  }
  private static func emit(_ value: [String: Any]) throws {
    var data = try JSONSerialization.data(withJSONObject: value); data.append(10)
    try FileHandle.standardOutput.write(contentsOf: data)
  }
}
#else
@main struct UnsupportedCredentialHost { static func main() {} }
#endif
