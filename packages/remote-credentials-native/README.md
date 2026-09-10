# Cindy remote credential native core

This library is wired into the Mac host and iOS controller in this worktree.
The Android controller implements the same wire protocol in its native module.
See [integration status](../../docs/remote-desktop-credentials.md) for the product
contract, required server rollout and remaining lockscreen/device validation.
The Mac helper targets macOS 12+, matching the Desktop application's minimum.

The permanent signing key stays in native Keychain/Secure Enclave APIs. Session
ECDH keys are ephemeral and are released when the native channel closes.
Passwords must never cross the React Native or Electron renderer bridge.
The iOS vault's internal methods must be called only by the native transaction
coordinator after peer confirmation; they are not public Expo methods.

Build and test the pure native core with `swift test`. Tests generate temporary
keys in memory and do not access personal Keychain data or verify a real OS
password. An iOS build is a compile check, not a biometric test.

Cryptographic implementation: [JOSESwift 3.0.0](https://github.com/airsidemobile/JOSESwift/tree/3.0.0),
Apache-2.0, pinned in `Package.resolved`. Its [license](LICENSE.JOSESwift)
is included by the repository's third-party notice generator in Mac and iOS artifacts.

Apple contracts: [OpenDirectory password verification](<https://developer.apple.com/documentation/opendirectory/odrecord/verifypassword(_:)>),
[Keychain accessibility and user presence](https://developer.apple.com/documentation/security/restricting-keychain-item-accessibility).
