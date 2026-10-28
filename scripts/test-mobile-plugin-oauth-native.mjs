/** Runs the production Swift loopback listener against real local TCP requests.
 * Expo's thin Promise/Record bridge is stubbed; the listener/parser is not copied.
 * All callback material is synthetic and stays in a disposable directory.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const source = fs.readFileSync(new URL('../apps/mobile/modules/cindy-plugin-oauth/ios/CindyPluginOauthModule.swift', import.meta.url), 'utf8');
const marker = 'private final class PluginOauthListener';
if (!source.includes(marker)) throw new Error('Production listener not found');
const listener = source.slice(source.indexOf(marker)).replace(marker, 'final class PluginOauthListener');
const driver = String.raw`
import Foundation
import Network
import Darwin
struct PluginOauthListenerOptions { var id: String; var callbackUrl: String; var state: String; var expiresAt: Double }
final class Promise {
  var value: [String: String]?; var error: String?
  func resolve(_ value: Any?) { self.value = value as? [String: String] }
  func reject(_ code: String, _ message: String) { error = code }
}
func require(_ condition: @autoclosure () -> Bool, _ message: String) { if !condition() { fatalError(message) } }
func freePort() -> UInt16 {
  let fd = Darwin.socket(AF_INET, SOCK_STREAM, 0); defer { Darwin.close(fd) }
  var address = sockaddr_in(); address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size); address.sin_family = sa_family_t(AF_INET); address.sin_addr.s_addr = inet_addr("127.0.0.1")
  let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
  require(bound == 0, "port probe failed")
  var length = socklen_t(MemoryLayout<sockaddr_in>.size)
  _ = withUnsafeMutablePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) } }
  return UInt16(bigEndian: address.sin_port)
}
let queue = DispatchQueue(label: "oauth.native.test")
let state = "synthetic-provider-state-123"
func create(ttl: Double = 10000) throws -> (PluginOauthListener, UInt16, PluginOauthListenerOptions) {
  let port = freePort()
  let options = PluginOauthListenerOptions(id: "synthetic-listener-id", callbackUrl: "http://127.0.0.1:\(port)/callback", state: state, expiresAt: Date().timeIntervalSince1970 * 1000 + ttl)
  let server = try PluginOauthListener(options, queue: queue)
  let ready = DispatchSemaphore(value: 0); var bound = false
  queue.async { server.start { bound = $0; ready.signal() } }
  require(ready.wait(timeout: .now() + 3) == .success && bound, "listener not ready")
  return (server, port, options)
}
func send(_ port: UInt16, target: String, host: String? = nil, extra: String = "") -> String {
  let fd = Darwin.socket(AF_INET, SOCK_STREAM, 0); defer { Darwin.close(fd) }
  var timeout = timeval(tv_sec: 2, tv_usec: 0)
  _ = withUnsafePointer(to: &timeout) { setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, $0, socklen_t(MemoryLayout<timeval>.size)) }
  var address = sockaddr_in(); address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size); address.sin_family = sa_family_t(AF_INET); address.sin_addr.s_addr = inet_addr("127.0.0.1"); address.sin_port = port.bigEndian
  let connected = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
  require(connected == 0, "test connection failed")
  let bytes = Array("GET \(target) HTTP/1.1\r\nHost: \(host ?? "127.0.0.1:\(port)")\r\n\(extra)\r\n".utf8)
  _ = bytes.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, bytes.count) }
  var response = [UInt8](repeating: 0, count: 4096)
  let count = Darwin.read(fd, &response, response.count)
  return count > 0 ? String(decoding: response.prefix(count), as: UTF8.self) : ""
}
let (server, port, options) = try create()
let invalid: [(String, String?, String)] = [
  ("/callback?state=wrong&code=fake-code", nil, ""),
  ("/other?state=\(state)&code=fake-code", nil, ""),
  ("/callback?state=\(state)&code=fake-code", "localhost:\(port)", ""),
  ("/callback?state=\(state)&code=fake-code", nil, "Origin: https://accounts.example.com\r\n"),
  ("/callback?state=\(state)&code=a&code=b", nil, ""),
  ("/callback?state=\(state)&code=a&error=access_denied", nil, ""),
  ("/callback?state=\(state)&state=\(state)&code=a", nil, ""),
  ("/callback?state=\(state)&code=", nil, ""),
  ("/callback?state=\(state)&code=fake-code", nil, "Content-Length: 1\r\n"),
]
for item in invalid { require(send(port, target: item.0, host: item.1, extra: item.2).hasPrefix("HTTP/1.1 400"), "invalid callback accepted") }
// An occupied fixed port must fail, never reclaim or silently pick a new port.
var conflict: PluginOauthListener?
do { conflict = try PluginOauthListener(options, queue: queue) } catch {}
if let conflict {
  let ready = DispatchSemaphore(value: 0); var bound = true
  queue.async { conflict.start { bound = $0; ready.signal() } }
  require(ready.wait(timeout: .now() + 3) == .success && !bound, "occupied port accepted")
  queue.sync { conflict.close() }
}
let first = Promise(); queue.sync { server.wait(first) }
require(send(port, target: "/callback?state=\(state)&code=fake-code&scope=read").hasPrefix("HTTP/1.1 200"), "valid callback rejected")
queue.sync { require(first.value?["code"] == "fake-code", "callback not delivered") }
let second = Promise(); queue.sync { server.wait(second); require(second.error != nil, "callback consumed twice"); server.close() }
let (expired, _, _) = try create(ttl: 100)
Thread.sleep(forTimeInterval: 0.2)
queue.sync { require(expired.status() == "closed", "expired listener still active"); expired.close() }
let (unconsumed, unconsumedPort, _) = try create(ttl: 100)
require(send(unconsumedPort, target: "/callback?state=\(state)&code=fake-code").hasPrefix("HTTP/1.1 200"), "valid pending callback rejected")
Thread.sleep(forTimeInterval: 0.2)
queue.sync { let late = Promise(); unconsumed.wait(late); require(late.error != nil && unconsumed.status() == "closed", "expired callback retained"); unconsumed.close() }
let (_, _, base) = try create(ttl: 100)
for bad in ["http://localhost:57123/callback", "http://[::1]:57123/callback", "http://127.0.0.1:80/callback"] {
  var options = base; options.callbackUrl = bad
  do { _ = try PluginOauthListener(options, queue: queue); fatalError("unsupported callback accepted") } catch {}
}
print("Swift production listener: 17 security scenarios passed")
`;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-plugin-oauth-native-'));
try {
  fs.writeFileSync(path.join(directory, 'main.swift'), driver + '\n' + listener);
  execFileSync('xcrun', ['swiftc', '-swift-version', '5', path.join(directory, 'main.swift'), '-o', path.join(directory, 'test')], { stdio: 'inherit' });
  execFileSync(path.join(directory, 'test'), [], { stdio: 'inherit', timeout: 20000 });
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
