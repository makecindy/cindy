#if os(macOS)
import Foundation
import Security

// libuv creates AF_UNIX socket pairs for child stdio on macOS. Authenticate
// their kernel-supplied audit tokens, not argv, environment, PID alone or a
// caller-supplied secret. All three channels must belong to the same Main.
public struct DesktopInputCaller {
  let token: Data
  let parent: pid_t
  let requirement: SecRequirement

  static func signingInfo(_ code: SecCode) -> [String: Any]? {
    var value: SecStaticCode?
    var information: CFDictionary?
    guard SecCodeCopyStaticCode(code, [], &value) == errSecSuccess, let value = value,
      SecCodeCopySigningInformation(value, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess else { return nil }
    return information as? [String: Any]
  }

  public static func hasSealedHelper(_ code: SecCode, executable: URL, resourceName: String = "cindy-macos-desktop-input") -> Bool {
    var value: SecStaticCode?
    guard SecCodeCopyStaticCode(code, [], &value) == errSecSuccess, let value = value,
      let bytes = try? Data(contentsOf: executable) else { return false }
    // Bind the shipped pair: a same-team older app must not gain this helper's
    // privileges by transplanting it into an app with weaker Electron fuses.
    return SecCodeValidateFileResource(value,
      ("Resources/tools/remote-desktop/" + resourceName) as CFString,
      bytes as CFData, []) == errSecSuccess
  }

  static func peer(_ descriptor: Int32) -> Data? {
    var token = audit_token_t()
    var size = socklen_t(MemoryLayout<audit_token_t>.size)
    guard getsockopt(descriptor, 0 /* SOL_LOCAL */, 6 /* LOCAL_PEERTOKEN */, &token, &size) == 0,
      size == MemoryLayout<audit_token_t>.size else { return nil }
    return withUnsafeBytes(of: token) { Data($0) }
  }

  public func code() -> SecCode? {
    guard getppid() == parent else { return nil }
    var code: SecCode?
    let attributes = [kSecGuestAttributeAudit: token] as CFDictionary
    guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess,
      let code = code, SecCodeCheckValidity(code, [], requirement) == errSecSuccess else { return nil }
    return code
  }

  public static func authenticate(resourceName: String = "cindy-macos-desktop-input", developmentExecutable: String? = nil) -> DesktopInputCaller? {
    guard let token = peer(STDIN_FILENO), peer(STDOUT_FILENO) == token,
      peer(STDERR_FILENO) == token else { return nil }
    let words = token.withUnsafeBytes { Array($0.bindMemory(to: UInt32.self)) }
    let parent = getppid()
    guard parent > 1, words[5] == UInt32(parent), words[1] == geteuid() else { return nil }
    var requirement: SecRequirement?
    let executable: URL
#if DESKTOP_INPUT_DEVELOPMENT
    // Development runs writable JS in generic Electron with an inspector.
    // This is only an exact runtime binding, NOT a production security boundary.
    // Main fills this compile-time value; no environment/CLI downgrade exists.
    let encodedExecutable = developmentExecutable ?? "DESKTOP_INPUT_DEVELOPMENT_EXECUTABLE"
    guard let data = Data(base64Encoded: encodedExecutable),
      let value = String(data: data, encoding: .utf8), value.hasPrefix("/") else { return nil }
    executable = URL(fileURLWithPath: value).resolvingSymlinksInPath()
    var expected: SecStaticCode?
    guard SecStaticCodeCreateWithPath(executable as CFURL, [], &expected) == errSecSuccess,
      let expected = expected,
      SecCodeCopyDesignatedRequirement(expected, [], &requirement) == errSecSuccess else { return nil }
#else
    var own: SecCode?
    guard SecCodeCopySelf([], &own) == errSecSuccess, let own = own,
      SecCodeCheckValidity(own, [], nil) == errSecSuccess,
      let info = signingInfo(own),
      let team = info[kSecCodeInfoTeamIdentifier as String] as? String,
      team.range(of: "^[A-Z0-9]+$", options: .regularExpression) != nil,
      let ownExecutable = info[kSecCodeInfoMainExecutable as String] as? URL else { return nil }
    // Only the Main executable in this helper's enclosing, signed app may call
    // it. Another signed application (even from our team) is not Cindy Main.
    var appURL = ownExecutable.resolvingSymlinksInPath()
    for _ in 0..<5 { appURL.deleteLastPathComponent() }
    guard let bundle = Bundle(url: appURL), let identifier = bundle.bundleIdentifier,
      ["com.xd.cindy", "com.xd.cindycn"].contains(identifier),
      let mainExecutable = bundle.executableURL else { return nil }
    executable = mainExecutable.resolvingSymlinksInPath()
    let rule = "anchor apple generic and identifier \"\(identifier)\" and certificate leaf[subject.OU] = \"\(team)\""
    guard SecRequirementCreateWithString(rule as CFString, [], &requirement) == errSecSuccess else { return nil }
#endif
    guard let requirement = requirement else { return nil }
    let caller = DesktopInputCaller(token: token, parent: parent, requirement: requirement)
    guard let code = caller.code(), let info = signingInfo(code),
      let actual = info[kSecCodeInfoMainExecutable as String] as? URL,
      actual.resolvingSymlinksInPath() == executable else { return nil }
#if !DESKTOP_INPUT_DEVELOPMENT
    guard let flags = info[kSecCodeInfoFlags as String] as? UInt32,
      flags & 0x10000 /* kSecCodeSignatureRuntime */ != 0,
      flags & 0x0002 /* kSecCodeSignatureAdhoc */ == 0,
      hasSealedHelper(code, executable: ownExecutable, resourceName: resourceName) else { return nil }
#endif
    return caller
  }
}

#endif
