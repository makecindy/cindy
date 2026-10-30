import Foundation

/// Fixed errors only: OS, crypto and network diagnostic text can contain secrets.
public enum CredentialError: String, Codable, LocalizedError, CustomNSError {
  case invalidMessage = "CREDENTIAL_INVALID_MESSAGE"
  case invalidIdentity = "CREDENTIAL_INVALID_IDENTITY"
  case unavailable = "CREDENTIAL_UNAVAILABLE"
  // Local phone diagnostics only; never include OS descriptions or secret data.
  case applicationInactive = "CREDENTIAL_APPLICATION_INACTIVE"
  case authenticationBusy = "CREDENTIAL_AUTHENTICATION_BUSY"
  case savedPasswordMissing = "CREDENTIAL_SAVED_PASSWORD_MISSING"
  case savedBindingChanged = "CREDENTIAL_SAVED_BINDING_CHANGED"
  case savedReadDenied = "CREDENTIAL_SAVED_READ_DENIED"
  case savedInteractionRequired = "CREDENTIAL_SAVED_INTERACTION_REQUIRED"
  case savedReadFailed = "CREDENTIAL_SAVED_READ_FAILED"
  case expired = "CREDENTIAL_EXPIRED"
  case cancelled = "CREDENTIAL_CANCELLED"
  case accessibilityRequired = "CREDENTIAL_ACCESSIBILITY_REQUIRED"
  case unlockUnavailable = "CREDENTIAL_UNLOCK_UNAVAILABLE"
  public var errorDescription: String? { rawValue }
  public static var errorDomain: String { "CindyRemoteCredentials" }
  public var errorUserInfo: [String: Any] { [NSLocalizedDescriptionKey: rawValue] }
}

/// Continue only an already-authorized native operation. Inactive is still
/// foreground (for example a Face ID overlay); background and stale owners fail.
@MainActor
enum CredentialForegroundGate {
  enum State { case active, inactive, background }
  static func require(isCurrent: Bool, state: State) throws {
    guard isCurrent, state != .background else { throw CredentialError.cancelled }
  }
}
