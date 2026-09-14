#if os(macOS)
import Foundation
import XCTest
@testable import CindyRemoteCredentials

final class AndroidInteropTests: XCTestCase {
  func testSwiftAndAndroidExchangeConfirmedEncryptedPackets() throws {
    let environment = ProcessInfo.processInfo.environment
    guard let classpath = environment["CINDY_CREDENTIAL_JVM_CLASSPATH"],
      let executable = environment["CINDY_CREDENTIAL_JAVA"] else {
      throw XCTSkip("Build Android writeInteropClasspath and provide the test-only JVM environment")
    }
    let process = Process(), input = Pipe(), output = Pipe()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = ["-cp", classpath, "app.cindy.credentials.InteropPeer"]
    process.standardInput = input; process.standardOutput = output
    process.standardError = FileHandle.nullDevice
    try process.run()
    let timeout = DispatchWorkItem { if process.isRunning { process.terminate() } }
    DispatchQueue.global().asyncAfter(deadline: .now() + 30, execute: timeout)
    defer { timeout.cancel(); try? input.fileHandleForWriting.close(); if process.isRunning { process.terminate() } }
    func send(_ value: String) throws { try input.fileHandleForWriting.write(contentsOf: Data((value + "\n").utf8)) }
    func line() throws -> String {
      var bytes = Data()
      while bytes.count < 65_536 {
        guard let byte = try output.fileHandleForReading.read(upToCount: 1), !byte.isEmpty else { throw CredentialError.unavailable }
        if byte[0] == 10 { return String(decoding: bytes, as: UTF8.self) }
        bytes.append(byte)
      }
      throw CredentialError.invalidMessage
    }
    let key = try IdentityKey.ephemeral(), a = UUID().uuidString.lowercased(), b = UUID().uuidString.lowercased()
    let membership = "interop/互通"
    let publicKey = try JSONSerialization.jsonObject(with: JSONEncoder().encode(key.publicKey))
    let fixture = try JSONSerialization.data(withJSONObject: ["id": a, "peerId": b,
      "membership": membership, "publicKey": publicKey])
    try send(String(decoding: fixture, as: UTF8.self))
    let remoteKey = try JSONDecoder().decode(IdentityPublicKey.self, from: Data(line().utf8))
    let local = ChannelIdentity(id: a, membershipId: membership, publicKey: key.publicKey, realm: .global, checkedAt: Date())
    let remote = ChannelIdentity(id: b, membershipId: membership, publicKey: remoteKey, realm: .global, checkedAt: Date())
    let channel = try NativeChannel(local: local, remote: remote, key: key)
    try send(channel.offer()); try channel.accept(offer: line())
    XCTAssertEqual(try channel.open(line()).purpose, "ready")
    try send(channel.seal(body: Data(), purpose: "ready"))
    let payload = Data("non-secret/跨端测试/\(UUID().uuidString)".utf8)
    try send(channel.seal(body: payload, purpose: "request"))
    let reply = try channel.open(line())
    XCTAssertEqual(reply.purpose, "response"); XCTAssertEqual(reply.body, payload)
    process.waitUntilExit(); XCTAssertEqual(process.terminationStatus, 0)
  }
}
#endif
