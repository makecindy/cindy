//! Owner verification through the system Windows Hello / PIN prompt, used only when the
//! privacy screen could not lock this computer (docs/product-rules/privacy-screen.md).
//! The prompt belongs to Windows; this process never sees a credential, only whether
//! the owner was verified.
use windows::{
    core::{factory, HSTRING},
    Foundation::IAsyncOperation,
    Security::Credentials::UI::{UserConsentVerificationResult, UserConsentVerifier},
    Win32::{
        Foundation::HWND,
        System::WinRT::{IUserConsentVerifierInterop, RoInitialize, RO_INIT_SINGLETHREADED},
    },
};

/// `Some(true)` once verified, `Some(false)` when cancelled or refused, `None` when
/// Windows cannot verify here (no Hello / PIN set up, or the prompt is unavailable).
pub fn verify(window: isize, reason: &str) -> Option<bool> {
    unsafe {
        let _ = RoInitialize(RO_INIT_SINGLETHREADED);
    }
    let interop = factory::<UserConsentVerifier, IUserConsentVerifierInterop>().ok()?;
    let operation: IAsyncOperation<UserConsentVerificationResult> = unsafe {
        interop
            .RequestVerificationForWindowAsync(HWND(window as *mut _), &HSTRING::from(reason))
            .ok()?
    };
    match operation.get().ok()? {
        UserConsentVerificationResult::Verified => Some(true),
        UserConsentVerificationResult::Canceled | UserConsentVerificationResult::RetriesExhausted => {
            Some(false)
        }
        _ => None,
    }
}
