import ExpoModulesCore
import CindyRemoteCredentials

public final class CindyRemoteCredentialsModule: Module {
  @MainActor private lazy var client: MobileCredentialClient = {
    let value = MobileCredentialClient()
    value.onInvalidated = { [weak self] handle in self?.sendEvent("invalidated", ["handle": handle]) }
    return value
  }()

  public func definition() -> ModuleDefinition {
    Name("CindyRemoteCredentials")
    Events("invalidated")
    AsyncFunction("savedUnlockSettings") { (realm: String, membership: String, authDevice: String, target: String) async throws -> [String: Bool] in
      try await self.client.savedSettings(realm: realm, membership: membership, authDevice: authDevice, target: target)
    }
    AsyncFunction("forgetSavedUnlock") { (realm: String, membership: String, authDevice: String, target: String) async throws in
      try await self.client.forgetSaved(realm: realm, membership: membership, authDevice: authDevice, target: target)
    }
    AsyncFunction("setSavedUnlockBiometric") { (realm: String, membership: String, authDevice: String, target: String, enabled: Bool, locale: String) async throws in
      try await self.client.changeBiometric(realm: realm, membership: membership, authDevice: authDevice, target: target, enabled: enabled, locale: locale)
    }
    AsyncFunction("beginUnlock") { (target: String, setup: Bool, biometric: Bool, descriptor: String) async throws -> [String: String] in
      try await self.client.begin(target: target, descriptor: descriptor, setup: setup, savedOnly: !setup, biometric: biometric)
    }
    AsyncFunction("configure") { (realm: String, membership: String, authDevice: String, token: String) async throws -> String in
      try await self.client.configure(realm: realm, membership: membership, authDevice: authDevice, token: token)
    }
    AsyncFunction("updateToken") { (realm: String, membership: String, token: String) async throws in
      try await self.client.updateToken(realm: realm, membership: membership, token: token)
    }
    AsyncFunction("relayHeaders") { () async throws -> [String: String] in try await self.client.relayHeaders() }
    AsyncFunction("pushHeaders") { (method: String, body: [String: String]) async throws -> [String: String] in
      try await self.client.pushHeaders(method: method, body: body)
    }
    AsyncFunction("begin") { (target: String) async throws -> [String: String] in try await self.client.begin(target: target) }
    AsyncFunction("accept") { (handle: String, offer: String) async throws -> String in
      try await self.client.accept(handle: handle, offer: offer)
    }
    AsyncFunction("receive") { (handle: String, ciphertext: String) async throws -> String in
      try await self.client.receive(handle: handle, ciphertext: ciphertext)
    }
    AsyncFunction("password") { (handle: String, useSaved: Bool, locale: String, theme: String) async throws -> String in
      try await self.client.password(handle: handle, useSaved: useSaved, locale: locale, theme: theme)
    }
    AsyncFunction("authenticationStatus") { (handle: String) async throws -> String in
      try await self.client.authenticationStatus(handle: handle)
    }
    AsyncFunction("request") { (handle: String, body: String) async throws -> [String: String] in
      try await self.client.request(handle: handle, body: body)
    }
    AsyncFunction("abandonRequest") { (handle: String, id: String) async throws in
      try await self.client.abandonRequest(handle: handle, id: id)
    }
    AsyncFunction("forget") { (handle: String) async throws in try await self.client.forget(handle: handle) }
    AsyncFunction("end") { (handle: String) async -> String? in await self.client.end(handle: handle) }
    AsyncFunction("close") { (handle: String) async in await self.client.close(handle: handle) }
    AsyncFunction("reset") { () async in await self.client.reset() }
    OnAppEntersBackground { Task { @MainActor in self.client.close() } }
    OnDestroy { Task { @MainActor in self.client.reset() } }
  }
}
