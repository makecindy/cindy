#if os(iOS)
import Foundation
import CryptoKit
import UIKit
// The system context is read on the worker and only invalidated on Main for
// cancellation; LocalAuthentication predates Swift Sendable annotations.
@preconcurrency import LocalAuthentication

/// Narrow bridge surface. Passwords can only enter through the native form or
/// protected Keychain operation, and only encrypted packets leave this object.
@MainActor
public final class MobileCredentialClient {
  private struct Owner: Equatable { let realm: IdentityRealm; let membership: String; let authDevice: String }
  private final class Session {
    let handle = UUID().uuidString.lowercased()
    let channel: NativeChannel
    let controller: ControllerCredentialSession
    let local: ChannelIdentity
    let remote: ChannelIdentity
    var account: CredentialAccount?
    var usedSavedPassword = false
    var setup = false
    var savedOnly = false
    var savedBinding: CredentialBinding?
    init(channel: NativeChannel, controller: ControllerCredentialSession,
      local: ChannelIdentity, remote: ChannelIdentity) {
      self.channel = channel; self.controller = controller; self.local = local; self.remote = remote
    }
    func binding(_ account: CredentialAccount) -> CredentialBinding {
      var binding = CredentialBinding(realm: local.realm, membership: local.membershipId, controller: local.id,
        target: remote.id, targetThumbprint: remote.publicKey.thumbprint, systemRecord: account.recordID)
      if var saved = savedBinding {
        let version = saved.protectionVersion; saved.protectionVersion = nil
        if saved == binding { binding.protectionVersion = version }
      }
      return binding
    }
  }
  private var owner: Owner?
  private var generation: UInt64 = 0
  private var key: IdentityKey?
  private var vault: CredentialVault?
  private var session: Session?
  private var form: CredentialPasswordForm?
  private var operationPending = false
  private var authentication: LAContext?
  public var onInvalidated: ((String) -> Void)?

  public init() {}

  private func localVault() throws -> CredentialVault {
    let root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
      appropriateFor: nil, create: true).appendingPathComponent("CindyRemoteCredentials", isDirectory: true)
    return CredentialVault(installation: try InstallationMarker.loadOrCreate(directory: root))
  }
  private func settingsKey(realm: String, membership: String, authDevice: String, target: String) throws -> String {
    guard IdentityRealm(rawValue: realm) != nil, !membership.isEmpty, !authDevice.isEmpty,
      !target.isEmpty, [membership, authDevice, target].allSatisfy({ $0.utf8.count <= 512 }) else { throw CredentialError.invalidIdentity }
    return Data(SHA256.hash(data: try JSONEncoder().encode([realm, membership, authDevice, target]))).base64URL
  }
  public func savedSettings(realm: String, membership: String, authDevice: String, target: String) throws -> [String: Bool] {
    let vault = try localVault()
    let value = try vault.settings(settingsKey(realm: realm, membership: membership, authDevice: authDevice, target: target))
    let biometricAvailable = LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
    let autoUnlock = try value.map { settings in
      guard settings.targetPublicKey != nil else { return false }
      return try vault.contains(binding: settings.binding)
    } ?? false
    return ["biometricAvailable": biometricAvailable, "autoUnlock": autoUnlock,
      "biometricVerification": autoUnlock ? (value?.biometric ?? false) : false,
      "biometricPreferred": value?.biometric ?? true]
  }
  public func forgetSaved(realm: String, membership: String, authDevice: String, target: String) throws {
    close()
    let vault = try localVault(), key = try settingsKey(realm: realm, membership: membership, authDevice: authDevice, target: target)
    if let value = try vault.settings(key) { try vault.forget(binding: value.binding) }
    // Retain the non-secret preference and host pin; only the password is forgotten.
  }
  public func changeBiometric(realm: String, membership: String, authDevice: String, target: String,
    enabled: Bool, locale: String) async throws {
    guard UIApplication.shared.applicationState == .active, authentication == nil, !operationPending else { throw CredentialError.cancelled }
    let vault = try localVault(), key = try settingsKey(realm: realm, membership: membership, authDevice: authDevice, target: target)
    guard let settings = try vault.settings(key) else { throw CredentialError.unavailable }
    if settings.biometric == enabled { return }
    operationPending = true
    defer { operationPending = false }
    let epoch = generation, reason = try CredentialLabels(locale: locale)["biometric"]
    if enabled {
      try await evaluateBiometrics(reason: reason)
      try requireForeground(epoch: epoch)
    }
    let secret = try await readProtectedSecret(vault: vault, binding: settings.binding, reason: reason)
    try requireForeground(epoch: epoch)
    var binding = settings.binding; binding.protectionVersion = UUID().uuidString.lowercased()
    try vault.store(secret, binding: binding, requireBiometric: enabled)
    do { try vault.setSettings(key, SavedUnlockSettings(targetPublicKey: settings.targetPublicKey, binding: binding, biometric: enabled)) }
    catch { try? vault.forget(binding: binding); throw error }
    try? vault.forget(binding: settings.binding)
  }

  public func configure(realm: String, membership: String, authDevice: String, token: String) async throws -> String {
    guard let realm = IdentityRealm(rawValue: realm), !membership.isEmpty, !authDevice.isEmpty else {
      throw CredentialError.invalidIdentity
    }
    let next = Owner(realm: realm, membership: membership, authDevice: authDevice)
    if owner != next { reset(); owner = next }
    let root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
      appropriateFor: nil, create: true).appendingPathComponent("CindyRemoteCredentials", isDirectory: true)
    let installation = try InstallationMarker.loadOrCreate(directory: root)
    let signingKey = try InstallationIdentity.loadOrCreate(installation: installation, realm: realm)
    let descriptor = LocalCredentialIdentity(device: authDevice, membership: membership, realm: realm, publicKey: signingKey.publicKey)
    self.key = signingKey; vault = CredentialVault(installation: installation)
    return try descriptor.encoded()
  }

  public func updateToken(realm: String, membership: String, token: String) throws {
    guard let owner, owner.realm.rawValue == realm, owner.membership == membership else { throw CredentialError.cancelled }
  }
  public func relayHeaders() async throws -> [String: String] { throw CredentialError.unavailable }
  public func pushHeaders(method: String, body: [String: String]) async throws -> [String: String] { throw CredentialError.unavailable }

  public func begin(target: String, descriptor: String = "", setup: Bool = false, savedOnly: Bool = false, biometric: Bool = false) async throws -> [String: String] {
    guard UIApplication.shared.applicationState == .active,
      let owner, let key, let vault else { throw CredentialError.unavailable }
    close()
    let local = LocalCredentialIdentity(device: owner.authDevice, membership: owner.membership, realm: owner.realm, publicKey: key.publicKey).peer
    let remoteDescriptor = try LocalCredentialIdentity.decode(descriptor, device: target, membership: owner.membership, realm: owner.realm)
    let remote = remoteDescriptor.peer
    let preferenceKey = try settingsKey(realm: owner.realm.rawValue, membership: owner.membership, authDevice: owner.authDevice, target: target)
    let saved = try vault.settings(preferenceKey)
    if savedOnly || saved?.targetPublicKey != nil { try remoteDescriptor.requirePin(saved?.targetPublicKey) }
    guard setup || savedOnly else { throw CredentialError.unavailable }
    let channel = try NativeChannel(local: local, remote: remote, key: key)
    if setup, biometric, !LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil) { throw CredentialError.unavailable }
    let controller = ControllerCredentialSession(channel: channel, saveAfterVerification: setup || savedOnly) { secret, account in
      var binding = CredentialBinding(realm: local.realm, membership: local.membershipId,
        controller: local.id, target: remote.id, targetThumbprint: remote.publicKey.thumbprint,
        systemRecord: account.recordID)
      binding.protectionVersion = UUID().uuidString.lowercased()
      let previous = try vault.settings(preferenceKey)
      try vault.store(secret, binding: binding, requireBiometric: biometric)
      do { try vault.setSettings(preferenceKey, SavedUnlockSettings(targetPublicKey: remote.publicKey, binding: binding, biometric: biometric)) }
      catch { try? vault.forget(binding: binding); throw error }
      if let previous { try? vault.forget(binding: previous.binding) }
    }
    let state = Session(channel: channel, controller: controller, local: local, remote: remote)
    state.setup = setup; state.savedOnly = savedOnly
    state.savedBinding = try vault.settings(preferenceKey)?.binding
    session = state
    return ["handle": state.handle, "offer": try channel.offer(), "descriptor": try LocalCredentialIdentity(device: owner.authDevice, membership: owner.membership, realm: owner.realm, publicKey: key.publicKey).encoded()]
  }

  public func accept(handle: String, offer: String) throws -> String {
    let state = try current(handle)
    try state.channel.accept(offer: offer)
    return try state.controller.ready()
  }

  public func receive(handle: String, ciphertext: String) throws -> String {
    let state = try current(handle)
    do {
      let value: [String: Any]
      switch try state.controller.receive(ciphertext) {
      case .ignored: value = ["kind": "ignored"]
      case .ready(let account):
        state.account = account
        value = ["kind": "ready", "account": account.name, "target": state.remote.id,
          "saved": try vault?.contains(binding: state.binding(account)) ?? false]
      case .authenticated(let accepted):
        if !accepted, state.usedSavedPassword, let account = state.account {
          try vault?.forget(binding: state.binding(account))
        }
        value = ["kind": "authenticated", "accepted": accepted]
      case .response(let id, let body, let success, let saved):
        guard let json = String(data: body, encoding: .utf8) else { throw CredentialError.invalidMessage }
        value = ["kind": "response", "id": id, "body": json, "success": success, "saved": saved]
      }
      return String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
    } catch { close(); throw (error as? CredentialError) ?? CredentialError.invalidMessage }
  }

  public func password(handle: String, useSaved: Bool, locale: String, theme: String) async throws -> String {
    let state = try current(handle)
    try state.channel.requireConfirmed()
    guard UIApplication.shared.applicationState == .active else { throw CredentialError.applicationInactive }
    guard let account = state.account, let vault else { throw CredentialError.unavailable }
    guard form == nil, authentication == nil, !operationPending else { throw CredentialError.authenticationBusy }
    operationPending = true
    defer { operationPending = false }
    let labels = try CredentialLabels(locale: locale)
    if state.savedOnly && !useSaved {
      if let saved = state.savedBinding, saved != state.binding(account) {
        throw CredentialError.savedBindingChanged
      }
      throw CredentialError.savedPasswordMissing
    }
    if useSaved {
      do {
      let secret = try await readProtectedSecret(vault: vault, binding: state.binding(account), reason: labels["biometric"])
      guard session === state else { throw CredentialError.cancelled }
      let epoch = generation
      try requireForeground(epoch: epoch)
      guard session === state else { throw CredentialError.cancelled }
      _ = try current(handle)
      state.usedSavedPassword = true
      return try state.controller.authenticate(password: secret, remember: false)
      } catch {
        guard session === state else { throw CredentialError.cancelled }
        if state.savedOnly { throw error }
        guard let failure = error as? CredentialError,
          [.unavailable, .savedPasswordMissing, .savedReadDenied, .savedInteractionRequired, .savedReadFailed].contains(failure) else { throw error }
        try state.channel.requireConfirmed()
        // An unavailable/invalidated vault falls back to native manual entry.
        // Cancellation is never turned into another prompt.
      }
    }
    guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
      .first(where: { $0.activationState == .foregroundActive }),
      var presenter = scene.windows.first(where: { $0.isKeyWindow })?.rootViewController else {
      throw CredentialError.unavailable
    }
    while let presented = presenter.presentedViewController { presenter = presented }
    defer { if session === state { form = nil } }
    let entered: (Data, Bool) = try await withCheckedThrowingContinuation { continuation in
      let form = CredentialPasswordForm(labels: labels, account: account.name, target: state.remote.id, saveRequired: state.setup) {
        continuation.resume(with: $0.mapError { $0 as Error })
      }
      form.overrideUserInterfaceStyle = theme == "dark" ? .dark : .light
      self.form = form
      presenter.present(form, animated: true)
    }
    guard session === state, UIApplication.shared.applicationState == .active else { throw CredentialError.cancelled }
    _ = try current(handle)
    state.usedSavedPassword = false
    return try state.controller.authenticate(password: entered.0, remember: state.setup || entered.1)
  }

  public func authenticationStatus(handle: String) throws -> String { try current(handle).controller.authenticationStatus() }
  public func request(handle: String, body: String) throws -> [String: String] {
    let request = try current(handle).controller.request(Data(body.utf8))
    return ["id": request.id, "ciphertext": request.ciphertext]
  }
  public func abandonRequest(handle: String, id: String) throws { try current(handle).controller.abandonRequest(id) }
  public func forget(handle: String) throws {
    let state = try current(handle)
    guard let account = state.account else { throw CredentialError.invalidIdentity }
    try vault?.forget(binding: state.binding(account))
  }
  public func close() {
    let handle = session?.handle
    generation &+= 1
    session?.controller.close(); session = nil
    authentication?.invalidate(); authentication = nil
    form?.cancel(); form = nil
    if let handle { onInvalidated?(handle) }
  }
  public func end(handle: String) -> String? {
    guard let state = session, state.handle == handle else { return nil }
    let packet = try? state.channel.seal(body: Data(), purpose: "revoke")
    close(); return packet
  }
  public func close(handle: String) { if session?.handle == handle { close() } }
  public func reset() { close(); owner = nil; key = nil; vault = nil }

  // Helpers own the authentication context and release it when evaluation/read
  // finishes. Operation exclusion is separate from context ownership.
  private func readProtectedSecret(vault: CredentialVault, binding: CredentialBinding, reason: String) async throws -> Data {
    let context = LAContext(); authentication = context
    defer { context.invalidate(); if authentication === context { authentication = nil } }
    return try await withCheckedThrowingContinuation { continuation in
      DispatchQueue.global(qos: .userInitiated).async {
        do { continuation.resume(returning: try vault.read(binding: binding, reason: reason, context: context)) }
        catch { continuation.resume(throwing: error as? CredentialError ?? CredentialError.unavailable) }
      }
    }
  }
  private func evaluateBiometrics(reason: String) async throws {
    let context = LAContext(); authentication = context
    defer { context.invalidate(); if authentication === context { authentication = nil } }
    guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil) else { throw CredentialError.unavailable }
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { accepted, error in
        if accepted { continuation.resume() }
        else {
          let code = (error as? LAError)?.code
          let cancelled = code == .userCancel || code == .appCancel || code == .systemCancel
          continuation.resume(throwing: cancelled ? CredentialError.cancelled : CredentialError.savedReadDenied)
        }
      }
    }
  }

  private func requireForeground(epoch: UInt64) throws {
    let state: CredentialForegroundGate.State
    switch UIApplication.shared.applicationState {
    case .active: state = .active
    case .inactive: state = .inactive
    default: state = .background
    }
    try CredentialForegroundGate.require(isCurrent: generation == epoch, state: state)
  }

  private func current(_ handle: String) throws -> Session {
    guard let session, session.handle == handle else { throw CredentialError.invalidIdentity }
    try session.channel.active()
    return session
  }
}
#endif
